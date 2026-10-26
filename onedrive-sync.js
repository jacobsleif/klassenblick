(function () {
  "use strict";

  const AUTHORITY = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
  const GRAPH_FILE = "https://graph.microsoft.com/v1.0/me/drive/special/approot:/klassenblick-daten.json";
  const SCOPES = "Files.ReadWrite.AppFolder offline_access";
  const TOKEN_KEY = "klassenblick-onedrive-token";
  const PKCE_KEY = "klassenblick-onedrive-pkce";
  const META_KEY = "klassenblick-onedrive-meta";

  class ConflictError extends Error {}

  const clientId = () => (window.KLASSENBLICK_CONFIG?.clientId || "").trim();
  const redirectUri = () => location.origin + location.pathname;

  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (error) { return null; }
  }

  function base64Url(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function randomString(length = 48) {
    return base64Url(crypto.getRandomValues(new Uint8Array(length))).slice(0, length);
  }

  async function tokenRequest(params) {
    const response = await fetch(`${AUTHORITY}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId(), scope: SCOPES, ...params })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error_description || "Anmeldung bei Microsoft fehlgeschlagen.");
      error.code = body.error;
      throw error;
    }
    const previous = readJson(TOKEN_KEY) || {};
    localStorage.setItem(TOKEN_KEY, JSON.stringify({
      accessToken: body.access_token,
      refreshToken: body.refresh_token || previous.refreshToken,
      expiresAt: Date.now() + (body.expires_in - 60) * 1000
    }));
  }

  async function login() {
    if (!clientId()) throw new Error("Es ist noch keine Microsoft-Client-ID in config.js eingetragen.");
    if (!crypto.subtle) throw new Error("Die Anmeldung braucht eine sichere Verbindung (HTTPS oder localhost).");
    const verifier = randomString(64);
    const state = randomString(24);
    sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
    const challenge = base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const url = `${AUTHORITY}/authorize?` + new URLSearchParams({
      client_id: clientId(), response_type: "code", redirect_uri: redirectUri(), response_mode: "query",
      scope: SCOPES, state, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account"
    });
    location.assign(url);
  }

  // Schließt die Anmeldung ab, wenn Microsoft zur App zurückleitet.
  async function handleRedirect() {
    const params = new URLSearchParams(location.search);
    if (!params.has("code") && !params.has("error")) return null;
    const pending = JSON.parse(sessionStorage.getItem(PKCE_KEY) || "null");
    sessionStorage.removeItem(PKCE_KEY);
    history.replaceState(null, "", location.pathname);
    if (params.has("error")) throw new Error(params.get("error_description") || "Anmeldung abgebrochen.");
    if (!pending || pending.state !== params.get("state")) throw new Error("Ungültige Anmeldeantwort.");
    await tokenRequest({
      grant_type: "authorization_code", code: params.get("code"),
      redirect_uri: redirectUri(), code_verifier: pending.verifier
    });
    return true;
  }

  async function accessToken() {
    const token = readJson(TOKEN_KEY);
    if (!token) throw new Error("Nicht mit OneDrive verbunden.");
    if (token.expiresAt > Date.now()) return token.accessToken;
    if (!token.refreshToken) throw new Error("Bitte erneut mit OneDrive verbinden.");
    try {
      await tokenRequest({ grant_type: "refresh_token", refresh_token: token.refreshToken });
    } catch (error) {
      if (error.code === "invalid_grant") logout();
      throw error;
    }
    return readJson(TOKEN_KEY).accessToken;
  }

  async function graph(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(options.headers || {}) }
    });
    return response;
  }

  // Liefert { exists:false } oder { exists:true, etag, text }.
  async function download() {
    const meta = await graph(GRAPH_FILE);
    if (meta.status === 404) return { exists: false };
    if (!meta.ok) throw new Error(`OneDrive-Abruf fehlgeschlagen (${meta.status}).`);
    const info = await meta.json();
    const content = await graph(`${GRAPH_FILE}:/content`);
    if (!content.ok) throw new Error(`OneDrive-Inhalt konnte nicht gelesen werden (${content.status}).`);
    const text = await content.text();
    return { exists: true, etag: info.eTag, text };
  }

  // Überschreibt nur, wenn die Datei seit dem letzten Abgleich unverändert ist (etag); sonst ConflictError.
  async function upload(text, etag) {
    const headers = { "Content-Type": "application/json" };
    headers[etag ? "If-Match" : "If-None-Match"] = etag || "*";
    const response = await graph(`${GRAPH_FILE}:/content`, { method: "PUT", headers, body: text });
    if (response.status === 412 || response.status === 409) throw new ConflictError("OneDrive-Datei wurde zwischenzeitlich geändert.");
    if (!response.ok) throw new Error(`OneDrive-Speichern fehlgeschlagen (${response.status}).`);
    const info = await response.json();
    return { etag: info.eTag };
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(META_KEY);
  }

  window.KlassenblickCloud = {
    ConflictError,
    isConfigured: () => Boolean(clientId()),
    isConnected: () => Boolean(readJson(TOKEN_KEY)),
    getMeta: () => readJson(META_KEY) || {},
    setMeta: (meta) => localStorage.setItem(META_KEY, JSON.stringify(meta)),
    login, handleRedirect, download, upload, logout
  };
}());

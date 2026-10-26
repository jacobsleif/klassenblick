(function () {
  "use strict";

  const STORAGE_KEY = "klassenblick-data-v2";
  const LEGACY_STORAGE_KEY = "klassenblick-data-v1";
  const DB_NAME = "klassenblick-file-handles";
  const DB_STORE = "handles";
  const BACKUP_STORE = "snapshots";
  const PLUS_MINUS_GRADES = [
    { label: "1+", value: 0.7 }, { label: "1", value: 1 }, { label: "1-", value: 1.3 },
    { label: "2+", value: 1.7 }, { label: "2", value: 2 }, { label: "2-", value: 2.3 },
    { label: "3+", value: 2.7 }, { label: "3", value: 3 }, { label: "3-", value: 3.3 },
    { label: "4+", value: 3.7 }, { label: "4", value: 4 }, { label: "4-", value: 4.3 },
    { label: "5+", value: 4.7 }, { label: "5", value: 5 }, { label: "5-", value: 5.3 },
    { label: "6+", value: 5.7 }, { label: "6", value: 6 }, { label: "6-", value: 6.3 }
  ];
  const today = () => {
    const date = new Date();
    const offset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 10);
  };
  const uid = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);

  const blankState = () => ({ version: 2, classes: [], selectedClassId: null });
  let state = blankState();
  let storageRecoveryError = null;
  let persistenceWarning = "";
  let storagePolicyWarning = "";
  let activeTab = "grades";
  let studentFilter = "";
  let showingSchedule = false;
  let toastTimer;
  let fileHandle = null;
  let backupDirectoryHandle = null;
  let oneDrivePermissionGranted = false;
  let scheduleOverrideUntil = 0;
  let lastScheduleConflictKey = "";
  const cloud = window.KlassenblickCloud;
  const CLOUD_ERROR_TEXT = "OneDrive ist nicht erreichbar. Änderungen sind lokal gespeichert und werden beim nächsten erfolgreichen Abgleich übertragen.";
  let cloudStatus = "Nur auf diesem Gerät";
  let cloudBusy = false;
  let cloudDirty = false;
  let cloudPaused = false;
  let cloudTimer;

  const $ = (selector, root = document) => root.querySelector(selector);
  const classList = $("#class-list");
  const emptyState = $("#empty-state");
  const courseView = $("#course-view");
  const scheduleView = $("#schedule-view");
  const modal = $("#modal");
  const modalFields = $("#modal-fields");
  const modalForm = $("#modal-form");

  function parseStoredState(raw) {
    const parsed = migrateState(JSON.parse(raw));
    validateImport(parsed);
    return parsed;
  }

  function formatWeight(weight) {
    return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 3 }).format(Number(weight));
  }

  async function loadState() {
    let localState = null;
    let localStorageHadData = false;
    let localStorageError = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
      localStorageHadData = Boolean(raw);
      if (raw) {
        localState = parseStoredState(raw);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(localState));
        } catch (error) {
          persistenceWarning = "Daten wurden geladen, konnten aber nicht in den primären Browserspeicher zurückgeschrieben werden.";
          console.error("Migrierte App-Daten konnten nicht im primären Browserspeicher gespeichert werden.", error);
        }
      }
    } catch (error) {
      localStorageError = error;
      console.error("Die gespeicherten App-Daten konnten nicht gelesen werden.", error);
    }

    let backups = [];
    try {
      backups = await getAutomaticBackups();
    } catch (error) {
      persistenceWarning = "Die automatische Zusatzsicherung ist nicht verfügbar.";
      console.error("Automatische Sicherungen konnten nicht gelesen werden.", error);
    }

    const validBackups = backups.flatMap(({ raw, priority }) => {
      if (typeof raw !== "string") return [];
      try {
        return [{ state: parseStoredState(raw), priority }];
      } catch (error) {
        console.error("Eine automatische Sicherung konnte nicht gelesen werden.", error);
        return [];
      }
    });
    if (backups.length && !validBackups.length) {
      persistenceWarning = "Die automatische Sicherung ist beschädigt und konnte nicht gelesen werden.";
    }
    const newestBackup = validBackups.sort((a, b) =>
      Date.parse(b.state.updatedAt || "") - Date.parse(a.state.updatedAt || "") ||
      b.priority - a.priority)[0]?.state || null;

    if (!localState && newestBackup) {
      localState = newestBackup;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(localState));
        persistenceWarning = "Die App-Daten wurden aus der automatischen Sicherung wiederhergestellt.";
      } catch (error) {
        persistenceWarning = "Daten aus der automatischen Sicherung geladen, aber nicht in den Browserspeicher zurückgeschrieben.";
        console.error("Wiederhergestellte Daten konnten nicht lokal gespeichert werden.", error);
      }
    } else if (localState && newestBackup &&
        Date.parse(newestBackup.updatedAt || "") > Date.parse(localState.updatedAt || "")) {
      localState = newestBackup;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(localState));
        persistenceWarning = "Neuere App-Daten wurden aus der automatischen Sicherung wiederhergestellt.";
      } catch (error) {
        persistenceWarning = "Neuere Daten aus der automatischen Sicherung geladen, aber nicht lokal zurückgeschrieben.";
        console.error("Neuere wiederhergestellte Daten konnten nicht lokal gespeichert werden.", error);
      }
    }

    if (!localState && (localStorageHadData || backups.length)) {
      storageRecoveryError = localStorageError
        ? "Der lokale Datenbestand ist nicht lesbar. Die App wurde gesperrt, damit kein leerer Bestand darüber gespeichert wird."
        : "Es wurden gespeicherte, aber nicht lesbare Daten gefunden. Die App wurde zum Schutz deiner Daten gesperrt.";
      return blankState();
    }
    return localState || blankState();
  }

  function saveState() {
    if (storageRecoveryError) {
      showToast("Zum Schutz der vorhandenen Daten ist die App gesperrt. Bitte zuerst eine Sicherungsdatei öffnen.");
      return;
    }
    const indicator = $("#save-indicator");
    indicator.classList.add("is-saving");
    let localSaved = false;
    try {
      state.updatedAt = new Date().toISOString();
      state.version = 2;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      localSaved = true;
    } catch (error) {
      console.error("Daten konnten nicht im primären Browserspeicher gespeichert werden.", error);
      persistenceWarning = "Der primäre Browserspeicher konnte nicht aktualisiert werden. Die automatische Zusatzsicherung wird versucht.";
      updateStorageWarning();
    }
    render();
    indicator.classList.remove("is-saving");
    persistAutomaticBackup(state).then(() => {
      if (!localSaved) {
        persistenceWarning = "Der primäre Browserspeicher ist voll oder nicht verfügbar. Die Änderung liegt nur in der Zusatzsicherung; bitte jetzt eine JSON-Sicherung speichern.";
        updateStorageWarning();
        showToast("Änderung in der Zusatzsicherung gespeichert. Bitte zusätzlich eine JSON-Sicherung in OneDrive speichern.");
      }
    }).catch((error) => {
      persistenceWarning = localSaved
        ? "Automatische Zusatzsicherung fehlgeschlagen. Bitte eine Sicherungsdatei speichern."
        : "Speichern in Browser- und Zusatzspeicher fehlgeschlagen. Bitte Daten sofort exportieren und Browser-Speicher prüfen.";
      console.error("Automatische Sicherung konnte nicht gespeichert werden.", error);
      updateStorageWarning();
      showToast("Automatische Sicherung fehlgeschlagen. Bitte sofort eine JSON-Sicherung speichern.");
    });
    scheduleCloudSync();
    if (fileHandle) writeConnectedFile().catch((error) => {
      oneDrivePermissionGranted = false;
      updateSaveIndicator();
      updateStorageWarning();
      console.error("Die verbundene Sicherungsdatei konnte nicht aktualisiert werden.", error);
      showToast("Lokal gespeichert, OneDrive-Datei konnte nicht aktualisiert werden.");
    });
  }

  function selectedClass() {
    return state.classes.find((course) => course.id === state.selectedClassId) || null;
  }

  function createNode(name, kind, weight, children = []) {
    return { id: uid(), name, kind, weight, children };
  }

  function defaultGradeTree() {
    const makeSemester = (name) => createNode(name, "semester", 1, [
      createNode("Arbeiten", "area", 1),
      createNode("Sonstige Mitarbeit", "area", 1, [
        createNode("Unterrichtsgespräch", "subcategory", 1),
        createNode("Sonstiges", "subcategory", 1)
      ])
    ]);
    return createNode("Endnote", "root", 1, [makeSemester("1. Halbjahr"), makeSemester("2. Halbjahr")]);
  }

  function findNode(node, nodeId) {
    if (node.id === nodeId) return node;
    for (const child of node.children || []) {
      const found = findNode(child, nodeId);
      if (found) return found;
    }
    return null;
  }

  function gradePath(course, columnId) {
    const parts = [];
    let node = findNode(course.gradeTree, columnId);
    while (node && node.kind !== "root") {
      if (node.kind !== "column") parts.unshift(node.name);
      node = findParent(course.gradeTree, node.id);
    }
    return parts.join(" / ") || "Notenbaum";
  }

  function migrationHalfYear(date) {
    const month = Number(String(date || "").slice(5, 7));
    return month >= 2 && month <= 7 ? "2. Halbjahr" : "1. Halbjahr";
  }

  function migrateCourse(course) {
    course.grades = Array.isArray(course.grades) ? course.grades : [];
    if (!Object.prototype.hasOwnProperty.call(course, "schedule")) course.schedule = [];
    if (course.scale === "grades") course.scale = "grades-plusminus";
    if (Object.prototype.hasOwnProperty.call(course, "weightModel") && course.weightModel !== "relative-v1") {
      throw new Error("Unbekanntes Gewichtungsmodell. Die Daten wurden zum Schutz nicht verändert.");
    }
    if (!course.gradeTree) {
      course.gradeTree = defaultGradeTree();
      const firstSemester = course.gradeTree.children[0];
      const secondSemester = course.gradeTree.children[1];
      const groups = new Map();
      for (const oldGrade of course.grades) {
        const semester = migrationHalfYear(oldGrade.date) === "2. Halbjahr" ? secondSemester : firstSemester;
        const category = String(oldGrade.category || "").toLocaleLowerCase("de");
        const isConversation = category.includes("mündlich");
        const isWork = category.includes("schriftlich") || category.includes("arbeit");
        const parent = isWork
          ? semester.children[0]
          : isConversation
            ? semester.children[1].children[0]
            : semester.children[1].children[1];
        const key = [semester.id, parent.id, oldGrade.title, oldGrade.date, oldGrade.category].join("|");
        let column = groups.get(key);
        if (!column) {
          column = createNode(oldGrade.title || oldGrade.category || "Übernommene Leistung", "column", 100);
          parent.children.push(column);
          groups.set(key, column);
        }
        oldGrade.columnId = column.id;
      }
    }
    for (const grade of course.grades) {
      if (grade.columnId) continue;
      const root = course.gradeTree;
      const semester = root.children[0];
      let parent = semester.children[1].children[1];
      const column = createNode(grade.title || "Übernommene Leistung", "column", 100);
      parent.children.push(column);
      grade.columnId = column.id;
    }
    for (const grade of course.grades) {
      if (!isAllowedGradeValue(course, Number(grade.value))) grade.legacyValue = true;
    }
    if (course.weightModel !== "relative-v1") {
      normalizeLegacyWeights(course.gradeTree);
      course.weightModel = "relative-v1";
    }
    return course;
  }

  function normalizeLegacyWeights(parent) {
    const children = parent.children || [];
    const positiveWeights = children.map((child) => Number(child.weight)).filter((weight) => weight > 0);
    if (positiveWeights.length) {
      const largest = positiveWeights.reduce((maximum, weight) => Math.max(maximum, weight), 0);
      const meanRatio = positiveWeights.reduce((sum, weight) => sum + weight / largest, 0) / positiveWeights.length;
      children.forEach((child) => {
        const weight = Number(child.weight);
        child.weight = weight > 0 ? (weight / largest) / meanRatio : 0;
      });
    }
    children.forEach(normalizeLegacyWeights);
  }

  function migrateState(data) {
    if (!data || !Array.isArray(data.classes) || ![1, 2].includes(data.version)) throw new Error("Unbekanntes Datenformat.");
    data.classes.forEach(migrateCourse);
    data.version = 2;
    return data;
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 2800);
  }

  function render() {
    renderClassList();
    const course = selectedClass();
    emptyState.hidden = Boolean(course) || showingSchedule;
    courseView.hidden = !course || showingSchedule;
    scheduleView.hidden = !showingSchedule;
    $("#schedule-button").classList.toggle("active", showingSchedule);
    if (showingSchedule) {
      scheduleView.innerHTML = renderSchedule();
      bindScheduleActions();
      return;
    }
    if (!course) return;
    courseView.innerHTML = renderCourse(course);
    bindCourseActions();
  }

  function renderClassList() {
    if (!state.classes.length) {
      classList.innerHTML = '<div class="empty-inline">Noch keine Kurse</div>';
      return;
    }
    classList.innerHTML = state.classes.map((course) => {
      const initials = course.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
      return `<button class="class-item ${course.id === state.selectedClassId ? "active" : ""}" data-class-id="${escapeHtml(course.id)}" type="button">
        <span class="class-icon">${escapeHtml(initials || "K")}</span>
        <span class="class-info"><strong>${escapeHtml(course.name)}</strong><small>${escapeHtml(course.subject || "Kurs")} · ${course.students.length} Lernende</small></span>
      </button>`;
    }).join("");
    classList.querySelectorAll("[data-class-id]").forEach((button) => button.addEventListener("click", () => {
      holdAutomaticSelectionForCurrentPeriod();
      showingSchedule = false;
      state.selectedClassId = button.dataset.classId;
      activeTab = "grades";
      studentFilter = "";
      saveState();
    }));
  }

  function renderCourse(course) {
    const tabs = [["grades", "Notenübersicht"], ["overview", "Übersicht"], ["students", "Lernende"], ["attendance", "Anwesenheit"]];
    const subtitle = [course.subject, course.schoolYear].filter(Boolean).map(escapeHtml).join(" · ");
    const activeCourses = [...new Map(currentScheduleMatches().map((match) => [match.course.id, match.course])).values()];
    const conflictNotice = activeCourses.length > 1
      ? `<div class="timetable-conflict" role="status">Zeitüberschneidung im Stundenplan: ${activeCourses.map((item) => escapeHtml(item.name)).join(", ")}. Bitte prüfe die eingetragenen Zeiten.</div>`
      : "";
    return `<div class="course-header">
      <div class="course-title-wrap"><p class="eyebrow">KURSÜBERSICHT</p><h2>${escapeHtml(course.name)}</h2><p class="course-subtitle">${subtitle || "Noch keine Kursdetails"}</p></div>
      <div class="course-actions">
        <button class="button button-quiet" data-action="edit-course" type="button">Kurs bearbeiten</button>
        <button class="button button-quiet" data-action="edit-schedule" type="button">Stundenplan</button>
        <button class="button button-quiet" data-action="add-student" type="button">+ Lernende</button>
        <button class="button button-quiet" data-action="add-grade" type="button">+ Notenspalte</button>
        <button class="button button-primary" data-action="attendance" type="button">Anwesenheit erfassen</button>
      </div>
    </div>
    ${conflictNotice}
    <nav class="tabs" aria-label="Kursbereiche">${tabs.map(([id, label]) => `<button class="tab ${activeTab === id ? "active" : ""}" data-tab="${id}" type="button">${label}</button>`).join("")}</nav>
    ${activeTab === "overview" ? renderOverview(course) : ""}
    ${activeTab === "students" ? renderStudents(course) : ""}
    ${activeTab === "grades" ? renderGrades(course) : ""}
    ${activeTab === "attendance" ? renderAttendance(course) : ""}`;
  }

  function currentScheduleMatches(date = new Date()) {
    const day = date.getDay();
    if (day < 1 || day > 5) return [];
    const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    return state.classes.flatMap((course) => (course.schedule || [])
      .filter((slot) => slot.day === day && slot.start <= time && time < slot.end)
      .map((slot) => ({ course, slot })));
  }

  function isValidScheduleTime(value) {
    if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return false;
    const [hours, minutes] = value.split(":").map(Number);
    return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
  }

  function holdAutomaticSelectionForCurrentPeriod() {
    const matches = currentScheduleMatches();
    if (!matches.length) return;
    const ends = matches.map(({ slot }) => {
      const [hours, minutes] = slot.end.split(":").map(Number);
      const end = new Date();
      end.setHours(hours, minutes, 0, 0);
      return end.getTime();
    });
    scheduleOverrideUntil = Math.max(...ends);
  }

  function bindScheduleActions() {
    scheduleView.querySelectorAll("[data-timetable-course]").forEach((button) => button.addEventListener("click", () => {
      holdAutomaticSelectionForCurrentPeriod();
      showingSchedule = false;
      state.selectedClassId = button.dataset.timetableCourse;
      activeTab = "grades";
      studentFilter = "";
      saveState();
    }));
    const editCurrent = scheduleView.querySelector("[data-schedule-action='edit-current']");
    if (editCurrent) editCurrent.addEventListener("click", () => {
      const course = selectedClass();
      if (course) openEditCourseModal(course);
    });
  }

  function renderSchedule() {
    const days = [
      { id: 1, name: "Montag" }, { id: 2, name: "Dienstag" }, { id: 3, name: "Mittwoch" },
      { id: 4, name: "Donnerstag" }, { id: 5, name: "Freitag" }
    ];
    const now = new Date();
    const matches = currentScheduleMatches(now);
    const matchingCourses = [...new Map(matches.map((match) => [match.course.id, match.course])).values()];
    const conflictIds = new Set(matchingCourses.length > 1 ? matchingCourses.map((course) => course.id) : []);
    const today = now.getDay();
    return `<section class="panel timetable-panel">
      <div class="panel-heading"><div><p class="eyebrow">WOCHENÜBERSICHT</p><h2>Stundenplan</h2><p>Wiederkehrende Unterrichtszeiten aller Kurse. Bei einem laufenden Termin wird der Kurs automatisch geöffnet.</p></div>
        <button class="small-button" data-schedule-action="edit-current" type="button" ${selectedClass() ? "" : "disabled"}>Kurszeiten bearbeiten</button>
      </div>
      ${matchingCourses.length > 1 ? `<div class="timetable-conflict" role="status">Zeitüberschneidung: ${matchingCourses.map((course) => escapeHtml(course.name)).join(", ")}. Es wurde kein Kurs automatisch ausgewählt.</div>` : ""}
      <div class="timetable-week">${days.map((day) => {
        const entries = state.classes.flatMap((course) => (course.schedule || [])
          .filter((slot) => slot.day === day.id)
          .map((slot) => ({ course, slot })))
          .sort((a, b) => a.slot.start.localeCompare(b.slot.start) || a.slot.end.localeCompare(b.slot.end));
        return `<section class="timetable-day ${today === day.id ? "is-today" : ""}">
          <h3>${day.name}${today === day.id ? '<span>Heute</span>' : ""}</h3>
          ${entries.length ? entries.map(({ course, slot }) => {
            const isCurrent = matches.some((match) => match.course.id === course.id && match.slot.id === slot.id);
            const room = slot.room ? ` · Raum ${escapeHtml(slot.room)}` : "";
            return `<button class="timetable-entry ${isCurrent ? "is-current" : ""} ${conflictIds.has(course.id) ? "has-conflict" : ""}" data-timetable-course="${escapeHtml(course.id)}" type="button">
              <span class="timetable-time">${escapeHtml(slot.start)}–${escapeHtml(slot.end)}</span>
              <strong>${escapeHtml(course.name)}</strong>
              <small>${escapeHtml(course.subject || "Kurs")}${room}</small>
              ${isCurrent ? '<span class="timetable-current-label">Läuft gerade</span>' : ""}
              ${conflictIds.has(course.id) ? '<span class="timetable-conflict-label">Überschneidung</span>' : ""}
            </button>`;
          }).join("") : '<p class="timetable-empty">Keine Unterrichtszeiten eingetragen.</p>'}
        </section>`;
      }).join("")}</div>
      <p class="field-hint">Zeiten und Räume verwaltest du über „Kurs bearbeiten“ → „Stundenplan“.</p>
    </section>`;
  }

  function classAverage(course) {
    const entries = course.students.map((student) => calculateNodeAverage(course, course.gradeTree, student.id)).filter((value) => value !== null);
    if (!entries.length) return "–";
    const average = entries.reduce((sum, value) => sum + value, 0) / entries.length;
    return course.scale === "points" ? formatGrade(course, average, true) : formatGrade(course, average, true);
  }

  function calculateNodeAverage(course, node, studentId) {
    if (!node) return null;
    if (node.kind === "column") {
      const grade = course.grades.find((item) => item.columnId === node.id && item.studentId === studentId);
      return grade && Number.isFinite(Number(grade.value)) ? Number(grade.value) : null;
    }
    const scoredChildren = (node.children || []).map((child) => ({
      value: calculateNodeAverage(course, child, studentId),
      weight: Number(child.weight)
    })).filter((item) => item.value !== null && Number.isFinite(item.weight) && item.weight > 0);
    const totalWeight = scoredChildren.reduce((sum, item) => sum + item.weight, 0);
    if (!totalWeight) return null;
    return scoredChildren.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight;
  }

  function formatGrade(course, value, isAverage = false) {
    if (value === null || !Number.isFinite(value)) return "–";
    if (course.scale === "points") return isAverage ? value.toFixed(1).replace(".", ",") : String(value);
    if (course.scale === "grades") return isAverage ? value.toFixed(2).replace(".", ",") : String(value);
    const closest = PLUS_MINUS_GRADES.reduce((best, grade) =>
      Math.abs(grade.value - value) < Math.abs(best.value - value) ? grade : best, PLUS_MINUS_GRADES[0]);
    if (isAverage) return `${closest.label} (${value.toFixed(2).replace(".", ",")})`;
    if (Math.abs(closest.value - value) < 0.001) return closest.label;
    return value.toFixed(2).replace(".", ",");
  }

  function isAllowedGradeValue(course, value, legacyValue = false) {
    if (!Number.isFinite(value)) return false;
    if (legacyValue) return course.scale === "points" ? value >= 0 && value <= 15 : value >= 1 && value <= 6;
    return course.scale === "points"
      ? Number.isInteger(value) && value >= 0 && value <= 15
      : PLUS_MINUS_GRADES.some((grade) => Math.abs(grade.value - value) < 0.001);
  }

  function parseGradeValue(course, rawValue, legacyValue = false) {
    const raw = String(rawValue ?? "").trim();
    if (!raw) return null;
    if (course.scale === "points") {
      if (!/^\d+$/.test(raw)) return null;
      const value = Number(raw);
      return isAllowedGradeValue(course, value, legacyValue) ? { value, legacyValue: false } : null;
    }
    const normalized = raw.replace(/[−–]/g, "-");
    const selected = PLUS_MINUS_GRADES.find((grade) => grade.label === normalized);
    if (selected) return { value: selected.value, legacyValue: false };
    if (legacyValue && /^\d+(?:[.,]\d+)?$/.test(normalized)) {
      const value = Number(normalized.replace(",", "."));
      return isAllowedGradeValue(course, value, true) ? { value, legacyValue: true } : null;
    }
    return null;
  }

  function gradeValueInput(course, name, selectedValue = null, includeBlank = false) {
    if (course.scale === "points") {
      const selected = selectedValue === null ? "" : String(selectedValue);
      return `<select name="${escapeHtml(name)}" aria-label="Notenpunkte"><option value="" ${includeBlank && selected === "" ? "selected" : ""}>–</option>${Array.from({ length: 16 }, (_, value) => `<option value="${value}" ${selected === String(value) ? "selected" : ""}>${value}</option>`).join("")}</select>`;
    }
    const listId = `scale-${uid()}`;
    const formattedValue = selectedValue === null ? "" : formatGrade(course, Number(selectedValue));
    return `<input name="${escapeHtml(name)}" type="text" list="${listId}" value="${escapeHtml(formattedValue)}" placeholder="${includeBlank ? "–" : "z. B. 2+"}" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="text" aria-label="Note: 1 bis 6, optional mit Plus oder Minus">
      <datalist id="${listId}">${PLUS_MINUS_GRADES.map((grade) => `<option value="${grade.label}"></option>`).join("")}</datalist>`;
  }

  function renderGradeNode(course, node, depth) {
    const children = node.children || [];
    const weightLabel = node.kind === "root" ? "" : `    <label class="weight-field"><span>Gewicht</span><input data-weight-id="${escapeHtml(node.id)}" type="number" min="0" step="0.1" value="${escapeHtml(node.weight)}" aria-label="Gewicht von ${escapeHtml(node.name)}"><span>×</span></label>`;
    if (node.kind === "column") {
      const gradeCount = course.grades.filter((grade) => grade.columnId === node.id).length;
      return `<div class="grade-tree-row grade-column" style="--tree-depth:${depth}">
        <span class="tree-marker column-marker">●</span><span class="tree-name">${escapeHtml(node.name)}</span>
        <span class="tree-meta">${escapeHtml(node.date || "Kein Datum")} · ${gradeCount}/${course.students.length} Noten</span>${weightLabel}
        <button class="small-button" data-action="edit-column-grades" data-id="${escapeHtml(node.id)}" type="button">Noten eintragen</button>
        <button class="small-button danger" data-action="delete-grade-column" data-id="${escapeHtml(node.id)}" type="button">Löschen</button>
      </div>`;
    }
    const kindLabel = { root: "Endnote", semester: "Halbjahr", area: "Bereich", subcategory: "Mitarbeit" }[node.kind] || "Kategorie";
    const addButton = node.kind === "root"
      ? `<button class="small-button" data-action="add-semester" data-id="${escapeHtml(node.id)}" type="button">+ Halbjahr</button>`
      : `<button class="small-button" data-action="add-subcategory" data-id="${escapeHtml(node.id)}" type="button">+ Kategorie</button>
         <button class="small-button" data-action="add-grade-column" data-id="${escapeHtml(node.id)}" type="button">+ Notenspalte</button>`;
    return `<section class="grade-tree-node kind-${node.kind}" style="--tree-depth:${depth}">
      <div class="grade-tree-row">
        <span class="tree-marker">${node.kind === "root" ? "◆" : node.kind === "semester" ? "▰" : "▱"}</span>
        <span class="tree-name">${escapeHtml(node.name)}</span><span class="tree-kind">${kindLabel}</span>
        ${weightLabel}${addButton}
      </div>
      ${children.length ? `<div class="grade-tree-children">${children.map((child) => renderGradeNode(course, child, depth + 1)).join("")}</div>` : node.kind !== "root" ? '<div class="tree-empty">Noch keine Unterkategorien oder Notenspalten.</div>' : ""}
    </section>`;
  }

  function renderWeightedSummary(course) {
    const rows = course.students.map((student) => ({
      student,
      result: calculateNodeAverage(course, course.gradeTree, student.id)
    }));
    const graded = rows.filter((row) => row.result !== null);
    return `<section class="panel weighted-results">
      <div class="panel-heading"><div><h3>Gewichtete Endnoten</h3><p>Relative Gewichte werden auf jeder Ebene innerhalb des Notenbaums verrechnet.</p></div></div>
      ${graded.length ? `<div class="table-wrap"><table><thead><tr><th>Lernende/r</th><th>Endnote</th><th>Noten in Baum</th></tr></thead><tbody>${graded.map(({ student, result }) => {
        const count = course.grades.filter((grade) => grade.studentId === student.id && findNode(course.gradeTree, grade.columnId)).length;
        return `<tr><td>${studentFullName(student)}</td><td><span class="grade-pill ${isLowGrade(course, result) ? "low" : ""}">${escapeHtml(formatGrade(course, result, true))}</span></td><td><span class="badge">${count}</span></td></tr>`;
      }).join("")}</tbody></table></div>` : '<div class="empty-inline">Noch keine Noten im Notenbaum eingetragen.</div>'}
    </section>`;
  }

  function renderOverview(course) {
    const records = course.attendance.flatMap((entry) => entry.records);
    const absences = records.filter((record) => record.status.startsWith("absent")).length;
    const sportInactive = records.filter((record) => record.status.startsWith("sport_")).length;
    const recentGrades = [...course.grades].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, 5);
    return `<div class="stats-grid">
      <article class="stat-card"><span class="stat-label">LERNENDE</span><strong class="stat-value">${course.students.length}</strong><span class="stat-note">im Kurs</span></article>
      <article class="stat-card"><span class="stat-label">DURCHSCHNITT</span><strong class="stat-value">${escapeHtml(classAverage(course))}</strong><span class="stat-note">${course.scale === "points" ? "Notenpunkte" : course.scale === "grades" ? "Noten 1–6" : "Noten · +/- als Dezimalwerte"}</span></article>
      <article class="stat-card"><span class="stat-label">ABWESENHEITEN</span><strong class="stat-value">${absences}</strong><span class="stat-note">erfasste Fehlzeiten</span></article>
      <article class="stat-card"><span class="stat-label">SPORT: INAKTIV</span><strong class="stat-value">${sportInactive}</strong><span class="stat-note">Erfassungen</span></article>
    </div>
    <section class="panel">
      <div class="panel-heading"><div><h3>Schnellzugriff</h3><p>Häufige Aktionen im Unterricht</p></div></div>
      <div class="panel-content"><div class="quick-links">
        <button class="quick-link" data-action="attendance" type="button"><span>◷</span><strong>Anwesenheit erfassen</strong><small>Fehlzeiten und Sportstatus eintragen</small></button>
        <button class="quick-link" data-action="add-grade" type="button"><span>✎</span><strong>Notenspalte anlegen</strong><small>Arbeit, Gespräch oder sonstige Leistung</small></button>
        <button class="quick-link" data-action="add-student" type="button"><span>＋</span><strong>Lernende hinzufügen</strong><small>Kursliste pflegen</small></button>
      </div></div>
    </section>
    <section class="panel">
      <div class="panel-heading"><div><h3>Zuletzt erfasste Leistungen</h3><p>Die letzten fünf Noteneinträge</p></div><button class="small-button" data-tab="grades" type="button">Alle Leistungen</button></div>
      ${recentGrades.length ? `<div class="table-wrap"><table><thead><tr><th>Lernende/r</th><th>Leistung</th><th>Bereich</th><th>Note</th></tr></thead><tbody>${recentGrades.map((grade) => {
        const student = course.students.find((item) => item.id === grade.studentId);
        const column = findNode(course.gradeTree, grade.columnId);
        return `<tr><td>${student ? studentFullName(student) : '<span class="muted">Gelöscht</span>'}</td><td>${escapeHtml(column?.name || grade.title || "Leistung")}</td><td><span class="badge">${escapeHtml(grade.category || gradePath(course, grade.columnId))}</span></td><td><span class="grade-pill ${isLowGrade(course, grade.value) ? "low" : ""}">${escapeHtml(formatGrade(course, Number(grade.value)))}</span></td></tr>`;
      }).join("")}</tbody></table></div>` : '<div class="empty-inline">Noch keine Leistungen erfasst.</div>'}
    </section>`;
  }

  function studentFullName(student) {
    return `<span class="student-name">${escapeHtml(student.lastName)}</span> <span class="student-last">${escapeHtml(student.firstName)}</span>`;
  }

  function isLowGrade(course, grade) {
    const value = Number(grade);
    return course.scale === "points" ? value <= 4 : value >= 4.5;
  }

  function renderStudents(course) {
    const query = studentFilter.trim().toLocaleLowerCase("de");
    const students = course.students.filter((student) => `${student.lastName} ${student.firstName}`.toLocaleLowerCase("de").includes(query));
    return `<section class="panel">
      <div class="panel-heading"><div><h3>Kursliste</h3><p>${course.students.length} Lernende · Namen bleiben nur in deinen App-Daten</p></div><div class="tool-row">
        <input class="search-input" id="student-search" type="search" placeholder="Name suchen…" value="${escapeHtml(studentFilter)}" aria-label="Lernende suchen">
        <button class="small-button" data-action="import-csv" type="button">CSV importieren</button><button class="small-button" data-action="add-student" type="button">+ Hinzufügen</button>
      </div></div>
      ${students.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Nachname</th><th>Vorname</th><th>Noten</th><th>Aktionen</th></tr></thead><tbody>${students.map((student) => {
        const grades = course.grades.filter((grade) => grade.studentId === student.id);
        return `<tr><td class="muted">${course.students.indexOf(student) + 1}</td><td class="student-name">${escapeHtml(student.lastName)}</td><td>${escapeHtml(student.firstName)}</td><td><span class="badge">${grades.length} ${grades.length === 1 ? "Eintrag" : "Einträge"}</span></td><td><div class="row-actions"><button class="small-button" data-action="edit-student" data-id="${escapeHtml(student.id)}" type="button">Bearbeiten</button><button class="small-button" data-action="student-grade" data-id="${escapeHtml(student.id)}" type="button">Note</button><button class="small-button danger" data-action="delete-student" data-id="${escapeHtml(student.id)}" type="button">Entfernen</button></div></td></tr>`;
      }).join("")}</tbody></table></div>` : `<div class="empty-inline"><strong>${course.students.length ? "Keine Treffer" : "Die Kursliste ist noch leer."}</strong>${course.students.length ? "Ändere den Suchbegriff." : "Füge Lernende einzeln hinzu oder importiere eine CSV-Datei."}</div>`}
    </section>`;
  }

  function renderGrades(course) {
    const tree = course.gradeTree || defaultGradeTree();
    const metrics = tree.children.flatMap((child) => gradeBookMetrics(child));
    const maxDepth = Math.max(0, ...tree.children.map((child) => gradeBookHeaderDepth(child)));
    const totalHeaderRows = maxDepth + 1;
    const headerRows = Array.from({ length: totalHeaderRows }, () => []);
    headerRows[0].push(`<th class="gradebook-student-heading" rowspan="${totalHeaderRows}">Lernende/r</th>`);
    headerRows[0].push(`<th class="gradebook-endnote-heading" rowspan="${totalHeaderRows}"><span>Endnote</span><small>Gewichtete Gesamtnote</small>${gradeBookRootActions(tree)}</th>`);
    tree.children.forEach((child) => appendGradeBookHeader(child, 0, totalHeaderRows, headerRows));
    const body = course.students.length
      ? course.students.map((student, index) => `<tr>
          <th class="gradebook-student" scope="row"><span class="student-index">${index + 1}</span><span>${studentFullName(student)}</span></th>
          <td class="gradebook-cell gradebook-total-cell"><span class="gradebook-average">${escapeHtml(formatGrade(course, calculateNodeAverage(course, tree, student.id), true))}</span></td>
          ${metrics.map((node) => {
            const value = calculateNodeAverage(course, node, student.id);
            if (node.kind === "column") {
              const grade = course.grades.find((item) => item.columnId === node.id && item.studentId === student.id);
              return `<td class="gradebook-cell ${grade ? "" : "gradebook-empty-cell"}"><button class="gradebook-value ${grade ? isLowGrade(course, grade.value) ? "low" : "has-grade" : "empty"}" data-action="edit-column-grades" data-id="${escapeHtml(node.id)}" type="button" aria-label="${escapeHtml(student.firstName)} ${escapeHtml(student.lastName)}: ${grade ? escapeHtml(formatGrade(course, Number(grade.value))) : "Note eintragen"}">${grade ? escapeHtml(formatGrade(course, Number(grade.value))) : "–"}</button></td>`;
            }
            return `<td class="gradebook-cell ${node.kind === "root" ? "gradebook-total-cell" : "gradebook-average-cell"}"><span class="gradebook-average">${escapeHtml(formatGrade(course, value, true))}</span></td>`;
          }).join("")}
        </tr>`).join("")
      : `<tr><td class="gradebook-no-students" colspan="${metrics.length + 2}">Im Kurs sind noch keine Lernenden eingetragen. <button class="small-button" data-action="add-student" type="button">+ Lernende hinzufügen</button></td></tr>`;
    const footer = course.students.length ? `<tfoot><tr><th class="gradebook-student">Kursmittel</th><td class="gradebook-cell gradebook-total-cell"><strong class="gradebook-average">${escapeHtml(classAverage(course))}</strong></td>${metrics.map((node) => {
      const values = course.students.map((student) => calculateNodeAverage(course, node, student.id)).filter((value) => value !== null);
      const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      return `<td class="gradebook-cell">${node.kind === "column"
        ? `<span class="gradebook-count">${course.grades.filter((grade) => grade.columnId === node.id).length}/${course.students.length}</span>`
        : `<strong class="gradebook-average">${escapeHtml(formatGrade(course, average, true))}</strong>`}</td>`;
    }).join("")}</tr></tfoot>` : "";
    return `<section class="panel gradebook-panel">
      <div class="panel-heading"><div><h3>Notenübersicht</h3><p>${course.students.length} Lernende · Gewichtete Zwischennoten und Einzelspalten · Klick auf ein Notenfeld zum Eintragen oder Ändern</p></div>
        <div class="tool-row"><button class="small-button" data-action="add-grade" type="button">+ Notenspalte</button><button class="small-button" data-action="add-student" type="button">+ Lernende</button></div>
      </div>
      <div class="gradebook-scroll"><table class="gradebook-table"><thead>${headerRows.map((row) => `<tr>${row.join("")}</tr>`).join("")}</thead><tbody>${body}</tbody>${footer}</table></div>
      <div class="gradebook-legend"><span><i class="legend-average"></i> Gewichtete Zwischen- und Endnote</span><span><i class="legend-entry"></i> Einzelbewertung · anklicken zum Bearbeiten</span><span>Fehlende Noten werden bei der Gewichtung ausgelassen.</span></div>
    </section>
    <details class="panel weight-settings">
      <summary><span><strong>Notenbaum & Gewichtungen</strong><small>Relative Gewichte jederzeit ändern, Halbjahre, Kategorien und Notenspalten verwalten</small></span><span class="weight-settings-arrow">⌄</span></summary>
      <div class="panel-content"><div class="grade-tree">${renderGradeNode(course, tree, 0)}</div>
        <div class="hint-box weight-hint"><strong>Berechnung:</strong> Gewichte sind relative Faktoren, keine Prozentwerte. Neue Notenspalten erhalten standardmäßig Gewicht 1; dadurch bleiben gleichwertige Noten auch beim Hinzufügen weiterer Spalten gleich gewichtet. Du kannst Kategorien unterschiedlich gewichten, z. B. Mitarbeit mit 6 und Klassenarbeiten mit 4. Nicht bewertete Einträge werden bei der Berechnung ausgelassen.</div>
      </div>
    </details>`;
  }

  function gradeBookMetrics(node) {
    return [node, ...(node.children || []).flatMap((child) => gradeBookMetrics(child))];
  }

  function gradeBookRootActions(node) {
    return `<button class="gradebook-add-button" data-action="add-semester" data-id="${escapeHtml(node.id)}" type="button">+ Halbjahr</button>`;
  }

  function gradeBookCategoryActions(node) {
    return `<span class="gradebook-heading-actions">
      <button class="gradebook-add-button" data-action="add-subcategory" data-id="${escapeHtml(node.id)}" type="button" title="Unterkategorie zu ${escapeHtml(node.name)} hinzufügen">+ Kategorie</button>
      <button class="gradebook-add-button" data-action="add-grade-column" data-id="${escapeHtml(node.id)}" type="button" title="Notenspalte zu ${escapeHtml(node.name)} hinzufügen">+ Note</button>
    </span>`;
  }

  function gradeBookColumnCount(node) {
    return 1 + (node.children || []).reduce((sum, child) => sum + gradeBookColumnCount(child), 0);
  }

  function gradeBookHeaderDepth(node, depth = 0) {
    if (node.kind === "column" || !node.children?.length) return depth;
    return Math.max(...node.children.map((child) => gradeBookHeaderDepth(child, depth + 1)));
  }

  function appendGradeBookHeader(node, depth, totalRows, rows) {
    if (node.kind === "column") {
      rows[depth].push(`<th class="gradebook-column-heading" rowspan="${totalRows - depth}"><span>${escapeHtml(node.name)}</span><small>${escapeHtml(node.date || "Notenspalte")} · Gewicht ${escapeHtml(formatWeight(node.weight))}×</small></th>`);
      return;
    }
    if (!node.children?.length) {
      rows[depth].push(`<th class="gradebook-column-heading empty-category-heading" rowspan="${totalRows - depth}"><span>Ø ${escapeHtml(node.name)}</span><small>Gewicht ${escapeHtml(formatWeight(node.weight))}× · noch leer</small>${gradeBookCategoryActions(node)}</th>`);
      return;
    }
    const count = gradeBookColumnCount(node);
    rows[depth].push(`<th class="gradebook-group-heading group-${node.kind}" colspan="${count}"><span>${escapeHtml(node.name)}</span><small>Gewicht ${escapeHtml(formatWeight(node.weight))}×</small>${gradeBookCategoryActions(node)}</th>`);
    rows[depth + 1].push(`<th class="gradebook-average-heading average-${node.kind}" rowspan="${totalRows - depth - 1}"><span>Ø ${escapeHtml(node.name)}</span><small>Gewicht ${escapeHtml(formatWeight(node.weight))}×</small></th>`);
    node.children.forEach((child) => appendGradeBookHeader(child, depth + 1, totalRows, rows));
  }

  function getGradeColumns(course, node = course.gradeTree) {
    if (!node) return [];
    if (node.kind === "column") return [node];
    return (node.children || []).flatMap((child) => getGradeColumns(course, child));
  }

  function getColumnParents(node, path = []) {
    const currentPath = [...path, node.name];
    const allowed = node.kind !== "root" && node.kind !== "column"
      ? [{ node, path: currentPath.join(" / ") }]
      : [];
    return allowed.concat((node.children || []).flatMap((child) => getColumnParents(child, currentPath)));
  }

  function openSemesterModal(course) {
    const number = course.gradeTree.children.filter((child) => child.kind === "semester").length + 1;
    openModal("Halbjahr hinzufügen", `<div class="field"><label for="semester-name">Bezeichnung *</label><input id="semester-name" name="name" required maxlength="60" value="${number}. Halbjahr"></div>
      <div class="hint-box">Das neue Halbjahr erhält zunächst Gewicht 1. Du kannst das Verhältnis zu den anderen Halbjahren danach im Notenbaum anpassen.</div>`, "Halbjahr hinzufügen", (formData) => {
      const name = String(formData.get("name") || "").trim();
      if (!name) return false;
      const semester = createNode(name, "semester", 1, [
        createNode("Arbeiten", "area", 1),
        createNode("Sonstige Mitarbeit", "area", 1, [
          createNode("Unterrichtsgespräch", "subcategory", 1),
          createNode("Sonstiges", "subcategory", 1)
        ])
      ]);
      course.gradeTree.children.push(semester);
      saveState();
      showToast("Halbjahr wurde hinzugefügt.");
    });
  }

  function openSubcategoryModal(course, parentId) {
    const parent = findNode(course.gradeTree, parentId);
    if (!parent || parent.kind === "column") return;
    openModal("Unterkategorie hinzufügen", `<div class="field"><label for="subcategory-name">Bezeichnung *</label><input id="subcategory-name" name="name" required maxlength="80" placeholder="z. B. Präsentationen"></div>
      <div class="hint-box">Die Unterkategorie wird unter „${escapeHtml(parent.name)}“ angelegt und erhält zunächst Gewicht 1. Darunter kannst du weitere Kategorien oder Notenspalten erfassen.</div>`, "Kategorie hinzufügen", (formData) => {
      const name = String(formData.get("name") || "").trim();
      if (!name) return false;
      parent.children.push(createNode(name, "subcategory", 1));
      saveState();
      showToast("Unterkategorie wurde hinzugefügt.");
    });
  }

  function openGradeColumnModal(course, parentId) {
    const parents = getColumnParents(course.gradeTree);
    if (!parents.length) {
      showToast("Lege zuerst ein Halbjahr an, damit Notenspalten zugeordnet werden können.");
      return;
    }
    const selectedParent = parents.find((item) => item.node.id === parentId) || parents[0];
    const parentOptions = parents.map(({ node, path }) => `<option value="${escapeHtml(node.id)}" ${node.id === selectedParent.node.id ? "selected" : ""}>${escapeHtml(path)}</option>`).join("");
    openModal("Notenspalte anlegen", `<div class="form-grid">
      <div class="field full"><label for="column-name">Bezeichnung *</label><input id="column-name" name="name" required maxlength="100" placeholder="z. B. Klassenarbeit 1 oder Vokabeltest 3"></div>
      <div class="field full"><label for="column-parent">Übergeordnete Kategorie *</label><select id="column-parent" name="parentId" required>${parentOptions}</select></div>
      <div class="field"><label for="column-date">Datum</label><input id="column-date" name="date" type="date" value="${today()}"></div>
      <div class="field"><label for="column-weight">Gewicht innerhalb der Kategorie</label><input id="column-weight" name="weight" type="number" min="0" step="0.1" value="1"></div>
      <div class="field full"><span class="field-hint">Standardgewicht 1: Neue gleichwertige Noten verändern das Gewicht bestehender Noten nicht. Für einzelne besonders wichtige Prüfungen kannst du den Faktor hier oder später im Notenbaum erhöhen.</span></div>
    </div>`, "Notenspalte anlegen", (formData) => {
      const name = String(formData.get("name") || "").trim();
      const parent = findNode(course.gradeTree, String(formData.get("parentId")));
      const weight = Number(formData.get("weight"));
      if (!name || !parent || !Number.isFinite(weight) || weight < 0) {
        showToast("Bitte eine Bezeichnung, Kategorie und ein gültiges Gewicht ab 0 angeben.");
        return false;
      }
      const column = createNode(name, "column", weight);
      column.date = String(formData.get("date") || "");
      parent.children.push(column);
      saveState();
      showToast("Notenspalte wurde angelegt.");
    });
    $("#column-parent").addEventListener("change", (event) => {
      const parent = findNode(course.gradeTree, event.target.value);
      if (parent) $("#column-weight").value = 1;
    });
  }

  function openColumnGradesModal(course, columnId) {
    const column = findNode(course.gradeTree, columnId);
    const parent = findParent(course.gradeTree, columnId);
    if (!column || column.kind !== "column" || !parent) return;
    if (!course.students.length) return showToast("Lege zuerst Lernende im Kurs an.");
    const rows = course.students.map((student) => {
      const grade = course.grades.find((item) => item.columnId === columnId && item.studentId === student.id);
      return `<label class="grade-entry-row"><span>${studentFullName(student)}</span>${gradeValueInput(course, `student-${student.id}`, grade ? grade.value : null, true)}</label>`;
    }).join("");
    openModal(`Noten: ${column.name}`, `<div class="grade-entry-list">${rows}</div><p class="field-hint">${course.scale === "points" ? "Notenpunkte als ganze Zahl von 0 bis 15 auswählen." : "Note eintippen oder Vorschlag wählen, z. B. 2+ oder 2-. Auf dem NumPad funktionieren + und − zum direkten Eingeben."} Leer lassen, wenn keine Note eingetragen werden soll.</p>`, "Noten speichern", (formData) => {
      const parsedGrades = new Map();
      for (const student of course.students) {
        const rawValue = String(formData.get(`student-${student.id}`) || "").trim();
        if (!rawValue) continue;
        const existing = course.grades.find((grade) => grade.columnId === columnId && grade.studentId === student.id);
        const parsed = parseGradeValue(course, rawValue, Boolean(existing?.legacyValue));
        if (!parsed) {
          showToast(course.scale === "points" ? "Notenpunkte müssen ganze Werte von 0 bis 15 sein." : "Bitte 1, 2+, 2- usw. eingeben oder einen Vorschlag auswählen.");
          return false;
        }
        parsedGrades.set(student.id, parsed);
      }
      for (const student of course.students) {
        const rawValue = String(formData.get(`student-${student.id}`) || "").trim();
        if (!rawValue) {
          course.grades = course.grades.filter((grade) => grade.columnId !== columnId || grade.studentId !== student.id);
          continue;
        }
        const { value, legacyValue } = parsedGrades.get(student.id);
        const existing = course.grades.find((grade) => grade.columnId === columnId && grade.studentId === student.id);
        const gradeData = {
          value, title: column.name, category: parent.name, date: column.date || today(),
          createdAt: new Date().toISOString(), legacyValue
        };
        if (existing) Object.assign(existing, gradeData);
        else course.grades.push({ id: uid(), columnId, studentId: student.id, ...gradeData });
      }
      activeTab = "grades";
      saveState();
      showToast("Noten wurden gespeichert.");
    });
  }

  function deleteGradeColumn(course, columnId) {
    const parent = findParent(course.gradeTree, columnId);
    const column = findNode(course.gradeTree, columnId);
    if (!parent || !column || !confirm(`Notenspalte „${column.name}“ und alle dazugehörigen Noten löschen?`)) return;
    parent.children = parent.children.filter((child) => child.id !== columnId);
    course.grades = course.grades.filter((grade) => grade.columnId !== columnId);
    saveState();
    showToast("Notenspalte und Noten wurden gelöscht.");
  }

  function findParent(node, childId) {
    for (const child of node.children || []) {
      if (child.id === childId) return node;
      const found = findParent(child, childId);
      if (found) return found;
    }
    return null;
  }

  const attendanceLabels = {
    present: "Anwesend",
    absent_excused: "Abwesend · entschuldigt",
    absent_unexcused: "Abwesend · unentschuldigt",
    sport_excused_inactive: "Entschuldigt inaktiv",
    sport_unexcused_inactive: "Unentschuldigt inaktiv"
  };

  function renderAttendance(course) {
    const records = course.attendance.flatMap((entry) => entry.records.map((record) => ({ ...record, date: entry.date, lesson: entry.lesson })))
      .sort((a, b) => `${b.date}${b.lesson}`.localeCompare(`${a.date}${a.lesson}`));
    return `<section class="panel">
      <div class="panel-heading"><div><h3>Anwesenheit & Abwesenheiten</h3><p>Erfasse Fehlzeiten pro Unterrichtsstunde; Sportstatus wird gesondert geführt.</p></div>
        <button class="small-button" data-action="attendance" type="button">+ Erfassung</button></div>
      <div class="panel-content">
        <div class="attendance-stat-row">
          <span class="status-pill excused">Entschuldigt: ${records.filter((item) => item.status === "absent_excused" || item.status === "sport_excused_inactive").length}</span>
          <span class="status-pill unexcused">Unentschuldigt: ${records.filter((item) => item.status === "absent_unexcused" || item.status === "sport_unexcused_inactive").length}</span>
          ${course.isSport ? `<span class="badge">Sportstatus getrennt erfasst</span>` : ""}
        </div>
      </div>
      ${records.length ? `<div class="table-wrap"><table><thead><tr><th>Datum</th><th>Stunde</th><th>Lernende/r</th><th>Status</th><th>Notiz</th><th></th></tr></thead><tbody>${records.map((record) => {
        const student = course.students.find((item) => item.id === record.studentId);
        const style = record.status.includes("unexcused") ? "unexcused" : record.status.includes("excused") ? "excused" : "present";
        return `<tr><td>${escapeHtml(record.date)}</td><td>${escapeHtml(record.lesson || "–")}</td><td>${student ? studentFullName(student) : '<span class="muted">Gelöscht</span>'}</td><td><span class="status-pill ${style}">${escapeHtml(attendanceLabels[record.status] || record.status)}</span></td><td>${escapeHtml(record.note || "–")}</td><td><button class="small-button danger" data-action="delete-attendance" data-id="${escapeHtml(record.id)}" type="button">Löschen</button></td></tr>`;
      }).join("")}</tbody></table></div>` : '<div class="empty-inline">Noch keine Anwesenheiten oder Fehlzeiten erfasst.</div>'}
    </section>
    <div class="hint-box" style="margin-top:14px"><strong>So funktioniert es:</strong> Fehlzeiten und Sport-Inaktivität werden als Unterrichtsereignisse mit Datum, Stunde und optionaler Notiz gespeichert. Für Sport stehen „entschuldigt inaktiv“ und „unentschuldigt inaktiv“ zusätzlich zur Verfügung.</div>`;
  }

  function bindCourseActions() {
    courseView.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => {
      activeTab = button.dataset.tab;
      render();
    }));
    courseView.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => handleAction(button.dataset.action, button.dataset.id)));
    const search = $("#student-search");
    if (search) search.addEventListener("input", () => {
      studentFilter = search.value;
      const cursor = search.selectionStart;
      render();
      const refreshed = $("#student-search");
      refreshed.focus();
      refreshed.setSelectionRange(cursor, cursor);
    });
    courseView.querySelectorAll("[data-weight-id]").forEach((input) => input.addEventListener("change", () => {
      const course = selectedClass();
      const node = course && findNode(course.gradeTree, input.dataset.weightId);
      const weight = Number(input.value);
      const settingsWereOpen = input.closest(".weight-settings")?.open;
      if (!node || !Number.isFinite(weight) || weight < 0) {
        showToast("Gewichte müssen gültige Werte ab 0 sein.");
        render();
        const settings = courseView.querySelector(".weight-settings");
        if (settings && settingsWereOpen) settings.open = true;
        return;
      }
      node.weight = weight;
      saveState();
      const settings = courseView.querySelector(".weight-settings");
      if (settings && settingsWereOpen) settings.open = true;
      showToast("Gewicht gespeichert.");
    }));
  }

  function handleAction(action, id) {
    const course = selectedClass();
    if (!course) return;
    if (action === "add-student") return openStudentModal(course);
    if (action === "edit-course") return openEditCourseModal(course);
    if (action === "edit-schedule") return openEditCourseModal(course);
    if (action === "delete-course") return deleteCourse(course);
    if (action === "add-grade") return openGradeColumnModal(course);
    if (action === "student-grade") return openGradeModal(course, id);
    if (action === "edit-student") return openEditStudentModal(course, id);
    if (action === "add-semester") return openSemesterModal(course);
    if (action === "add-subcategory") return openSubcategoryModal(course, id);
    if (action === "add-grade-column") return openGradeColumnModal(course, id);
    if (action === "edit-column-grades") return openColumnGradesModal(course, id);
    if (action === "attendance") return openAttendanceModal(course);
    if (action === "import-csv") return importStudentsCsv(course);
    if (action === "delete-student") return deleteStudent(course, id);
    if (action === "delete-grade") return deleteGrade(course, id);
    if (action === "delete-grade-column") return deleteGradeColumn(course, id);
    if (action === "delete-attendance") return deleteAttendance(course, id);
  }

  function openModal(title, fields, submitLabel, onSubmit) {
    $("#modal-title").textContent = title;
    modalFields.innerHTML = fields;
    $("#modal-submit").textContent = submitLabel || "Speichern";
    modalForm.onsubmit = (event) => {
      event.preventDefault();
      const formData = new FormData(modalForm);
      const result = onSubmit(formData);
      if (result === "continue") {
        const first = modalFields.querySelector("input:not([type=checkbox]), select, textarea");
        if (first) {
          first.focus();
          first.select?.();
        }
      } else if (result !== false) {
        modal.close();
      }
    };
    modal.showModal();
    const first = modalFields.querySelector("input:not([type=checkbox]), select, textarea");
    if (first) setTimeout(() => first.focus(), 0);
  }

  function openClassModal() {
    openModal("Neuen Kurs anlegen", `<div class="form-grid">
      <div class="field full"><label for="course-name">Kursname *</label><input id="course-name" name="name" required maxlength="80" placeholder="z. B. 10R2 Englisch"></div>
      <div class="field"><label for="course-subject">Fach</label><input id="course-subject" name="subject" maxlength="60" placeholder="Englisch"></div>
      <div class="field"><label for="course-year">Schuljahr / Jahrgang</label><input id="course-year" name="schoolYear" maxlength="30" placeholder="2026/27"></div>
      <div class="field"><label for="course-scale">Notensystem</label><select id="course-scale" name="scale"><option value="grades-plusminus" selected>Noten 1–6 mit +/−</option><option value="points">Notenpunkte 0–15</option></select></div>
      <div class="field full"><label class="toggle-row"><input type="checkbox" name="isSport"> Sportkurs (Sport-Inaktivität erfassen)</label></div>
      ${state.classes.length ? `<div class="field full"><button type="button" class="button button-quiet participant-picker-open">Teilnehmer aus anderen Kursen wählen…</button>
        <span class="field-hint participant-selection-summary">Noch keine Teilnehmer ausgewählt</span>
        <div class="participant-selection" hidden></div></div>` : ""}
    </div>`, "Kurs anlegen", (formData) => {
      const course = {
        id: uid(), name: String(formData.get("name")).trim(), subject: String(formData.get("subject") || "").trim(),
        schoolYear: String(formData.get("schoolYear") || "").trim(), scale: formData.get("scale") === "points" ? "points" : "grades-plusminus",
        isSport: formData.has("isSport"), students: [], grades: [], attendance: [], schedule: [], gradeTree: defaultGradeTree(),
        weightModel: "relative-v1"
      };
      if (!course.name) return false;
      const selectedParticipants = JSON.parse(modalFields.querySelector("[name='selectedParticipants']")?.value || "[]");
      for (const [sourceCourseId, studentId] of selectedParticipants) {
        const sourceCourse = state.classes.find((item) => item.id === sourceCourseId);
        const student = sourceCourse?.students.find((item) => item.id === studentId);
        if (student && !course.students.some((item) => item.firstName === student.firstName && item.lastName === student.lastName)) {
          course.students.push({ id: uid(), firstName: student.firstName, lastName: student.lastName, group: student.group || "" });
        }
      }
      state.classes.push(course);
      state.selectedClassId = course.id;
      activeTab = "grades";
      saveState();
      showToast("Kurs wurde angelegt.");
    });
    if (state.classes.length) bindParticipantPicker();
  }

  function bindParticipantPicker(options = {}) {
    const { excludeCourseId = null, onApply = null } = options;
    const picker = modalFields.querySelector(".participant-picker-open");
    const container = modalFields.querySelector(".participant-selection");
    const summary = modalFields.querySelector(".participant-selection-summary");
    if (!picker || !container || !summary) return;

    const sourceCourses = () => state.classes.filter((course) => course.id !== excludeCourseId);
    const selectedKeys = new Set();
    const participantKey = (courseId, studentId) => JSON.stringify([courseId, studentId]);
    const updateHiddenField = () => {
      const hidden = container.querySelector("[name='selectedParticipants']");
      if (hidden) hidden.value = JSON.stringify([...selectedKeys].map((key) => JSON.parse(key)));
    };
    picker.addEventListener("click", () => {
      const sourceOptions = sourceCourses().map((course) => `<option value="${escapeHtml(course.id)}">${escapeHtml(course.name)} (${course.students.length})</option>`).join("");
      container.hidden = false;
      container.innerHTML = `<div class="participant-picker-panel">
        <div class="field"><label for="participant-source">Quellkurs</label><select id="participant-source">${sourceOptions}</select></div>
        <div class="participant-picker-toolbar">
          <button type="button" class="small-button participant-select-all">Alle auswählen</button>
          <button type="button" class="small-button participant-select-none">Auswahl aufheben</button>
        </div>
        <div class="participant-picker-list"></div>
        <p class="field-hint">Die ausgewählten Lernenden werden kopiert. Noten und Anwesenheiten werden nicht übernommen.</p>
        ${onApply ? `<button type="button" class="button button-primary participant-picker-apply">Ausgewählte Teilnehmer übernehmen</button>` : `<input type="hidden" name="selectedParticipants" value="">`}
      </div>`;

      const sourceSelect = container.querySelector("#participant-source");
      const list = container.querySelector(".participant-picker-list");
      const applyButton = container.querySelector(".participant-picker-apply");
      const renderParticipants = () => {
        const source = sourceCourses().find((course) => course.id === sourceSelect.value);
        if (!source || !source.students.length) {
          list.innerHTML = '<p class="empty-inline">In diesem Kurs sind keine Lernenden eingetragen.</p>';
          updateSummary();
          return;
        }
        list.innerHTML = source.students.map((student) => `<label class="participant-option">
          <input type="checkbox" value="${escapeHtml(participantKey(source.id, student.id))}" ${selectedKeys.has(participantKey(source.id, student.id)) ? "checked" : ""}>
          <span>${escapeHtml(student.lastName)}, ${escapeHtml(student.firstName)}</span>
        </label>`).join("");
        list.querySelectorAll("input[type=checkbox]").forEach((checkbox) => checkbox.addEventListener("change", () => {
          if (checkbox.checked) selectedKeys.add(checkbox.value);
          else selectedKeys.delete(checkbox.value);
          updateSummary();
        }));
        updateSummary();
      };
      const updateSummary = () => {
        updateHiddenField();
        summary.textContent = selectedKeys.size
          ? `${selectedKeys.size} ${selectedKeys.size === 1 ? "Teilnehmer" : "Teilnehmer"} ausgewählt`
          : "Noch keine Teilnehmer ausgewählt";
        if (applyButton) applyButton.disabled = selectedKeys.size === 0;
      };
      sourceSelect.addEventListener("change", renderParticipants);
      container.querySelector(".participant-select-all").addEventListener("click", () => {
        const source = sourceCourses().find((course) => course.id === sourceSelect.value);
        (source?.students || []).forEach((student) => selectedKeys.add(participantKey(source.id, student.id)));
        renderParticipants();
      });
      container.querySelector(".participant-select-none").addEventListener("click", () => {
        const source = sourceCourses().find((course) => course.id === sourceSelect.value);
        (source?.students || []).forEach((student) => selectedKeys.delete(participantKey(source.id, student.id)));
        renderParticipants();
      });
      if (applyButton) {
        applyButton.addEventListener("click", () => {
          if (!selectedKeys.size) return;
          const pairs = [...selectedKeys].map((key) => JSON.parse(key));
          onApply(pairs);
          selectedKeys.clear();
          renderParticipants();
        });
      }
      renderParticipants();
    });
  }

  function scheduleRowHtml(entry = {}) {
    const days = [["1", "Montag"], ["2", "Dienstag"], ["3", "Mittwoch"], ["4", "Donnerstag"], ["5", "Freitag"]];
    return `<div class="schedule-entry-row" data-schedule-id="${escapeHtml(entry.id || "")}">
      <label><span>Wochentag</span><select data-schedule-day aria-label="Wochentag">${days.map(([value, label]) => `<option value="${value}" ${String(entry.day || 1) === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <label><span>Beginn</span><input data-schedule-start type="time" value="${escapeHtml(entry.start || "")}" aria-label="Beginn"></label>
      <label><span>Ende</span><input data-schedule-end type="time" value="${escapeHtml(entry.end || "")}" aria-label="Ende"></label>
      <label><span>Raum (optional)</span><input data-schedule-room maxlength="50" value="${escapeHtml(entry.room || "")}" placeholder="z. B. 653" aria-label="Raum (optional)"></label>
      <button class="small-button danger schedule-remove-button" data-remove-schedule type="button" aria-label="Unterrichtszeit entfernen">Entfernen</button>
    </div>`;
  }

  function openEditCourseModal(course) {
    const scheduleRows = (course.schedule || []).map((entry) => scheduleRowHtml(entry)).join("");
    openModal("Kurs bearbeiten", `<div class="form-grid">
      <div class="field full"><label for="course-name">Kursname *</label><input id="course-name" name="name" required maxlength="80" value="${escapeHtml(course.name)}"></div>
      <div class="field"><label for="course-subject">Fach</label><input id="course-subject" name="subject" maxlength="60" value="${escapeHtml(course.subject)}"></div>
      <div class="field"><label for="course-year">Schuljahr / Jahrgang</label><input id="course-year" name="schoolYear" maxlength="30" value="${escapeHtml(course.schoolYear)}"></div>
      <div class="field"><label for="course-scale">Notensystem</label><select id="course-scale" name="scale"><option value="grades-plusminus" ${course.scale !== "points" ? "selected" : ""}>Noten 1–6 mit +/−</option><option value="points" ${course.scale === "points" ? "selected" : ""}>Notenpunkte 0–15</option></select></div>
      <div class="field full"><label class="toggle-row"><input type="checkbox" name="isSport" ${course.isSport ? "checked" : ""}> Sportkurs (Sport-Inaktivität erfassen)</label></div>
      <fieldset class="field full course-schedule-editor"><legend>Stundenplan</legend>
        <p class="field-hint">Trage jede regelmäßige Unterrichtszeit dieses Kurses ein. Während dieser Zeit wird der Kurs beim Öffnen der App automatisch ausgewählt.</p>
        <div class="schedule-entry-list">${scheduleRows}</div>
        <button class="small-button" data-add-schedule type="button">+ Unterrichtszeit</button>
      </fieldset>
      <div class="field full"><button class="small-button danger" type="button" data-delete-course>Kurs mit allen Daten löschen</button></div>
    </div>`, "Änderungen speichern", (formData) => {
      const name = String(formData.get("name")).trim();
      if (!name) return false;
      const schedule = [...modalFields.querySelectorAll(".schedule-entry-row")].map((row) => ({
        id: row.dataset.scheduleId || uid(),
        day: Number(row.querySelector("[data-schedule-day]").value),
        start: row.querySelector("[data-schedule-start]").value,
        end: row.querySelector("[data-schedule-end]").value,
        room: row.querySelector("[data-schedule-room]").value.trim()
      }));
      if (schedule.some((entry) => !Number.isInteger(entry.day) || entry.day < 1 || entry.day > 5 ||
          !isValidScheduleTime(entry.start) || !isValidScheduleTime(entry.end) ||
          entry.start >= entry.end || entry.room.length > 50)) {
        showToast("Bitte bei jeder Unterrichtszeit einen Wochentag sowie gültige Beginn- und Endzeiten angeben.");
        return false;
      }
      const selectedScale = String(formData.get("scale"));
      const nextScale = selectedScale === "points" ? "points" : "grades-plusminus";
      if (nextScale !== course.scale && course.grades.length) {
        showToast("Das Notensystem kann nicht geändert werden, solange bereits Noten eingetragen sind.");
        return false;
      }
      course.name = name;
      course.subject = String(formData.get("subject") || "").trim();
      course.schoolYear = String(formData.get("schoolYear") || "").trim();
      course.scale = nextScale;
      course.isSport = formData.has("isSport");
      course.schedule = schedule;
      saveState();
      showToast("Kurseinstellungen wurden gespeichert.");
    });
    const scheduleList = modalFields.querySelector(".schedule-entry-list");
    modalFields.querySelector("[data-add-schedule]").addEventListener("click", () => {
      scheduleList.insertAdjacentHTML("beforeend", scheduleRowHtml());
      scheduleList.lastElementChild.querySelector("[data-schedule-start]").focus();
    });
    scheduleList.addEventListener("click", (event) => {
      const remove = event.target.closest("[data-remove-schedule]");
      if (remove) remove.closest(".schedule-entry-row").remove();
    });
    modalFields.querySelector("[data-delete-course]").addEventListener("click", () => {
      modal.close();
      deleteCourse(course);
    });
  }

  function deleteCourse(course) {
    if (!confirm(`Kurs „${course.name}“ und alle dazugehörigen Noten- und Anwesenheitseinträge löschen?`)) return;
    state.classes = state.classes.filter((item) => item.id !== course.id);
    state.selectedClassId = state.classes[0]?.id || null;
    activeTab = "grades";
    studentFilter = "";
    saveState();
    showToast("Kurs wurde gelöscht.");
  }

  function openStudentModal(course) {
    const otherCoursesExist = state.classes.some((item) => item.id !== course.id);
    openModal("Lernende hinzufügen", `<div class="form-grid">
      <div class="field"><label for="student-first">Vorname *</label><input id="student-first" name="firstName" required maxlength="60" autocomplete="off" enterkeyhint="next"></div>
      <div class="field"><label for="student-last">Nachname *</label><input id="student-last" name="lastName" required maxlength="60" autocomplete="off" enterkeyhint="done"></div>
      <div class="field full"><label for="student-group">Gruppe / Hinweise (optional)</label><input id="student-group" name="group" maxlength="80" placeholder="z. B. Tischgruppe 2"></div>
      <div class="field full"><span class="field-hint">Enter im Vornamen springt zum Nachnamen. Enter im Nachnamen speichert und startet den nächsten Eintrag.</span></div>
      ${otherCoursesExist ? `<div class="field full"><button type="button" class="button button-quiet participant-picker-open">Teilnehmer aus anderen Kursen wählen…</button>
        <span class="field-hint participant-selection-summary">Noch keine Teilnehmer ausgewählt</span>
        <div class="participant-selection" hidden></div></div>` : ""}
    </div>`, "Hinzufügen", (formData) => {
      const firstName = String(formData.get("firstName")).trim();
      const lastName = String(formData.get("lastName")).trim();
      if (!firstName || !lastName) return false;
      course.students.push({ id: uid(), firstName, lastName, group: String(formData.get("group") || "").trim() });
      saveState();
      showToast("Lernende/r wurde hinzugefügt.");
      modalFields.querySelector("#student-first").value = "";
      modalFields.querySelector("#student-last").value = "";
      modalFields.querySelector("#student-group").value = "";
      return "continue";
    });
    $("#student-first").addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      $("#student-last").focus();
    });
    if (otherCoursesExist) {
      bindParticipantPicker({
        excludeCourseId: course.id,
        onApply: (pairs) => {
          let added = 0;
          for (const [sourceCourseId, studentId] of pairs) {
            const sourceCourse = state.classes.find((item) => item.id === sourceCourseId);
            const student = sourceCourse?.students.find((item) => item.id === studentId);
            if (student && !course.students.some((item) => item.firstName === student.firstName && item.lastName === student.lastName)) {
              course.students.push({ id: uid(), firstName: student.firstName, lastName: student.lastName, group: student.group || "" });
              added += 1;
            }
          }
          if (added) {
            saveState();
            showToast(`${added} ${added === 1 ? "Lernende/r wurde übernommen" : "Lernende wurden übernommen"}.`);
          } else {
            showToast("Diese Lernenden sind bereits im Kurs enthalten.");
          }
        }
      });
    }
  }

  function openEditStudentModal(course, studentId) {
    const student = course.students.find((item) => item.id === studentId);
    if (!student) {
      showToast("Lernende/r wurde nicht gefunden.");
      return;
    }
    openModal("Stammdaten bearbeiten", `<div class="form-grid">
      <div class="field"><label for="student-first">Vorname *</label><input id="student-first" name="firstName" required maxlength="60" autocomplete="off" value="${escapeHtml(student.firstName)}"></div>
      <div class="field"><label for="student-last">Nachname *</label><input id="student-last" name="lastName" required maxlength="60" autocomplete="off" value="${escapeHtml(student.lastName)}"></div>
      <div class="field full"><label for="student-group">Gruppe / Hinweise (optional)</label><input id="student-group" name="group" maxlength="80" value="${escapeHtml(student.group || "")}"></div>
      <div class="field full"><span class="field-hint">Noten und Anwesenheiten bleiben erhalten und weiterhin mit diesem Lernenden verknüpft.</span></div>
    </div>`, "Stammdaten speichern", (formData) => {
      const firstName = String(formData.get("firstName") || "").trim();
      const lastName = String(formData.get("lastName") || "").trim();
      if (!firstName || !lastName) {
        showToast("Vor- und Nachname dürfen nicht leer sein.");
        return false;
      }
      student.firstName = firstName;
      student.lastName = lastName;
      student.group = String(formData.get("group") || "").trim();
      saveState();
      showToast("Stammdaten gespeichert.");
    });
  }

  function openGradeModal(course, studentId) {
    const columns = getGradeColumns(course);
    if (!course.students.length) return showToast("Lege zuerst Lernende im Kurs an.");
    if (!columns.length) return showToast("Lege zuerst im Notenbaum eine Notenspalte an.");
    const studentOptions = course.students.map((student) => `<option value="${escapeHtml(student.id)}" ${student.id === studentId ? "selected" : ""}>${escapeHtml(student.lastName)}, ${escapeHtml(student.firstName)}</option>`).join("");
    const columnOptions = columns.map((column) => `<option value="${escapeHtml(column.id)}">${escapeHtml(column.name)}</option>`).join("");
    openModal("Einzelnote eintragen", `<div class="form-grid">
      <div class="field full"><label for="grade-student">Lernende/r *</label><select id="grade-student" name="studentId" required>${studentOptions}</select></div>
      <div class="field full"><label for="grade-column">Notenspalte *</label><select id="grade-column" name="columnId" required>${columnOptions}</select></div>
      <div class="field full"><label for="grade-value">Note *</label>${gradeValueInput(course, "value")}<span class="field-hint">${course.scale === "points" ? "Notenpunkte von 0 bis 15" : "Direkt eintippen oder Vorschlag wählen, z. B. 2+ = 1,7 oder 2- = 2,3."}</span></div>
    </div>`, "Note speichern", (formData) => {
      const columnId = String(formData.get("columnId"));
      const studentIdValue = String(formData.get("studentId"));
      const column = findNode(course.gradeTree, columnId);
      const parent = findParent(course.gradeTree, columnId);
      if (!column || !parent) return false;
      const existing = course.grades.find((grade) => grade.columnId === columnId && grade.studentId === studentIdValue);
      const parsed = parseGradeValue(course, formData.get("value"), Boolean(existing?.legacyValue));
      if (!parsed) {
        showToast(course.scale === "points" ? "Bitte ganze Notenpunkte von 0 bis 15 eingeben." : "Bitte eine gültige Note eingeben, z. B. 2+ oder 2-.");
        return false;
      }
      const gradeData = {
        value: parsed.value, title: column.name, category: parent.name, date: column.date || today(),
        createdAt: new Date().toISOString(), legacyValue: parsed.legacyValue
      };
      if (existing) Object.assign(existing, gradeData);
      else course.grades.push({ id: uid(), columnId, studentId: studentIdValue, ...gradeData });
      activeTab = "grades";
      saveState();
      showToast(existing ? "Note wurde aktualisiert." : "Note wurde gespeichert.");
    });
  }

  function openAttendanceModal(course) {
    if (!course.students.length) {
      showToast("Lege zuerst Lernende im Kurs an.");
      activeTab = "students";
      render();
      return;
    }
    const options = course.students.map((student) => `<option value="${escapeHtml(student.id)}">${escapeHtml(student.lastName)}, ${escapeHtml(student.firstName)}</option>`).join("");
    const statuses = [
      ["absent_excused", "Abwesend · entschuldigt"],
      ["absent_unexcused", "Abwesend · unentschuldigt"],
      ...(course.isSport ? [["sport_excused_inactive", "Entschuldigt inaktiv"], ["sport_unexcused_inactive", "Unentschuldigt inaktiv"]] : [])
    ];
    openModal("Anwesenheit erfassen", `<div class="form-grid">
      <div class="field"><label for="attendance-date">Datum *</label><input id="attendance-date" name="date" type="date" required value="${today()}"></div>
      <div class="field"><label for="attendance-lesson">Stunde</label><input id="attendance-lesson" name="lesson" maxlength="30" placeholder="z. B. 3. Stunde"></div>
      <div class="field full"><label for="attendance-student">Lernende/r *</label><select id="attendance-student" name="studentId" required>${options}</select></div>
      <div class="field full"><label for="attendance-status">Status *</label><select id="attendance-status" name="status" required>${statuses.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></div>
      <div class="field full"><label for="attendance-note">Notiz (optional)</label><textarea id="attendance-note" name="note" maxlength="300" placeholder="Kurzer Hinweis, z. B. Entschuldigung liegt vor"></textarea><span class="field-hint">Keine sensiblen Gesundheitsdetails eintragen.</span></div>
    </div>`, "Eintrag speichern", (formData) => {
      const date = String(formData.get("date"));
      const status = String(formData.get("status"));
      if (!date || !attendanceLabels[status] || (status.startsWith("sport_") && !course.isSport)) return false;
      let entry = course.attendance.find((item) => item.date === date && item.lesson === String(formData.get("lesson") || "").trim());
      if (!entry) {
        entry = { id: uid(), date, lesson: String(formData.get("lesson") || "").trim(), records: [] };
        course.attendance.push(entry);
      }
      const studentId = String(formData.get("studentId"));
      const existing = entry.records.find((record) => record.studentId === studentId);
      const record = { id: existing ? existing.id : uid(), studentId, status, note: String(formData.get("note") || "").trim() };
      if (existing) Object.assign(existing, record);
      else entry.records.push(record);
      activeTab = "attendance";
      saveState();
      showToast(existing ? "Eintrag wurde aktualisiert." : "Anwesenheit wurde gespeichert.");
    });
  }

  function deleteStudent(course, studentId) {
    const student = course.students.find((item) => item.id === studentId);
    if (!student || !confirm(`${student.firstName} ${student.lastName} und alle zugehörigen Noten- und Anwesenheitseinträge entfernen?`)) return;
    course.students = course.students.filter((item) => item.id !== studentId);
    course.grades = course.grades.filter((grade) => grade.studentId !== studentId);
    course.attendance.forEach((entry) => { entry.records = entry.records.filter((record) => record.studentId !== studentId); });
    course.attendance = course.attendance.filter((entry) => entry.records.length);
    saveState();
    showToast("Lernende/r und verbundene Einträge wurden entfernt.");
  }

  function deleteGrade(course, gradeId) {
    if (!confirm("Diesen Noteneintrag wirklich löschen?")) return;
    course.grades = course.grades.filter((grade) => grade.id !== gradeId);
    saveState();
    showToast("Noteneintrag wurde gelöscht.");
  }

  function deleteAttendance(course, recordId) {
    if (!confirm("Diesen Anwesenheitseintrag wirklich löschen?")) return;
    course.attendance.forEach((entry) => { entry.records = entry.records.filter((record) => record.id !== recordId); });
    course.attendance = course.attendance.filter((entry) => entry.records.length);
    saveState();
    showToast("Anwesenheitseintrag wurde gelöscht.");
  }

  function importStudentsCsv(course) {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = ".csv,text/csv";
    picker.addEventListener("change", async () => {
      const file = picker.files && picker.files[0];
      if (!file) return;
      try {
        const text = (await file.text()).replace(/^\uFEFF/, "");
        const lines = text.split(/\r?\n/).filter((line) => line.trim());
        if (lines.length < 2) throw new Error("Die CSV-Datei enthält keine Lernenden.");
        const delimiter = lines[0].includes(";") ? ";" : ",";
        const header = parseCsvLine(lines[0], delimiter).map((part) => part.trim().toLocaleLowerCase("de"));
        const firstIndex = header.findIndex((item) => ["vorname", "firstname", "first name"].includes(item));
        const lastIndex = header.findIndex((item) => ["nachname", "lastname", "last name", "familienname"].includes(item));
        if (firstIndex < 0 || lastIndex < 0) throw new Error("Die Kopfzeile braucht die Spalten „Vorname“ und „Nachname“.");
        const newStudents = lines.slice(1).map((line) => parseCsvLine(line, delimiter)).filter((columns) => columns[firstIndex] && columns[lastIndex])
          .map((columns) => ({ id: uid(), firstName: columns[firstIndex].trim(), lastName: columns[lastIndex].trim(), group: "" }));
        if (!newStudents.length) throw new Error("Keine gültigen Lernendennamen in der CSV gefunden.");
        if (!confirm(`${newStudents.length} Lernende importieren? Vorhandene Einträge bleiben erhalten.`)) return;
        course.students.push(...newStudents);
        saveState();
        showToast(`${newStudents.length} Lernende importiert.`);
      } catch (error) {
        console.error("CSV-Import fehlgeschlagen.", error);
        showToast(error.message || "CSV-Datei konnte nicht eingelesen werden.");
      }
    });
    picker.click();
  }

  function parseCsvLine(line, delimiter) {
    const result = [];
    let value = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"' && quoted && line[i + 1] === '"') { value += '"'; i += 1; }
      else if (char === '"') quoted = !quoted;
      else if (char === delimiter && !quoted) { result.push(value); value = ""; }
      else value += char;
    }
    result.push(value);
    return result;
  }

  function backupFileName() {
    return `Klassenblick-Sicherung-${new Date().toISOString().replace(/[:.]/g, "-")}-${uid()}.json`;
  }

  function exportData() {
    if (storageRecoveryError) {
      showToast("Zum Schutz der vorhandenen Daten ist eine Sicherung des leeren App-Zustands gesperrt.");
      return;
    }
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = backupFileName();
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("Sicherung heruntergeladen. Lege sie in „Beispiele und Notensicherung“ ab.");
  }

  async function saveBackup() {
    if (storageRecoveryError) {
      showToast("Zum Schutz der vorhandenen Daten ist eine Sicherung des leeren App-Zustands gesperrt.");
      return;
    }
    try {
      if ("showDirectoryPicker" in window && window.isSecureContext) {
        let directoryHandle = backupDirectoryHandle;
        if (!directoryHandle) {
          directoryHandle = await window.showDirectoryPicker({
            id: "klassenblick-backup-directory",
            mode: "readwrite"
          });
        }
        let permission = await directoryHandle.queryPermission({ mode: "readwrite" });
        if (permission !== "granted") {
          permission = await directoryHandle.requestPermission({ mode: "readwrite" });
        }
        if (permission !== "granted") throw new Error("Schreibberechtigung für den Sicherungsordner fehlt.");

        const newFileHandle = await directoryHandle.getFileHandle(backupFileName(), { create: true });
        await writeFileHandle(newFileHandle);
        await saveHandle(directoryHandle, "backupDirectory");
        await saveHandle(newFileHandle);
        backupDirectoryHandle = directoryHandle;
        fileHandle = newFileHandle;
        oneDrivePermissionGranted = true;
      } else if ("showSaveFilePicker" in window && window.isSecureContext) {
        const previousFileHandle = fileHandle;
        const previousPermission = oneDrivePermissionGranted;
        try {
          fileHandle = await window.showSaveFilePicker({
            suggestedName: backupFileName(),
            ...(backupDirectoryHandle ? { startIn: backupDirectoryHandle } : {}),
            types: [{ description: "Klassenblick-Sicherung", accept: { "application/json": [".json"] } }]
          });
          await writeConnectedFile();
          await saveHandle(fileHandle);
        } catch (error) {
          fileHandle = previousFileHandle;
          oneDrivePermissionGranted = previousPermission;
          updateSaveIndicator();
          updateStorageWarning();
          throw error;
        }
      } else {
        exportData();
        return;
      }
      updateSaveIndicator();
      updateStorageWarning();
      showToast("Neue Sicherung im gewählten Ordner gespeichert; Änderungen werden dort weiter gesichert.");
    } catch (error) {
      if (error.name !== "AbortError") {
        console.error("Sicherungsdatei konnte nicht gespeichert werden.", error);
        showToast(error.message || "Sicherungsdatei konnte nicht gespeichert werden.");
      }
    }
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (isGradeSupplement(data)) {
          applyGradeSupplement(data);
          return;
        }
        const imported = migrateState(data);
        validateImport(imported);
        if (!confirm("Die aktuellen App-Daten vollständig durch die Inhalte der Sicherungsdatei ersetzen? Exportiere zuerst eine Sicherung, wenn du den jetzigen Stand behalten möchtest.")) return;
        const previousState = state;
        const previousRecoveryError = storageRecoveryError;
        state = imported;
        if (!state.classes.some((course) => course.id === state.selectedClassId)) state.selectedClassId = state.classes[0]?.id || null;
        activeTab = "grades";
        studentFilter = "";
        storageRecoveryError = null;
        try {
          saveState();
        } catch (saveError) {
          state = previousState;
          storageRecoveryError = previousRecoveryError;
          updateStorageWarning();
          throw saveError;
        }
        updateStorageWarning();
        showToast("Sicherungsdatei wurde geöffnet.");
      } catch (error) {
        console.error("Importdatei konnte nicht geladen werden.", error);
        showToast(error.message || "Datei ist ungültig oder kein Klassenblick-Backup.");
      }
    };
    reader.onerror = () => showToast("Datei konnte nicht gelesen werden.");
    reader.readAsText(file);
  }

  function isGradeSupplement(data) {
    return Boolean(data && data.kind === "klassenblick-grade-supplement");
  }

  function normalizeMatchText(value) {
    return String(value || "").normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("de");
  }

  function applyGradeSupplement(supplement) {
    if (supplement.version !== 1 || !Array.isArray(supplement.courseNames) ||
        !supplement.courseNames.length || supplement.courseNames.some((name) => typeof name !== "string") ||
        !Array.isArray(supplement.columns) || !supplement.columns.length ||
        supplement.columns.some((name) => typeof name !== "string") || !Array.isArray(supplement.entries) ||
        supplement.entries.some((entry) => !entry || typeof entry.firstName !== "string" ||
          typeof entry.lastName !== "string" || !entry.grades || typeof entry.grades !== "object" ||
          Array.isArray(entry.grades))) {
      throw new Error("Der Notennachtrag hat ein ungültiges Format. Es wurden keine Daten geändert.");
    }

    const courseNames = new Set(supplement.courseNames.map(normalizeMatchText));
    const matches = state.classes.filter((course) => courseNames.has(normalizeMatchText(course.name)));
    if (matches.length !== 1) {
      throw new Error(matches.length
        ? "Mehrere Kurse passen zum Notennachtrag. Es wurden keine Daten geändert."
        : `Kein passender Kurs gefunden (${supplement.courseNames.join(" / ")}). Es wurden keine Daten geändert.`);
    }
    const course = matches[0];
    const columns = new Map();
    for (const name of supplement.columns) {
      const matchesByName = getGradeColumns(course).filter((column) => normalizeMatchText(column.name) === normalizeMatchText(name));
      if (matchesByName.length !== 1) {
        throw new Error(`Die Notenspalte „${name}“ fehlt oder ist nicht eindeutig. Es wurden keine Daten geändert.`);
      }
      columns.set(name, matchesByName[0]);
    }

    const staged = [];
    const seen = new Set();
    let skippedExisting = 0;
    for (const entry of supplement.entries) {
      const students = course.students.filter((student) =>
        normalizeMatchText(student.firstName) === normalizeMatchText(entry.firstName) &&
        normalizeMatchText(student.lastName) === normalizeMatchText(entry.lastName));
      if (students.length !== 1) {
        throw new Error(`Lernende/r „${entry.firstName} ${entry.lastName}“ fehlt oder ist nicht eindeutig. Es wurden keine Daten geändert.`);
      }
      const student = students[0];
      for (const [columnName, rawValue] of Object.entries(entry.grades)) {
        if (!columns.has(columnName) || typeof rawValue !== "string" || !rawValue.trim()) {
          throw new Error(`Ungültige Note oder Spalte bei „${entry.firstName} ${entry.lastName}“. Es wurden keine Daten geändert.`);
        }
        const column = columns.get(columnName);
        const key = `${student.id}|${column.id}`;
        if (seen.has(key)) {
          throw new Error("Der Notennachtrag enthält doppelte Einträge. Es wurden keine Daten geändert.");
        }
        seen.add(key);
        const parsed = parseGradeValue(course, rawValue, false);
        if (!parsed) {
          throw new Error(`„${rawValue}“ ist keine gültige Note für „${entry.firstName} ${entry.lastName}“. Es wurden keine Daten geändert.`);
        }
        const existing = course.grades.find((grade) => grade.studentId === student.id && grade.columnId === column.id);
        if (existing) {
          skippedExisting += 1;
          continue;
        }
        staged.push({ student, column, ...parsed });
      }
    }
    if (!staged.length) {
      showToast(`Keine neuen Noten ergänzt. ${skippedExisting} bereits vorhandene Einträge blieben unverändert.`);
      return;
    }
    if (!confirm(`${staged.length} Noten für „${course.name}“ ergänzen? Vorhandene Noten und alle übrigen Daten bleiben unverändert.`)) return;

    for (const item of staged) {
      const parent = findParent(course.gradeTree, item.column.id);
      course.grades.push({
        id: uid(),
        columnId: item.column.id,
        studentId: item.student.id,
        value: item.value,
        title: item.column.name,
        category: parent?.name || "",
        date: item.column.date || today(),
        createdAt: new Date().toISOString(),
        legacyValue: item.legacyValue
      });
    }
    state.selectedClassId = course.id;
    activeTab = "grades";
    showingSchedule = false;
    saveState();
    showToast(`${staged.length} Noten ergänzt; ${skippedExisting} vorhandene Einträge unverändert gelassen.`);
  }

  function validateImport(data) {
    if (!data || data.version !== 2 || !Array.isArray(data.classes) ||
    (data.selectedClassId !== null && data.selectedClassId !== undefined && typeof data.selectedClassId !== "string")) {
      throw new Error("Ungültige Sicherungsdatei.");
    }
    const ids = new Set();
    for (const course of data.classes) {
      if (!course || typeof course.id !== "string" || !course.id || typeof course.name !== "string" || !course.name ||
          !Array.isArray(course.students) || !Array.isArray(course.grades) || !Array.isArray(course.attendance) ||
          !Array.isArray(course.schedule) || course.schedule.some((slot) => !slot || typeof slot.id !== "string" || !slot.id ||
            !Number.isInteger(slot.day) || slot.day < 1 || slot.day > 5 ||
            !isValidScheduleTime(slot.start) || !isValidScheduleTime(slot.end) || slot.start >= slot.end ||
            typeof slot.room !== "string" || slot.room.length > 50) ||
          !["grades", "grades-plusminus", "points"].includes(course.scale) || typeof course.isSport !== "boolean" ||
          course.weightModel !== "relative-v1" ||
          !course.gradeTree || !validateGradeNode(course.gradeTree, "root")) {
        throw new Error("Die Sicherungsdatei enthält einen unvollständigen Kurs.");
      }
      if (ids.has(course.id)) throw new Error("Die Sicherungsdatei enthält doppelte Kurskennungen.");
      ids.add(course.id);
      if (course.students.some((student) => !student || typeof student.id !== "string" ||
          typeof student.firstName !== "string" || typeof student.lastName !== "string")) {
        throw new Error("Die Sicherungsdatei enthält ungültige Lernendendaten.");
      }
      if (course.grades.some((grade) => !grade || typeof grade.id !== "string" ||
          typeof grade.studentId !== "string" || typeof grade.title !== "string" ||
          typeof grade.columnId !== "string" || !Number.isFinite(Number(grade.value)) ||
          !isAllowedGradeValue(course, Number(grade.value), Boolean(grade.legacyValue)) ||
          !findNode(course.gradeTree, grade.columnId) || findNode(course.gradeTree, grade.columnId).kind !== "column")) {
        throw new Error("Die Sicherungsdatei enthält ungültige Leistungsdaten.");
      }
      if (course.attendance.some((entry) => !entry || typeof entry.id !== "string" ||
          typeof entry.date !== "string" || !Array.isArray(entry.records) ||
          entry.records.some((record) => !record || typeof record.id !== "string" ||
            typeof record.studentId !== "string" || !attendanceLabels[record.status] ||
            (record.status.startsWith("sport_") && !course.isSport)))) {
        throw new Error("Die Sicherungsdatei enthält ungültige Anwesenheitsdaten.");
      }
    }

    function validateGradeNode(node, expectedKind) {
      if (!node || typeof node.id !== "string" || !node.id || typeof node.name !== "string" ||
          node.kind !== expectedKind || !Number.isFinite(Number(node.weight)) || Number(node.weight) < 0) return false;
      if (node.kind === "column") return !Array.isArray(node.children) || node.children.length === 0;
      if (!Array.isArray(node.children)) return false;
      const allowedChildren = node.kind === "root" ? ["semester"]
        : node.kind === "semester" ? ["area", "subcategory", "column"]
          : node.kind === "area" || node.kind === "subcategory" ? ["subcategory", "column"]
            : null;
      return Boolean(allowedChildren) && node.children.every((child) =>
        allowedChildren.includes(child?.kind) && validateGradeNode(child, child.kind));
    }
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE);
        if (!request.result.objectStoreNames.contains(BACKUP_STORE)) request.result.createObjectStore(BACKUP_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getAutomaticBackups() {
    const db = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(BACKUP_STORE, "readonly");
        const store = tx.objectStore(BACKUP_STORE);
        const keysRequest = store.getAllKeys();
        const valuesRequest = store.getAll();
        tx.oncomplete = () => resolve(keysRequest.result.flatMap((key, index) => {
          const raw = valuesRequest.result[index];
          if (typeof raw !== "string") return [];
          const priority = key === "latest" ? 3 : key === "previous" ? 2 : String(key).startsWith("history-") ? 1 : 0;
          return priority ? [{ raw, priority }] : [];
        }));
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("Automatische Sicherung konnte nicht gelesen werden."));
      });
    } finally {
      db.close();
    }
  }

  async function persistAutomaticBackup(data) {
    const snapshot = JSON.stringify(data);
    const db = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(BACKUP_STORE, "readwrite");
        const store = tx.objectStore(BACKUP_STORE);
        const latestRequest = store.get("latest");
        const keysRequest = store.getAllKeys();
        latestRequest.onsuccess = () => {
          if (latestRequest.result && latestRequest.result !== snapshot) {
            store.put(latestRequest.result, "previous");
            store.put(latestRequest.result, `history-${Date.now()}-${uid()}`);
          }
          store.put(snapshot, "latest");
        };
        keysRequest.onsuccess = () => {
          const historyKeys = keysRequest.result.filter((key) => String(key).startsWith("history-")).map(String).sort();
          historyKeys.slice(0, Math.max(0, historyKeys.length - 24)).forEach((key) => store.delete(key));
        };
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("Automatische Sicherung konnte nicht gespeichert werden."));
      });
      persistenceWarning = "";
      updateStorageWarning();
    } finally {
      db.close();
    }
  }

  function updateStorageWarning() {
    const warning = $("#storage-warning");
    if (!warning) return;
    const message = storageRecoveryError || persistenceWarning || (!oneDrivePermissionGranted ? storagePolicyWarning : "");
    warning.hidden = !message;
    warning.textContent = message || "";
    warning.classList.toggle("storage-recovery-error", Boolean(storageRecoveryError));
    $("#add-class-button").disabled = Boolean(storageRecoveryError);
    $("#first-class-button").disabled = Boolean(storageRecoveryError);
    $("#export-button").disabled = Boolean(storageRecoveryError);
  }

  function updateSaveIndicator() {
    const indicator = $("#save-indicator");
    if (cloud.isConnected()) {
      indicator.lastChild.textContent = ` ${cloudStatus}`;
      indicator.title = "Die Daten werden mit der Datei klassenblick-daten.json im OneDrive-App-Ordner abgeglichen.";
      return;
    }
    indicator.lastChild.textContent = oneDrivePermissionGranted ? " Sicherungsdatei verbunden" : " Nur auf diesem Gerät";
    indicator.title = oneDrivePermissionGranted
      ? "Änderungen werden zusätzlich in die verbundene Sicherungsdatei geschrieben."
      : "Zusatzsicherungen liegen im Browserprofil dieses Geräts. Speichere regelmäßig eine JSON-Sicherung in OneDrive.";
  }

  function updateCloudUi() {
    const connected = cloud.isConnected();
    const button = $("#cloud-button");
    button.textContent = connected ? "OneDrive abgleichen" : "Mit OneDrive verbinden";
    $("#cloud-disconnect-button").hidden = !connected;
    updateSaveIndicator();
  }

  async function adoptRemoteState(remote) {
    const imported = migrateState(JSON.parse(remote.text));
    validateImport(imported);
    if (!imported.classes.some((course) => course.id === imported.selectedClassId)) imported.selectedClassId = imported.classes[0]?.id || null;
    imported.updatedAt = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(imported));
    await persistAutomaticBackup(imported);
    state = imported;
    cloud.setMeta({ etag: remote.etag, syncedUpdatedAt: state.updatedAt });
    render();
  }

  async function pushToCloud(etag) {
    if (!state.classes.length && etag) throw new Error("Ein leerer Datenstand überschreibt keine vorhandenen OneDrive-Daten.");
    const result = await cloud.upload(JSON.stringify(state, null, 2), etag);
    cloud.setMeta({ etag: result.etag, syncedUpdatedAt: state.updatedAt });
  }

  function formatSyncDate(value) {
    const time = Date.parse(value || "");
    return Number.isNaN(time) ? "unbekannt" : new Date(time).toLocaleString("de-DE");
  }

  async function resolveCloudConflict(remote) {
    let remoteUpdatedAt = "";
    try { remoteUpdatedAt = JSON.parse(remote.text).updatedAt; } catch (error) { /* ungültiger Stand wird beim Laden gemeldet */ }
    const useRemote = confirm(
      `OneDrive und dieses Gerät haben unterschiedliche Datenstände.\n\nOneDrive: ${formatSyncDate(remoteUpdatedAt)}\nDieses Gerät: ${formatSyncDate(state.updatedAt)}\n\n` +
      "OK: OneDrive-Stand übernehmen (der Stand dieses Geräts wird vorher als Sicherungsdatei heruntergeladen).\n" +
      "Abbrechen: weitere Optionen.");
    if (useRemote) {
      exportData();
      await adoptRemoteState(remote);
      return;
    }
    if (confirm("OneDrive-Stand stattdessen mit dem Stand dieses Geräts überschreiben?\n\nDer bisherige OneDrive-Stand bleibt im OneDrive-Versionsverlauf der Datei erhalten.\n\nAbbrechen: nichts ändern und den Abgleich pausieren.")) {
      await pushToCloud(remote.etag);
      return;
    }
    cloudPaused = true;
    cloudStatus = "Abgleich pausiert";
  }

  async function syncCloud() {
    if (!cloud.isConnected() || storageRecoveryError) return;
    if (cloudBusy) { cloudDirty = true; return; }
    cloudBusy = true;
    cloudDirty = false;
    try {
      if (cloudPaused) { cloudStatus = "Abgleich pausiert"; return; }
      cloudStatus = "Abgleich läuft …";
      updateSaveIndicator();
      const meta = cloud.getMeta();
      const remote = await cloud.download();
      const localChanged = meta.syncedUpdatedAt !== state.updatedAt;
      if (!remote.exists) {
        if (state.classes.length) await pushToCloud(null);
      } else if (remote.etag === meta.etag) {
        if (localChanged) await pushToCloud(remote.etag);
      } else {
        let remoteUpdatedAt = null;
        try { remoteUpdatedAt = JSON.parse(remote.text).updatedAt; } catch (error) { /* siehe Validierung beim Übernehmen */ }
        if (remoteUpdatedAt && remoteUpdatedAt === state.updatedAt) {
          cloud.setMeta({ etag: remote.etag, syncedUpdatedAt: state.updatedAt });
        } else if (!state.classes.length || (meta.etag && !localChanged)) {
          await adoptRemoteState(remote);
        } else {
          await resolveCloudConflict(remote);
        }
      }
      if (!cloudPaused) cloudStatus = `Mit OneDrive abgeglichen (${new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })})`;
      persistenceWarning = persistenceWarning === CLOUD_ERROR_TEXT ? "" : persistenceWarning;
    } catch (error) {
      if (error instanceof cloud.ConflictError) {
        cloudDirty = true;
      } else {
        console.error("OneDrive-Abgleich fehlgeschlagen.", error);
        cloudStatus = "OneDrive nicht erreichbar";
        persistenceWarning = CLOUD_ERROR_TEXT;
      }
    } finally {
      cloudBusy = false;
      updateSaveIndicator();
      updateStorageWarning();
      if (cloudDirty && !cloudPaused) scheduleCloudSync(500);
    }
  }

  function scheduleCloudSync(delay = 1500) {
    if (!cloud.isConnected()) return;
    clearTimeout(cloudTimer);
    cloudTimer = setTimeout(syncCloud, delay);
  }

  async function handleCloudButton() {
    if (!cloud.isConfigured()) {
      showToast("OneDrive-Sync ist noch nicht eingerichtet: Client-ID in config.js eintragen (siehe README).");
      return;
    }
    if (!cloud.isConnected()) {
      try { await cloud.login(); } catch (error) { showToast(error.message); }
      return;
    }
    cloudPaused = false;
    await syncCloud();
    showToast(cloudStatus);
  }

  function disconnectCloud() {
    if (!confirm("Die Verbindung zu OneDrive auf diesem Gerät trennen? Die Daten in OneDrive und auf diesem Gerät bleiben erhalten.")) return;
    cloud.logout();
    cloudPaused = false;
    cloudStatus = "Nur auf diesem Gerät";
    persistenceWarning = persistenceWarning === CLOUD_ERROR_TEXT ? "" : persistenceWarning;
    updateCloudUi();
    updateStorageWarning();
  }

  async function requestPersistentStorage() {
    if (!navigator.storage?.persist || !navigator.storage?.persisted) {
      storagePolicyWarning = "Der Browser kann dauerhaften Schutz vor automatischer Speicherbereinigung nicht bestätigen. Bitte zusätzlich regelmäßig eine JSON-Sicherung in OneDrive speichern.";
      return;
    }
    if (await navigator.storage.persisted()) return;
    if (await navigator.storage.persist()) return;
    storagePolicyWarning = "Der Browser hat dauerhaften Schutz für den lokalen Speicher nicht gewährt. Bitte nach jeder Arbeitssitzung eine JSON-Sicherung in OneDrive speichern.";
  }

  async function saveHandle(handle, key = "oneDriveFile") {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(handle, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  async function getHandle(key = "oneDriveFile") {
    if (!("indexedDB" in window)) return null;
    const db = await openDatabase();
    const handle = await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const request = tx.objectStore(DB_STORE).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return handle;
  }

  async function writeFileHandle(handle) {
    let permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      permission = await handle.requestPermission({ mode: "readwrite" });
    }
    if (permission !== "granted") throw new Error("Schreibberechtigung fehlt.");
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(state, null, 2));
    await writable.close();
  }

  async function writeConnectedFile() {
    if (storageRecoveryError || !fileHandle) return;
    await writeFileHandle(fileHandle);
    oneDrivePermissionGranted = true;
    updateSaveIndicator();
    updateStorageWarning();
    showToast("OneDrive-Sicherungsdatei aktualisiert.");
  }

  async function connectOneDriveFile() {
    if (!("showOpenFilePicker" in window) || !window.isSecureContext) {
      showToast("Direkte Dateiverbindung wird hier nicht unterstützt. Nutze „Daten öffnen“ und „Sicherung speichern“.");
      return;
    }
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: "Klassenblick-Sicherung", accept: { "application/json": [".json"] } }],
        multiple: false
      });
      const file = await handle.getFile();
      const data = JSON.parse(await file.text());
      if (isGradeSupplement(data)) {
        applyGradeSupplement(data);
        return;
      }
      const imported = migrateState(data);
      validateImport(imported);
      if (!confirm("Die gewählte OneDrive-Sicherung als aktuelle Daten laden und ab jetzt bei Änderungen aktualisieren?")) return;
      const previousState = state;
      const previousFileHandle = fileHandle;
      const previousRecoveryError = storageRecoveryError;
      state = imported;
      fileHandle = handle;
      await saveHandle(handle);
      if (!state.classes.some((course) => course.id === state.selectedClassId)) state.selectedClassId = state.classes[0]?.id || null;
      activeTab = "grades";
      studentFilter = "";
      storageRecoveryError = null;
      try {
        saveState();
      } catch (saveError) {
        state = previousState;
        fileHandle = previousFileHandle;
        storageRecoveryError = previousRecoveryError;
        updateStorageWarning();
        throw saveError;
      }
      updateStorageWarning();
      updateSaveIndicator();
      showToast("OneDrive-Datei verbunden.");
    } catch (error) {
      if (error.name !== "AbortError") {
        console.error("OneDrive-Datei konnte nicht verbunden werden.", error);
        showToast(error.message || "Datei konnte nicht verbunden werden.");
      }
    }
  }

  async function restoreFileHandle() {
    try {
      fileHandle = await getHandle();
      backupDirectoryHandle = await getHandle("backupDirectory");
      if (fileHandle) {
        const permission = await fileHandle.queryPermission({ mode: "readwrite" });
        oneDrivePermissionGranted = permission === "granted";
        if (permission !== "granted") $("#save-indicator").title = "OneDrive-Datei verbunden; Berechtigung beim nächsten Speichern erforderlich.";
      }
    } catch (error) {
      console.error("Verbundene Datei konnte nicht wiederhergestellt werden.", error);
      fileHandle = null;
      backupDirectoryHandle = null;
      oneDrivePermissionGranted = false;
    }
  }

  async function initializeApp() {
    $("#add-class-button").disabled = true;
    $("#first-class-button").disabled = true;
    $("#import-button").disabled = true;
    $("#export-button").disabled = true;
    $("#save-indicator").title = "Vorhandene Daten und automatische Sicherung werden geprüft.";
    try {
      state = await loadState();
    } catch (error) {
      console.error("App-Daten konnten nicht sicher initialisiert werden.", error);
      storageRecoveryError = "Die vorhandenen Daten konnten nicht sicher geprüft werden. Die App wurde gesperrt, damit keine Noten überschrieben werden.";
      state = blankState();
    }
    if (!storageRecoveryError) {
      try {
        await requestPersistentStorage();
      } catch (error) {
        storagePolicyWarning = "Der Browser konnte den dauerhaften Schutz lokaler Daten nicht prüfen. Bitte zusätzlich regelmäßig eine JSON-Sicherung in OneDrive speichern.";
        console.error("Dauerhafter Browserspeicher konnte nicht angefragt werden.", error);
      }
    }
    updateStorageWarning();
    $("#import-button").disabled = false;
    const selectionChanged = applyCurrentSchedule(false);
    render();
    if (selectionChanged) saveState();
    const startupNotice = persistenceWarning;
    if (!storageRecoveryError) {
      try {
        await persistAutomaticBackup(state);
      } catch (error) {
        persistenceWarning = "Die automatische Zusatzsicherung ist nicht verfügbar. Bitte eine Sicherungsdatei in OneDrive speichern.";
        console.error("Initiale automatische Sicherung konnte nicht erstellt werden.", error);
        updateStorageWarning();
      }
    }
    await restoreFileHandle();
    updateSaveIndicator();
    updateStorageWarning();
    if (startupNotice) showToast(startupNotice);
    try {
      if (await cloud.handleRedirect()) showToast("Mit OneDrive verbunden.");
    } catch (error) {
      console.error("OneDrive-Anmeldung fehlgeschlagen.", error);
      showToast(error.message);
    }
    updateCloudUi();
    await syncCloud();
  }

  function applyCurrentSchedule(notify = true) {
    const matches = currentScheduleMatches();
    const matchingCourses = [...new Map(matches.map((match) => [match.course.id, match.course])).values()];
    if (!matchingCourses.length) {
      lastScheduleConflictKey = "";
      return false;
    }
    if (matchingCourses.length > 1) {
      const conflictKey = matchingCourses.map((course) => course.id).sort().join("|");
      if (conflictKey !== lastScheduleConflictKey && notify) {
        showToast(`Stundenplan-Überschneidung: ${matchingCourses.map((course) => course.name).join(", ")}. Bitte Kurs manuell wählen.`);
      }
      lastScheduleConflictKey = conflictKey;
      if (showingSchedule) render();
      return false;
    }
    lastScheduleConflictKey = "";
    if (Date.now() < scheduleOverrideUntil) return false;
    const course = matchingCourses[0];
    if (course.id === state.selectedClassId) return false;
    state.selectedClassId = course.id;
    activeTab = "grades";
    studentFilter = "";
    showingSchedule = false;
    if (notify) {
      saveState();
      showToast(`Stundenplan: ${course.name} wurde geöffnet.`);
    }
    return true;
  }

  $("#add-class-button").addEventListener("click", openClassModal);
  $("#first-class-button").addEventListener("click", openClassModal);
  $("#schedule-button").addEventListener("click", () => {
    showingSchedule = !showingSchedule;
    render();
  });
  $("#export-button").addEventListener("click", saveBackup);
  $("#cloud-button").addEventListener("click", handleCloudButton);
  $("#cloud-disconnect-button").addEventListener("click", disconnectCloud);
  $("#import-button").addEventListener("click", () => {
    if ("showOpenFilePicker" in window && window.isSecureContext) connectOneDriveFile();
    else $("#import-file").click();
  });
  $("#import-file").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) importData(file);
    event.target.value = "";
  });
  $("#modal-close").addEventListener("click", () => modal.close());
  $("#modal-cancel").addEventListener("click", () => modal.close());

  initializeApp();
  window.setInterval(() => {
    if (!storageRecoveryError && !modal.open) applyCurrentSchedule();
  }, 30000);
  window.addEventListener("focus", () => {
    if (!storageRecoveryError && !modal.open) applyCurrentSchedule();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !storageRecoveryError && !modal.open) {
      applyCurrentSchedule();
      scheduleCloudSync(300);
    }
  });
  window.setInterval(() => {
    if (document.visibilityState === "visible" && !modal.open) scheduleCloudSync(0);
  }, 120000);
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js").catch((error) => console.error("Offline-Cache konnte nicht aktiviert werden.", error)));
  }
}());

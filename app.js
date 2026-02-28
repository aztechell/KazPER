"use strict";

const STORAGE_KEYS = {
  choices: "kazper.picker.v1.choices",
  prefs: "kazper.picker.v1.prefs"
};

const ALL_LOCALES = ["ru", "kk", "en"];
const ALL_GENDERS = ["M", "F", "B"];
const VALID_GENDERS = new Set(ALL_GENDERS);
const VALID_GENDER_MODES = new Set(["male", "female", "both"]);
const SWIPE_THRESHOLD_PX = 96;
const SWIPE_OUT_DISTANCE_PX = 460;

/** @typedef {"ru" | "kk" | "en"} Locale */
/** @typedef {"M" | "F" | "B"} Gender */
/** @typedef {"good" | "bad"} Bucket */

/**
 * @typedef {Object} NameEntry
 * @property {string} id
 * @property {string} kk
 * @property {string} ru
 * @property {string} en
 * @property {Gender} gender
 */

/**
 * @typedef {Object} SwipeAction
 * @property {string} id
 * @property {Bucket | null} previousBucket
 * @property {Bucket} nextBucket
 */

const refs = {};

const state = {
  /** @type {NameEntry[]} */
  allNames: [],
  /** @type {Map<string, NameEntry>} */
  byId: new Map(),
  /** @type {Locale} */
  activeLocale: "ru",
  activeGenderMode: "both",
  /** @type {Set<Gender>} */
  activeGenders: new Set(ALL_GENDERS),
  /** @type {NameEntry[]} */
  deck: [],
  deckIndex: 0,
  /** @type {Set<string>} */
  goodKeys: new Set(),
  /** @type {Set<string>} */
  badKeys: new Set(),
  /** @type {SwipeAction[]} */
  history: [],
  isLoading: false,
  loadError: "",
  invalidRows: 0,
  actionLocked: false,
  dragging: false,
  dragPointerId: null,
  dragStartX: 0,
  dragDeltaX: 0
};

document.addEventListener("DOMContentLoaded", () => {
  cacheRefs();
  bindEvents();
  hydratePrefs();
  syncFilterControlsFromState();
  render();
  loadNames();
});

function cacheRefs() {
  refs.errorBanner = document.getElementById("errorBanner");
  refs.errorText = document.getElementById("errorText");
  refs.retryLoadBtn = document.getElementById("retryLoadBtn");
  refs.loadWarning = document.getElementById("loadWarning");

  refs.genderModeRadios = Array.from(document.querySelectorAll("input[name='genderMode']"));
  refs.localeRadios = Array.from(document.querySelectorAll("input[name='locale']"));

  refs.btnUndo = document.getElementById("btnUndo");
  refs.btnRestart = document.getElementById("btnRestart");
  refs.btnExportCsv = document.getElementById("btnExportCsv");
  refs.btnExportJson = document.getElementById("btnExportJson");
  refs.btnReset = document.getElementById("btnReset");

  refs.badCount = document.getElementById("badCount");
  refs.goodCount = document.getElementById("goodCount");
  refs.deckProgress = document.getElementById("deckProgress");

  refs.badList = document.getElementById("badList");
  refs.goodList = document.getElementById("goodList");
  refs.badEmpty = document.getElementById("badEmpty");
  refs.goodEmpty = document.getElementById("goodEmpty");

  refs.cardStage = document.getElementById("cardStage");
  refs.nameCard = document.getElementById("nameCard");
  refs.cardTag = document.getElementById("cardTag");
  refs.cardName = document.getElementById("cardName");
  refs.cardMeta = document.getElementById("cardMeta");
  refs.cardNotice = document.getElementById("cardNotice");

  refs.btnBad = document.getElementById("btnBad");
  refs.btnGood = document.getElementById("btnGood");
}

function bindEvents() {
  refs.retryLoadBtn.addEventListener("click", () => {
    loadNames();
  });

  refs.genderModeRadios.forEach((input) => {
    input.addEventListener("change", () => {
      handleGenderModeChange();
    });
  });

  refs.localeRadios.forEach((input) => {
    input.addEventListener("change", () => {
      handleLocaleChange();
    });
  });

  refs.btnBad.addEventListener("click", () => triggerSwipe("bad"));
  refs.btnGood.addEventListener("click", () => triggerSwipe("good"));
  refs.btnUndo.addEventListener("click", () => undoLastSwipe());
  refs.btnRestart.addEventListener("click", () => restartDeck());
  refs.btnExportCsv.addEventListener("click", () => exportCsv());
  refs.btnExportJson.addEventListener("click", () => exportJson());
  refs.btnReset.addEventListener("click", () => resetAll());
  refs.badList.addEventListener("click", (event) => handleListTransferClick(event, "bad"));
  refs.goodList.addEventListener("click", (event) => handleListTransferClick(event, "good"));
  refs.badList.addEventListener("keydown", (event) => handleListTransferKeydown(event, "bad"));
  refs.goodList.addEventListener("keydown", (event) => handleListTransferKeydown(event, "good"));

  refs.cardNotice.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }

    if (button.dataset.action === "restart") {
      restartDeck();
      return;
    }

    if (button.dataset.action === "retry") {
      loadNames();
    }
  });

  window.addEventListener("keydown", (event) => {
    handleKeyboard(event);
  });

  refs.nameCard.addEventListener("pointerdown", (event) => onPointerDown(event));
  refs.nameCard.addEventListener("pointermove", (event) => onPointerMove(event));
  refs.nameCard.addEventListener("pointerup", (event) => onPointerUp(event));
  refs.nameCard.addEventListener("pointercancel", () => cancelPointerDrag());
}

async function loadNames() {
  state.isLoading = true;
  state.loadError = "";
  state.invalidRows = 0;
  state.deck = [];
  state.deckIndex = 0;
  state.history = [];
  render();

  try {
    const csvText = await fetchCsvText("name_list.csv");
    const parsed = parseNameCsv(csvText);

    state.allNames = parsed.names;
    state.byId = new Map(parsed.names.map((entry) => [entry.id, entry]));
    state.invalidRows = parsed.invalidRows;

    hydrateChoices();
    sanitizeChoiceSets();

    state.isLoading = false;
    rebuildDeck();
    return;
  } catch (error) {
    state.isLoading = false;
    state.loadError = error instanceof Error ? error.message : "Unknown load error.";
    render();
  }
}

function handleGenderModeChange() {
  const selected = refs.genderModeRadios.find((radio) => radio.checked);
  if (!selected || !VALID_GENDER_MODES.has(selected.value)) {
    return;
  }

  state.activeGenderMode = selected.value;
  state.activeGenders = getGendersForMode(state.activeGenderMode);
  persistPrefs();
  rebuildDeck();
}

function handleLocaleChange() {
  const selected = refs.localeRadios.find((radio) => radio.checked);
  if (!selected || !ALL_LOCALES.includes(selected.value)) {
    return;
  }

  state.activeLocale = selected.value;
  persistPrefs();
  rebuildDeck();
}

function rebuildDeck() {
  const uniqueDisplayKeys = new Set();
  const filtered = [];

  state.allNames.forEach((entry) => {
    if (!state.activeGenders.has(entry.gender)) {
      return;
    }

    const displayValue = entry[state.activeLocale];
    const dedupeKey = `${entry.gender}::${normalizeText(displayValue)}`;
    if (uniqueDisplayKeys.has(dedupeKey)) {
      return;
    }

    uniqueDisplayKeys.add(dedupeKey);
    filtered.push(entry);
  });

  state.deck = shuffle(filtered);
  state.deckIndex = 0;
  state.history = [];
  state.actionLocked = false;
  cancelPointerDrag();
  render();
}

function restartDeck() {
  if (state.isLoading || state.loadError) {
    return;
  }

  rebuildDeck();
}

function triggerSwipe(bucket) {
  if (!canSwipe()) {
    return;
  }

  state.actionLocked = true;
  renderButtonState();

  const direction = bucket === "good" ? 1 : -1;
  refs.nameCard.classList.add("fly-out");
  refs.nameCard.style.transform = `translateX(${direction * SWIPE_OUT_DISTANCE_PX}px) rotate(${direction * 17}deg)`;
  refs.cardStage.dataset.swipe = bucket;

  window.setTimeout(() => {
    refs.nameCard.classList.remove("fly-out");
    resetCardTransform();
    applySwipe(bucket);
    state.actionLocked = false;
    render();
  }, 145);
}

function applySwipe(bucket) {
  const current = getCurrentEntry();
  if (!current) {
    return;
  }

  const previousBucket = getBucketForId(current.id);
  assignBucket(current.id, bucket);

  state.history.push({
    id: current.id,
    previousBucket,
    nextBucket: bucket
  });

  state.deckIndex += 1;
  persistChoices();
}

function undoLastSwipe() {
  if (state.actionLocked || state.history.length === 0) {
    return;
  }

  const action = state.history.pop();
  if (!action) {
    return;
  }

  state.deckIndex = Math.max(0, state.deckIndex - 1);
  restoreBucket(action.id, action.previousBucket);
  persistChoices();
  render();
}

function resetAll() {
  const shouldReset = window.confirm("Clear all saved picks and reset filters to defaults?");
  if (!shouldReset) {
    return;
  }

  state.activeLocale = "ru";
  state.activeGenderMode = "both";
  state.activeGenders = getGendersForMode(state.activeGenderMode);
  state.goodKeys = new Set();
  state.badKeys = new Set();
  state.history = [];

  clearStorage();
  persistPrefs();
  persistChoices();
  syncFilterControlsFromState();
  rebuildDeck();
}

function exportCsv() {
  const records = collectExportRecords();
  if (records.length === 0) {
    return;
  }

  const headers = ["bucket", "gender", "kk", "ru", "en", "display_locale", "display_name"];
  const lines = [headers.join(",")];

  records.forEach((record) => {
    const displayName = record.entry[state.activeLocale];
    const line = [
      record.bucket,
      record.entry.gender,
      record.entry.kk,
      record.entry.ru,
      record.entry.en,
      state.activeLocale,
      displayName
    ].map(escapeCsvCell).join(",");
    lines.push(line);
  });

  const fileName = `kazper-picks-${getDateStamp()}.csv`;
  downloadTextFile(fileName, lines.join("\n"), "text/csv;charset=utf-8");
}

function exportJson() {
  const records = collectExportRecords();
  if (records.length === 0) {
    return;
  }

  const exportedAt = new Date().toISOString();
  const payload = {
    exportedAt,
    display_locale: state.activeLocale,
    items: records.map((record) => ({
      bucket: record.bucket,
      exportedAt,
      id: record.entry.id,
      gender: record.entry.gender,
      kk: record.entry.kk,
      ru: record.entry.ru,
      en: record.entry.en,
      display_locale: state.activeLocale,
      display_name: record.entry[state.activeLocale]
    }))
  };

  const fileName = `kazper-picks-${getDateStamp()}.json`;
  downloadTextFile(fileName, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
}

function collectExportRecords() {
  const records = [];

  state.badKeys.forEach((id) => {
    const entry = state.byId.get(id);
    if (entry) {
      records.push({ bucket: "bad", entry });
    }
  });

  state.goodKeys.forEach((id) => {
    const entry = state.byId.get(id);
    if (entry) {
      records.push({ bucket: "good", entry });
    }
  });

  records.sort((a, b) => {
    const bucketCompare = a.bucket.localeCompare(b.bucket);
    if (bucketCompare !== 0) {
      return bucketCompare;
    }

    return a.entry[state.activeLocale].localeCompare(b.entry[state.activeLocale], "ru");
  });

  return records;
}

function handleKeyboard(event) {
  if (event.defaultPrevented || event.repeat) {
    return;
  }

  const target = event.target;
  const targetTag = target && target.tagName ? target.tagName.toLowerCase() : "";
  const isInputContext = targetTag === "input" || targetTag === "textarea" || targetTag === "select";

  if (!isInputContext && event.key === "ArrowLeft") {
    event.preventDefault();
    triggerSwipe("bad");
    return;
  }

  if (!isInputContext && event.key === "ArrowRight") {
    event.preventDefault();
    triggerSwipe("good");
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undoLastSwipe();
  }
}

function onPointerDown(event) {
  if (!canSwipe()) {
    return;
  }

  if (event.button !== 0) {
    return;
  }

  state.dragging = true;
  state.dragPointerId = event.pointerId;
  state.dragStartX = event.clientX;
  state.dragDeltaX = 0;
  refs.nameCard.classList.add("dragging");

  try {
    refs.nameCard.setPointerCapture(event.pointerId);
  } catch (_) {
    // Ignore pointer capture failures and continue without drag capture.
  }
}

function onPointerMove(event) {
  if (!state.dragging || event.pointerId !== state.dragPointerId) {
    return;
  }

  state.dragDeltaX = event.clientX - state.dragStartX;
  applyDragTransform(state.dragDeltaX);
}

function onPointerUp(event) {
  if (!state.dragging || event.pointerId !== state.dragPointerId) {
    return;
  }

  const delta = state.dragDeltaX;
  cancelPointerDrag();

  if (Math.abs(delta) < SWIPE_THRESHOLD_PX) {
    resetCardTransform();
    return;
  }

  triggerSwipe(delta > 0 ? "good" : "bad");
}

function cancelPointerDrag() {
  if (!state.dragging) {
    return;
  }

  if (state.dragPointerId !== null) {
    try {
      refs.nameCard.releasePointerCapture(state.dragPointerId);
    } catch (_) {
      // Ignore pointer capture release failures.
    }
  }

  state.dragging = false;
  state.dragPointerId = null;
  state.dragStartX = 0;
  state.dragDeltaX = 0;
  refs.nameCard.classList.remove("dragging");
}

function applyDragTransform(deltaX) {
  const rotation = clamp(deltaX * 0.055, -14, 14);
  refs.nameCard.style.transform = `translateX(${deltaX}px) rotate(${rotation}deg)`;

  if (deltaX > 26) {
    refs.cardStage.dataset.swipe = "good";
  } else if (deltaX < -26) {
    refs.cardStage.dataset.swipe = "bad";
  } else {
    refs.cardStage.dataset.swipe = "";
  }
}

function resetCardTransform() {
  refs.nameCard.style.transform = "";
  refs.cardStage.dataset.swipe = "";
}

function render() {
  renderBannerState();
  renderWarning();
  renderCounts();
  renderLists();
  renderCard();
  renderButtonState();
}

function renderBannerState() {
  if (state.loadError) {
    refs.errorText.textContent = state.loadError;
    refs.errorBanner.classList.remove("hidden");
  } else {
    refs.errorBanner.classList.add("hidden");
  }
}

function renderWarning() {
  if (state.invalidRows > 0) {
    refs.loadWarning.textContent = `Skipped ${state.invalidRows} malformed row(s) while loading.`;
    refs.loadWarning.classList.remove("hidden");
  } else {
    refs.loadWarning.classList.add("hidden");
  }
}

function renderCounts() {
  refs.badCount.textContent = String(state.badKeys.size);
  refs.goodCount.textContent = String(state.goodKeys.size);

  if (state.deck.length === 0) {
    refs.deckProgress.textContent = "0 / 0";
    return;
  }

  if (getCurrentEntry()) {
    refs.deckProgress.textContent = `${state.deckIndex + 1} / ${state.deck.length}`;
  } else {
    refs.deckProgress.textContent = `${state.deck.length} / ${state.deck.length}`;
  }
}

function renderLists() {
  renderList(refs.badList, refs.badEmpty, state.badKeys, "bad");
  renderList(refs.goodList, refs.goodEmpty, state.goodKeys, "good");
}

function renderList(listElement, emptyElement, idSet, bucket) {
  listElement.textContent = "";
  const entries = [];

  idSet.forEach((id) => {
    const entry = state.byId.get(id);
    if (entry) {
      entries.push(entry);
    }
  });

  if (entries.length === 0) {
    emptyElement.classList.remove("hidden");
    return;
  }

  emptyElement.classList.add("hidden");
  const fragment = document.createDocumentFragment();

  entries.forEach((entry) => {
    const listItem = document.createElement("li");
    listItem.className = "pick-item";
    listItem.dataset.id = entry.id;
    listItem.dataset.bucket = bucket;
    listItem.setAttribute("role", "button");
    listItem.tabIndex = 0;

    const nameSpan = document.createElement("span");
    nameSpan.className = "pick-name";
    nameSpan.textContent = entry[state.activeLocale];

    const genderSpan = document.createElement("span");
    genderSpan.className = `gender-pill ${entry.gender.toLowerCase()}`;
    genderSpan.textContent = entry.gender;

    listItem.appendChild(nameSpan);
    listItem.appendChild(genderSpan);
    fragment.appendChild(listItem);
  });

  listElement.appendChild(fragment);
}

function handleListTransferClick(event, fromBucket) {
  const listItem = event.target.closest(".pick-item[data-id]");
  if (!listItem) {
    return;
  }

  transferPickedName(listItem.dataset.id, fromBucket);
}

function handleListTransferKeydown(event, fromBucket) {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  const listItem = event.target.closest(".pick-item[data-id]");
  if (!listItem) {
    return;
  }

  event.preventDefault();
  transferPickedName(listItem.dataset.id, fromBucket);
}

function transferPickedName(id, fromBucket) {
  if (!id || !state.byId.has(id)) {
    return;
  }

  const inBad = state.badKeys.has(id);
  const inGood = state.goodKeys.has(id);
  if (!inBad && !inGood) {
    return;
  }

  if (fromBucket === "bad") {
    assignBucket(id, "good");
  } else {
    assignBucket(id, "bad");
  }

  persistChoices();
  render();
}

function renderCard() {
  resetCardTransform();

  if (state.isLoading) {
    refs.cardTag.textContent = "Loading";
    refs.cardName.textContent = "Loading names...";
    refs.cardMeta.textContent = "Please wait while the CSV file is parsed.";
    refs.cardNotice.textContent = "";
    return;
  }

  if (state.loadError) {
    refs.cardTag.textContent = "Error";
    refs.cardName.textContent = "Data unavailable";
    refs.cardMeta.textContent = "Retry loading to continue.";
    refs.cardNotice.innerHTML = 'Could not load <code>name_list.csv</code>. <button class="notice-action" data-action="retry">Retry</button>';
    return;
  }

  if (state.deck.length === 0) {
    refs.cardTag.textContent = "Empty";
    refs.cardName.textContent = "No names match these filters";
    refs.cardMeta.textContent = "Try changing gender or format filters.";
    refs.cardNotice.textContent = "";
    return;
  }

  const current = getCurrentEntry();
  if (!current) {
    refs.cardTag.textContent = "Done";
    refs.cardName.textContent = "Deck complete";
    refs.cardMeta.textContent = `You reviewed ${state.deck.length} names with current filters.`;
    refs.cardNotice.innerHTML = 'Start another pass. <button class="notice-action" data-action="restart">Restart deck</button>';
    return;
  }

  refs.cardTag.textContent = `${current.gender} | ${state.activeLocale.toUpperCase()}`;
  refs.cardName.textContent = current[state.activeLocale];
  refs.cardMeta.textContent = `KK: ${current.kk} | RU: ${current.ru} | EN: ${current.en}`;
  refs.cardNotice.textContent = `${state.deck.length - state.deckIndex - 1} names remaining in this deck.`;
}

function renderButtonState() {
  const cardActive = canSwipe();
  const hasChoices = state.goodKeys.size + state.badKeys.size > 0;

  refs.btnBad.disabled = !cardActive;
  refs.btnGood.disabled = !cardActive;
  refs.btnUndo.disabled = state.actionLocked || state.history.length === 0;
  refs.btnRestart.disabled = state.isLoading || !!state.loadError || state.deck.length === 0;
  refs.btnExportCsv.disabled = !hasChoices;
  refs.btnExportJson.disabled = !hasChoices;
  refs.btnReset.disabled = state.isLoading;
}

function getCurrentEntry() {
  if (state.deckIndex < 0 || state.deckIndex >= state.deck.length) {
    return null;
  }
  return state.deck[state.deckIndex];
}

function canSwipe() {
  return !state.isLoading && !state.loadError && !state.actionLocked && !!getCurrentEntry();
}

function getBucketForId(id) {
  if (state.goodKeys.has(id)) {
    return "good";
  }
  if (state.badKeys.has(id)) {
    return "bad";
  }
  return null;
}

function assignBucket(id, bucket) {
  if (bucket === "good") {
    state.badKeys.delete(id);
    state.goodKeys.add(id);
    return;
  }

  state.goodKeys.delete(id);
  state.badKeys.add(id);
}

function restoreBucket(id, bucket) {
  if (bucket === "good") {
    state.badKeys.delete(id);
    state.goodKeys.add(id);
    return;
  }

  if (bucket === "bad") {
    state.goodKeys.delete(id);
    state.badKeys.add(id);
    return;
  }

  state.goodKeys.delete(id);
  state.badKeys.delete(id);
}

function hydratePrefs() {
  const persisted = readJsonStorage(STORAGE_KEYS.prefs);
  if (!persisted || typeof persisted !== "object") {
    return;
  }

  if (typeof persisted.locale === "string" && ALL_LOCALES.includes(persisted.locale)) {
    state.activeLocale = persisted.locale;
  }

  if (typeof persisted.genderMode === "string" && VALID_GENDER_MODES.has(persisted.genderMode)) {
    state.activeGenderMode = persisted.genderMode;
    state.activeGenders = getGendersForMode(state.activeGenderMode);
    return;
  }

  if (Array.isArray(persisted.genders)) {
    const nextGenders = new Set();
    persisted.genders.forEach((gender) => {
      if (VALID_GENDERS.has(gender)) {
        nextGenders.add(gender);
      }
    });
    const inferredMode = inferGenderModeFromSet(nextGenders);
    state.activeGenderMode = inferredMode;
    state.activeGenders = getGendersForMode(inferredMode);
  }
}

function hydrateChoices() {
  const persisted = readJsonStorage(STORAGE_KEYS.choices);

  state.goodKeys = new Set();
  state.badKeys = new Set();

  if (!persisted || typeof persisted !== "object") {
    return;
  }

  if (Array.isArray(persisted.good)) {
    persisted.good.forEach((id) => {
      if (typeof id === "string") {
        state.goodKeys.add(id);
      }
    });
  }

  if (Array.isArray(persisted.bad)) {
    persisted.bad.forEach((id) => {
      if (typeof id === "string") {
        state.badKeys.add(id);
      }
    });
  }
}

function sanitizeChoiceSets() {
  const validIds = new Set(state.byId.keys());

  state.goodKeys.forEach((id) => {
    if (!validIds.has(id)) {
      state.goodKeys.delete(id);
    }
  });

  state.badKeys.forEach((id) => {
    if (!validIds.has(id) || state.goodKeys.has(id)) {
      state.badKeys.delete(id);
    }
  });

  persistChoices();
}

function persistPrefs() {
  writeJsonStorage(STORAGE_KEYS.prefs, {
    locale: state.activeLocale,
    genderMode: state.activeGenderMode,
    genders: Array.from(state.activeGenders)
  });
}

function persistChoices() {
  writeJsonStorage(STORAGE_KEYS.choices, {
    good: Array.from(state.goodKeys),
    bad: Array.from(state.badKeys)
  });
}

function syncFilterControlsFromState() {
  refs.genderModeRadios.forEach((input) => {
    input.checked = input.value === state.activeGenderMode;
  });

  refs.localeRadios.forEach((input) => {
    input.checked = input.value === state.activeLocale;
  });
}

function clearStorage() {
  try {
    localStorage.removeItem(STORAGE_KEYS.choices);
    localStorage.removeItem(STORAGE_KEYS.prefs);
  } catch (_) {
    // Ignore storage clearing errors.
  }
}

function readJsonStorage(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function writeJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {
    // Ignore storage writing errors to keep UI usable.
  }
}

async function fetchCsvText(filePath) {
  const response = await fetch(filePath, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${filePath} (${response.status}).`);
  }

  const buffer = await response.arrayBuffer();
  const utf8Text = decodeBuffer(buffer, "utf-8");

  if (utf8Text.toLowerCase().includes("kk,ru,en,gender")) {
    return utf8Text;
  }

  const win1251Text = decodeBuffer(buffer, "windows-1251");
  if (win1251Text.toLowerCase().includes("kk,ru,en,gender")) {
    return win1251Text;
  }

  return utf8Text;
}

function decodeBuffer(buffer, encoding) {
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch (_) {
    return "";
  }
}

function parseNameCsv(text) {
  const rows = parseCsvRows(text);
  if (rows.length === 0) {
    throw new Error("CSV file is empty.");
  }

  const headerRow = rows[0].map((value) => value.trim().replace(/^\uFEFF/, "").toLowerCase());
  const kkIndex = headerRow.indexOf("kk");
  const ruIndex = headerRow.indexOf("ru");
  const enIndex = headerRow.indexOf("en");
  const genderIndex = headerRow.indexOf("gender");

  if ([kkIndex, ruIndex, enIndex, genderIndex].some((index) => index < 0)) {
    throw new Error("CSV header must include kk, ru, en, and gender.");
  }

  const seenIds = new Set();
  const parsedNames = [];
  let invalidRows = 0;

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row.length === 1 && row[0].trim() === "") {
      continue;
    }

    const kk = (row[kkIndex] || "").trim();
    const ru = (row[ruIndex] || "").trim();
    const en = (row[enIndex] || "").trim();
    const gender = ((row[genderIndex] || "").trim().toUpperCase());

    if (!kk || !ru || !en || !VALID_GENDERS.has(gender)) {
      invalidRows += 1;
      continue;
    }

    const id = makeEntryId(kk, ru, en, gender);
    if (seenIds.has(id)) {
      invalidRows += 1;
      continue;
    }

    seenIds.add(id);
    parsedNames.push({ id, kk, ru, en, gender });
  }

  if (parsedNames.length === 0) {
    throw new Error("CSV file has no valid rows.");
  }

  return {
    names: parsedNames,
    invalidRows
  };
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    if (char === "\r") {
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.length > 1 || row[0].trim() !== "") {
    rows.push(row);
  }

  return rows;
}

function shuffle(items) {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    const temp = copy[index];
    copy[index] = copy[randomIndex];
    copy[randomIndex] = temp;
  }
  return copy;
}

function makeEntryId(kk, ru, en, gender) {
  return `${kk}||${ru}||${en}||${gender}`;
}

function normalizeText(value) {
  return value.trim().toLocaleLowerCase("ru-RU").normalize("NFKC");
}

function getGendersForMode(mode) {
  if (mode === "male") {
    return new Set(["M", "B"]);
  }

  if (mode === "female") {
    return new Set(["F", "B"]);
  }

  return new Set(ALL_GENDERS);
}

function inferGenderModeFromSet(genderSet) {
  if (genderSet.has("M") && !genderSet.has("F")) {
    return "male";
  }

  if (genderSet.has("F") && !genderSet.has("M")) {
    return "female";
  }

  return "both";
}

function downloadTextFile(fileName, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);

  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();

  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (/["\n,\r]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function getDateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

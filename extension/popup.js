// Popup logic: manage the blocked site list, timed blocks and focus sessions.

const DEFAULT_SETTINGS = {
  enabled: true,
  blockedSites: [],
  timedBlocks: {},
  focus: {
    active: false,
    sites: [],
    workMinutes: 25,
    breakMinutes: 5,
    rounds: 0,
    state: "idle",
    endsAt: 0,
    round: 0,
  },
};

// Preset choices offered in the focus panel.
const WORK_PRESETS = ["15", "25", "50"];
const BREAK_PRESETS = ["5", "10", "15"];
const ROUND_PRESETS = ["1", "2", "3", "4", "5"];

const els = {
  toggle: document.getElementById("enabledToggle"),
  accessWarning: document.getElementById("accessWarning"),
  ruleWarning: document.getElementById("ruleWarning"),
  current: document.getElementById("currentSite"),
  currentDomain: document.getElementById("currentDomain"),
  currentState: document.getElementById("currentState"),
  currentAction: document.getElementById("currentAction"),
  addForm: document.getElementById("addForm"),
  input: document.getElementById("domainInput"),
  error: document.getElementById("error"),
  list: document.getElementById("siteList"),
  empty: document.getElementById("emptyState"),
  status: document.getElementById("statusText"),
  durationOptions: document.getElementById("durationOptions"),
  customMinutes: document.getElementById("customMinutes"),
  focusStatus: document.getElementById("focusStatus"),
  focusSiteList: document.getElementById("focusSiteList"),
  focusEmptyState: document.getElementById("focusEmptyState"),
  focusAddForm: document.getElementById("focusAddForm"),
  focusDomainInput: document.getElementById("focusDomainInput"),
  workMinutes: document.getElementById("workMinutes"),
  customWorkMinutes: document.getElementById("customWorkMinutes"),
  breakMinutes: document.getElementById("breakMinutes"),
  customBreakMinutes: document.getElementById("customBreakMinutes"),
  focusRounds: document.getElementById("focusRounds"),
  customRounds: document.getElementById("customRounds"),
  focusStartBtn: document.getElementById("focusStartBtn"),
  focusStopBtn: document.getElementById("focusStopBtn"),
  focusError: document.getElementById("focusError"),
};

let settings = { ...DEFAULT_SETTINGS };
let currentTab = null; // { id, host }
let hasSiteAccess = true;
let localRevision = 0; // bumped on every local change, guards against stale init
let selectedMinutes = 0; // 0 = forever, "custom" = use the custom field
let tickTimer = null; // live countdown while the popup is open

// The user's timing choice for the next session. Kept separate from
// settings.focus so that re-rendering never clobbers it.
let workChoice = { preset: "25", custom: 25 };
let breakChoice = { preset: "5", custom: 5 };
let roundsChoice = { preset: "0", custom: 3 }; // 0 rounds = keep going until stopped

// ---------- helpers ----------

function normalizeDomain(raw) {
  let value = (raw || "").trim();
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : "http://" + value);
    value = url.hostname;
  } catch {
    return null;
  }
  value = value.toLowerCase().replace(/^www\./, "").replace(/\.+$/, "");
  const isIPv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
  const isHostname = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value);
  if (value === "localhost" || isIPv4 || isHostname) return value;
  return null;
}

function matchBlocked(host, sites) {
  if (!host) return null;
  host = host.toLowerCase();
  return sites.find((s) => host === s || host.endsWith("." + s)) || null;
}

function siteFromTabUrl(tabUrl) {
  try {
    const url = new URL(tabUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname;
  } catch {
    return null;
  }
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = !message;
}

function showFocusError(message) {
  els.focusError.textContent = message;
  els.focusError.hidden = !message;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

// The duration the user picked for a new block, in minutes (0 = always).
function chosenMinutes() {
  if (selectedMinutes === "custom") {
    const value = Number(els.customMinutes.value);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.min(10080, Math.round(value));
  }
  return selectedMinutes;
}

// Work/break length in minutes for the next session. When "custom" is
// selected the live input value wins, so the number is picked up however it
// was entered (typing, the spinner, or programmatically).
function chosenWorkMinutes() {
  if (workChoice.preset === "custom") {
    const live = Number(els.customWorkMinutes.value);
    if (Number.isFinite(live) && live > 0) return Math.min(480, Math.round(live));
    const value = Number(workChoice.custom);
    return Number.isFinite(value) && value > 0 ? Math.min(480, Math.round(value)) : 25;
  }
  const value = Number(workChoice.preset);
  return Number.isFinite(value) && value > 0 ? value : 25;
}

function chosenBreakMinutes() {
  if (breakChoice.preset === "custom") {
    const live = Number(els.customBreakMinutes.value);
    if (Number.isFinite(live) && live > 0) return Math.min(120, Math.round(live));
    const value = Number(breakChoice.custom);
    return Number.isFinite(value) && value > 0 ? Math.min(120, Math.round(value)) : 5;
  }
  const value = Number(breakChoice.preset);
  return Number.isFinite(value) && value > 0 ? value : 5;
}

// How many work/break rounds the session should run. 0 means "keep going
// until the user stops the session".
function chosenRounds() {
  if (roundsChoice.preset === "custom") {
    const live = Number(els.customRounds.value);
    if (Number.isFinite(live) && live > 0) return Math.min(99, Math.round(live));
    const value = Number(roundsChoice.custom);
    return Number.isFinite(value) && value > 0 ? Math.min(99, Math.round(value)) : 0;
  }
  const value = Number(roundsChoice.preset);
  return Number.isFinite(value) && value >= 0 ? Math.min(99, Math.round(value)) : 0;
}

async function save(patch) {
  localRevision++;
  settings = { ...settings, ...patch };
  await chrome.storage.sync.set(patch);
  // Don't block the UI on the service worker: storage.onChanged also triggers
  // a rule sync, so this is just a nudge to apply changes right away.
  // Once it is done, re-check that the rules really landed.
  syncNow().then(checkRuleStatus, checkRuleStatus);
}

// Save part of the focus settings without clobbering the parts the service
// worker owns (the running phase, its end time and the round counter).
// Writing the whole object back would resurrect a stale phase and break the
// running timer.
//
// `partial` may be an object or a function that receives the latest stored
// focus object and returns the new one. Updates are queued so that two quick
// edits can never read the same old value and overwrite each other.
let focusWriteChain = Promise.resolve();

function saveFocus(partial) {
  focusWriteChain = focusWriteChain.then(
    () => writeFocus(partial),
    () => writeFocus(partial)
  );
  return focusWriteChain;
}

async function writeFocus(partial) {
  const stored = await chrome.storage.sync.get({ focus: DEFAULT_SETTINGS.focus });
  const latest = { ...DEFAULT_SETTINGS.focus, ...(stored.focus || {}) };
  const next = typeof partial === "function" ? partial(latest) : { ...latest, ...partial };
  settings = { ...settings, focus: next };
  render();
  await save({ focus: next });
}

// Ask the service worker to rebuild blocking rules immediately.
async function syncNow() {
  try {
    await chrome.runtime.sendMessage({ type: "syncNow" });
  } catch {
    // Service worker not reachable; it will sync from storage.onChanged.
  }
}

// Check that the blocking rules really are in place, and warn the user when
// they are not. Without this, a browser that refuses the rules leaves
// blocking silently broken.
async function checkRuleStatus() {
  let status = null;
  try {
    status = await chrome.runtime.sendMessage({ type: "getRuleStatus" });
  } catch {
    // The service worker is not reachable right now. Say so instead of
    // pretending everything is fine.
    els.ruleWarning.textContent =
      "Blocking isn't running: the extension's background service is not responding. Reload the extension from the browser's extension page.";
    els.ruleWarning.hidden = false;
    return;
  }
  if (!status) return;

  let message = "";
  if (status.error) {
    message =
      "Blocking isn't working: the browser refused the blocking rules (" +
      status.error +
      ").";
  } else if (status.expected > 0 && status.installed === 0) {
    message = "Blocking isn't working: no blocking rules are installed.";
  } else if (status.expected > status.installed) {
    message =
      "Blocking is only partly working: " +
      status.installed +
      " of " +
      status.expected +
      " sites have a rule installed.";
  }
  els.ruleWarning.textContent = message;
  els.ruleWarning.hidden = !message;
}

// ---------- rendering ----------

function renderList() {
  const now = Date.now();
  const entries = [];

  for (const site of settings.blockedSites) {
    entries.push({ site, badge: null, title: site });
  }
  for (const [site, expiry] of Object.entries(settings.timedBlocks || {})) {
    if (expiry > now) {
      entries.push({
        site,
        badge: { kind: "timed", text: formatDuration(expiry - now) },
        title: site + " (timed)",
      });
    }
  }
  entries.sort((a, b) => a.site.localeCompare(b.site));

  els.list.textContent = "";
  els.empty.hidden = entries.length > 0;
  els.list.hidden = entries.length === 0;

  for (const entry of entries) {
    const li = document.createElement("li");

    const name = document.createElement("span");
    name.className = "site-name";
    name.textContent = entry.site;
    name.title = entry.title;

    li.append(name);

    if (entry.badge) {
      const badge = document.createElement("span");
      badge.className = "badge " + entry.badge.kind;
      badge.textContent = entry.badge.text;
      li.append(badge);
    }

    const remove = document.createElement("button");
    remove.className = "remove";
    remove.type = "button";
    remove.textContent = "\u00d7"; // ×
    remove.title = "Remove " + entry.site;
    remove.setAttribute("aria-label", "Remove " + entry.site);
    remove.addEventListener("click", async () => {
      const next = {
        blockedSites: settings.blockedSites.filter((s) => s !== entry.site),
        timedBlocks: { ...settings.timedBlocks },
      };
      delete next.timedBlocks[entry.site];
      settings = { ...settings, ...next };
      render();
      await save(next);
    });

    li.append(remove);
    els.list.append(li);
  }
}

function renderCurrentSite() {
  if (!currentTab) {
    els.current.hidden = true;
    return;
  }
  const blockedBy = matchBlocked(currentTab.host, settings.blockedSites);
  const timedBy = Object.keys(settings.timedBlocks || {}).find(
    (s) => currentTab.host === s || currentTab.host.endsWith("." + s)
  );
  els.current.hidden = false;
  els.currentDomain.textContent = currentTab.host;
  els.currentDomain.title = currentTab.host;

  if (blockedBy) {
    els.currentState.textContent = "Blocked";
    els.currentState.classList.add("blocked");
    els.currentAction.textContent = "Unblock";
    els.currentAction.onclick = async () => {
      const next = settings.blockedSites.filter((s) => s !== blockedBy);
      settings = { ...settings, blockedSites: next };
      render();
      await save({ blockedSites: next });
      // Wait for the rule to be gone before reloading, or the reload is
      // caught by the very rule we just removed.
      await syncNow();
      chrome.tabs.reload(currentTab.id);
    };
  } else if (timedBy) {
    const expiry = settings.timedBlocks[timedBy];
    els.currentState.textContent = "Blocked for " + formatDuration(expiry - Date.now());
    els.currentState.classList.add("blocked");
    els.currentAction.textContent = "Unblock";
    els.currentAction.onclick = async () => {
      const next = { ...settings.timedBlocks };
      delete next[timedBy];
      settings = { ...settings, timedBlocks: next };
      render();
      await save({ timedBlocks: next });
      await syncNow();
      chrome.tabs.reload(currentTab.id);
    };
  } else {
    els.currentState.textContent = "Not blocked";
    els.currentState.classList.remove("blocked");
    els.currentAction.textContent = "Block this site";
    els.currentAction.onclick = async () => {
      const site = normalizeDomain(currentTab.host);
      if (!site) return;
      await addSite(site, { reloadCurrentTab: true });
    };
  }
}

function renderFocus() {
  const focus = settings.focus;
  const sites = focus.sites || [];

  els.focusSiteList.textContent = "";
  els.focusEmptyState.hidden = sites.length > 0;
  els.focusSiteList.hidden = sites.length === 0;

  for (const site of sites) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "site-name";
    name.textContent = site;
    name.title = site;
    const remove = document.createElement("button");
    remove.className = "remove";
    remove.type = "button";
    remove.textContent = "\u00d7";
    remove.title = "Remove " + site;
    remove.setAttribute("aria-label", "Remove " + site);
    remove.addEventListener("click", async () => {
      await saveFocus((latest) => ({
        ...latest,
        sites: (latest.sites || []).filter((s) => s !== site),
      }));
    });
    li.append(name, remove);
    els.focusSiteList.append(li);
  }

  els.focusStartBtn.hidden = focus.active;
  els.focusStopBtn.hidden = !focus.active;

  // While a session runs the timings are locked, so the running timer can't
  // be changed half way through.
  const running = !!focus.active;
  els.workMinutes.disabled = running;
  els.breakMinutes.disabled = running;
  els.customWorkMinutes.disabled = running;
  els.customBreakMinutes.disabled = running;
  els.focusRounds.disabled = running;
  els.customRounds.disabled = running;
  els.workMinutes.classList.toggle("locked", running);
  els.breakMinutes.classList.toggle("locked", running);

  renderFocusStatus();
}

function renderFocusStatus() {
  const focus = settings.focus;
  if (!focus.active) {
    els.focusStatus.textContent = "Idle";
    els.focusStatus.classList.remove("running");
    return;
  }
  const remaining = formatDuration(focus.endsAt - Date.now());
  const round = focus.rounds > 0 ? ` · round ${focus.round + 1}/${focus.rounds}` : "";
  els.focusStatus.textContent = (focus.state === "working" ? "Focus" : "Break") + round + " · " + remaining;
  els.focusStatus.classList.add("running");
}

function render() {
  document.body.classList.toggle("disabled", !settings.enabled);
  els.accessWarning.hidden = hasSiteAccess;
  els.toggle.checked = settings.enabled;

  const permanent = settings.blockedSites.length;
  const timed = Object.keys(settings.timedBlocks || {}).filter(
    (s) => settings.timedBlocks[s] > Date.now()
  ).length;
  const focus = settings.focus;
  const focusBlocked = focus.active && focus.state === "working" ? focus.sites.length : 0;

  let status;
  if (!settings.enabled) {
    status = permanent + timed ? `Blocking is off · ${permanent + timed} saved` : "Blocking is off";
  } else {
    const total = permanent + timed + focusBlocked;
    status = total ? `Blocking ${total} site${total === 1 ? "" : "s"}` : "Blocking is on";
  }
  els.status.textContent = status;

  renderCurrentSite();
  renderList();
  renderFocus();
}

// Keep the countdowns ticking while the popup stays open.
let statusTick = 0;
function startTicking() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    const focus = settings.focus;
    if (focus.active) renderFocusStatus();
    if (settings.timedBlocks && Object.keys(settings.timedBlocks).length) renderList();
    // Re-check the rules now and then, not every second.
    if (++statusTick % 5 === 0) checkRuleStatus();
  }, 1000);
}

function stopTicking() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

// ---------- actions ----------

async function addSite(site, { reloadCurrentTab = false, minutes = 0 } = {}) {
  const patch = {};
  if (minutes > 0) {
    // A timed block stands on its own: it must not also be a permanent block,
    // and it replaces an existing permanent block of the same site.
    patch.timedBlocks = { ...settings.timedBlocks, [site]: Date.now() + minutes * 60 * 1000 };
    patch.blockedSites = settings.blockedSites.filter((s) => s !== site);
  } else if (!settings.blockedSites.includes(site)) {
    patch.blockedSites = [...settings.blockedSites, site].sort();
  }
  settings = { ...settings, ...patch };
  render();
  await save(patch);
  if (reloadCurrentTab && currentTab) {
    // Apply the new rule first, otherwise the reload slips through unblocked.
    await syncNow();
    chrome.tabs.reload(currentTab.id);
  }
}

// duration chips ("block for X minutes")
els.durationOptions.addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  for (const other of els.durationOptions.querySelectorAll(".chip")) {
    other.classList.toggle("active", other === chip);
  }
  selectedMinutes = chip.dataset.minutes === "custom" ? "custom" : Number(chip.dataset.minutes);
  els.customMinutes.hidden = selectedMinutes !== "custom";
  if (selectedMinutes === "custom" && !els.customMinutes.value) {
    els.customMinutes.value = 30;
  }
});

els.toggle.addEventListener("change", async () => {
  settings = { ...settings, enabled: els.toggle.checked };
  render();
  await save({ enabled: settings.enabled });
});

els.addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const raw = els.input.value;
  const site = normalizeDomain(raw);
  if (!site) {
    showError("Enter a valid site, like example.com");
    return;
  }
  if (settings.blockedSites.includes(site)) {
    showError(site + " is already blocked");
    return;
  }
  const minutes = chosenMinutes();
  if (selectedMinutes === "custom" && minutes === 0) {
    showError("Enter how many minutes to block for");
    return;
  }
  const alreadyTimed = (settings.timedBlocks || {})[site];
  if (alreadyTimed && minutes > 0) {
    showError(site + " is already blocked (temporarily)");
    return;
  }
  els.input.value = "";
  const reload = currentTab && matchBlocked(currentTab.host, [site]) !== null;
  await addSite(site, { reloadCurrentTab: reload, minutes });
  els.input.focus();
});

els.input.addEventListener("input", () => showError(""));

// ---------- focus mode ----------

els.focusAddForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const site = normalizeDomain(els.focusDomainInput.value);
  if (!site) {
    showFocusError("Enter a valid site, like example.com");
    return;
  }
  const sites = settings.focus.sites || [];
  if (sites.includes(site)) {
    showFocusError(site + " is already in the focus list");
    return;
  }
  showFocusError("");
  els.focusDomainInput.value = "";
  await saveFocus((latest) => ({
    ...latest,
    sites: [...(latest.sites || []), site],
  }));
});

els.focusDomainInput.addEventListener("input", () => showFocusError(""));

els.workMinutes.addEventListener("change", () => {
  if (els.workMinutes.value === "custom") {
    if (!els.customWorkMinutes.value) els.customWorkMinutes.value = 25;
    workChoice = { preset: "custom", custom: Number(els.customWorkMinutes.value) || 25 };
  } else {
    workChoice = { preset: els.workMinutes.value, custom: workChoice.custom };
  }
  els.customWorkMinutes.hidden = els.workMinutes.value !== "custom";
});

els.customWorkMinutes.addEventListener("input", () => {
  workChoice = { preset: "custom", custom: Number(els.customWorkMinutes.value) || 25 };
});

els.breakMinutes.addEventListener("change", () => {
  if (els.breakMinutes.value === "custom") {
    if (!els.customBreakMinutes.value) els.customBreakMinutes.value = 5;
    breakChoice = { preset: "custom", custom: Number(els.customBreakMinutes.value) || 5 };
  } else {
    breakChoice = { preset: els.breakMinutes.value, custom: breakChoice.custom };
  }
  els.customBreakMinutes.hidden = els.breakMinutes.value !== "custom";
});

els.customBreakMinutes.addEventListener("input", () => {
  breakChoice = { preset: "custom", custom: Number(els.customBreakMinutes.value) || 5 };
});

els.focusRounds.addEventListener("change", () => {
  if (els.focusRounds.value === "custom") {
    if (!els.customRounds.value) els.customRounds.value = 3;
    roundsChoice = { preset: "custom", custom: Number(els.customRounds.value) || 3 };
  } else {
    roundsChoice = { preset: els.focusRounds.value, custom: roundsChoice.custom };
  }
  els.customRounds.hidden = els.focusRounds.value !== "custom";
});

els.customRounds.addEventListener("input", () => {
  roundsChoice = { preset: "custom", custom: Number(els.customRounds.value) || 3 };
});

els.focusStartBtn.addEventListener("click", async () => {
  const focus = settings.focus;
  // A session is already running: never restart it. (The button is hidden
  // while a session runs, but guard anyway so the running timer can't be
  // reset by any stray click.)
  if (focus.active) {
    showFocusError("A focus session is already running. Stop it first.");
    return;
  }
  if (!focus.sites || focus.sites.length === 0) {
    showFocusError("Add at least one site to focus on");
    return;
  }
  showFocusError("");
  const workMinutes = chosenWorkMinutes();
  const breakMinutes = chosenBreakMinutes();
  const rounds = chosenRounds();
  await saveFocus({
    active: true,
    state: "working",
    workMinutes,
    breakMinutes,
    rounds,
    endsAt: Date.now() + workMinutes * 60 * 1000,
    round: 0,
  });
  await syncNow();
});

els.focusStopBtn.addEventListener("click", async () => {
  await saveFocus({ active: false, state: "idle", endsAt: 0, round: 0 });
  await syncNow();
});

// ---------- init ----------

(async function init() {
  const revisionAtStart = localRevision;
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  // If the user already changed something while we were reading, keep the
  // newer local state instead of clobbering it with this stale snapshot.
  if (localRevision === revisionAtStart) {
    settings = {
      ...DEFAULT_SETTINGS,
      ...stored,
      focus: { ...DEFAULT_SETTINGS.focus, ...(stored.focus || {}) },
    };
  }

  // Show the stored timings, but keep them as a starting point for the next
  // session rather than overwriting the user's choice on every render.
  const focus = settings.focus;
  const workValue = String(focus.workMinutes);
  if (WORK_PRESETS.includes(workValue)) {
    workChoice = { preset: workValue, custom: workChoice.custom };
    els.workMinutes.value = workValue;
    els.customWorkMinutes.hidden = true;
  } else {
    workChoice = { preset: "custom", custom: focus.workMinutes };
    els.workMinutes.value = "custom";
    els.customWorkMinutes.value = focus.workMinutes;
    els.customWorkMinutes.hidden = false;
  }
  const breakValue = String(focus.breakMinutes);
  if (BREAK_PRESETS.includes(breakValue)) {
    breakChoice = { preset: breakValue, custom: breakChoice.custom };
    els.breakMinutes.value = breakValue;
    els.customBreakMinutes.hidden = true;
  } else {
    breakChoice = { preset: "custom", custom: focus.breakMinutes };
    els.breakMinutes.value = "custom";
    els.customBreakMinutes.value = focus.breakMinutes;
    els.customBreakMinutes.hidden = false;
  }

  const roundsValue = String(focus.rounds || 0);
  if (ROUND_PRESETS.includes(roundsValue)) {
    roundsChoice = { preset: roundsValue, custom: roundsChoice.custom };
    els.focusRounds.value = roundsValue;
    els.customRounds.hidden = true;
  } else if (roundsValue === "0") {
    roundsChoice = { preset: "0", custom: roundsChoice.custom };
    els.focusRounds.value = "0";
    els.customRounds.hidden = true;
  } else {
    roundsChoice = { preset: "custom", custom: Number(focus.rounds) || 3 };
    els.focusRounds.value = "custom";
    els.customRounds.value = focus.rounds;
    els.customRounds.hidden = false;
  }

  try {
    hasSiteAccess = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  } catch {
    hasSiteAccess = true; // cannot check; assume access is fine
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const host = tab ? siteFromTabUrl(tab.url) : null;
    currentTab = host ? { id: tab.id, host } : null;
  } catch {
    currentTab = null;
  }

  render();
  // Opening the popup rebuilds the rules once, which repairs them if they
  // somehow went missing, then reports their real state.
  await syncNow();
  await checkRuleStatus();
  els.input.focus();
  startTicking();
})();

window.addEventListener("unload", stopTicking);

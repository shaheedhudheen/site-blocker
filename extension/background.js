// Site Blocker service worker.
//
// Keeps declarativeNetRequest dynamic rules in sync with the blocked list
// stored in chrome.storage.sync. Three kinds of blocked site are supported:
//
//   - permanent blocks  (blockedSites: string[])
//   - timed blocks      (timedBlocks: { domain: expiry timestamp })
//   - focus sessions    (focus: pomodoro style timer - its sites are blocked
//                        while the focus phase runs and released on breaks)
//
// Timers are driven by chrome.alarms so they keep working after the service
// worker is shut down (which happens after ~30s of inactivity) and after the
// browser is restarted.
//
// Blocking rules only intercept *navigations*, so a page that was already
// open when a site got blocked would keep working. To make blocking actually
// stick, open tabs are reconciled after every change: a tab sitting on a
// newly blocked site is reloaded so it hits the blocked page.

const DEFAULT_SETTINGS = {
  enabled: true,
  blockedSites: [],
  timedBlocks: {},
  focus: {
    active: false,
    sites: [],
    workMinutes: 25,
    breakMinutes: 5,
    rounds: 0, // 0 = keep going until stopped
    state: "idle", // idle | working | break
    endsAt: 0, // timestamp when the current phase ends
    round: 0, // completed focus rounds
  },
};

// Block top-level navigations only. Embedded frames on other sites are left
// alone, so blocking e.g. youtube.com doesn't break videos embedded elsewhere.
const RESOURCE_TYPES = ["main_frame"];

const ALARM_NEXT = "site-blocker-next"; // fires exactly when the next thing happens
const ALARM_TICK = "site-blocker-tick"; // safety net while timers are running

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const MAX_MINUTES = 7 * 24 * 60; // one week

function isValidSite(site) {
  return typeof site === "string" && (site === "localhost" || IPV4_RE.test(site) || HOSTNAME_RE.test(site));
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clampMinutes(value, fallback) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
  return Math.min(MAX_MINUTES, Math.round(minutes));
}

function normalizeSettings(raw) {
  const focus = { ...DEFAULT_SETTINGS.focus, ...(raw.focus && typeof raw.focus === "object" ? raw.focus : {}) };
  return {
    enabled: raw.enabled !== false,
    blockedSites: Array.isArray(raw.blockedSites) ? raw.blockedSites.filter(isValidSite) : [],
    timedBlocks: raw.timedBlocks && typeof raw.timedBlocks === "object" ? raw.timedBlocks : {},
    focus: {
      active: focus.active === true,
      sites: Array.isArray(focus.sites) ? focus.sites.filter(isValidSite) : [],
      workMinutes: clampMinutes(focus.workMinutes, DEFAULT_SETTINGS.focus.workMinutes),
      breakMinutes: clampMinutes(focus.breakMinutes, DEFAULT_SETTINGS.focus.breakMinutes),
      rounds: Number.isFinite(Number(focus.rounds)) ? Math.max(0, Math.min(99, Math.round(Number(focus.rounds)))) : 0,
      state: focus.state === "working" || focus.state === "break" ? focus.state : "idle",
      endsAt: Number(focus.endsAt) || 0,
      round: Number(focus.round) || 0,
    },
  };
}

// Move a focus session on to whatever phase it should be in by now. If the
// browser was closed for a long time this jumps straight to the right phase.
function advanceFocus(focus, now) {
  const next = { ...focus };
  let guard = 0;
  while (next.active && next.endsAt && now >= next.endsAt && guard++ < 100) {
    if (next.state === "working") {
      next.state = "break";
      next.endsAt = now + next.breakMinutes * 60 * 1000;
    } else {
      next.round += 1;
      if (next.rounds > 0 && next.round >= next.rounds) {
        next.active = false;
        next.state = "idle";
        next.endsAt = 0;
        next.round = 0;
      } else {
        next.state = "working";
        next.endsAt = now + next.workMinutes * 60 * 1000;
      }
    }
  }
  return next;
}

// The sites that should be blocked right now, and why.
function blockedEntries(settings, now) {
  const entries = new Map();

  for (const site of settings.blockedSites) {
    entries.set(site, { mode: "permanent", until: 0 });
  }
  for (const [site, expiry] of Object.entries(settings.timedBlocks)) {
    if (expiry > now && !entries.has(site)) {
      entries.set(site, { mode: "timed", until: expiry });
    }
  }
  const focus = settings.focus;
  if (focus.active && focus.state === "working") {
    for (const site of focus.sites) {
      if (!entries.has(site)) {
        entries.set(site, { mode: "focus", until: focus.endsAt });
      }
    }
  }
  return entries;
}

// Does this host belong to a blocked site? (exact match or a subdomain)
function hostIsBlocked(host, entries) {
  if (!host) return null;
  host = host.toLowerCase();
  for (const [site, entry] of entries) {
    if (host === site || host.endsWith("." + site)) return entry;
  }
  return null;
}

// One rule per blocked site: match the site's domain (and its subdomains, but
// not look-alike domains such as "example.com.evil.com") and redirect to the
// blocked page. "\0" is the full matched URL.
//
// The query string tells the blocked page why it is blocked and until when.
// The original URL goes last because it is substituted raw and may itself
// contain "&".
function buildRule(site, id, entry) {
  const domain = escapeRegex(site);
  const params = [];
  if (entry.mode !== "permanent") params.push("mode=" + entry.mode);
  if (entry.until) params.push("until=" + entry.until);
  const query = params.length ? "?" + params.join("&") + "&url=" : "?url=";

  return {
    id,
    priority: 1,
    action: {
      type: "redirect",
      redirect: { regexSubstitution: chrome.runtime.getURL("blocked.html") + query + "\\0" },
    },
    condition: {
      regexFilter: "^https?://([^/?#]*\\.)?" + domain + "(?::[0-9]+)?(?:[/?#].*)?$",
      resourceTypes: RESOURCE_TYPES,
    },
  };
}

// Serialize syncs so parallel triggers (storage change, messages, startup,
// alarms) can never interleave their remove/add operations.
let syncChain = Promise.resolve();

// The last error from installing the rules, and how many rules are actually
// in place. The popup shows this, so a user whose blocking silently does
// nothing can find out why instead of guessing.
let lastRuleError = null;

function syncRules() {
  syncChain = syncChain.then(doSyncRules, doSyncRules);
  return syncChain;
}

// How many rules should be in place right now.
function expectedRuleCount(settings, now) {
  if (!settings.enabled) return 0;
  return blockedEntries(settings, now).size;
}

// Report the real state of the blocking rules back to the popup.
async function reportRuleStatus(settings, now) {
  const status = {
    ok: lastRuleError === null,
    expected: expectedRuleCount(settings, now),
    installed: 0,
    error: lastRuleError,
    at: Date.now(),
  };
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    status.installed = Array.isArray(rules) ? rules.length : 0;
  } catch (error) {
    status.ok = false;
    status.error = lastRuleError || String(error && error.message ? error.message : error);
  }
  try {
    await chrome.storage.local.set({ ruleStatus: status });
  } catch {
    // not fatal
  }
  return status;
}

async function doSyncRules() {
  let raw;
  try {
    raw = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  } catch (error) {
    console.error("[Site Blocker] could not read settings:", error);
    return;
  }

  const settings = normalizeSettings(raw);
  const now = Date.now();

  // Move the focus session to the phase it should be in.
  const advanced = advanceFocus(settings.focus, now);
  const focusChanged =
    advanced.active !== settings.focus.active ||
    advanced.state !== settings.focus.state ||
    advanced.endsAt !== settings.focus.endsAt ||
    advanced.round !== settings.focus.round;

  if (focusChanged) {
    // Write back only the phase fields, and only if the session wasn't
    // changed by the user while we were working. Merging with the latest
    // stored value keeps sites/durations the user edited in the meantime.
    try {
      const latestRaw = await chrome.storage.sync.get({ focus: DEFAULT_SETTINGS.focus });
      const latest = normalizeSettings({ focus: latestRaw.focus }).focus;
      const untouched =
        latest.active === (raw.focus && raw.focus.active) &&
        latest.endsAt === (raw.focus && raw.focus.endsAt);
      if (untouched) {
        const merged = {
          ...latest, // keeps sites, durations and rounds
          active: advanced.active,
          state: advanced.state,
          endsAt: advanced.endsAt,
          round: advanced.round,
        };
        await chrome.storage.sync.set({ focus: merged });
        settings.focus = merged;
      } else {
        // The user changed the session meanwhile - use their version.
        settings.focus = latest;
      }
    } catch (error) {
      console.error("[Site Blocker] could not save timer state:", error);
    }
  }
  // Forget timed blocks that have expired, without touching blocks the user
  // added in the meantime.
  try {
    const latest = (await chrome.storage.sync.get({ timedBlocks: {} })).timedBlocks || {};
    const next = { ...latest };
    let removed = false;
    for (const [site, expiry] of Object.entries(next)) {
      if (expiry <= now) {
        delete next[site];
        removed = true;
      }
    }
    if (removed) await chrome.storage.sync.set({ timedBlocks: next });
    settings.timedBlocks = next;
  } catch (error) {
    console.error("[Site Blocker] could not clean up timed blocks:", error);
  }

  const entries = blockedEntries(settings, now);
  const addRules = [];
  if (settings.enabled) {
    let id = 1;
    for (const [site, entry] of entries) {
      addRules.push(buildRule(site, id++, entry));
    }
  }

  let existing = [];
  try {
    existing = await chrome.declarativeNetRequest.getDynamicRules();
  } catch {
    // fall through - updateDynamicRules below will surface the real problem
  }

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((rule) => rule.id),
      addRules,
    });
    lastRuleError = null;
  } catch (error) {
    lastRuleError = String(error && error.message ? error.message : error);
    console.error("[Site Blocker] failed to update blocking rules:", error);
  }

  await reportRuleStatus(settings, now);
  await reconcileTabs(entries);
  await scheduleAlarms(settings, now);
}

// Reload tabs that are sitting on a site that just became blocked, so
// blocking takes effect without the user having to refresh manually.
async function reconcileTabs(entries) {
  let previous = [];
  try {
    previous = (await chrome.storage.local.get({ lastBlocked: [] })).lastBlocked || [];
  } catch {
    previous = [];
  }

  const current = [...entries.keys()];
  const newlyBlocked = current.filter((site) => !previous.includes(site));

  try {
    await chrome.storage.local.set({ lastBlocked: current });
  } catch {
    // not fatal
  }

  if (!newlyBlocked.length) return;

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (error) {
    console.error("[Site Blocker] could not list tabs:", error);
    return;
  }

  for (const tab of tabs) {
    if (typeof tab.id !== "number" || !tab.url) continue;
    // Our own blocked page navigates itself when the block lifts.
    if (tab.url.startsWith("chrome-extension://")) continue;

    let host;
    try {
      host = new URL(tab.url).hostname;
    } catch {
      continue;
    }
    const entry = hostIsBlocked(host, entries);
    if (!entry) continue;
    // Only reload tabs on sites that just became blocked, so a tab that is
    // already showing the blocked page is left alone.
    if (!newlyBlocked.some((site) => host === site || host.endsWith("." + site))) continue;

    try {
      await chrome.tabs.reload(tab.id);
    } catch (error) {
      // The tab may have been closed already; that is fine.
    }
  }
}

// Make sure we wake up exactly when the next timer expires, plus a slow
// safety net in case that alarm is missed.
async function scheduleAlarms(settings, now) {
  const pending = [];
  if (settings.focus.active && settings.focus.endsAt > now) {
    pending.push(settings.focus.endsAt);
  }
  for (const expiry of Object.values(settings.timedBlocks)) {
    if (expiry > now) pending.push(expiry);
  }

  try {
    await chrome.alarms.clear(ALARM_NEXT);
    await chrome.alarms.clear(ALARM_TICK);
    if (pending.length) {
      await chrome.alarms.create(ALARM_NEXT, { when: Math.min(...pending) });
      await chrome.alarms.create(ALARM_TICK, { periodInMinutes: 1 });
    }
  } catch (error) {
    console.error("[Site Blocker] could not schedule timers:", error);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  syncRules();
});

chrome.runtime.onStartup.addListener(() => {
  syncRules();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && (changes.blockedSites || changes.enabled || changes.timedBlocks || changes.focus)) {
    syncRules();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NEXT || alarm.name === ALARM_TICK) {
    syncRules();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === "syncNow") {
    syncRules().then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false })
    );
    return true; // keep the message channel open for the async response
  }

  // Asked by the popup: are the blocking rules actually in place?
  if (message.type === "getRuleStatus") {
    (async () => {
      // Wait for any sync already in flight, otherwise the rules could still
      // be on their way in and the popup would report a false problem. Do not
      // start a new sync here: the popup asks every few seconds, and rebuilding
      // every rule each time would be wasteful.
      try {
        await syncChain;
      } catch {
        // A failed sync is reported through lastRuleError below.
      }
      const raw = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      const settings = normalizeSettings(raw);
      const status = await reportRuleStatus(settings, Date.now());
      sendResponse(status);
    })();
    return true;
  }

  // Asked by the blocked page: is this site still blocked right now?
  if (message.type === "getBlockState") {
    (async () => {
      const raw = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      const settings = normalizeSettings(raw);
      const entries = blockedEntries(settings, Date.now());
      const entry = hostIsBlocked(message.host, entries);
      sendResponse({
        blocked: !!entry,
        mode: entry ? entry.mode : null,
        until: entry ? entry.until : 0,
        enabled: settings.enabled,
      });
    })();
    return true;
  }

  return false;
});

// Also self-heal whenever the service worker wakes up.
syncRules();

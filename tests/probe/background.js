// Probe service worker used ONLY to discover which declarativeNetRequest
// redirect techniques are accepted and actually work in this Chromium build.
// It runs a sequence of phases, records the outcome of each, and finally
// navigates a tab to the local report endpoint of the test harness.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXT_ID = chrome.runtime.id;
const BLOCKED_PAGE = chrome.runtime.getURL("blocked.html");
const LOCAL_URL = "http://127.0.0.1:8765/page";

const LOCAL_MATCH = {
  urlFilter: "||127.0.0.1^",
  regex: "^https?://127\\.0\\.0\\.1(?::[0-9]+)?(?:[/?#].*)?$",
  site: "127.0.0.1",
};
const REMOTE_MATCH = {
  urlFilter: "||example.com^",
  regex: "^https?://([^/?#]*\\.)?example\\.com(?::[0-9]+)?(?:[/?#].*)?$",
  site: "example.com",
};

function makeVariants(match) {
  const uf = (redirect) => ({
    id: 1,
    priority: 1,
    action: { type: "redirect", redirect },
    condition: { urlFilter: match.urlFilter, resourceTypes: ["main_frame"] },
  });
  const rx = (redirect) => ({
    id: 1,
    priority: 1,
    action: { type: "redirect", redirect },
    condition: { regexFilter: match.regex, resourceTypes: ["main_frame"] },
  });
  return {
    V1_extensionPath: () => uf({ extensionPath: "/blocked.html" }),
    V2_extPath_qTransform: () =>
      uf({
        extensionPath: "/blocked.html",
        transform: { queryTransform: { addOrReplaceParams: [{ key: "site", value: match.site }] } },
      }),
    V3_extPath_queryInPath: () => uf({ extensionPath: "/blocked.html?site=" + match.site }),
    V4_regexSub: () => rx({ regexSubstitution: BLOCKED_PAGE + "?url=\\0" }),
    V5_urlField: () => uf({ url: BLOCKED_PAGE + "?site=" + match.site }),
    V6_transformScheme: () =>
      uf({
        transform: {
          scheme: "chrome-extension",
          host: EXT_ID,
          path: "/blocked.html",
          query: "?site=" + match.site,
        },
      }),
    V7_transformQTransformSub: () =>
      rx({
        transform: {
          scheme: "chrome-extension",
          host: EXT_ID,
          path: "/blocked.html",
          queryTransform: { addOrReplaceParams: [{ key: "url", value: "\\0" }] },
        },
      }),
  };
}

const results = [];

async function clearRules() {
  const old = await chrome.declarativeNetRequest.getDynamicRules();
  if (old.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.map((r) => r.id) });
  }
}

async function tryAddRule(rule) {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
    return { accepted: true, error: null };
  } catch (e) {
    return { accepted: false, error: String((e && e.message) || e) };
  }
}

// Create a tab, wait for it to finish loading (polling - race free), return final URL.
async function visit(url, timeoutMs = 12000) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (e) {
    return "(tab-create-failed: " + String(e) + ")";
  }
  const start = Date.now();
  await sleep(300);
  while (Date.now() - start < timeoutMs) {
    let t;
    try {
      t = await chrome.tabs.get(tab.id);
    } catch {
      return "(tab-closed)";
    }
    if (t.status === "complete" && t.url && t.url !== "about:blank") {
      const finalUrl = t.url;
      await chrome.tabs.remove(tab.id).catch(() => {});
      return finalUrl;
    }
    await sleep(150);
  }
  await chrome.tabs.remove(tab.id).catch(() => {});
  return "(timeout waiting for load)";
}

async function phase(label, rule, url) {
  const rec = { label, requested: url, accepted: null, error: null, finalUrl: null };
  if (rule) {
    const a = await tryAddRule(rule);
    rec.accepted = a.accepted;
    rec.error = a.error;
    if (!a.accepted) {
      results.push(rec);
      await clearRules();
      return;
    }
  } else {
    await clearRules();
  }
  rec.finalUrl = await visit(url);
  await clearRules();
  results.push(rec);
  // Persist progress so the harness can read partial state if reporting fails.
  await chrome.storage.local.set({ probeProgress: results }).catch(() => {});
}

async function main() {
  const { probeDone } = await chrome.storage.local.get("probeDone");
  if (probeDone) return;
  await chrome.storage.local.set({ probeDone: true });

  try {
    await phase("control-local (no rules)", null, LOCAL_URL);

    const localVariants = makeVariants(LOCAL_MATCH);
    for (const [name, build] of Object.entries(localVariants)) {
      await phase(name, build(), LOCAL_URL);
    }

    // Encoding checks for the regexSubstitution technique: what exactly lands
    // in the blocked page URL when the original URL contains "&" or "%xx"?
    await phase("V4-query-amp", localVariants.V4_regexSub(), "http://127.0.0.1:8765/page?a=1&b=2");
    await phase("V4-percent-path", localVariants.V4_regexSub(), "http://127.0.0.1:8765/pct%20name?q=1");

    const winner = results.find(
      (r) => typeof r.finalUrl === "string" && r.finalUrl.startsWith("chrome-extension://")
    );
    results.push({ label: "WINNER", winner: winner ? winner.label : null, finalUrl: winner ? winner.finalUrl : null });

    if (winner && localVariants[winner.label]) {
      const remoteRule = makeVariants(REMOTE_MATCH)[winner.label]();
      await phase("remote-main (winner rule, example.com)", remoteRule, "https://example.com/");
      await phase("remote-subdomain (winner rule, www.example.com)", remoteRule, "https://www.example.com/");
    }

    await phase("control-remote (no rules, example.org)", null, "https://example.org/");
  } catch (e) {
    results.push({ label: "FATAL", error: String((e && e.stack) || e) });
  }

  const payload = encodeURIComponent(JSON.stringify({ extId: EXT_ID, results }));
  try {
    await chrome.tabs.create({ url: "http://127.0.0.1:8765/report?data=" + payload, active: false });
  } catch (e) {
    results.push({ label: "REPORT-FAIL", error: String(e) });
  }
  await chrome.storage.local.set({ probeProgress: results, probeComplete: true });
}

chrome.runtime.onInstalled.addListener(() => {
  main();
});

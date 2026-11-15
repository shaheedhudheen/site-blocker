// Permission page: Firefox treats host permissions as optional and does not
// grant them at install time, so the extension asks for them from this page.
//
// The prompt has to come from a user gesture. A full page is used instead of
// the popup because the popup closes as soon as the browser shows the prompt,
// which would cancel the request.

// Firefox exposes a promise-based "browser" namespace. Chrome only has
// "chrome", but its Manifest V3 methods return promises too.
const api = globalThis.browser ?? globalThis.chrome;

const titleEl = document.getElementById("title");
const hintEl = document.getElementById("hint");
const grantBtn = document.getElementById("grant");
const closeBtn = document.getElementById("close");
const messageEl = document.getElementById("message");

const ORIGINS = { origins: ["<all_urls>"] };

function showMessage(text) {
  messageEl.textContent = text;
  messageEl.hidden = false;
}

async function closeTab() {
  try {
    const tab = await api.tabs.getCurrent();
    if (tab && typeof tab.id === "number") {
      await api.tabs.remove(tab.id);
      return;
    }
  } catch {
    // fall through
  }
  window.close();
}

function showGranted() {
  titleEl.textContent = "Access granted";
  hintEl.textContent = "Blocking is now active. Anything on your blocklist will be intercepted.";
  grantBtn.hidden = true;
  closeBtn.textContent = "Close";
  showMessage("You can close this tab.");
}

async function refresh() {
  let granted = false;
  try {
    granted = await api.permissions.contains(ORIGINS);
  } catch {
    // Cannot check; leave the button available.
    return;
  }
  if (granted) showGranted();
}

grantBtn.addEventListener("click", async () => {
  grantBtn.disabled = true;
  let granted = false;
  try {
    granted = await api.permissions.request(ORIGINS);
  } catch (error) {
    grantBtn.disabled = false;
    showMessage(
      "The browser could not show the permission prompt: " +
        (error && error.message ? error.message : error)
    );
    return;
  }

  if (!granted) {
    grantBtn.disabled = false;
    showMessage("Access was not granted. Blocking stays off until you allow it.");
    return;
  }

  // Host access is in place; rebuild the rules so blocking starts right away.
  try {
    await api.runtime.sendMessage({ type: "syncNow" });
  } catch {
    // storage.onChanged also triggers a sync
  }
  showGranted();
});

closeBtn.addEventListener("click", () => {
  closeTab();
});

refresh();

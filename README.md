# Site Blocker

A small Chromium (Manifest V3) extension that blocks websites you choose, so you
can't open them by accident.

When you try to visit a blocked site, the page is replaced with a friendly
"Site blocked" page. From there you can go back, or unblock the site if you
really mean it.

## Features

- **Blocklist in the toolbar popup** – add any domain (e.g. `youtube.com`,
  `reddit.com`) and it is blocked along with all of its subdomains.
- **Timed blocks** – block a site for a set amount of time (15 min, 30 min,
  1 hour, 2 hours, or any custom number of minutes). It unlocks itself when
  the timer runs out.
- **Focus mode (pomodoro)** – pick a set of sites, choose a work length and a
  break length, and start a session. Your focus sites are blocked during the
  work phase and let through during the break, then the cycle repeats.
- **Global on/off switch** – pause blocking without losing your list.
- **Block the current site in one click** – a shortcut when you're on a page
  you want gone.
- **Custom "blocked" page** – shows why the site is blocked, with a live
  countdown for timed blocks and focus sessions. Offers *Go back* and
  *Unblock and visit* (timed blocks also offer *Cancel timer and visit*).
- **Synced settings** – the list is stored in `chrome.storage.sync`, so it
  follows your browser profile.
- **No page access** – blocking uses the browser's native
  `declarativeNetRequest` engine. The extension never reads or modifies page
  content.

## Project layout

```
extension/   the unpacked extension (load this folder)
tests/       development test harness (not part of the extension)
README.md
```

Load `extension/` in the browser; `tests/` stays outside the packaged
extension.

## Install (from source)

1. Open the extensions page of your browser:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`
   - Opera: `opera://extensions` (enable Developer mode first)
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the `extension` folder (the one
   containing `manifest.json`).
4. Pin the extension from the puzzle-piece menu so you can see it in the
   toolbar.

## Usage

- Click the toolbar icon to open the popup.
- Type a domain such as `news.ycombinator.com` and press **Block**. Only the
  domain is used: `https://www.example.com/page?q=1` becomes `example.com`.
- Use the **For** row to pick how long the block lasts: *Always* (permanent),
  a preset (15 min / 30 min / 1 hour / 2 hours) or *Custom* for any number of
  minutes. Timed blocks show a countdown badge and unlock automatically.
- **Focus mode** (bottom of the popup) is the pomodoro timer:
  1. Add the sites you want to avoid during work.
  2. Choose a work length (15/25/50 min or custom) and a break length
     (5/10/15 min or custom).
  3. Press **Start focus session**. Those sites are blocked while you work
     and open freely during the break.
  Press **Stop session** to end it early.
- Use the **toggle** in the popup header to pause/resume blocking.
- While browsing, the popup shows the current site with a one-click
  **Block this site / Unblock** button.
- If you open a blocked site, you'll see the blocked page with a
  **Go back** and **Unblock and visit** button, plus a countdown if the block
  is temporary.

### Focus mode details

- A focus session runs one work phase, then one break phase, then repeats.
- The work and break lengths are **locked while a session is running** – stop
  the session first if you want to change them.
- Your focus sites are blocked during the work phase and open freely during
  the break. When the break starts, the blocked page sends you straight to
  the site on its own – no manual refresh needed.
- Adding a site to the focus list takes effect immediately, even mid-session.
- Timers keep running if you close the browser: they are driven by
  `chrome.alarms`, so the extension wakes up when a phase ends.
- If the browser was closed for a long time, the session jumps straight to
  the correct phase when you come back.
- Focus sites are blocked only during the work phase. There is deliberately
  no "unblock" button on the blocked page during a focus session – stop the
  session from the popup if you want out.

### Blocking already-open tabs

Blocking rules only intercept *navigations*, so a page that was already open
when you added a site to your blocklist would otherwise keep working. The
extension watches for this: when a site becomes blocked, any open tab showing
it is reloaded straight into the blocked page. The same happens when you block
the site you are currently on.

## How it works

- `background.js` (service worker) keeps a set of dynamic
  `declarativeNetRequest` rules in sync with the blocked list. Each rule
  redirects top-level navigations to `blocked.html`.
- Each blocked site gets one rule with a small regex: it matches the domain
  and all of its subdomains, but not look-alike domains like
  `example.com.evil.com`. The redirect passes the original URL along, so the
  blocked page can show the site and offer "Unblock and visit".
- Three kinds of block are supported: permanent (`blockedSites`), timed
  (`timedBlocks`, each with an expiry timestamp) and focus sessions
  (`focus`, blocked only during the work phase).
- Timers are driven by `chrome.alarms`, so they keep working after the
  service worker is shut down and after the browser restarts.
- Redirect rules need host access, which is why the extension asks for access
  to all sites. If that access is revoked in the browser's extension settings,
  blocking silently stops working - the popup shows a warning in that case.
- `popup.html` / `popup.js` manage the list in `chrome.storage.sync`.
- `blocked.html` reads the blocked site from the redirect URL and offers to
  unblock it.

## Tests

The `tests` folder contains the test harness used while building the
extension. It is not part of the extension itself and can be deleted.
(Chrome reserves top-level names starting with `_`, so this folder must not
be named `_test`.) It has
no dependencies beyond Node.js and a Chromium browser.

Note: branded Google Chrome (137+) ignores `--load-extension` for anti-malware
reasons, so the automated tests prefer Microsoft Edge. Override the browser
with the `TEST_BROWSER` environment variable if needed.

- `node tests/run.mjs` - runs a probe extension that measures which
  `declarativeNetRequest` redirect techniques work in your browser build
  (`node tests/run.mjs a` runs only the host-permissions variant).
- `node tests/e2e.mjs` - end-to-end test of the real extension: seeds the
  blocked list, navigates to a blocked site, and checks that the blocked page
  appears, that unblocking works, and that disabling clears all rules.
- `node tests/focus.mjs` - regression tests for the focus-mode bugs: locked
  timer, automatic release at the break, focus sites always blocking, and
  already-open tabs being blocked.
- `node tests/edge.mjs` - edge cases: the next work round re-blocking,
  stopping a session, the global switch, and timed blocks vs focus sites.

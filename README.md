# Site Blocker

A small Manifest V3 extension for Chrome, Edge and Firefox that blocks websites
you choose, so you can't open them by accident.

When you try to visit a blocked site, the page is replaced with a friendly
"Site blocked" page. From there you can go back, or unblock the site if you
really mean it.

MIT licensed.

## Features

- **Blocklist in the toolbar popup** – add any domain (e.g. `youtube.com`,
  `reddit.com`) and it is blocked along with all of its subdomains.
- **Timed blocks** – block a site for a set amount of time (15 min, 30 min,
  1 hour, 2 hours, or any custom number of minutes). It unlocks itself when
  the timer runs out.
- **Focus mode (pomodoro)** – pick a set of sites, choose a work length and a
  break length, and start a session. Your focus sites are blocked during the
  work phase and let through during the break, then the cycle repeats. Set a
  number of rounds to let the session end on its own, or leave it running
  until you stop it.
- **Global on/off switch** – pause blocking without losing your list.
- **Block the current site in one click** – a shortcut when you're on a page
  you want gone.
- **Custom "blocked" page** – shows why the site is blocked, with a live
  countdown for timed blocks and focus sessions. Offers *Go back* and
  *Unblock and visit* (timed blocks also offer *Cancel timer and visit*).
- **Synced settings** – the list is stored in the browser's sync storage, so
  it follows your browser profile.
- **No page access** – blocking uses the browser's native
  `declarativeNetRequest` engine. The extension never reads or modifies page
  content.

## Project layout

```
extension/       the unpacked extension (load this folder in Chromium browsers)
tests/           development test harness (not part of the extension)
store/           store listings, privacy policy and screenshots
build.mjs        packages extension/ into store-ready zips
dist/            build output (not tracked by git)
README.md
```

Load `extension/` in a Chromium browser, or `dist/firefox-unpacked/` in
Firefox; `tests/` stays outside the packaged extension. There is only one
copy of the source: the Firefox manifest is generated from
`extension/manifest.json` at build time.

## Install (from source)

### Chrome, Edge, Brave, Opera

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

### Firefox

Firefox cannot load `extension/` directly, because its manifest describes a
Chrome service worker. Build the Firefox version first and load that:

```
node build.mjs firefox
```

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `dist/firefox-unpacked/manifest.json`.

A temporary add-on lasts until Firefox is closed; that is the normal way to
try an unpacked extension. Firefox asks for site access separately (see
below).

## Site access on Firefox

Chrome grants host access at install time. Firefox does not: an extension
declared with `<all_urls>` starts without access, and the user has to allow it
on the **Permissions** tab of `about:addons`.

The popup detects this and shows a warning with a **Grant access** button that
opens the extension's own `grant.html` page. The page explains why access is
needed, then calls `permissions.request()` from the button click - a request
the browser will only show in response to a real user gesture. A popup cannot
do this itself, because Firefox closes the popup as soon as the permission
prompt appears, which cancels the request.

Until access is granted, blocking cannot work: `declarativeNetRequest` refuses
to install a redirect rule for a host the extension may not access. The popup
also reports that case through its rule-health warning.

## Build

```
node build.mjs            # Chrome Web Store zip
node build.mjs firefox    # addons.mozilla.org (AMO) zip
```

The first form packages `extension/` into `dist/site-blocker-<version>.zip`
with `manifest.json` at the root, which is what the Chrome Web Store expects.
The second form writes `dist/site-blocker-firefox-<version>.zip` and also
unpacks it into `dist/firefox-unpacked/` for testing from `about:debugging`.

The Firefox manifest is produced from the Chrome one, so there is no second
copy of the source to keep in step. The differences are:

- `background.service_worker` becomes `background.scripts` (Firefox does not
  run extension service workers)
- `minimum_chrome_version`, which Firefox does not understand, is dropped
- `use_dynamic_url` is dropped from `web_accessible_resources`
- `browser_specific_settings.gecko` is added: the add-on ID, the minimum
  Firefox version, and the data-collection declaration AMO requires

The zips are written by hand so the project needs no dependencies at all; a
`sha256` file is written next to each one. Rebuild whenever you change the
version in `extension/manifest.json`.

The archives are reproducible: the same sources always produce the same bytes
and the same hash, so the published checksum keeps matching. Set
`SOURCE_DATE_EPOCH` to stamp the archive with a date of your choosing.

## Store listings

`store/` holds everything needed to publish the extension:

- `store/listing.md` – the name, descriptions, category, permission
  justifications and screenshot notes for the Chrome Web Store dashboard.
- `store/amo-listing.md` – the same for addons.mozilla.org: summary,
  description, category, permission and data-collection answers, and the
  submission checklist.
- `store/privacy.md` – the privacy policy, which both stores need at a
  publicly reachable URL.
- `store/screenshots.mjs` – regenerates the screenshots from the real
  extension (`node store/screenshots.mjs`).

The screenshots are captured from the extension running in a browser, not
mocked up, so they always show the current UI.

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
  3. Optionally set a number of rounds, so the session ends by itself
     after that many work/break cycles.
  4. Press **Start focus session**. Those sites are blocked while you work
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
- The **Rounds** setting decides how long the session runs. *Until stopped*
  (the default) repeats forever until you stop it; a number of rounds makes
  the session end by itself after that many work/break cycles. The break
  after the last round still happens.
- The work and break lengths are **locked while a session is running** – stop
  the session first if you want to change them. The round count is locked
  as well.
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

- `background.js` keeps a set of dynamic `declarativeNetRequest` rules in sync
  with the blocked list. Each rule redirects top-level navigations to
  `blocked.html`. It runs as a service worker in Chrome and as an event page
  in Firefox; the code is the same because every script picks the promise
  based API namespace with `const api = globalThis.browser ?? globalThis.chrome`.
- Each blocked site gets one rule with a small regex: it matches the domain
  and all of its subdomains, but not look-alike domains like
  `example.com.evil.com`. The redirect passes the original URL along, so the
  blocked page can show the site and offer "Unblock and visit".
- Three kinds of block are supported: permanent (`blockedSites`), timed
  (`timedBlocks`, each with an expiry timestamp) and focus sessions
  (`focus`, blocked only during the work phase).
- Timers are driven by `alarms`, so they keep working after the background
  script is shut down and after the browser restarts.
- Redirect rules need host access, which is why the extension asks for access
  to all sites. If that access is revoked in the browser's extension settings,
  blocking silently stops working - the popup shows a warning in that case.
  Firefox never grants host access at install time, so there the popup's
  warning includes a **Grant access** button (see
  [Site access on Firefox](#site-access-on-firefox)).
- The popup also checks that the rules really are installed, and warns if the
  browser refused them or they went missing. Opening the popup rebuilds them.
  This is what to check first if a site is not being blocked.
- `popup.html` / `popup.js` manage the list in `storage.sync`.
- `blocked.html` reads the blocked site from the redirect URL and offers to
  unblock it.

### Redirects between domains

A rule matches the URL that is actually being loaded, so a site that
redirects to another domain is blocked by whichever entry matches the
redirect target. For example `twitter.com` redirects to `x.com`: blocking
`x.com` also blocks `twitter.com`, but blocking only `twitter.com` does
*not* block `x.com`.

## Tests

The `tests` folder contains the test harness used while building the
extension. It is not part of the extension itself and can be deleted.
(Chrome reserves top-level names starting with `_`, so this folder must not
be named `_test`.) It has no dependencies beyond Node.js and a browser.

The Chromium tests start a headless browser and load the extension through
the DevTools `Extensions` domain, because branded Chrome and Edge (137+) no
longer honour `--load-extension`. Older browsers fall back to the
command-line switch automatically. `TEST_BROWSER` overrides which browser is
used (Edge is the default on Windows).

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
  a session with a fixed number of rounds ending on its own, stopping a
  session, the global switch, timed blocks vs focus sites, and the popup's
  warning when the blocking rules go missing.
- `node tests/firefox.mjs` - the same end-to-end flow against real Firefox,
  using geckodriver. Firefox has no CDP, so this drives the browser over
  WebDriver instead.
- `node store/screenshots.mjs` - regenerates the store screenshots from
  the real extension.

The Firefox test needs two paths, and skips with a message when they are
missing:

```
set TEST_FIREFOX=C:\path\to\firefox.exe
set TEST_GECKODRIVER=C:\path\to\geckodriver.exe
node tests/firefox.mjs
```

`geckodriver` is a single executable from the
[geckodriver releases](https://github.com/mozilla/geckodriver/releases); it is
started with `--allow-system-access`, without which WebDriver refuses to
navigate to `moz-extension://` pages. The test builds the Firefox package
first, installs it temporarily, and then drives the popup, the blocked page
and the permission page like a user would.

## Privacy

The extension collects nothing. It has no servers, no accounts and no
analytics, and it never reads the content of the pages you visit - blocking
is done by the browser's own network engine. Everything it remembers is
stored in the browser's sync storage, which the browser may synchronize
between your own devices.

The full policy is in [`store/privacy.md`](store/privacy.md), published at
<https://shaheedhudheen.github.io/site-blocker/store/privacy.md>.

## License

MIT. See [LICENSE](LICENSE).


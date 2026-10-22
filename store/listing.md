# Chrome Web Store listing

Copy the blocks below into the [Chrome Web Store developer
dashboard](https://chrome.google.com/webstore/devconsole) when submitting
the extension.

## Basic listing

| Field | Value |
|---|---|
| Name | Site Blocker - Block Distracting Sites |
| Version | 1.0.0 |
| Category | Productivity |
| Language | English (United States) |

**Short description** (max 132 characters, 85 used):

> Block distracting websites. Set timed blocks or run a focus timer to stay on task.

## Detailed description

> Site Blocker stops you from opening the sites that pull you away from what
> you meant to do. Add a domain, and every visit to it - and to all of its
> subdomains - is replaced with a calm "Site blocked" page instead of the
> site itself.
>
> **Block for good, or for a while**
> Most sites are blocked permanently. Some deserve a time limit instead:
> pick 15 minutes, 30 minutes, an hour, two hours, or any custom number of
> minutes. The timer counts down on the blocked page, and the site unlocks
> itself the moment it runs out.
>
> **Focus mode**
> Pick the sites you want to avoid, choose a work length and a break length,
> and start a session. Those sites stay blocked while you work and open
> freely during the break - the blocked page sends you straight there when
> the break starts, so there is nothing to refresh. Set a number of rounds
> if you want the session to end on its own, or leave it running until you
> stop it.
>
> **Block the site you are on right now**
> The popup shows the site in the current tab, with a one-click button to
> block or unblock it. Blocking a site that is already open in another tab
> takes effect there too - you do not have to hunt for the tab and reload
> it yourself.
>
> **Always in reach**
> A single toggle pauses blocking without losing your list. From the blocked
> page you can go back, or unblock the site and visit it right away.
>
> **Your list follows you**
> Everything is stored in your browser's own sync storage, so the blocklist
> is there on your other devices and is never sent anywhere else.
>
> **Private by design**
> Blocking is done by the browser's own network engine. The extension never
> reads, records, or changes the content of the pages you visit, and it
> contains no tracking, no analytics, and no servers of its own.
>
> Free and open source. Works in Chrome, Edge, Brave, Opera and other
> Chromium browsers.

## Permissions and how they are justified

The store asks you to justify every permission. The answers below match
what the extension actually does.

| Permission | Why it is needed |
|---|---|
| `declarativeNetRequest` | Runs the blocking. Redirects a blocked navigation to the "Site blocked" page using the browser's own network engine, without the extension ever seeing page content. |
| `storage` | Stores the blocklist, the timers and the focus session. Uses `storage.sync` so the list follows your browser profile. |
| `alarms` | Drives the timers. Keeps timed blocks and focus sessions running correctly after the service worker is unloaded and after the browser restarts. |
| `<all_urls>` host access | A redirect rule can only be installed for a host the extension may access, so this is what makes blocking work at all. It is never used to read or modify page content. |

## Screenshots

Generated from the real extension by `node store/screenshots.mjs`:

| File | Size | Content |
|---|---|---|
| `store/screenshots/popup.png` | 640x1652 (2x) | The popup: blocklist with a live timer badge, and the focus mode panel |
| `store/screenshots/blocked.png` | 1280x800 | The page shown when a blocked site is opened |

The Chrome Web Store accepts PNG or JPEG and asks for 1280x800 or 640x400.
Both images above are larger than the recommended size, which is fine - the
dashboard scales them down and keeps the aspect ratio.

Small icon: `extension/icons/icon128.png` (128x128, already in the manifest).
Large icon: `extension/icons/icon128.png` as well - the store wants a 128x128
PNG for the listing and the extension's own icon already matches.

## Privacy policy

The policy text is in [privacy.md](privacy.md). The store needs it at a
publicly reachable URL, so publish that file somewhere (GitHub Pages, for
example) and paste the link into the dashboard.

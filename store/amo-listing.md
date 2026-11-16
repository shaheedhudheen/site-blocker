# Firefox Add-ons (AMO) listing

The listed add-on lives at
<https://addons.mozilla.org/firefox/addon/block-distracting-sites/>. This file
records the values that are entered in the [AMO developer
hub](https://addons.mozilla.org/developers/addons), so a later release can be
submitted with the same details. The package to upload is
`dist/site-blocker-firefox-<version>.zip`, built with `node build.mjs firefox`.

## Basic listing

| Field | Value |
|---|---|
| Name | Site Blocker - Block Distracting Sites |
| Add-on URL | `block-distracting-sites` → <https://addons.mozilla.org/firefox/addon/block-distracting-sites/> |
| Version | 1.0.0 |
| Category | Other |
| Second category | (none) |
| Platform | Firefox (desktop) |
| License | MIT License |
| Support email | the address on the AMO developer account |
| Support website | <https://github.com/shaheedhudheen/site-blocker/issues> |
| Privacy policy | <https://shaheedhudheen.github.io/site-blocker/store/privacy.md> |

AMO has no "Productivity" category, so the listing uses **Other**. The
description and the categories are the only place the storefront can express
what the add-on is for; the add-on's own summary carries the keywords.

The URL slug is `block-distracting-sites`. The form suggests a slug from the
name, but `site-blocker` already belongs to another add-on, and AMO's next free
variant was `site-blocker4`; the slug was changed to `block-distracting-sites`
before the first submission. The slug cannot be changed afterwards.

**Summary** (max 250 characters, 82 used):

> Block distracting websites. Set timed blocks or run a focus timer to stay on task.

## Detailed description

AMO renders Markdown, and the description can be long. This is the Chrome
listing's description with the browser-specific line at the end changed:

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
> Free and open source. Works in Firefox on desktop.

## Permissions, and how they are justified

AMO asks what each permission is for. These answers match what the extension
actually does.

| Permission | Why it is needed |
|---|---|
| `declarativeNetRequest` | Runs the blocking. Redirects a blocked navigation to the "Site blocked" page using the browser's own network engine, without the extension ever seeing page content. |
| `storage` | Stores the blocklist, the timers and the focus session. Uses `storage.sync` so the list follows the browser profile. |
| `alarms` | Drives the timers. Keeps timed blocks and focus sessions running correctly after the background page is unloaded and after the browser restarts. |
| `<all_urls>` host access | A redirect rule can only be installed for a host the extension may access, so this is what makes blocking work at all. It is never used to read or modify page content. On Firefox it is requested at runtime from the extension's own "grant access" page, because Firefox does not grant host permissions at install time. |

## Data collection

AMO requires every new add-on to declare what it collects. The manifest
declares `browser_specific_settings.gecko.data_collection_permissions.required
= ["none"]`, and the submission form must say the same thing:

- **Does this add-on collect or transmit data?** No.
- Data collection categories: none of them.
- The blocklist and timers are stored in the browser's own `storage.sync`.
  That is local to the browser profile; if the user has Firefox Sync turned
  on, Firefox synchronizes that storage itself. The extension never sends
  anything anywhere.

The privacy policy at the URL above states the same, so the two never
disagree.

## Notes for reviewers

> Site Blocker blocks sites with dynamic `declarativeNetRequest` rules. There
> are no content scripts and no remote code; everything is plain, unminified
> JavaScript in the package, so there is no separate source upload.
>
> `<all_urls>` is needed because a redirect rule can only be installed for a
> host the extension has access to. The extension never reads page content -
> the browser's network engine performs the redirect before a page is loaded.
> Firefox does not grant host permissions at install time, so the popup warns
> about it and links to `grant.html`, which requests the permission from a
> button click. Reviewers who install the add-on will see that page in place
> of the popup's normal state until access is granted.
>
> The extension stores the blocklist, timed-block expiry times and focus
> session state in `storage.sync`, and nothing else.

## Screenshots

The same captures used for the Chrome listing, regenerated by
`node store/screenshots.mjs`:

| File | Size | Content |
|---|---|---|
| `store/screenshots/popup.png` | 640x1652 (2x) | The popup: blocklist with a live timer badge, and the focus mode panel |
| `store/screenshots/blocked.png` | 1280x800 | The page shown when a blocked site is opened |

AMO allows any number of screenshots and recommends 1280x800; the blocked page
capture already matches that, and the popup capture is a 2x image that scales
down cleanly.

Both are uploaded to the listing, in this order, with these captions:

1. `blocked.png` - "The blocked page names the site and lets you go back or
   unblock it."
2. `popup.png` - "Add sites, set timed blocks, and run focus sessions from the
   toolbar popup."

The listing icon is `extension/icons/icon128.png` (128x128, already in the
manifest); it was uploaded as the custom icon as well.

## Submitting

The submission is done in the [developer
hub](https://addons.mozilla.org/developers/addons):

1. `node build.mjs firefox` and check the output with
   `npx web-ext lint --source-dir dist/firefox-unpacked` (it reports 0
   errors and 0 warnings for this add-on).
2. Click **Submit a New Add-on**, choose **On this site** (listed), and
   upload `dist/site-blocker-firefox-<version>.zip`. AMO validates the package
   immediately.
3. Select **Firefox** as the platform. Do not select Firefox for Android:
   the popup is laid out for a desktop window and has not been tested there.
4. Answer **No** to the source-code question - the package is the source.
5. Fill in the fields above. Paste the description into the description
   box; AMO renders the Markdown. AMO's category list has no "Other" entry;
   tick **My add-on doesn't fit into any of the categories**.
6. Tick **This add-on has a Privacy Policy** and enter the URL.
7. Submit and wait for review. New add-ons usually get a human review before
   they are listed.
8. Afterwards, add the screenshots and the icon from the **Images** section of
   the add-on's **Edit Product Page**. The page keeps the upload field behind
   an "Edit" toggle, and screenshots save without an image if you submit before
   the upload has finished - fill in the caption only once the preview shows the
   image.

### The first submission

Version 1.0.0 was submitted on 16 November 2026 and is in **Awaiting Review**:

- the validator reported no errors and no warnings
- platform: Firefox only; source code: no
- category: Other (the "doesn't fit into any of the categories" checkbox)
- license: MIT; privacy policy: the URL above
- one icon and two screenshots, with the captions above
- support website filled in; support email left empty

AMO names the signed package after the add-on's original slug, so the download
file is `site_blocker4-1.0.0.zip` even though the listing URL is
`block-distracting-sites`.

### Submitting from the command line

AMO accepts the same upload through the `web-ext sign` command, which needs
API credentials from <https://addons.mozilla.org/developers/addon/api/key/>:

```
set AMO_JWT_ISSUER=<api key>
set AMO_JWT_SECRET=<api secret>
npx web-ext sign --channel listed --source-dir dist/firefox-unpacked --api-key %AMO_JWT_ISSUER% --api-secret %AMO_JWT_SECRET%
```

`--channel listed` publishes through the normal review queue. With
`--channel unlisted` AMO only signs the package and returns an `.xpi`, which
is useful for self-distribution but does not create a store listing.

The credentials belong to the add-on's owner, so the submission cannot be
completed without them.

### After the first submission

Every later release is uploaded from the add-on's own page (**Upload New
Version**), not as a new add-on, so it is recognized as an update. Bump the
version in `extension/manifest.json`, rebuild both packages, and upload the
new Firefox zip.

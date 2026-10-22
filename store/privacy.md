# Privacy Policy for Site Blocker

**Last updated: 22 October 2026**

## Summary

Site Blocker does not collect, store, transmit, or sell any personal data.
It has no servers, no accounts, and no analytics. Everything the extension
remembers lives in your own browser, on your own device.

## What the extension stores

The extension stores the following, and nothing else, in your browser's
sync storage (`chrome.storage.sync`):

- the list of domains you chose to block
- the expiry time of each timed block
- the focus mode settings: the sites to focus on, the work and break
  lengths, the number of rounds, and the state of a running session
- whether blocking is switched on or off

This storage is part of your browser profile. If you are signed in to a
browser profile with sync enabled, the browser itself may synchronize this
data between your devices, using your browser's own sync service and your
existing browser account. The extension itself never sends this data
anywhere.

## What the extension does not do

- It does not collect personal data, browsing history, or usage statistics.
- It does not use analytics, telemetry, advertising, or tracking of any kind.
- It does not contact any server, and it contains no remote code.
- It does not read the content of the pages you visit.
- It does not modify the pages you visit. The only thing it changes is
  where a *blocked* navigation lands: instead of the site you asked to
  block, you get the extension's own "Site blocked" page.
- It does not use cookies, and it does not create or modify any on any
  other website.

## Permissions, and what they are used for

| Permission | Use |
|---|---|
| `declarativeNetRequest` | Applies the blocking rules. The browser's network engine performs the redirect; the extension never inspects page content. |
| `storage` | Reads and writes the blocklist and timers described above. |
| `alarms` | Wakes the extension when a timer expires, so blocks and focus sessions end on time even after the browser has been closed. |
| `<all_urls>` host access | Required for a redirect rule to be installed for a given host. Without it, blocking cannot work. It is not used to read or change page content. |

The extension can be granted narrower access by the browser. If site
access is revoked, blocking stops working and the popup shows a warning
explaining why.

## Children

Site Blocker is a general-purpose utility and is not directed at children.

## Changes to this policy

If this policy changes, the updated version will be published at the same
location, with the date at the top updated.

## Contact

Questions about this policy can be raised through the project's issue
tracker.

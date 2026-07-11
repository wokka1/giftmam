# GiftMAM

A Firefox/Chrome userscript for [MyAnonamouse](https://www.myanonamouse.net/) that automates gifting Bonus Points (BP) to new users, with history tracking so nobody gets gifted twice, plus a few quality-of-life extras (auto-VIP renewal, auto upload-credit buying, vault/lotto reminders).

## Origin and why this repo exists

This script was originally published by **Photaz** at `github.com/Photaz/GiftMAM`. That repository has since gone private or been deleted, which broke the script's built-in auto-update mechanism (`@updateURL`/`@downloadURL`) for anyone who already had it installed.

This repo is a continuation, hosted here purely so the userscript can keep auto-updating. It is **not** a claim of authorship over the original work - full credit for the original design and implementation goes to Photaz. `giftmam-2.2.4-original.user.js` is archived here unmodified, as the last known copy before any changes in this repo, for provenance now that the original source is gone.

## Installation

1. Install a userscript manager in your browser:
   - Firefox: [FireMonkey](https://addons.mozilla.org/firefox/addon/firemonkey/) or [Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/)
   - Chrome/Edge: [Tampermonkey](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
2. Install the script directly from the raw file:
   [`giftmam.user.js`](https://raw.githubusercontent.com/wokka1/giftmam/main/giftmam.user.js)
3. Your userscript manager should detect the `@updateURL`/`@downloadURL` metadata and check this repo for updates automatically going forward.

## Features

- Scans the newest-members list and gifts each new user a configurable BP amount
- Tracks gift history so users aren't gifted twice (with a configurable cooldown instead of a hard "once ever" rule, if desired)
- "Auto" mode that continuously monitors for new users and gifts them as they appear
- Configurable safety floor - stops gifting if your BP balance drops too low
- Optional auto-renew VIP status and auto-buy upload credit when BP is abundant
- Vault donation and lotto entry reminders
- Import/export of gift history, plus a rolling 7-day auto-spend log
- Automatic pause-and-resume on rate limits or transient server errors, instead of silently stopping

## Changelog (this fork)

- **2.2.6** - Restored 41 icons that had been corrupted to `�` (U+FFFD) during an earlier clipboard/editor hop that only handled the Unicode Basic Multilingual Plane; slowed the per-gift delay from ~8s to ~20s; rate-limit and server-error handling now pause in place and resume automatically regardless of Auto/manual mode, instead of silently stopping and requiring a manual restart.
- **2.2.5** - Retargeted `@updateURL`/`@downloadURL` to this repo.
- **2.2.4** - Last version as received from the original author; archived unmodified as `giftmam-2.2.4-original.user.js`.

## License

MIT, per the original script's license header.

# CHANGELOG-FIXES

## Defects found and fixed

| # | Defect | Fix | Files |
|---|---|---|---|
| 1 | `npm test` crashed: test helper was named `test_load-data.mjs` / `test_household.test.mjs` but imported as `load-data.mjs` / `household.test.mjs` | Restored the intended file names | `test/` |
| 2 | A new account with tablet times set **no alarm** until the first later request, so the first reminders could be missed | `create` now schedules immediately and reports `remindersScheduled` | `src/worker.js` |
| 3 | Notification text was saved **after** the push was sent, so a fast phone could fetch the generic fallback text | Message text is persisted first (`deliver()`), then the push is sent | `src/worker.js` |
| 4 | Push responses were ignored except 404/410; failures looked like success; "Test sent" shown even when nothing was accepted | Every attempt is classified (accepted / rejected / gone / throttled / service_error / network_error), retried once for 5xx/network, recorded, and shown in plain words | `src/worker.js`, `public/index.html` |
| 5 | Same TTL/urgency for everything | Per-kind TTL and urgency (emergency 2 min/high, tablet reminder 1 h, caregiver heads-up 2 h, test 1 min) | `src/worker.js` |
| 6 | No evidence of display on the phone | Service worker reports back after `showNotification`; shown separately from "accepted" | `public/sw.js`, `src/worker.js` |
| 7 | Fixed UTC offset ignored daylight saving | Optional IANA zone name (`tzName`) with DST-correct local times; fixed offset remains the fallback | `src/worker.js`, `public/index.html` |
| 8 | A late alarm lost the 23:00 heads-up after midnight; very late reminders were silently skipped | Yesterday is also checked; skipped reminders are recorded as `window_passed` | `src/worker.js` |
| 9 | Lost platform alarm was never noticed | `getAlarm()` self-heal | `src/worker.js` |
| 10 | Deleting an account left its alarm | `deleteAlarm()` before `deleteAll()` | `src/worker.js` |
| 11 | **Security:** any `https://` URL accepted as a push endpoint, so the server could be made to POST to arbitrary hosts | Only real push-service hosts accepted (FCM, Mozilla, Apple, Windows) | `src/worker.js` |
| 12 | **Security:** a removed caregiver (or re-invited phone) kept receiving household alerts | Their subscriptions are deleted on remove/re-invite | `src/worker.js` |
| 13 | **Security:** API keys could register phone subscriptions | Restricted to patient/caregiver/clinician | `src/worker.js` |
| 14 | **Security:** invite codes could be guessed without limit; invites never expired | 10 failed tries / 10 min limiter; 7-day expiry | `src/worker.js` |
| 15 | Invites had no clear status | `invited / joined / expired` shown in Family screen | `src/worker.js`, `public/index.html` |
| 16 | No audit trail for alerts | Per-household event log (kind, state, HTTP code, recipient id; no health text) shown to the patient | `src/worker.js`, `public/index.html` |
| 17 | AI assistant with no key returned a vague 502 | Clear `503 not_configured` message | `src/worker.js` |
| 18 | Contradictory README, stale test commands, no setup/push docs | Rewritten with status table, setup, push, troubleshooting | `README.md` |
| 19 | Demo page not labelled as fictional; inconsistent titles/labels; no visible focus outline; manifest described only a "talking companion" | Banner, titles, "Developer tools (API)" label, focus-visible, manifest text | `public/*` |
| 20 | `npm run check` covered 3 files only; `.dev.vars.example` lacked `RECEIPT_SECRET`, `VAPID_SUBJECT` | Extended | `package.json`, `.dev.vars.example` |

## Added
`test/notifications.test.mjs` (35 checks), `test/static.test.mjs` (6), `test/ui-smoke.py` (optional browser), `public/_headers`, `VERIFICATION-REPORT.md`.

## Not changed on purpose
Durable Object class name `AlertHub` and migration `v1`; existing endpoints and responses (new fields are additive); AI guard rules; FHIR validators; Orbit Connect.

## Round 2 (Baseten, calls, offline alerts, guide)
| # | Fix | Files |
|---|---|---|
| 21 | **Baseten 403 "please check the api-key you provided"**: Baseten needs `Authorization: Api-Key KEY`, the app sent `Bearer`. Now the right scheme is chosen from the base URL, and the other one is tried once if the provider says 401/403. | `src/meta.js` |
| 22 | Assistant, explain and rule-drafting calls sent the literal model name `auto`. The model is now resolved inside the client (Muse Spark Open on this key, else known slugs such as `meta-models/muse-spark-open`). | `src/meta.js` |
| 23 | The green "live" badge only checked that a key existed. It now runs a real test call (`/api/ai/status?test=1`); tap the badge to see why it failed. | `src/worker.js`, `public/ox.js` |
| 24 | Voice calls failed on mobile data (STUN only). TURN relay servers added, automatic relay retry, optional Cloudflare TURN secrets. | `src/worker.js`, `public/call.js` |
| 25 | Offline help: Text-everyone and Call buttons, queued alerts, optional Bluetooth help button and Meshtastic (LoRa) radio bridge, optional Twilio / Africa's Talking SMS and voice calls from the server. | `public/radio.js`, `public/index.html`, `public/sw.js`, `src/worker.js` |
| 26 | Document cards: friendly AI-failure text with retry, "Explain in plain words" for each document, compact add button that no longer covers content, no duplicate "(simulated)". | `public/workspace.html`, `src/ai.js`, `src/connect.js`, `public/ox.css` |
| 27 | Guide: animated demos and picture steps for patients, caregivers, doctors and hospital staff, including Developer tools. | `public/guide.html` |

Not verifiable here: real phone calls, real SMS delivery, Bluetooth and radio hardware, and the live Baseten key. They need your phone, your secrets and your hardware.

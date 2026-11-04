## Fix 2: self-hosted PDF/Word/OCR libraries
- New `scripts/vendor-libs.mjs` (`npm run vendor`) downloads pdf.js, mammoth and Tesseract (worker, core, English data) into `public/vendor/` and pins SHA-256 hashes in `scripts/vendor.lock.json`.
- `docread.js` loads them from `/vendor/`; CSP no longer allows `cdnjs`, `jsdelivr` or `tessdata.projectnaptha.com`.
- `npm run deploy` runs the vendor step first.

## Fix 1: no inline scripts (CSP)
- CORRECTED 4 Nov 2026: an earlier note here said every inline `<script>` had been moved to `public/js/*-main.js` and `'unsafe-inline'` removed from `script-src`. That was not true of the pages in the repo (they still contain inline scripts), and the strict policy made the deployed pages render blank. `script-src` now allows each page's inline code by SHA-256 fingerprint in `public/_headers` (no `'unsafe-inline'`); `npm run csp` regenerates the fingerprints and the static test fails if one is missing. Moving the code into files is still to do.
- CORRECTED 4 Nov 2026: the service worker cache in the repo is `orbitx-shell-v15` and there is no `public/js/` folder.
- `npm run check` syntax-checks `public/js/*.js` if that folder exists; static tests fail if the policy forbids inline scripts while a page still contains one, if an inline `on*=` handler appears, or if `unsafe-eval` is allowed.
- CORRECTED 4 Nov 2026: that verification did not match the repo. With the strict policy and the pages as uploaded, the main page rendered blank (inline script blocked). With the fingerprints in place, all 9 pages checked (`/`, guide, demo, workspace, developer, studio, docs, gateway, partner) rendered with no script errors in headless Chromium with the real headers applied. Not tested on a real phone.

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
`test/notifications.test.mjs` (35 checks when added; 105 now), `test/static.test.mjs` (6 when added; 12 now), `test/ui-smoke.py` (optional browser), `public/_headers`, `VERIFICATION-REPORT.md`.

## Not changed on purpose (as of this first pass)
Durable Object class name `AlertHub` and migration `v1`; existing endpoints and responses (new fields are additive); FHIR validators; Orbit Connect. (The AI guard rules were left alone here but rewritten later in the safety pass, `src/safety.js`.)

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

## Round 3 (clean-up, no pre-filled data, History)
| # | Change | Files |
|---|---|---|
| 28 | **No pre-filled data is written to a real account.** Removed: the first-page demo box and "pretend patient", "Try a demo cuff", "Load the synthetic documents", the one-tap developer demo, the "pretend emergency app" link, the pre-filled sample FHIR record, and the hard-coded "Dr Sandbox" requester (now typed by the user). Nothing is written to an account unless the person adds it. (Still present on purpose: the labelled fictional patient in `demo.html`/`data.js`, synthetic files in `public/samples/` used by tests, and an unused `enterSandbox` helper in `public/ox.js` that nothing calls.) | `public/index.html`, `workspace.html`, `developer.html`, `guide.html` |
| 29 | **History is a tidy drop-down panel**: blood-pressure readings, tablets taken, tablets not logged (7 days), notes for the care team, and alerts, each a collapsible section with a count. Built only from the person's own saved records. | `public/index.html` |
| 30 | **Readability**: brighter secondary text, larger small text, bigger buttons and labels, two-column tables become stacked cards on phones, Family alert log is a drop-down. | `public/index.html`, `public/ox.css` |
| 31 | `npm run check` now covers every front-end script; `.dev.vars.example` lists the TURN and SMS variables. | `package.json`, `.dev.vars.example` |

## Round 4 (tablet amounts, caregiver lock, SMS backup, Baseten)
| # | Change | Files |
|---|---|---|
| 32 | **Tablet amounts.** A dose now records how many tablets (1 to 10), not only the time. Usual amount per time is set in sign-up and Settings with a neat stepper; the dose sheet pre-fills it and lets the person change it each time; logging again corrects the amount; History shows "morning: 2 tablets". Invalid amounts are refused by the server. | `src/worker.js`, `public/index.html` |
| 33 | **The person cannot remove or lock out a caregiver.** `remove` is refused for everyone on the patient side; `reinvite` is refused once the caregiver has joined (only an unused invite can get a new code). The Remove button and "New invite" for linked caregivers are gone. (Account deletion remains, as the person's data right.) | `src/worker.js`, `public/index.html` |
| 34 | **SMS backup is dependable.** A caregiver phone number is now required. Nigerian numbers written 0801... are sent as +234801.... If SMS is not set up, or is refused, the alert log says so plainly instead of failing silently. SMS goes out at the same moment as the push for each caregiver being alerted and for "no one answered". | `src/worker.js`, `public/index.html` |
| 35 | **Baseten / Muse Spark Open.** The model "reasons" before answering, so tiny token budgets returned empty text and looked like an error. Minimum budget raised, one automatic retry with more room, `<think>` text stripped. A key limited to one model is no longer reported as "key rejected" just because the model list is refused. Payment problems show as "no credits". Default model name is `meta-models/muse-spark-open-1026`. | `src/meta.js`, `src/ai.js`, `wrangler.toml` |
| 36 | Tests: 45 notification/security checks at that point (105 now) (tablet amounts, caregiver protection, SMS), plus Baseten restricted-key and reasoning tests. | `test/` |


## Round 5a
37. **Abnormal BP flag.** `bpBand` now names every reading: Normal (<130/85), Slightly raised, High grade 1 (>=140/90, the WHO line), High grade 2 (>=160/100), Very high (>=180/110, same line as the fixed emergency rule) and Low (<90/60). The higher of the two numbers decides. Shown as a tag on the home "Last reading" card, in History and in the confirmation after saving. One reading is never called a diagnosis.
38. **History uses the same bands** as the rest of the app (the old local copy disagreed at 120 diastolic).
39. **Home screen fits a 360x720 phone.** Smaller face and caption, tidier cards, "I took my tablet" shortened to "Log tablet"; Family, Settings and "I need help now" are visible without scrolling.
40. **High BP texts the caregiver.** A reading of 140/90 or more (below the 180/110 emergency line, which already alerts with push, SMS and call) sends a push and an SMS to every caregiver with a phone number, naming the reading and band. Repeat texts for the same band are held back for 30 minutes (see item 43) so repeat measurements do not spam the family.
41. **Missed tablet texts the caregiver.** At the heads-up time (11:00 / 16:00 / 21:00 / 23:00 local) an SMS goes out as well as the push. New: a last-chance SMS at 22:00 local if a tablet is still not logged, once per day, before the day ends.
42. Every SMS attempt (sent, refused, or SMS not set up) appears in the alert log. Tests added (notifications 46-53).
43. **Low blood pressure texts the caregiver too** (below 90/60), alongside high (140/90 and up). Repeat texts for the same band are held for 30 minutes; a reading that changes band (for example high then low) always sends.
44. **Caregivers can remove caregivers.** A linked caregiver sees a "Care team" list and can remove another caregiver or doctor (not themselves, not during an active alert). The patient still cannot remove anyone. Removed people are signed out; ring order closes up.
45. **Family screen redesigned**: numbered cards with status pills (Linked, Called first, Phone alerts on/off) instead of long sentences; "Dr Dr" name bug fixed.
46. **Trend graph and "Why Orbit said this" are back**, now inside History as the first drop-down (open by default): your sentence, a colour key, the graph (top/bottom number, 140 line, your usual, red dots for missed tablets, date labels thinned so they never overlap) and the plain-words reasons. Tapping Orbit's sentence on the home screen still opens the same view.
47. **New end-to-end test (`test/e2e.test.mjs`, 13 checks when added; 28 now)**: patient + caregiver + doctor, doctor rule fires on high readings, caregiver gets the SMS, Baseten reads a report (invented facts rejected), explains it, answers questions, falls back cleanly when the AI is down, partner/Connect API keys, and the AI status check. Runs as part of `npm test`.
48. Static test now fails if a stray index.html sits in the project root (the page must be public/index.html) or if public/index.html is an old version.
49. **Evidence Graph is no longer blank with a single report.** It used to draw only facts that belong to a finding (a comparison between two reports, or a conflict), so one report gave an empty box. It now always shows each report and the facts read from it (flagged results first, up to 12), and says plainly that findings appear once a second report can be compared. The single-report layout fits a phone with no sideways scrolling.
50. **Photo of a paper report is read by Muse Spark Open's vision first** (new `docphoto` action, standard `image_url` message). The AI only copies the words; the person checks the text against the paper, edits it, then taps Analyse, and every extracted fact must still quote that text. If the endpoint cannot take images, or the AI is off or unreachable, the app falls back automatically to reading the photo on the phone (Tesseract). A tick box (on by default, remembered) lets people keep photos on the phone only. Photos are shrunk to a small JPEG, sent once, never stored.
51. Add-document sheet: clearer privacy text, "Let the AI read my photos" box; workspace pages get bottom padding so the + button never covers content. New tests (e2e 14-18).

## Round 5b (rules, onboarding, API)
52. Rules now work end to end: a matched "alert" rule sends a phone alert to caregivers and clinician and a text to caregivers (12-hour repeat guard kept). Before, it only wrote a line inside the app.
53. A new rule is checked against recent readings/symptoms the moment it is saved; a ringing rule is never fired by saving.
54. Clinicians get "Send a test alert" on each rule (phones only, no texts). Rule Studio labels alerts (your rule / blood pressure / missed tablet) and shows the evidence.
55. Patients get a "How I feel" button: tap symptoms or write them; it is saved for the care team and shows fixed, non-diagnostic general information with warning signs and 112. The chat also records and answers symptoms the same way. Assistant prompt now allows general symptom information, never diagnosis, medicine or doses.
56. First-time guide: 5-step tour (also under the "?" button) and a "Get started" checklist on the home screen.
57. Guide page: "Who Orbit-X is for" (primary, secondary, partner users).
58. API /api/v1/signals: accepts text numbers, systolic/diastolic, optional type, pulse, device/source, measuredAt; replies with band and the 10 latest readings.
59. FHIR live import (src/connect.js, developer.html) and Baseten photo reading remain from the previous round.

## Round 6
60. Alert screen (online): only Call 112, "I am okay. Cancel the alert" and Close remain. Per-caregiver call/text buttons removed (the server already calls and texts). With no internet the text fallback stays.
61. Tablet supply tracker: Settings -> "Tablets left in my pack". Orbit-X counts down from logged tablets, shows days left, warns on the home screen at 7 days or fewer, and texts and alerts the family once at 3 days or fewer and once when empty.
62. Bluetooth cuff: lists every nearby device (many cuffs do not advertise the blood-pressure service), looks inside after connecting, and says clearly what a non-standard cuff offers and what to do.
63. Developer page simplified to Connect / Data in / Activity / More tools. Connect = make a key, copy a ready example (curl, Python, ESP32), watch the first reading arrive. Starts empty.
64. "Clear test data" (new action cleartest): removes simulated/test imports, receipts, test keys and the activity log; runs once automatically on the developer page. Tests added.
65. Home screen: bigger head, text-size-adjust, tighter spacing. Dose sheet label shortened.
66. Pharmacist refills: Settings -> "My pharmacist". At 3 days or fewer left, and when the pack is empty, the pharmacist gets one short SMS refill request (name and the person's number only), the family gets an alert and text, and the person gets a push. Once per level.
67. The "running low" banner shows once per level (7 days, 3 days, empty), has Text my pharmacist / Got it, and does not return after Got it.
68. When the pack is finished the app stops asking about tablets (no reminders, no missed-tablet texts, no question on the home screen) until a new count is entered in Settings.
69. Home greeting shortened to the headline; "This week" chip reads "N missed".
70. Pharmacist requests capped at one per 20 hours whatever number is set (no spam), with tests.
71. Two AI providers: MODEL_* (e.g. Meta Model API) first, MODEL2_* (Baseten) takes over automatically on 401/402/403/404/429/5xx/timeouts. Safety checks apply to either answer.
72. Cuff Gateway (/gateway.html): any phone or laptop with Chrome pairs a Bluetooth cuff and sends every reading to the patient's account through the public API with a device key. Linked from the doctor page. Verified with a simulated Bluetooth cuff (reading parsed, sent with the key header, band returned).
73. In-app cuff readings now save automatically after a 10-second countdown (Do not save / Save now), are labelled "Bluetooth cuff" in History and in the doctor's Rule Studio so doctors can see where each reading came from.
74. "Your week, in plain words": code finds every number, Muse Spark (Meta model) rewords them, a safety check rejects advice and any number the model invents, otherwise fixed sentences are used. Shown in History and in the doctor's Rule Studio, labelled with who wrote it. Cached 6 hours.
75. API: signals accept systolic/diastolic, text numbers, pulse, device, measuredAt (earlier round) and are used by the gateway.
76. Android app (TWA) readiness (first pass, superseded by 76b): service worker now registers for everyone (it was only registered after sign-in, so PWABuilder and Chrome saw none and refused to install); manifest gained id, maskable icons, categories, shortcut; /.well-known/assetlinks.json placeholder; correct manifest content type; cache v6.
77. Doctors can be texted: rules have "Also text me when it matches" (on by default for ringing rules); the doctor adds their own number in Rule Studio; one text per rule per 12 hours; test alerts never text.
78. Chat safety filter also blocks treatment, cure and named-medicine words.
76b. Android app (TWA): manifest now has id, screenshots (phone and wide), display_override and prefer_related_applications=false; service worker no longer serves redirected answers for page loads (v7); the Worker serves /.well-known/assetlinks.json from two settings (TWA_PACKAGE, TWA_SHA256) so the Android link can be set from the dashboard without a code change.
77b. Disconnect: "Disconnect cuff" in Settings and on the Gateway page, "Remove key from this device" on the Gateway page; panic button "Remove" and radio "Disconnect" buttons now appear the moment a device is paired.
78b. Photo proof: a caregiver can ask for a photo of the person's tablets (3 requests a day at most). The person gets a phone alert and a banner (Take photo / Not now). The photo is shrunk on the phone, stored for 2 days only, never sent inside normal state, and shown to the caregiver on request. Clinicians cannot see it.
79. Medicine card reading: "Check my pack with a photo" (Settings) and the proof flow count tablets left with the vision model. The model only counts; a bottle or unclear photo gives no number. The person confirms or corrects the number, sees how it compares with what was logged (worded without blame), and can use it as their pack count.
80. Any language: Settings -> "Language Orbit speaks" (16 listed, or type any). Orbit's sentences are written and safety-checked in English, then translated by the server; a translation is kept only if every number survives and no web link appears, otherwise the English text is shown. Used for Orbit's spoken lines, captions, weekly summary and voice listening/speaking language. Follows the phone's language until a choice is made. Buttons stay in English.
81. Caregiver view: Orbit's sentences about the patient now read in the third person ("Alex did not log their tablets").
82. Service worker v8; radio/panic/cuff disconnect buttons (item 77).
83. Language now changes the WHOLE app (item 80 only changed Orbit's spoken lines): new public/lang.js translates every screen (home, History, Settings, Family, My records, guide, buttons, placeholders) through a new public route /api/xlate (batches, 40 requests per 10 minutes per address). Numbers are swapped for [#n] markers before translation and a translation is accepted only if every marker survives and no digits or links are added; otherwise the English stays. Document text (<pre>), typed text, keys and charts are never translated. Translations are remembered on the phone. The picker applies instantly (no Save), is on the welcome screen, caregiver screen, Settings and My records, and the app says so if translation is not switched on or the server is busy.
84. Caregiver view reads in the third person; service worker v9 caches lang.js.
85. Sign-up is now one question (your name). New patients land straight on the blood-pressure home screen and the help guide introduces the app (a new 'Your medicine times' step points to Settings). Phone and medicine times are set later in Settings.
86. One phone holds one Orbit-X role: joining as a caregiver on a phone signed in to your own account is now refused with an explanation (it used to replace your own account silently); joining a second person as caregiver asks first.

## Safety, voice, language and PWA pass (latest)
- New src/safety.js: rule-based pre-check (emergency / self-harm / advice requests get fixed replies, no model call, works with no AI key) and one wide output guard used by assistant, explain, weekly summary, document explainer and workspace Ask.
- Assistant prompt rewritten: information only, no causes, no self-care, no medicines.
- data.js symptom guide: self-care steps and cause links removed; 112 warning signs kept. Removed "sit down and rest", "stay calm", "take it when you can".
- New public/voice.js: one remembered voice for all languages, sentence-chunk playback, interrupt (face tap / mic / leaving page), specific mic errors with one retry. Used by index, workspace, demo.
- Language: the phone's OXLang choice is authoritative; caregiver phones are never overwritten; language chosen before sign-up is sent to the server; RTL; speech tag for custom languages; lang.js on every page.
- /api/ai/status: live test shared and limited to one real call per 5 minutes; model list needs ADMIN_TOKEN (header X-Admin-Token).
- _headers: Content-Security-Policy + Permissions-Policy. sw.js cache v12 with voice.js, maskable icons, demo page.
- Added maskable icons and screenshots; fixed demo.html banner squashing the app on phones.
- Tests: test/safety.test.mjs added; npm test, npm run check and test/ui-smoke.py pass (re-run 3 Nov 2026). The service worker cache is now `orbitx-shell-v15`. NOT tested: real microphone/speech, real Muse Spark/Baseten calls, CSP in a live browser session.


## Pre-submission pass (3 Nov 2026)
- Tests: `smoke` and `notifications` now set `ASSISTANT_CHAT: 'on'` (chat is off by default); `smoke` uses a neutral test origin (`https://app.example.test`).
- `/api/create` limit (20 per hour per IP) moved from a per-instance memory map to the Durable Object store (same store as translation), with `Retry-After`; new safety test 7b.
- Push contact (`VAPID_SUBJECT`): the hard-coded fallback `mailto:alerts@orbit-x.online` (a domain not owned) is removed. Fallback is now the first https address in `ALLOWED_ORIGINS`.
- `wrangler.toml`: custom-domain example no longer names `orbit-x.online`.
- Docs corrected against the code (README, this file, VERIFICATION-REPORT.md): SMS/voice status, document photo reading, Meta model table, env var list, test counts, 30-minute BP text gap, duplicate item numbers.

## Audit round (language, voice, safety, headers)

| Defect | Fix | Files |
|---|---|---|
| `Permissions-Policy` had `geolocation=()`: emergency location could never work | `geolocation=(self)` | `public/_headers` |
| CSP blocked the OCR script, wasm, workers and language data (photo/report reading failed silently) | Allowed cdnjs/jsdelivr/tessdata, `wasm-unsafe-eval`, blob workers | `public/_headers` |
| Pack-count message guessed causes | Factual wording only: it compares numbers and points to the pharmacist/doctor | `public/index.html` |
| Output guard blocked lab values such as `mg/dL` | Dose pattern ignores `/dL`, `/L`, `/min` etc.; real doses still blocked | `src/safety.js` |
| Emergency rules were English-only | Accent-folded phrases for Pidgin, Yoruba, Igbo, Hausa, Swahili, French (partial by design) | `src/safety.js` |
| Voice could stay on "Speaking" if the phone never fired start/end | Per-sentence watchdog moves on | `public/voice.js` |
| Translation lag: one big batch at a time | Up to 3 small parallel batches | `public/lang.js` |
| Old service worker cache | `orbitx-shell-v13` | `public/sw.js` |

# Orbit-X

**Orbit-X is a health-information intelligence and interoperability platform.** It helps a person keep their own health information in one place, understand it with evidence-linked explanations, exchange it using a limited FHIR R4 subset, and (optionally) have family or caregivers alerted if they need help.

Orbit-X **does not give medical advice and is not a medical device.** Plain code finds patterns in the person's own logged data; the AI only rewords facts, and its output is checked so it cannot suggest medicine, doses or diagnoses. Emergencies are decided by fixed code, never by an AI. Built for the Meta Global AI Developer Hackathon (Startups track). Use **synthetic (pretend) data only**.

**Prototype with synthetic data. Next steps: stricter CSP, sign-up CAPTCHA, an external security review.** See "Security: what is in place, and what is not" below.

## The screens

| Screen | Who it is for | What it does |
|---|---|---|
| `/` (index) | Everyone | Sign-up (just your name), then your daily app: log blood pressure and tablets, talk to Orbit (fixed, rule-based answers; free-text AI chat is off by default), History, Family and caregivers, Settings (phone alerts, tablet times, language, account). |
| `/workspace.html` | Everyone | **Health Workspace** — your documents, extracted facts with sources, timeline, Evidence Graph, appointment brief, sharing and consent. |
| `/guide.html` | Everyone | A one-minute plain-words explanation. |
| `/demo.html` | Anyone curious | A walkthrough with a **fictional** patient. No real people or alerts. |
| `/studio.html` | Doctors you invite | **Rule Studio** — a clinician writes an alert rule in plain words, reads it back, and approves it. |
| `/gateway.html` | Doctor / organisation accounts | **Cuff Gateway:** a phone or laptop with Chrome pairs a Bluetooth cuff and sends readings to a patient's account through the public API with a device key. |
| `/developer.html`, `/docs.html`, `/partner.html` | Doctor / organisation accounts only | **Developer tools:** API keys, FHIR record import, emergency handoff, API docs, a test app. Hidden from personal accounts (also enforced on the server). |
| `/brief.html`, `/receipt.html` | Whoever holds the link | Read-only shared appointment brief and integrity receipt. |

## What is implemented, partial, mocked or unverified

| Feature | Status |
|---|---|
| Accounts, caregiver invites (invited / joined / expired), household isolation | Implemented, automated-tested |
| Server-side reminder scheduling with Durable Object alarms (works with the page closed) | Implemented, tested against a fake store. **Not yet verified on live Cloudflare.** |
| Daylight-saving-aware local reminder times (uses the phone's IANA zone name) | Implemented, tested (US DST change) |
| Web Push request + result tracking (accepted / rejected / expired / throttled / service error / network error) | Implemented, tested with a fake push service. **Not yet verified against real Google/Mozilla/Apple push services.** |
| "Shown on the phone" confirmation | Implemented: the phone's service worker reports back after displaying. **Not yet verified on a real device.** |
| Emergency alert chain with server-side escalation | Implemented, tested (fake store) |
| SMS / phone calls from the server | **Implemented, needs a provider account:** SMS through Twilio or Africa's Talking, voice calls through Twilio (set the secrets below). Without them the alert log says "SMS not set up" and the app falls back to Call/Text buttons that use the person's own SIM. **Not verified against a live provider.** |
| Health Workspace, evidence graph, pattern engine | Implemented. Documents can be pasted/typed text or a photo of a paper report (read by Muse Spark Open's vision, or on the phone with Tesseract OCR as fallback). The person checks the text before analysis. |
| AI wording (Muse Spark Open via Baseten / Meta Model API) | Implemented; needs your key. Without a key: clear "not configured" message and a labelled rule-based mode. Free-text chat stays **off** unless `ASSISTANT_CHAT` is exactly `on`. Live model **not verified** in this repo's tests (mocked). |
| FHIR | **Limited R4 subset**, not full interoperability. Supported resources: Patient, Organization, Practitioner, Encounter, Observation, Condition, MedicationRequest, AllergyIntolerance, DiagnosticReport, DocumentReference, Provenance, Consent, AuditEvent. Structural validation only (not a full conformance validator). |
| Hospital/EMR connections, emergency handoff delivery | **Simulated** and labelled so. |
| WhatsApp webhook | Parked stub (verification handshake only). |
| Voice input | Uses the browser's speech recognition. |
| iPhone push | Untested (iOS 16.4+, Add to Home Screen). |
| Regulatory compliance (HIPAA, GDPR, etc.) | **Not assessed and not claimed.** |

## Prerequisites

Node.js 20+ (tested on 22), a free Cloudflare account, and `npx wrangler login`. Durable Objects with SQLite storage are used (available on the Workers free plan).

## Local setup

```
npm install                        # no lockfile is committed yet; run this once and commit the package-lock.json it creates
cp .dev.vars.example .dev.vars     # fill in only what you need; never commit this file
npm run dev                        # http://localhost:8787
```

Push notifications need HTTPS (or `localhost`). For phone testing use a deployed URL (see below).

## Environment variables and secrets

Names only, set with `npx wrangler secret put NAME`:

| Name | Required? | Purpose |
|---|---|---|
| `MODEL_API_KEY` | Optional | AI provider key. Without it the AI says it is not configured; everything else works. |
| `RECEIPT_SECRET` | Recommended | Signs integrity receipts. Without it receipts are hash-chained but unsigned. |
| `VAPID_SUBJECT` | Recommended | Your contact address for push services, e.g. `mailto:you@your-email.example` (or an `https://` address). If unset, the first `https://` address in `ALLOWED_ORIGINS` is used. |
| `ASSISTANT_CHAT` | Optional | Free-text AI chat. Off unless exactly `on`. Set in `wrangler.toml`. |
| `MODEL2_API_KEY`, `MODEL2_BASE_URL`, `MODEL2_TEXT` | Optional | Second AI provider that takes over if the first is out of credit or down. |
| `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` / `AT_USERNAME`, `AT_API_KEY`, `AT_FROM` | Optional | Server-sent SMS (and Twilio voice calls) when a caregiver must be reached. |
| `TURN_KEY_ID`, `TURN_API_TOKEN` (or `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`) | Optional | TURN relay so voice calls work on mobile data. |
| `ADMIN_TOKEN` | Optional | Lets you list models on `/api/ai/status` (header `X-Admin-Token`). |
| `TWA_PACKAGE`, `TWA_SHA256` | Optional | Android app (TWA) link; see the last section. |
| `WHATSAPP_*` | Optional | Parked WhatsApp feature. |

Non-secret settings live in `wrangler.toml`: `MODEL_BASE_URL`, `MODEL_TEXT`, `ESCALATE_MS`, `ALLOWED_ORIGINS` (**change this to your own domain**), optional `PUSH_EXTRA_HOSTS`.

Push (VAPID) keys are generated automatically per household and kept inside that household's Durable Object. They are never sent to the browser except the public half.

## Run the tests

```
npm test          # smoke + household + notifications/security + end-to-end + static front-end + safety (no network, no cost)
npm run check     # syntax check of every source file and front-end script
python3 test/ui-smoke.py   # optional: real headless browser, needs `pip install playwright && playwright install chromium`
```

## Deploy to Cloudflare

1. `npm install`
2. `npx wrangler login`
3. Edit `ALLOWED_ORIGINS` in `wrangler.toml` to your domain(s).
4. `npx wrangler secret put MODEL_API_KEY` (optional), `RECEIPT_SECRET`, and `VAPID_SUBJECT`.
5. `npm run deploy`

Durable Object configuration (already in `wrangler.toml`; do not rename the class, the migration depends on it):

```
[[durable_objects.bindings]]  name = "ALERTS", class_name = "AlertHub"
[[migrations]]                tag = "v1", new_sqlite_classes = ["AlertHub"]
```

Static files are served from `public/` (`run_worker_first` sends only `/api/*` to the Worker). `public/_headers` adds security headers and a Content-Security-Policy (which still allows inline scripts).

## Turn on phone alerts on Android

1. Open your deployed `https://` Orbit-X address in **Chrome** and create your account (just your name). Then set your tablet times in Settings.
2. Settings → **Turn on phone alerts** → **Allow** when asked.
3. Tap again to **Send a test**. You will see two steps: "push service accepted" (step 1) and, a few seconds later, "this phone confirmed it displayed the alert" (step 2).
4. Optional: Chrome menu → **Add to Home screen**.

## Test a reminder with the website closed

1. Make sure step 3 above confirmed on this phone.
2. Choose a tablet time (e.g. Morning = 08:00 local) and do **not** log the tablet.
3. Close the Orbit-X tab and swipe Chrome away. Leave the phone on with internet.
4. At the reminder time (08:00 morning, 13:00 afternoon, 18:00 evening, 21:00 night) a notification appears. If you set up a caregiver phone, it gets a "tablet not logged" heads-up 3 hours later (11:00, 16:00, 21:00, 23:00).
5. Reminders only start for times **after** the account is created.

## How to read the push diagnostics

| Message | Meaning |
|---|---|
| Accepted by the push service (code 201) | Google/Mozilla/Apple took the request. **Not proof the phone showed it.** |
| Confirmed: this phone displayed it | The phone's service worker ran and reported back. This is the real evidence. |
| Expired / removed (404, 410) | The browser dropped this subscription. Turn alerts on again on that phone. |
| Refused (400, 401, 403, 413) | The push service refused the request. Turn alerts off and on again; check `VAPID_SUBJECT`. |
| Throttled (429) | Too many requests. Wait a minute. |
| Push service error (5xx) / network error | Temporary. One automatic retry is made, then it is reported. |

The Family screen's activity list (patient only) records kind, state and HTTP code per attempt, never health text, endpoints or keys.

## Security: what is in place, and what is not

**In place (tested with fakes, not a formal audit):**
- Tokens are stored hashed on the server; invite codes are single-use and expire; wrong invite codes are rate-limited (10 per 10 minutes).
- Account creation, translation and sign-in attempts are rate-limited; caregivers cannot do patient-only actions; inputs are validated; CORS uses an allowlist.
- Security headers: `Strict-Transport-Security`, `nosniff`, `no-referrer`, `X-Frame-Options: DENY`, `Permissions-Policy`, and a Content-Security-Policy (`object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`).
- Model output goes through a safety filter; emergency decisions are made by fixed code, not by the model. A test scans front-end files for secret-looking strings.

**Not in place (known, and why):**
- The CSP still allows inline scripts (`'unsafe-inline'`), because the pages use inline scripts; moving them to files is planned. The app keeps its session token in the browser's storage, so a script-injection bug would be serious.
- The CSP also allows `cdnjs.cloudflare.com` and `cdn.jsdelivr.net` for the PDF and OCR libraries, which is wide for a strict policy.
- No CAPTCHA (for example Cloudflare Turnstile) on sign-up, and no password: the recovery key is the only way back in. Account creation is capped per IP address only.
- Health text and photos are sent to the AI provider, and phone numbers and message text to the SMS provider, when those features are used. No independent security review, penetration test or compliance assessment (HIPAA, GDPR) has been done. No dependency lockfile is committed yet.

Use synthetic (pretend) data only until these are addressed.

## Known platform limitations

- A phone that is off or has no connection cannot show a notification at that moment. The push service holds a reminder for up to 1 hour (tablet reminder) or 2 hours (caregiver heads-up) and an emergency push for 2 minutes, then discards it.
- Do Not Disturb, silenced Chrome notifications, battery savers and "force stop" can hide or block alerts.
- Web Push is free but offers **no delivery guarantee**. Orbit-X therefore never says "delivered" unless the phone itself reports it displayed the notification.
- Reminders more than 2 hours late (caregiver heads-up: 3 hours) are skipped and recorded rather than sent stale.
- Automatic SMS and phone calls need a Twilio or Africa's Talking account (secrets below). Without one, only push alerts go out and the screens fall back to the device's own Call/Text.
- Account creation is limited to 20 new accounts per hour per IP address (counted in a Durable Object, so it holds across Worker instances). There is no CAPTCHA, and many different addresses can still create accounts, so add Cloudflare rate-limiting/WAF rules before a public launch.

## Troubleshooting

| Problem | Try |
|---|---|
| "Notifications are blocked" | Chrome lock icon → Permissions → Notifications → Allow. |
| Test says "accepted" but nothing appears and no confirmation | Android Settings → Apps → Chrome → Notifications on; Do Not Disturb off; battery "Unrestricted". Send another test. |
| "Expired / removed" | Turn phone alerts on again on that phone. |
| "Refused" | Turn alerts off and on; confirm the site is HTTPS; check `VAPID_SUBJECT`. |
| "Session expired" | Sign out, then rejoin with a new invite link. |
| Invite says expired | Invites last 7 days. Tap **New invite**. |
| AI says "not configured" | Set `MODEL_API_KEY` (optional feature). |

## Meta models

| Model | Use | Status |
|---|---|---|
| Muse Spark (Open) | Rewords the facts the pattern engine found; reads photos of paper reports and counts tablets in a pack photo (vision); translates Orbit's sentences. Output is checked for medical advice. Free-text chat only if `ASSISTANT_CHAT=on`. | Integrated; needs your key; live model not verified here |
| Muse Voice Transcribe | Speech understanding (today the app uses the browser's own speech recognition) | Planned, not used |
| SAM 3.1 | Segment tablets in a photo | Planned, not used (tablet counting uses Muse Spark vision) |

## What was built when (hackathon disclosure)

**Before the event** (tagged `scaffold-pre-hackathon`): an empty Cloudflare Worker with a health check, a thin Meta API client (`src/meta.js`), a stub WhatsApp webhook, a "coming soon" page, and a mocked smoke test.

**Before kickoff, on the same day:** `public/demo.html` and the fictional-patient parts of `public/data.js` were a first prototype of the demo story ("Mr. Briggs", fictional data).

**Built during the hackathon:** everything else, including accounts, invite links, caregiver phones, the alert chain, the household store, the pattern engine, the medical-advice guard, the Health Workspace, Orbit Connect (FHIR subset, API keys, handoff, receipts), and the tests. A later repair pass (see `CHANGELOG-FIXES.md`) fixed notification scheduling and diagnostics, security and documentation.

## Orbit Connect (developers)

FHIR R4 subset API, simulated EMR connector, provenance, duplicate/conflict detection, scoped API keys, OAuth-style client-credentials tokens, rate limits, audit log, OpenAPI spec (`/openapi.json`, `/docs.html`). Emergency handoff is consent-gated and its delivery is **simulated** and labelled; receipts prove integrity (hash chain, optional HMAC), not medical truth. Check `/api/health` and `/api/ai/status` for AI mode.

## License

MIT. See `LICENSE`.

## Android app (TWA)
1. Open pwabuilder.com, enter the live URL, choose Android. Install the signed **.apk** from the download (not the .aab, which only Google Play can use). Remove any older Orbit-X install first.
2. PWABuilder shows a package name and a SHA-256 fingerprint. In the Cloudflare dashboard, Workers, orbit-x, Settings, Variables, add `TWA_PACKAGE` and `TWA_SHA256` (several fingerprints may be separated by commas) and deploy. `/.well-known/assetlinks.json` is then served automatically and the address bar disappears. Until both are set the Worker returns 404 for that file, and the Android link is not active (the web app and PWA install are unaffected). The fingerprint must be a full 32-byte SHA-256 (`AB:CD:...`).
3. Moving to a custom domain later means building the Android app again for that domain.

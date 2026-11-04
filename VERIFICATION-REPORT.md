# VERIFICATION REPORT

Last automated re-run: 4 Nov 2026 on the delivered files. Node v22.23.4, Linux sandbox, **no network, no real Cloudflare, no real phone**.
This report covers the **automated runs only**. Things the author confirmed by hand on real devices and the live site are listed separately below and in `README.md`.

## Commands and results
| Command | Result |
|---|---|
| `npm test` (runs the six files below in order; exit code 0) | Passed |
| `node test/smoke.mjs` | Passed (smoke, Baseten auth, Baseten restricted-key/reasoning blocks) |
| `node test/household.test.mjs` | 19/19 passed |
| `node test/notifications.test.mjs` | 105/105 passed |
| `node test/e2e.test.mjs` | 28/28 passed |
| `node test/static.test.mjs` | 15/15 passed |
| `node test/safety.test.mjs` | 11/11 passed |
| `node test/captcha.test.mjs` | 6/6 passed (CAPTCHA off by default; half-configured stays off; token required when on; token not stored; Cloudflare refusal and outage handled) |
| `python3 test/ui-captcha.py` (headless Chromium, fake Cloudflare script and fake API) | Passed: widget shown only when the server turns it on; Start blocked without a token; token sent; failed check resets the box; no script errors |
| `npm run check` (syntax of every `src/*.js`, `scripts/*.mjs` and front-end script) | Passed |
| `npm run csp` | `public/_headers` already matches the inline scripts (12 fingerprints) |
| `python3 test/ui-smoke.py` (headless Chromium, 390x780, static server, API not running) | 8 pages (`/`, guide, demo, workspace, developer, studio, docs, privacy): no script errors, no horizontal overflow |
| Secret scan of the repo (key-like strings, private keys) | None found; `.dev.vars` and `.env` are git-ignored |

Skipped / not run in the sandbox: `wrangler dev`, `wrangler deploy`, and the `[build]` step in `wrangler.toml` that downloads the PDF/Word/OCR libraries (no network). `public/vendor/` is not part of the source files; it is downloaded at deploy time.

## What the automated tests cover
Account creation with tablet times scheduling immediately; reschedule and clear; DST (New York, 1 Nov 2026); invalid zone name; invite statuses and 7-day expiry; push results 201/403/429/5xx(retry)/network/410; payload stored before push; service-worker message retrieval; phone display confirmation; endpoint host allow-list; API keys barred from subscriptions; duplicate alarm runs; late and very late alarms; already-logged doses; lost alarm recovery; cross-household and caregiver authorization; removed caregiver gets nothing; invalid inputs; invite brute-force limit; missing AI key; malformed AI answers; unsafe AI text replaced; FHIR malformed/unsupported/oversized bundles and the bundled sample; end-to-end flows (patient, caregiver, doctor, partner API, FHIR pull, document reading with a mocked model, photo reading, fallback when the AI is unreachable); the safety layer (emergency/self-harm/advice pre-check, output guard, chat switch, translation and account-creation rate limits, multilingual emergency phrases); static page checks (12 HTML pages, manifest, service worker, CSP fingerprints, no secret-looking strings).

## Confirmed by the author by hand (not by automated tests)
Per `README.md`: a real push alert on a real phone, a real SMS, an in-app voice call over the TURN relay, reading a photo of a medicine pack, explaining uploaded documents, and language switching (sometimes slow). Also confirmed after the last deploy: the AI status check shows Baseten live, document upload works (the reader files must be present in `public/vendor/`), and a test alert reaches the phone. These are the author's own observations and are not reproduced by this report.

## Help and guide coverage (code review, not a live new-account test)
Patients: welcome-screen guide link, automatic 7-step first-run tour, **?** replay button, get-started checklist, Settings help and privacy links. Caregivers: invite screen text and a Help link to the caregiver guide on the caregiver screen. Doctors: Help link in Rule Studio and the clinic guide linked from the developer page. Not tested by walking through a fresh sign-up on a live phone.

## NOT verified (honest limits)
- Real Durable Object alarm timing over days, and Worker behaviour under load.
- Mozilla and Apple push services; iPhone/Safari; Android battery/Doze behaviour.
- Twilio voice calls and Africa's Talking SMS (SMS to one phone was confirmed by hand; the automated tests use a fake provider).
- Real Bluetooth cuff hardware, real microphone/speech recognition, and the offline/radio alert path on real devices.
- Accessibility: focus outlines, labels and live regions were added, but nothing was audited with a screen reader or contrast tool.
- Dependency audit (`npm audit`) could not be run offline. The only dependency is dev-only `wrangler` (`^4`, no lockfile committed).
- The downloaded reader libraries are only pinned if `scripts/vendor.lock.json` is committed after the first download.
- No regulatory compliance (HIPAA, GDPR, etc.) is claimed or assessed.

## Known remaining risks
- `/api/create` is limited to 20 accounts/hour/IP in the Durable Object store. A sign-up CAPTCHA (Cloudflare Turnstile) is built but **off until the site key and secret are configured**, and it has only been tested against a fake Cloudflare, never the real Turnstile service or a real browser CSP. There is no cross-address limit; add Cloudflare rate-limit/WAF rules before a public launch.
- The join-attempt limiter and API rate limiter are in-memory per Durable Object instance (best effort across restarts).
- `/api/push/msg` and `/api/push/ack` are unauthenticated but keyed by a 64-hex hash of the secret push endpoint; notification text (first name, reading) is retrievable by anyone holding that hash.
- Only the newest message per phone is kept; two pushes in the same second show the latest text.
- Session tokens are kept in `localStorage`, so a script-injection bug would be serious.
- Content-Security-Policy: the only third-party host allowed is `https://challenges.cloudflare.com` (Turnstile: script, frame and connect). `script-src` has **no** `'unsafe-inline'` or `'unsafe-eval'`. Each page's inline script runs only if its SHA-256 fingerprint is listed in `public/_headers` (run `npm run csp` after editing any inline script). Page code is still inline in the HTML files, and `style-src` still allows `'unsafe-inline'` for style attributes. The app loads and runs under this policy on the author's live phone test; it has not been tested across other browsers.
- Health text and photos are sent to the AI provider (Baseten, Muse Spark Open) when document or photo reading is used. `/privacy.html` says so in plain words, but it is a link, not a tick-box consent gate, and it is not legal advice.

## Readiness ratings (evidence-based)
| Area | Rating | Why |
|---|---|---|
| Automated test coverage | 7/10 | Server logic well covered with fakes; no automated live or full-browser E2E |
| Core application functionality | 7/10 | Tests pass and the author confirmed the main flows live |
| Notification scheduling | 7/10 | Tested incl. DST/duplicates; long-run live alarm timing unverified |
| Push diagnostics | 8/10 | Honest states and display confirmation implemented and tested; author saw a real push arrive |
| Security review | 6/10 | Several real holes fixed and scripts are hash-restricted; create-endpoint abuse protection, external review and compliance outstanding |
| Mobile usability | 6/10 | No overflow at 390px, focus styles added; no accessibility audit |
| Deployment readiness | 7/10 | Deployed and working for the author; build step now fetches the reader files; lockfile and pinned hashes not committed |
| Real-device notification verification | Hand-checked only | Author saw a real push and SMS; iPhone, Doze and long-run timing not covered |

Blockers to genuine production use: create-endpoint abuse protection, an external security review, a compliance review, a dependency audit, and moving page code out of inline scripts.

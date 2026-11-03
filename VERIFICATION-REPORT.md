# VERIFICATION REPORT

Re-run on 3 Nov 2026 on the delivered files: Node v22.23.4, Linux sandbox, **no network, no real Cloudflare, no real phone**.

## Commands and results
| Command | Result |
|---|---|
| `npm test` (runs the six files below in order; exit code 0) | Passed |
| `node test/smoke.mjs` | Passed (smoke, Baseten auth, Baseten restricted-key/reasoning blocks) |
| `node test/household.test.mjs` | 19/19 passed |
| `node test/notifications.test.mjs` | 105/105 passed |
| `node test/e2e.test.mjs` | 28/28 passed |
| `node test/static.test.mjs` | 12/12 passed |
| `node test/safety.test.mjs` | 11/11 passed |
| `npm run check` (syntax of every `src/*.js` and front-end script) | Passed |
| `python3 test/ui-smoke.py` (headless Chromium, 390x780, static server, API not running) | 7 pages (`/`, guide, demo, workspace, developer, studio, docs): no script errors, no horizontal overflow |

Not re-run in this pass: the earlier ad-hoc headless-Chromium run with a mocked API (Family screen with invite statuses); it was never saved as a test file.

Skipped / not run: `wrangler dev` / `wrangler deploy` (no network to install or log in).

Fixed in this pass: `test/smoke.mjs` and `test/notifications.test.mjs` failed because free-text chat is now off unless `ASSISTANT_CHAT` is `on`; both tests now set `ASSISTANT_CHAT: 'on'` in their test environment. No source file was changed. Earlier history: the original `npm test` crashed on a test-helper file name, fixed in the first repair pass.

## What the automated tests cover
Account creation with tablet times scheduling immediately; reschedule and clear; DST (New York, 1 Nov 2026); invalid zone name; invite statuses and 7-day expiry; push results 201/403/429/5xx(retry)/network/410; payload stored before push; service-worker message retrieval; phone display confirmation; endpoint host allow-list; API keys barred from subscriptions; duplicate alarm runs; late and very late alarms; already-logged doses; lost alarm recovery; cross-household and caregiver authorization; removed caregiver gets nothing; invalid inputs; invite brute-force limit; missing AI key; malformed AI answers; unsafe AI text replaced; FHIR malformed/unsupported/oversized bundles and the bundled sample; end-to-end flows (patient, caregiver, doctor, partner API, FHIR pull, document reading with a mocked model); the safety layer (emergency/self-harm/advice pre-check, output guard, chat switch, translation rate limit, multilingual emergency phrases); static page checks (11 HTML pages, manifest, service worker, no secret-looking strings).

## NOT verified (honest limits)
- Live Cloudflare deployment, real Durable Object alarm timing, and Worker startup under `wrangler`.
- Real push services (Google/Mozilla/Apple) accepting this server's VAPID requests, and real phones showing notifications or reporting display. The VAPID signature was verified locally (existing test) but not against a real push service.
- Android battery/Doze behaviour; iPhone/Safari.
- Full browser flows (sign-up, tapping Allow, etc.) against a running Worker.
- Live AI provider and live SMS/voice-call providers (Twilio, Africa's Talking) and TURN relay (all mocked or untested). Real microphone/speech and Bluetooth cuff hardware. Accessibility was improved (focus outline, labels, live regions) but not audited with a screen reader or contrast tool.
- Dependency audit (`npm audit`) could not be run offline; the only dependency is dev-only `wrangler`.
- No regulatory compliance is claimed or assessed.

## Known remaining risks
- `/api/create` is limited to 20 accounts/hour/IP in the Durable Object store (tested with a fake store, not on live Cloudflare). There is no CAPTCHA and no cross-address limit; add Cloudflare rate-limit/WAF rules before a public launch.
- Join-attempt limiter and API rate limiter are in-memory per Durable Object instance (best effort across restarts).
- `/api/push/msg` and `/api/push/ack` are unauthenticated but keyed by a 64-hex hash of the secret push endpoint; notification text (first name, reading) is retrievable by anyone holding that hash.
- Only the newest message per phone is kept; two pushes in the same second show the latest text.
- Session tokens are kept in `localStorage` (standard for this design; vulnerable if XSS is introduced).
- The Content-Security-Policy in `public/_headers` still allows `'unsafe-inline'` scripts (inline scripts are used throughout), so it limits what can load but does not stop injected inline script. It has not been tested in a live browser session.

## Readiness ratings (evidence-based)
| Area | Rating | Why |
|---|---|---|
| Automated test coverage | 7/10 | Server logic well covered with fakes; no live or full-browser E2E |
| Core application functionality | 7/10 | Original features preserved and tests pass; not exercised on live infra |
| Notification scheduling | 7/10 | Fixed and tested incl. DST/duplicates; real DO alarms unverified |
| Push diagnostics | 8/10 | Honest states and display confirmation implemented and tested; real services unverified |
| Security review | 6/10 | Several real holes fixed; create-rate-limit, strict CSP (no inline scripts), compliance outstanding |
| Mobile usability | 6/10 | No overflow at 390px, focus styles added; no real-device or accessibility audit |
| Deployment readiness | 6/10 | Config consistent and documented; never deployed from this environment |
| Real-device notification verification | 0/10 | Not performed. Follow the Android steps in the README |

Blockers to genuine production readiness: real-device and live-Cloudflare verification, create-endpoint abuse protection, a strict CSP, a compliance review, and a dependency audit.

# VERIFICATION REPORT

Run on the delivered files, Node v22.22.2, Linux sandbox, **no network, no real Cloudflare, no real phone**.

## Commands and results

| Command | Result |
|---|---|
| `npm run check` (syntax of all `src/*.js` and `public/sw.js`) | Passed |
| `node test/smoke.mjs` | Passed (original suite, unchanged) |
| `node test/household.test.mjs` | 19/19 passed (original suite, unchanged) |
| `node test/notifications.test.mjs` | 35/35 passed (new) |
| `node test/static.test.mjs` | 6/6 passed (new) |
| `python3 test/ui-smoke.py` (headless Chromium, 390x780, static server, API not running) | 7 pages: no script errors, no horizontal overflow |
| Ad-hoc headless Chromium run with a mocked API | Family screen rendered invite statuses (joined / expired), per-caregiver push line and activity list; no script errors (not saved as a test file) |

Skipped / not run: nothing skipped within these suites. Deliberately not run: `wrangler dev` / `wrangler deploy` (no network to install or log in).

Baseline before changes: `npm test` **failed** (missing test helper file name). After renaming, the 19 original household checks and the smoke checks passed unchanged.

## What the automated tests cover
Account creation with tablet times scheduling immediately; reschedule and clear; DST (New York, 1 Nov 2026); invalid zone name; invite statuses and 7-day expiry; push results 201/403/429/5xx(retry)/network/410; payload stored before push; service-worker message retrieval; phone display confirmation; endpoint host allow-list; API keys barred from subscriptions; duplicate alarm runs; late and very late alarms; already-logged doses; lost alarm recovery; cross-household and caregiver authorization; removed caregiver gets nothing; invalid inputs; invite brute-force limit; missing AI key; malformed AI answers; unsafe AI text replaced; FHIR malformed/unsupported/oversized bundles and the bundled sample; static page checks.

## NOT verified (honest limits)
- Live Cloudflare deployment, real Durable Object alarm timing, and Worker startup under `wrangler`.
- Real push services (Google/Mozilla/Apple) accepting this server's VAPID requests, and real phones showing notifications or reporting display. The VAPID signature was verified locally (existing test) but not against a real push service.
- Android battery/Doze behaviour; iPhone/Safari.
- Full browser flows (sign-up, tapping Allow, etc.) against a running Worker.
- Live AI provider (mocked only). Accessibility was improved (focus outline, labels, live regions) but not audited with a screen reader or contrast tool.
- Dependency audit (`npm audit`) could not be run offline; the only dependency is dev-only `wrangler`.
- No regulatory compliance is claimed or assessed.

## Known remaining risks
- `/api/create` has no global rate limit (needs Cloudflare rate-limit rules).
- Join-attempt limiter and API rate limiter are in-memory per Durable Object instance (best effort across restarts).
- `/api/push/msg` and `/api/push/ack` are unauthenticated but keyed by a 64-hex hash of the secret push endpoint; notification text (first name, reading) is retrievable by anyone holding that hash.
- Only the newest message per phone is kept; two pushes in the same second show the latest text.
- Session tokens are kept in `localStorage` (standard for this design; vulnerable if XSS is introduced).
- Static pages have no Content-Security-Policy (inline scripts are used throughout).

## Readiness ratings (evidence-based)
| Area | Rating | Why |
|---|---|---|
| Automated test coverage | 7/10 | Server logic well covered with fakes; no live or full-browser E2E |
| Core application functionality | 7/10 | Original features preserved and tests pass; not exercised on live infra |
| Notification scheduling | 7/10 | Fixed and tested incl. DST/duplicates; real DO alarms unverified |
| Push diagnostics | 8/10 | Honest states and display confirmation implemented and tested; real services unverified |
| Security review | 6/10 | Several real holes fixed; create-rate-limit, CSP, compliance outstanding |
| Mobile usability | 6/10 | No overflow at 390px, focus styles added; no real-device or accessibility audit |
| Deployment readiness | 6/10 | Config consistent and documented; never deployed from this environment |
| Real-device notification verification | 0/10 | Not performed. Follow the Android steps in the README |

Blockers to genuine production readiness: real-device and live-Cloudflare verification, create-endpoint abuse protection, CSP, a compliance review, and a dependency audit.

# Orbit-X

A voice-first health companion with a talking AI face. It helps a person keep track of their own blood pressure and medicine, notices changes in their own numbers, and makes sure family knows if they need help.

Built for the Meta Global AI Developer Hackathon (Startups track).

**Orbit-X does not give medical advice.** Plain code finds patterns in the person's own logged numbers. The AI only puts those facts into plain words, and its output is checked so it cannot suggest medicine, doses or diagnoses. Emergencies are decided by fixed code, never by an AI.

## What it does

- **A face you talk to.** Speak or type to log a reading ("my pressure is 150 over 95"), log a tablet, or ask about your week.
- **Proof for every sentence.** When Orbit says "your pressure has been higher than your usual for 4 days", tapping the sentence shows the exact readings and missed tablets behind it.
- **A fixed emergency rule.** A reading of 180/120 or higher, dangerous symptom words (including Pidgin, such as "chest dey pain"), or the help button starts the alert chain. No AI is in this path.
- **An alert chain.** Caregivers join with a single-use invite link. The first caregiver's phone rings like a call. If they do not answer in 20 seconds, the next one rings. If nobody is linked or nobody answers, the person is told to call 112. The person can cancel a false alarm.
- **Private by design.** Each person's data lives in their own isolated store. Keys are stored only as hashes. A person can delete their account and data at any time.

## Meta models

| Model | Use | Status |
|---|---|---|
| Muse Spark | Rewords the facts the pattern engine found, and answers general questions. Output is checked for medical advice. | In progress |
| Muse Voice Transcribe | Understands speech, including Nigerian-accented English. | Planned |
| SAM 3.1 | Checks a photo of a tablet. | Planned |

This table is updated as each piece lands. Meta's models are called only from the server, so the API key never reaches the browser.

## What was built when (hackathon disclosure)

**Before the event** (tagged `scaffold-pre-hackathon`): an empty Cloudflare Worker with a health check, a thin Meta API client (`src/meta.js`), a stub WhatsApp webhook, a "coming soon" page, and a mocked smoke test.

**Before kickoff, on the same day** (hours before the event began): `public/demo.html` and the fictional-patient parts of `public/data.js` were a first prototype of the demo story ("Mr. Briggs", fictional data).

**Built during the hackathon:** everything else, including accounts, invite links, caregiver phones, the alert chain, the household store, real readings and the pattern engine for real users, the medical-advice guard, the settings and recovery flow, and the tests.

## How it works

- `src/worker.js`: the whole server (routes, the per-person store, the alert chain, the AI guard).
- `src/meta.js`: the Meta Model API client.
- `public/index.html`: the app.
- `public/data.js`: the pattern engine, emergency keywords and command parsing.
- `public/demo.html`: the fictional demo story.
- `test/`: automated tests for the server rules, the pattern engine, and a multi-phone end-to-end flow.

Runs on Cloudflare Workers with Durable Objects. There is no separate database.

## Run the tests

```
node test/api.test.mjs
node test/engine.test.mjs
```

The end-to-end test (`test/e2e.py`) needs Playwright for Python.

## Known limits

- **Phone alerts use Web Push** (free, no app store). A caregiver taps "Arm this phone" once and allows notifications; after that the phone is alerted even when Orbit-X is closed. It shows a notification with vibration, not a full-screen phone call. Do Not Disturb, silenced Chrome notifications and aggressive battery savers can still hide it, so test it on each phone (the app has a "Send me a test alert" button). iPhone needs iOS 16.4 or later and "Add to Home Screen" first. iPhone delivery is untested.
- Orbit-X does not place real phone calls or SMS by itself (that needs a paid provider). Instead the emergency screen gives the person big **Call** and **Text** buttons that use their own phone and SIM.
- Voice input uses the browser's speech recognition until Muse Voice Transcribe is connected.
- Documents are text only (paste or .txt). Photos and PDFs are a next step.
- Orbit-X is a hackathon project. It is not a medical device.

## Added during the hackathon (day 3)

Server-side escalation with Durable Object alarms (an alert moves to the next caregiver even if every phone is closed), Web Push alerts, tablet reminders for the person plus an opt-out heads-up for caregivers, free Call/Text buttons, separate sign-up for individuals and for doctors/organisations (only the latter reach the API and Developer area, enforced on the server), the 3-day learning period (was 5), and a plain-words guide. See `SUBMISSION.md`.

## Tests (no network, no cost)

```
node test/smoke.mjs                 # basic server checks
node test/household.test.mjs        # invites, push, escalation alarm, tablet reminders, account types
CHROME=/path/to/chrome node test/ui.test.mjs   # real pages in a headless browser (needs Playwright)
```

## License

MIT. See `LICENSE`.

## Orbit-X: health intelligence + interoperability (hackathon build)

**Orbit Health Intelligence** – upload synthetic lab reports / discharge summaries; facts are extracted with source, date, units and confidence, placed on a timeline, compared (math is deterministic code), and questions are answered evidence-first. Every statement links to a source; documented facts, user-reported info, AI interpretation, conflicts and missing information are kept separate. No medical advice.

**Orbit Connect** – FHIR R4 subset API, simulated EMR connector, provenance, duplicate/conflict detection, scoped API keys, OAuth-style client-credentials tokens, rate limits, audit log, OpenAPI spec (`/openapi.json`, `/docs.html`).

**Emergency handoff** – consent-gated event → summary → verifiable receipt with five states (accepted, generated, sent, received, acknowledged). Delivery is **simulated** and labelled so. Receipts prove integrity (hash chain, optional HMAC), not medical truth, and contain no private details.

**Meta model use** – Muse Spark Open via Baseten (OpenAI-compatible API) proposes extractions and wording. Code validates every output (quotes must appear in the source, numbers must appear in evidence, advice is rejected). If the model is unavailable, a rule-based fallback runs and the UI says "mock/rules mode"; it is never presented as a Meta model. Check `/api/health` and `/api/ai/status`.

**Synthetic data only.** Setup: set secret `MODEL_API_KEY` (Baseten); optional `RECEIPT_SECRET`.

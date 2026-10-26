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

- A caregiver's phone rings only while the page is open with the screen on. Push notifications are the next step.
- Voice input uses the browser's speech recognition until Muse Voice Transcribe is connected.
- Orbit-X is a hackathon project. It is not a medical device.

## License

MIT. See `LICENSE`.

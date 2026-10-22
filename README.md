# Orbit-X

Health insights that explain what's changing, show the evidence, and alert the right person.
Stack: Cloudflare Worker + static assets, Meta Model API (Muse Spark, SAM 3.1), WhatsApp Cloud API.

## Layout
- `src/worker.js` — API routes (`/api/health`, `/api/assistant`, `/api/whatsapp/webhook`) + static site fallthrough
- `src/meta.js` — Meta Model API client (OpenAI-compatible, key stays server-side)
- `public/` — the web app
- `test/smoke.mjs` — `npm test` (Meta API is mocked, no key needed)

## Run locally
    npm install
    cp .dev.vars.example .dev.vars   # fill in keys (never commit this file)
    npm test
    npm run dev

## Secrets (production)
    npx wrangler secret put MODEL_API_KEY
    npx wrangler secret put WHATSAPP_TOKEN
    npx wrangler secret put WHATSAPP_PHONE_ID
    npx wrangler secret put WHATSAPP_VERIFY_TOKEN

## Deploy
Cloudflare dashboard -> Workers & Pages -> Create -> Connect to Git -> pick this repo.
Every push to `main` deploys. Add the domain under the Worker's Settings -> Domains & Routes
(or uncomment the route in `wrangler.toml`).

## Git workflow
- `main` = always deployable. Work on `feat/<name>` branches, merge when `npm test` passes.
- Tag `scaffold-pre-hackathon` marks exactly what existed before kickoff.

## Monday checklist (hackathon kickoff 26 Oct, 12:00 PM EST)
1. Read the Official Rules (published before kickoff) — especially anything about pre-existing code.
2. Create the API key at dev.meta.ai -> `wrangler secret put MODEL_API_KEY`.
3. Confirm exact model IDs in the docs (`muse-spark-1.3`, SAM 3.1) and update `wrangler.toml` vars if different.
4. Visit `/api/health` -> `metaKeyConfigured` should be `true`.
5. POST `{"messages":[{"role":"user","content":"hi"}]}` to `/api/assistant` -> expect a reply.

## Do before Monday (account setup, no code)
- Meta developer + Business account, WhatsApp test number, submit caregiver-alert message template (approval takes time).
- Buy Orbit-X.Online, add it to Cloudflare, confirm the renewal price.
- Deploy this scaffold once so `/api/health` works and the WhatsApp webhook URL can be verified.

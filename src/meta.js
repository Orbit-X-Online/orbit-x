// Model client (OpenAI-compatible). Server-side only: the key never reaches the browser.
// Works with Baseten Model APIs (https://inference.baseten.co/v1, header "Authorization: Api-Key KEY")
// and with any Bearer-style OpenAI-compatible endpoint (for example the Meta Model API).
// FIX: Baseten rejects "Bearer" keys with 403 "please check the api-key you provided". The correct scheme is "Api-Key".
// The client picks the right scheme from the base URL and, if the provider answers 401/403, tries the other scheme once.

export class MetaError extends Error {
  constructor(message, status = 500) { super(message); this.name = 'MetaError'; this.status = status; }
}

export const MODEL_FALLBACKS = ['meta-models/muse-spark-open-1026', 'meta-models/muse-spark-open', 'meta/muse-spark-open', 'muse-spark-open'];
const SCHEME_CACHE = new Map(); // base -> 'Api-Key' | 'Bearer' (last one that worked)
let modelCache = { id: null, at: 0, base: '' };

export function baseUrl(env) { return String(env.MODEL_BASE_URL || 'https://inference.baseten.co/v1').replace(/\/+$/, ''); }
export function isBaseten(env) { return /baseten/i.test(baseUrl(env)); }
function keyOf(env) { return String(env.MODEL_API_KEY || '').trim().replace(/^(Api-Key|Bearer)\s+/i, ''); }
function schemeOrder(env) {
  const b = baseUrl(env), first = SCHEME_CACHE.get(b) || (isBaseten(env) || /^\w+\.\w+/.test(keyOf(env)) && /baseten/i.test(b) ? 'Api-Key' : 'Bearer');
  return [first, first === 'Api-Key' ? 'Bearer' : 'Api-Key'];
}

// One authenticated request. Tries the preferred auth scheme, then the other one if the provider says 401/403.
async function authed(env, path, init, timeoutMs) {
  if (!keyOf(env)) throw new MetaError('MODEL_API_KEY is not set', 500);
  const b = baseUrl(env); let last = null;
  for (const scheme of schemeOrder(env)) {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(b + path, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}), Authorization: scheme + ' ' + keyOf(env) }, signal: ctrl.signal });
      if (res.status === 401 || res.status === 403) { last = res; continue; }
      SCHEME_CACHE.set(b, scheme); res.__scheme = scheme; return res;
    } catch (err) {
      if (err && err.name === 'AbortError') throw new MetaError('Model provider timed out', 504);
      throw new MetaError('Could not reach the model provider', 502);
    } finally { clearTimeout(timer); }
  }
  return last;
}

export async function listModels(env) {
  const res = await authed(env, '/models', { method: 'GET' }, 10000);
  if (!res.ok) throw new MetaError('Models list ' + res.status, res.status === 401 || res.status === 403 ? 401 : 502);
  const j = await res.json().catch(() => ({}));
  return (Array.isArray(j.data) ? j.data : Array.isArray(j) ? j : []).map((m) => m && (m.id || m.slug || m.name)).filter((x) => typeof x === 'string');
}

// Find the model id to use. An explicit MODEL_TEXT wins. Otherwise: the Muse model on this key, else known slugs.
export async function resolveModel(env) {
  const want = String(env.MODEL_TEXT || '').trim();
  if (want && want.toLowerCase() !== 'auto') return want;
  const b = baseUrl(env);
  if (modelCache.id && modelCache.base === b && Date.now() - modelCache.at < 600000) return modelCache.id;
  let pick = null;
  try {
    const ids = await listModels(env);
    pick = ids.find((x) => /muse[-_ ]?spark[-_ ]?open/i.test(x)) || ids.find((x) => /muse[-_ ]?spark/i.test(x)) || ids.find((x) => /muse/i.test(x)) || null;
  } catch (e) { /* some gateways, and keys limited to one model (hackathon keys), refuse /models: use the known slug and let the chat call decide */ }
  pick = pick || (isBaseten(env) ? MODEL_FALLBACKS[0] : 'muse-spark-1.3');
  modelCache = { id: pick, at: Date.now(), base: b };
  return pick;
}
export function forgetModel() { modelCache = { id: null, at: 0, base: '' }; }

function textOf(msg) {
  if (!msg) return '';
  let c = msg.content;
  if (Array.isArray(c)) c = c.map((p) => (p && (p.text || p.content)) || '').join('');
  c = typeof c === 'string' ? c : '';
  return c.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '').trim();
}

export async function metaChat(env, { messages, model, temperature = 0.3, maxTokens, timeoutMs }) {
  if (!keyOf(env)) throw new MetaError('MODEL_API_KEY is not set', 500);
  const tried = []; let candidates = [model || null], retried = false;
  let maxTok = Math.max(Number(maxTokens) || Number(env.MODEL_MAX_TOKENS) || 4000, 800); // Muse Spark Open always reasons first; a tiny budget leaves no room for the answer
  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i] || await resolveModel(env); tried.push(m);
    const body = { model: m, messages, temperature, max_tokens: maxTok };
    if (env.MODEL_REASONING) body.reasoning_effort = env.MODEL_REASONING; // opt-in only
    const res = await authed(env, '/chat/completions', { method: 'POST', body: JSON.stringify(body) }, timeoutMs || Number(env.MODEL_TIMEOUT_MS) || 45000);
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      const notFound = res.status === 404 || ((res.status === 400 || res.status === 422) && /model/i.test(detail));
      if (notFound && !env.MODEL_TEXT || notFound && String(env.MODEL_TEXT).toLowerCase() === 'auto') {
        if (candidates.length === 1) candidates = candidates.concat((isBaseten(env) ? MODEL_FALLBACKS : ['muse-spark-1.3']).filter((x) => x !== m)); // try the other known slugs
        forgetModel(); if (i < candidates.length - 1) continue;
      }
      const status = res.status === 429 ? 429 : res.status === 402 ? 402 : res.status === 401 || res.status === 403 ? 401 : 502;
      throw new MetaError('Model API ' + res.status + ': ' + detail, status);
    }
    const data = await res.json().catch(() => null);
    const choice = data && data.choices && data.choices[0];
    const text = textOf(choice && choice.message);
    if (!text && choice && choice.finish_reason === 'length' && !retried) { retried = true; maxTok = Math.min(maxTok * 2 + 1000, 8000); i--; continue; } // thinking used the whole budget: ask again with more room
    if (!text) throw new MetaError(choice && choice.finish_reason === 'length' ? 'Model ran out of room before answering' : 'Empty model reply', 502);
    modelCache = { id: m, at: Date.now(), base: baseUrl(env) };
    return text;
  }
  throw new MetaError('No working model found. Tried: ' + tried.join(', '), 404);
}

// Tiny live test used by the status badge and the developer page. Never throws.
export async function probeAI(env) {
  const t0 = Date.now();
  const provider = isBaseten(env) ? 'Baseten' : baseUrl(env).replace(/^https?:\/\//, '').split('/')[0];
  if (!keyOf(env)) return { ok: false, error: 'not_configured', provider, hint: 'MODEL_API_KEY is not set on the server. Run: npx wrangler secret put MODEL_API_KEY' };
  try {
    const out = await metaChat(env, { temperature: 0, maxTokens: 400, timeoutMs: 40000, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] });
    return { ok: true, provider, model: modelCache.id, authScheme: SCHEME_CACHE.get(baseUrl(env)) || null, ms: Date.now() - t0, sample: out.slice(0, 40) };
  } catch (e) {
    const s = e && e.status;
    const code = s === 401 ? 'key_rejected' : s === 402 ? 'no_credits' : s === 429 ? 'rate_limited' : s === 504 ? 'timeout' : s === 404 ? 'model_not_found' : 'provider_unavailable';
    const hints = { key_rejected: 'The provider refused the key with both sign-in methods. Create a new API key in Baseten (Settings > API keys), then run: npx wrangler secret put MODEL_API_KEY. Also check the Muse Spark Open model is enabled on the Model APIs page.',
      model_not_found: 'Enable Muse Spark Open on the Baseten Model APIs page, or set MODEL_TEXT in wrangler.toml to the exact model slug shown there.',
      no_credits: 'The provider says the account has no credit or a payment problem. Check billing and credits on the provider site.',
      rate_limited: 'Too many requests. Wait a minute and try again.', timeout: 'The model was slow. Try again.', provider_unavailable: 'The provider could not be reached from the server.' };
    return { ok: false, error: code, provider, status: s || 0, hint: hints[code], detail: String(e && e.message || '').slice(0, 200), ms: Date.now() - t0 };
  }
}
export const probeModel = probeAI;

export function friendlyAiError(code) {
  const c = String(code || '').split(/[:( ]/)[0];
  return ({
    not_configured: 'The AI key is not set on the server yet.',
    key_rejected: 'The AI provider did not accept the key. The server owner should re-check MODEL_API_KEY.',
    model_not_found: 'The AI model name was not found on this provider.',
    no_credits: 'The AI provider account has no credit. The server owner should check billing.',
    rate_limited: 'The AI provider is busy. Try again in a minute.',
    timeout: 'The AI took too long to answer.',
    provider_unavailable: 'The AI provider could not be reached.',
    malformed_json: 'The AI answered in a shape Orbit could not use.',
    unexpected_error: 'Something unexpected stopped the AI step.',
    no_valid_facts: 'The AI found nothing it could back up with exact text from the document.',
    invalid_schema: 'The AI answered in a shape Orbit could not use.',
  })[c] || 'The AI step could not finish.';
}

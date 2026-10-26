import { metaChat, MetaError } from './meta.js';

export { AlertHub } from './alerts.js';

const SYSTEM_PROMPT =
  'You are the Orbit-X assistant. You explain health patterns in plain, calm language. ' +
  'You are not a doctor and never diagnose. For anything that sounds like an emergency ' +
  '(chest pain, trouble breathing, stroke signs, severe bleeding, fainting), tell the person to ' +
  'call their local emergency number now. Keep answers short.';

const MAX_MESSAGES = 20;
const MAX_CHARS = 2000;

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

function corsHeaders(env, req) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get('Origin');
  if (origin && allowed.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
  }
  return {};
}

function cleanMessages(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_MESSAGES) return null;
  const out = [];
  for (const m of input) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
    if (typeof m.content !== 'string' || !m.content.trim() || m.content.length > MAX_CHARS) return null;
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

async function handleAssistant(req, env, cors) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
  const messages = cleanMessages(body && body.messages);
  if (!messages) return json({ error: 'messages must be 1-' + MAX_MESSAGES + ' items of {role, content}' }, 400, cors);
  try {
    const reply = await metaChat(env, { messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages] });
    return json({ reply }, 200, cors);
  } catch (err) {
    const status = err instanceof MetaError ? err.status : 500;
    console.error('assistant error:', err && err.message);
    return json({ error: 'The assistant is unavailable right now. Please try again.' }, status === 429 ? 429 : 502, cors);
  }
}

// Alert chain: every request for a room goes to that room's single Durable Object.
async function handleAlert(req, env, url, cors) {
  if (!env.ALERTS) return json({ error: 'Alert store not configured' }, 503, cors);
  const room = (url.searchParams.get('room') || 'demo').toLowerCase();
  if (!/^[a-z0-9-]{1,32}$/.test(room)) return json({ error: 'bad room' }, 400, cors);
  const action = url.pathname.split('/').pop();
  const ok = (req.method === 'GET' && action === 'state') ||
    (req.method === 'POST' && ['start', 'answer', 'decline', 'handled', 'reset'].includes(action));
  if (!ok) return json({ error: 'Not found' }, 404, cors);
  const stub = env.ALERTS.get(env.ALERTS.idFromName(room));
  const res = await stub.fetch(new Request('https://alerts.internal' + url.pathname + url.search, {
    method: req.method, body: req.method === 'POST' ? await req.text() : undefined,
  }));
  return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors } });
}

// WhatsApp Cloud API webhook. GET = Meta's one-time verification handshake.
// POST is a stub for now (accepts and acknowledges events).
function handleWhatsApp(req, env, url) {
  if (req.method === 'GET') {
    const ok =
      url.searchParams.get('hub.mode') === 'subscribe' &&
      env.WHATSAPP_VERIFY_TOKEN &&
      url.searchParams.get('hub.verify_token') === env.WHATSAPP_VERIFY_TOKEN;
    return ok ? new Response(url.searchParams.get('hub.challenge') || '', { status: 200 }) : new Response('Forbidden', { status: 403 });
  }
  if (req.method === 'POST') return new Response('EVENT_RECEIVED', { status: 200 });
  return new Response('Method Not Allowed', { status: 405 });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(env, req);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });
    }
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/api/health' && req.method === 'GET') {
      return json({ ok: true, app: 'orbit-x', time: new Date().toISOString(), metaKeyConfigured: Boolean(env.MODEL_API_KEY) }, 200, cors);
    }
    if (url.pathname === '/api/assistant' && req.method === 'POST') return handleAssistant(req, env, cors);
    if (url.pathname.startsWith('/api/alert/')) return handleAlert(req, env, url, cors);
    if (url.pathname === '/api/whatsapp/webhook') return handleWhatsApp(req, env, url);

    return json({ error: 'Not found' }, 404, cors);
  },
};

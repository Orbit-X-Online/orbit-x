import { metaChat, MetaError } from './meta.js';

// ===== Alert chain logic (fixed code, no AI) =====
// Orbit-X alert chain. Pure functions: no I/O, fully unit-tested.
// The chain, the timers and the rules are fixed code. No AI is involved.

const CHAIN = ['preye', 'mamaebi'];
const NAMES = { preye: 'Preye', mamaebi: 'Mama Ebi' };
const DEFAULT_ESCALATE_MS = 20000;

function logLine(a, now, text) { a.log.push({ t: now, text }); }

function validRole(r) { return CHAIN.includes(r); }

// Starts an alert. If one is already active, returns it unchanged (idempotent).
function startAlert(existing, input, now) {
  if (existing && (existing.status === 'ringing' || existing.status === 'answered')) return existing;
  const sys = Number.isInteger(input.sys) && input.sys >= 40 && input.sys <= 300 ? input.sys : null;
  const dia = Number.isInteger(input.dia) && input.dia >= 20 && input.dia <= 200 ? input.dia : null;
  const why = String(input.why || '').slice(0, 200);
  const a = {
    id: String(now), status: 'ringing', idx: 0, ringStart: now, startedAt: now,
    sys: sys !== null && dia !== null ? sys : null, dia: sys !== null && dia !== null ? dia : null,
    why, answeredBy: null, handledBy: null, exhausted: false, log: [],
  };
  logLine(a, now, a.sys ? 'Reading ' + a.sys + '/' + a.dia : 'Symptoms reported');
  logLine(a, now, 'Emergency rule fired');
  logLine(a, now, NAMES[CHAIN[0]] + ' is being called');
  return a;
}

// Moves the chain forward if the current caregiver has had too long.
// Safe to call from every poll: it only changes state when time has actually passed.
function advance(a, now, escalateMs) {
  if (!a || a.status !== 'ringing') return a;
  let guard = 0;
  while (a.status === 'ringing' && now - a.ringStart >= escalateMs && guard++ < 10) {
    escalate(a, a.ringStart + escalateMs, 'No answer from ' + NAMES[CHAIN[a.idx]]);
  }
  return a;
}

function escalate(a, at, reason) {
  if (a.idx < CHAIN.length - 1) {
    a.idx += 1; a.ringStart = at;
    logLine(a, at, reason + '. ' + NAMES[CHAIN[a.idx]] + ' alerted');
  } else {
    a.status = 'unanswered'; a.exhausted = true;
    logLine(a, at, reason + '. No one answered. Patient told to call 112');
  }
}

function answer(a, role, now) {
  if (!a || a.status !== 'ringing' || CHAIN[a.idx] !== role) return { ok: false, error: 'not_your_call' };
  a.status = 'answered'; a.answeredBy = role;
  logLine(a, now, NAMES[role] + ' answered');
  return { ok: true };
}

function decline(a, role, now) {
  if (!a || a.status !== 'ringing' || CHAIN[a.idx] !== role) return { ok: false, error: 'not_your_call' };
  escalate(a, now, NAMES[role] + ' declined');
  return { ok: true };
}

function handled(a, role, now) {
  if (!a || a.status !== 'answered' || a.answeredBy !== role) return { ok: false, error: 'not_your_alert' };
  a.status = 'handled'; a.handledBy = role;
  logLine(a, now, NAMES[role] + ' marked handled');
  return { ok: true };
}

// What a phone is allowed to see. now lets clients show a countdown without clock skew.
function view(a, role, now, escalateMs) {
  if (!a) return { alert: null, now };
  const target = a.status === 'ringing' ? CHAIN[a.idx] : null;
  const secondsLeft = a.status === 'ringing' ? Math.max(0, Math.ceil((escalateMs - (now - a.ringStart)) / 1000)) : 0;
  return { now, alert: {
    id: a.id, status: a.status, target, secondsLeft, sys: a.sys, dia: a.dia, why: a.why,
    answeredBy: a.answeredBy, handledBy: a.handledBy, exhausted: a.exhausted, log: a.log, startedAt: a.startedAt,
    mine: role ? (target === role || a.answeredBy === role) : false,
  } };
}

// ===== Durable Object: one live alert per room =====
// Durable Object: one instance per "room" holds the single live alert, so every phone sees the same state.

const KEY = 'alert';

export class AlertHub {
  constructor(state, env) {
    this.state = state;
    this.escalateMs = Number(env.ESCALATE_MS) || DEFAULT_ESCALATE_MS;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const now = Date.now();
    const role = url.searchParams.get('role');
    let a = (await this.state.storage.get(KEY)) || null;
    const before = a && JSON.stringify(a);
    let result = { ok: true };

    if (req.method === 'POST') {
      let body = {};
      try { body = await req.json(); } catch { /* empty body is fine */ }
      const action = url.pathname.split('/').pop();
      a = advance(a, now, this.escalateMs);
      if (action === 'start') a = startAlert(a, body || {}, now);
      else if (action === 'reset') a = null;
      else if (!validRole(role)) result = { ok: false, error: 'bad_role' };
      else if (action === 'answer') result = answer(a, role, now);
      else if (action === 'decline') result = decline(a, role, now);
      else if (action === 'handled') result = handled(a, role, now);
      else result = { ok: false, error: 'unknown_action' };
    } else {
      a = advance(a, now, this.escalateMs);
    }

    const after = a && JSON.stringify(a);
    if (after !== before) { if (a) await this.state.storage.put(KEY, a); else await this.state.storage.delete(KEY); }
    return new Response(JSON.stringify({ ...result, ...view(a, validRole(role) ? role : null, now, this.escalateMs) }), {
      status: result.ok ? 200 : 409, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
}



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

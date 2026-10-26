import { metaChat, MetaError } from './meta.js';

/* =====================================================================
   Orbit-X server. One file on purpose (easy to upload, nothing to mis-place).
   - Every person has a private "household" (a Durable Object) holding their profile,
     their own readings and doses, their caregivers and any live alert.
   - Caregivers join with a single-use invite link and get their own token.
   - The emergency rule and the alert chain are FIXED CODE. No AI decides them.
   - The AI (Muse Spark) only rewords facts and answers general questions, and its output is
     checked so it can never hand out medical advice.
   NOTE: the Durable Object class is still called AlertHub so the existing migration keeps working.
   ===================================================================== */

const SYSTEM_PROMPT =
  'You are the Orbit-X assistant. You explain health patterns in plain, calm language. ' +
  'You are not a doctor and never diagnose. You never give medical advice, never suggest medicine or doses, ' +
  'and never say what condition someone has. For anything that sounds like an emergency ' +
  '(chest pain, trouble breathing, stroke signs, severe bleeding, fainting), tell the person to ' +
  'call 112 now. For anything medical, suggest they ask their doctor or pharmacist. Keep answers short.';

const SAFE_FALLBACK = "I can't give medical advice. Please ask your doctor or pharmacist. If this is urgent, call 112 now.";
const UNSAFE = /\b(diagnos\w*|prescri\w*|dos(e|es|age|ing)|you (have|probably have|likely have|might have|may have|are suffering)|(take|taking) (an? |some |your )?(extra|double|more|less|another|\d+)|(double|halve|skip|stop|reduce|raise|lower|increase|decrease|change|adjust) (your |the |that )?(tablet|tablets|pill|pills|medicine|medication|drug|drugs)|stop taking|you should (take|stop|start|increase|decrease|skip)|\d+\s?(mg|mcg|ml|g)\b)/i;
function guardReply(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 1200 || UNSAFE.test(t)) return SAFE_FALLBACK;
  return t;
}

const MAX_MESSAGES = 20;
const MAX_CHARS = 2000;
const DEFAULT_ESCALATE_MS = 20000;
const HIGH_BP_SYS = 180, HIGH_BP_DIA = 120;
const MAX_CAREGIVERS = 4;

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
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
  }
  return {};
}

/* ------------------------------ small helpers ------------------------------ */
const ALPHA = '23456789abcdefghjkmnpqrstuvwxyz';
function rand(n) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (const x of b) s += ALPHA[x % ALPHA.length];
  return s;
}
async function sha(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function cleanName(s, max = 40) {
  const t = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  return t;
}
function cleanPhone(s) {
  const t = String(s == null ? '' : s).replace(/[\s\-()]/g, '');
  return /^\+?[0-9]{7,15}$/.test(t) ? t : '';
}
function isEmergencyReading(sys, dia) { return sys >= HIGH_BP_SYS || dia >= HIGH_BP_DIA; }
function validDate(s, now) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  if (!Number.isFinite(t)) return false;
  return Math.abs(t - now) <= 3 * 86400000;
}
function inviteCode(pid, secret) { return pid + secret; }
function parseCode(raw) {
  const c = String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (c.length !== 14) return null;
  return { pid: c.slice(0, 8), secret: c.slice(8) };
}

/* ------------------------------ alert chain (household) ------------------------------ */
function logLine(a, t, text) { a.log.push({ t, text }); }
function joinedChain(h) {
  return h.caregivers.filter((c) => c.tokenHash).sort((x, y) => x.order - y.order).map((c) => ({ id: c.id, name: c.name }));
}
function activeAlert(a) { return a && (a.status === 'ringing' || a.status === 'answered'); }

function startAlert(h, input, now) {
  if (activeAlert(h.alert)) return h.alert;
  const sys = Number.isInteger(input.sys) && input.sys >= 50 && input.sys <= 300 ? input.sys : null;
  const dia = Number.isInteger(input.dia) && input.dia >= 30 && input.dia <= 200 ? input.dia : null;
  const both = sys !== null && dia !== null;
  const chain = joinedChain(h);
  const a = {
    id: String(now), status: 'ringing', chain, idx: 0, ringStart: now, startedAt: now,
    sys: both ? sys : null, dia: both ? dia : null, why: cleanName(input.why, 200),
    answeredBy: null, handledBy: null, log: [],
  };
  logLine(a, now, both ? 'Reading ' + sys + '/' + dia : 'Help requested');
  logLine(a, now, 'Emergency rule fired');
  if (!chain.length) {
    a.status = 'unanswered';
    logLine(a, now, 'No caregiver is linked. Call 112 now');
  } else {
    logLine(a, now, chain[0].name + ' is being called');
  }
  h.alert = a;
  return a;
}

function escalate(a, at, reason) {
  if (a.idx < a.chain.length - 1) {
    a.idx += 1; a.ringStart = at;
    logLine(a, at, reason + '. ' + a.chain[a.idx].name + ' alerted');
  } else {
    a.status = 'unanswered';
    logLine(a, at, reason + '. No one answered. Call 112 now');
  }
}
function advance(a, now, escalateMs) {
  if (!a || a.status !== 'ringing') return false;
  let changed = false, guard = 0;
  while (a.status === 'ringing' && now - a.ringStart >= escalateMs && guard++ < 10) {
    escalate(a, a.ringStart + escalateMs, 'No answer from ' + a.chain[a.idx].name);
    changed = true;
  }
  return changed;
}
function target(a) { return a && a.status === 'ringing' ? a.chain[a.idx] : null; }
function nameOf(a, id) { const c = a.chain.find((x) => x.id === id); return c ? c.name : null; }

function alertView(a, who, now, escalateMs) {
  if (!a) return null;
  const t = target(a);
  const me = who.role === 'caregiver' ? who.id : null;
  return {
    id: a.id, status: a.status, startedAt: a.startedAt, sys: a.sys, dia: a.dia, why: a.why,
    target: t ? t.id : null, targetName: t ? t.name : null,
    secondsLeft: a.status === 'ringing' ? Math.max(0, Math.ceil((escalateMs - (now - a.ringStart)) / 1000)) : 0,
    answeredBy: a.answeredBy, answeredByName: a.answeredBy ? nameOf(a, a.answeredBy) : null,
    handledBy: a.handledBy, handledByName: a.handledBy ? nameOf(a, a.handledBy) : null,
    cancelled: a.status === 'cancelled', chainNames: a.chain.map((c) => c.name),
    mine: me ? (t && t.id === me) || a.answeredBy === me : false,
    log: a.log,
  };
}

/* ------------------------------ the household Durable Object ------------------------------ */
export class AlertHub {
  constructor(state, env) {
    this.state = state;
    this.escalateMs = Number(env.ESCALATE_MS) || DEFAULT_ESCALATE_MS;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/h/')) return this.household(req, url.pathname.slice(3));
    return this.demo(req, url); // the original shared demo room (/api/alert/*)
  }

  /* ---- the original demo room: unchanged behaviour, separate storage key ---- */
  async demo(req, url) {
    const CHAIN = ['preye', 'mamaebi'];
    const NAMES = { preye: 'Preye', mamaebi: 'Mama Ebi' };
    const E = this.escalateMs, now = Date.now();
    const role = url.searchParams.get('role');
    const valid = CHAIN.includes(role);
    let a = (await this.state.storage.get('alert')) || null;
    const before = a && JSON.stringify(a);
    let result = { ok: true };
    const L = (t, s) => a.log.push({ t, text: s });
    const esc = (at, why) => {
      if (a.idx < CHAIN.length - 1) { a.idx += 1; a.ringStart = at; L(at, why + '. ' + NAMES[CHAIN[a.idx]] + ' alerted'); }
      else { a.status = 'unanswered'; a.exhausted = true; L(at, why + '. No one answered. Patient told to call 112'); }
    };
    const adv = () => { let g = 0; while (a && a.status === 'ringing' && now - a.ringStart >= E && g++ < 10) esc(a.ringStart + E, 'No answer from ' + NAMES[CHAIN[a.idx]]); };
    if (req.method === 'POST') {
      let body = {}; try { body = await req.json(); } catch { /* empty */ }
      const action = url.pathname.split('/').pop();
      adv();
      if (action === 'start') {
        if (!(a && (a.status === 'ringing' || a.status === 'answered'))) {
          const sys = Number.isInteger(body.sys) && body.sys >= 40 && body.sys <= 300 ? body.sys : null;
          const dia = Number.isInteger(body.dia) && body.dia >= 20 && body.dia <= 200 ? body.dia : null;
          const both = sys !== null && dia !== null;
          a = { id: String(now), status: 'ringing', idx: 0, ringStart: now, startedAt: now, sys: both ? sys : null, dia: both ? dia : null,
            why: cleanName(body.why, 200), answeredBy: null, handledBy: null, exhausted: false, log: [] };
          L(now, both ? 'Reading ' + sys + '/' + dia : 'Symptoms reported'); L(now, 'Emergency rule fired'); L(now, 'Preye is being called');
        }
      } else if (action === 'reset') a = null;
      else if (!valid) result = { ok: false, error: 'bad_role' };
      else if (action === 'answer') { if (a && a.status === 'ringing' && CHAIN[a.idx] === role) { a.status = 'answered'; a.answeredBy = role; L(now, NAMES[role] + ' answered'); } else result = { ok: false, error: 'not_your_call' }; }
      else if (action === 'decline') { if (a && a.status === 'ringing' && CHAIN[a.idx] === role) esc(now, NAMES[role] + ' declined'); else result = { ok: false, error: 'not_your_call' }; }
      else if (action === 'handled') { if (a && a.status === 'answered' && a.answeredBy === role) { a.status = 'handled'; a.handledBy = role; L(now, NAMES[role] + ' marked handled'); } else result = { ok: false, error: 'not_your_alert' }; }
      else result = { ok: false, error: 'unknown_action' };
    } else adv();
    const after = a && JSON.stringify(a);
    if (after !== before) { if (a) await this.state.storage.put('alert', a); else await this.state.storage.delete('alert'); }
    let alert = null;
    if (a) {
      const tg = a.status === 'ringing' ? CHAIN[a.idx] : null;
      alert = { id: a.id, status: a.status, target: tg, secondsLeft: a.status === 'ringing' ? Math.max(0, Math.ceil((E - (now - a.ringStart)) / 1000)) : 0,
        sys: a.sys, dia: a.dia, why: a.why, answeredBy: a.answeredBy, handledBy: a.handledBy, exhausted: a.exhausted, log: a.log, startedAt: a.startedAt,
        mine: valid ? (tg === role || a.answeredBy === role) : false };
    }
    return json({ ...result, now, alert }, result.ok ? 200 : 409);
  }

  /* ---- real households ---- */
  async auth(h, req) {
    const m = /^Bearer ([a-z0-9]{20,64})$/.exec(req.headers.get('Authorization') || '');
    if (!m) return null;
    const hash = await sha(m[1]);
    if (hash === h.tokenHash) return { role: 'patient' };
    const c = h.caregivers.find((x) => x.tokenHash && x.tokenHash === hash);
    return c ? { role: 'caregiver', id: c.id } : null;
  }

  stateView(h, who, now) {
    return {
      ok: true, now, role: who.role, pid: h.pid,
      me: who.role === 'caregiver' ? { id: who.id, name: (h.caregivers.find((c) => c.id === who.id) || {}).name } : null,
      profile: { name: h.name, slots: h.slots, phone: h.phone || '', createdAt: h.createdAt, createdDate: h.createdDate },
      caregivers: who.role === 'patient' ? h.caregivers.map((c) => ({ id: c.id, name: c.name, order: c.order, joined: !!c.tokenHash })) : undefined,
      readings: h.readings.slice(-120), doses: h.doses.slice(-240),
      alert: alertView(h.alert, who, now, this.escalateMs),
    };
  }

  async household(req, action) {
    const now = Date.now();
    let body = {};
    if (req.method === 'POST') { try { body = (await req.json()) || {}; } catch { body = {}; } }
    const bad = (status, error) => json({ ok: false, error }, status);
    let h = (await this.state.storage.get('h')) || null;

    if (action === 'create') {
      if (h) return bad(409, 'exists');
      const name = cleanName(body.name);
      if (!name) return bad(400, 'name_required');
      const slots = Array.isArray(body.slots) ? [...new Set(body.slots.filter((s) => s === 'morning' || s === 'evening'))] : [];
      const token = rand(40);
      h = { v: 1, pid: String(body.pid || ''), name, slots, phone: cleanPhone(body.phone), createdAt: now, createdDate: validDate(body.today, now) ? body.today : new Date(now).toISOString().slice(0, 10),
        tokenHash: await sha(token), caregivers: [], readings: [], doses: [], alert: null, nextCid: 1 };
      await this.state.storage.put('h', h);
      return json({ ok: true, pid: h.pid, token });
    }
    if (!h) return bad(404, 'not_found');

    if (action === 'join') {
      const secretHash = await sha(String(body.secret || ''));
      const c = h.caregivers.find((x) => x.secretHash && x.secretHash === secretHash);
      if (!c) return bad(404, 'invalid_code');
      const token = rand(40);
      c.tokenHash = await sha(token); c.secretHash = null; c.joinedAt = now;
      await this.state.storage.put('h', h);
      return json({ ok: true, pid: h.pid, token, id: c.id, name: c.name, patientName: h.name });
    }

    const who = await this.auth(h, req);
    if (!who) return bad(401, 'unauthorized');
    const before = JSON.stringify(h);
    let extra = {}, status = 200, error = null;
    const fail = (s, e) => { status = s; error = e; };
    if (h.alert) advance(h.alert, now, this.escalateMs);
    const isPatient = who.role === 'patient';

    switch (action) {
      case 'state': break;
      case 'bp': {
        if (!isPatient) { fail(403, 'patient_only'); break; }
        const sys = body.sys, dia = body.dia;
        if (!Number.isInteger(sys) || !Number.isInteger(dia) || sys < 50 || sys > 300 || dia < 30 || dia > 200 || sys <= dia || !validDate(body.date, now)) { fail(400, 'bad_reading'); break; }
        h.readings.push({ t: now, date: body.date, sys, dia });
        if (h.readings.length > 400) h.readings = h.readings.slice(-400);
        const emergency = isEmergencyReading(sys, dia);
        if (emergency) startAlert(h, { sys, dia, why: 'High reading' }, now);
        extra.emergency = emergency;
        break;
      }
      case 'dose': {
        if (!isPatient) { fail(403, 'patient_only'); break; }
        if (!(body.slot === 'morning' || body.slot === 'evening') || !validDate(body.date, now)) { fail(400, 'bad_dose'); break; }
        if (!h.doses.some((d) => d.date === body.date && d.slot === body.slot)) {
          h.doses.push({ t: now, date: body.date, slot: body.slot });
          if (h.doses.length > 400) h.doses = h.doses.slice(-400);
        }
        break;
      }
      case 'sos': {
        if (!isPatient) { fail(403, 'patient_only'); break; }
        startAlert(h, { sys: body.sys, dia: body.dia, why: body.why || 'Help requested' }, now);
        break;
      }
      case 'cancel': {
        if (!isPatient) { fail(403, 'patient_only'); break; }
        if (activeAlert(h.alert)) { h.alert.status = 'cancelled'; logLine(h.alert, now, h.name + ' says they are okay. Alert cancelled'); }
        else fail(409, 'no_alert');
        break;
      }
      case 'answer': case 'decline': case 'handled': {
        if (isPatient) { fail(403, 'caregiver_only'); break; }
        const a = h.alert, me = who.id;
        const myName = (h.caregivers.find((c) => c.id === me) || {}).name || 'Caregiver';
        if (action === 'answer' && a && a.status === 'ringing' && target(a).id === me) { a.status = 'answered'; a.answeredBy = me; logLine(a, now, myName + ' answered'); }
        else if (action === 'decline' && a && a.status === 'ringing' && target(a).id === me) escalate(a, now, myName + ' declined');
        else if (action === 'handled' && a && a.status === 'answered' && a.answeredBy === me) { a.status = 'handled'; a.handledBy = me; logLine(a, now, myName + ' marked handled'); }
        else fail(409, 'not_yours');
        break;
      }
      case 'invite': {
        if (!isPatient) { fail(403, 'patient_only'); break; }
        const name = cleanName(body.name);
        if (!name) { fail(400, 'name_required'); break; }
        if (h.caregivers.length >= MAX_CAREGIVERS) { fail(409, 'too_many'); break; }
        const secret = rand(6);
        const c = { id: 'c' + h.nextCid++, name, order: h.caregivers.length + 1, secretHash: await sha(secret), tokenHash: null, joinedAt: null };
        h.caregivers.push(c);
        extra.code = inviteCode(h.pid, secret); extra.caregiverId = c.id;
        break;
      }
      case 'reinvite': {
        if (!isPatient) { fail(403, 'patient_only'); break; }
        const c = h.caregivers.find((x) => x.id === body.id);
        if (!c) { fail(404, 'no_caregiver'); break; }
        const secret = rand(6);
        c.secretHash = await sha(secret); c.tokenHash = null; c.joinedAt = null;
        extra.code = inviteCode(h.pid, secret); extra.caregiverId = c.id;
        break;
      }
      case 'remove': {
        if (!isPatient) { fail(403, 'patient_only'); break; }
        const i = h.caregivers.findIndex((x) => x.id === body.id);
        if (i < 0) { fail(404, 'no_caregiver'); break; }
        h.caregivers.splice(i, 1);
        h.caregivers.forEach((c, k) => { c.order = k + 1; });
        break;
      }
      case 'profile': {
        if (!isPatient) { fail(403, 'patient_only'); break; }
        if (body.name !== undefined) { const n = cleanName(body.name); if (!n) { fail(400, 'name_required'); break; } h.name = n; }
        if (body.phone !== undefined) h.phone = cleanPhone(body.phone);
        if (Array.isArray(body.slots)) h.slots = [...new Set(body.slots.filter((s) => s === 'morning' || s === 'evening'))];
        break;
      }
      case 'delete': {
        if (!isPatient) { fail(403, 'patient_only'); break; }
        await this.state.storage.deleteAll();
        return json({ ok: true, deleted: true });
      }
      default: return bad(404, 'unknown_action');
    }

    if (JSON.stringify(h) !== before) await this.state.storage.put('h', h);
    if (error) return bad(status, error);
    return json({ ...this.stateView(h, who, now), ...extra }, 200);
  }
}

/* ------------------------------ public routes ------------------------------ */
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
    return json({ reply: guardReply(reply) }, 200, cors);
  } catch (err) {
    const status = err instanceof MetaError ? err.status : 500;
    console.error('assistant error:', err && err.message);
    return json({ error: 'The assistant is unavailable right now. Please try again.' }, status === 429 ? 429 : 502, cors);
  }
}

// Rewords facts that plain code already found. It adds nothing and the output is checked.
async function handleExplain(req, env, cors) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
  const sentence = cleanName(body && body.sentence, 400);
  const evidence = Array.isArray(body && body.evidence) ? body.evidence.slice(0, 6).map((e) => cleanName(e && e.title, 60) + ': ' + cleanName(e && e.text, 120)) : [];
  if (!sentence) return json({ error: 'sentence required' }, 400, cors);
  if (!env.MODEL_API_KEY) return json({ error: 'not_configured' }, 503, cors);
  try {
    const reply = await metaChat(env, { temperature: 0.3, messages: [
      { role: 'system', content: 'Reword the facts below in at most two short, calm sentences for an older adult, in plain English. Use ONLY the facts given. Do not add causes, advice, diagnoses or medicine instructions. Do not use numbers that are not in the facts.' },
      { role: 'user', content: 'Facts: ' + sentence + (evidence.length ? ' Evidence: ' + evidence.join('; ') : '') },
    ] });
    const text = guardReply(reply);
    return json({ text: text === SAFE_FALLBACK ? sentence : text }, 200, cors);
  } catch (err) {
    console.error('explain error:', err && err.message);
    return json({ error: 'unavailable' }, 502, cors);
  }
}

function hub(env, name) { return env.ALERTS.get(env.ALERTS.idFromName(name)); }

async function forward(stub, path, req, withBody) {
  const headers = new Headers();
  const auth = req.headers.get('Authorization'); if (auth) headers.set('Authorization', auth);
  const res = await stub.fetch(new Request('https://alerts.internal' + path, { method: req.method, headers, body: withBody }));
  return res;
}
function relay(res, cors) {
  return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors } });
}

// The original shared demo room.
async function handleDemoAlert(req, env, url, cors) {
  const room = (url.searchParams.get('room') || 'demo').toLowerCase();
  if (!/^[a-z0-9-]{1,32}$/.test(room)) return json({ error: 'bad room' }, 400, cors);
  const action = url.pathname.split('/').pop();
  const ok = (req.method === 'GET' && action === 'state') ||
    (req.method === 'POST' && ['start', 'answer', 'decline', 'handled', 'reset'].includes(action));
  if (!ok) return json({ error: 'Not found' }, 404, cors);
  const res = await hub(env, 'demo:' + room).fetch(new Request('https://alerts.internal' + url.pathname + url.search, {
    method: req.method, body: req.method === 'POST' ? await req.text() : undefined,
  }));
  return relay(res, cors);
}

async function handleHousehold(req, env, url, cors) {
  if (!env.ALERTS) return json({ error: 'Alert store not configured' }, 503, cors);
  const p = url.pathname;
  if (p === '/api/create' && req.method === 'POST') {
    let body = {}; try { body = (await req.json()) || {}; } catch { /* empty */ }
    const pid = rand(8);
    body.pid = pid;
    return relay(await forward(hub(env, 'h:' + pid), '/h/create', req, JSON.stringify(body)), cors);
  }
  if (p === '/api/join' && req.method === 'POST') {
    let body = {}; try { body = (await req.json()) || {}; } catch { /* empty */ }
    const c = parseCode(body.code);
    if (!c) return json({ ok: false, error: 'invalid_code' }, 404, cors);
    return relay(await forward(hub(env, 'h:' + c.pid), '/h/join', req, JSON.stringify({ secret: c.secret })), cors);
  }
  const m = /^\/api\/h\/([a-z0-9]{8})\/([a-z]{2,10})$/.exec(p);
  if (m) {
    const get = req.method === 'GET' && m[2] === 'state';
    const post = req.method === 'POST' && ['bp', 'dose', 'sos', 'cancel', 'answer', 'decline', 'handled', 'invite', 'reinvite', 'remove', 'profile', 'delete'].includes(m[2]);
    if (!get && !post) return json({ error: 'Not found' }, 404, cors);
    const text = post ? await req.text() : undefined;
    if (text && text.length > 4000) return json({ error: 'too_large' }, 413, cors);
    return relay(await forward(hub(env, 'h:' + m[1]), '/h/' + m[2], req, text), cors);
  }
  return json({ error: 'Not found' }, 404, cors);
}

// WhatsApp Cloud API webhook (parked). GET = Meta's one-time verification handshake.
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
    if (url.pathname === '/api/explain' && req.method === 'POST') return handleExplain(req, env, cors);
    if (url.pathname.startsWith('/api/alert/')) return env.ALERTS ? handleDemoAlert(req, env, url, cors) : json({ error: 'Alert store not configured' }, 503, cors);
    if (url.pathname === '/api/create' || url.pathname === '/api/join' || url.pathname.startsWith('/api/h/')) return handleHousehold(req, env, url, cors);
    if (url.pathname === '/api/whatsapp/webhook') return handleWhatsApp(req, env, url);

    return json({ error: 'Not found' }, 404, cors);
  },
};

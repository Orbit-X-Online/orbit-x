import { metaChat, MetaError, listModels } from './meta.js';
import { handleConnect, WORKSPACE_ACTIONS, V1_ACTIONS, SCOPES, LEGACY_SCOPES, oauthToken, chainAppend, kindOf, signHead, publicReceipt, loadForReceipt, rand as crand, sha as csha } from './connect.js';
import { aiMode, providerName } from './ai.js';

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
const HIGH_BP_SYS = 180, HIGH_BP_DIA = 110; // severe hypertension line (WHO defines hypertension at 140/90 but sets no crisis number)
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
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Orbit-Key',
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


/* ------------------------------ phone notifications (Web Push, free) ------------------------------
   A phone that has been "armed" gets a real notification even when Orbit-X is closed and the screen is off.
   The push carries NO health details: it only wakes the phone. The phone then asks our server what to show. */
const REMIND_HOUR = { morning: 8, afternoon: 13, evening: 18, night: 21 };   // gentle reminder to the person
const MISSED_HOUR = { morning: 11, afternoon: 16, evening: 21, night: 23 };  // heads-up to caregivers if still not logged
const PUSH_KIND = { // TTL = how long the push service may hold the message while the phone is off/offline
  emergency: { ttl: 120, urgency: 'high' }, escalation: { ttl: 120, urgency: 'high' }, unanswered: { ttl: 300, urgency: 'high' },
  cancel_notice: { ttl: 300, urgency: 'normal' }, handled_notice: { ttl: 300, urgency: 'normal' }, answered_notice: { ttl: 300, urgency: 'high' },
  reminder: { ttl: 3600, urgency: 'normal' }, missed_dose: { ttl: 7200, urgency: 'normal' },
  test: { ttl: 60, urgency: 'high' }, ready: { ttl: 60, urgency: 'normal' },
};
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
// Only real browser push services are accepted, so a caller cannot make our server POST to an arbitrary address.
function validPushEndpoint(ep, env) {
  if (typeof ep !== 'string' || ep.length > 700) return false;
  let u; try { u = new URL(ep); } catch (e) { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const extra = String((env && env.PUSH_EXTRA_HOSTS) || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.some((re) => re.test(host)) || extra.includes(host);
}
const INVITE_TTL_MS = 7 * 86400000;
function b64u(buf) { let s = ''; const b = new Uint8Array(buf); for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function vapidKeys(storage) {
  let v = await storage.get('vapid');
  if (v && v.pub && v.jwk) return v;
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  v = { pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), jwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
  await storage.put('vapid', v);
  return v;
}
async function vapidAuth(v, endpoint, env) {
  const enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ typ: 'JWT', alg: 'ES256' });
  const claims = enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:alerts@orbit-x.online' });
  const key = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(head + '.' + claims));
  return 'vapid t=' + head + '.' + claims + '.' + b64u(sig) + ', k=' + v.pub;
}
const TZ_FMT = new Map();
function validTzName(n) {
  if (typeof n !== 'string' || n.length < 3 || n.length > 64 || !/^[A-Za-z0-9_+\-\/]+$/.test(n)) return '';
  try { new Intl.DateTimeFormat('en-US', { timeZone: n }); return n; } catch (e) { return ''; }
}
// Offset (minutes east of UTC) of a zone at a given instant. Honors daylight saving when an IANA name is known.
function tzOffsetAt(t, tz, tzName) {
  if (!tzName) return tz || 0;
  try {
    let f = TZ_FMT.get(tzName);
    if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tzName, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); TZ_FMT.set(tzName, f); }
    const o = {}; for (const p of f.formatToParts(new Date(t))) if (p.type !== 'literal') o[p.type] = +p.value;
    const asUtc = Date.UTC(o.year, o.month - 1, o.day, o.hour % 24, o.minute, o.second);
    return Math.round((asUtc - Math.floor(t / 1000) * 1000) / 60000);
  } catch (e) { return tz || 0; }
}
function localParts(now, tz, tzName) {
  const off = tzOffsetAt(now, tz, tzName);
  const d = new Date(now + off * 60000); const p = (n) => (n < 10 ? '0' : '') + n;
  const date = d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  return { date, hour: d.getUTCHours(), dayStart: localTime(date, 0, tz, tzName) };
}
// The real instant at which the wall clock in the person's zone shows ymd + hour:00.
function localTime(ymd, hour, tz, tzName) {
  const base = Date.parse(ymd + 'T00:00:00Z') + hour * 3600000;
  let t = base - (tzOffsetAt(base, tz, tzName)) * 60000;
  t = base - tzOffsetAt(t, tz, tzName) * 60000; // second pass settles the DST edge
  return t;
}
function dayShift(ymd, n) { const t = Date.parse(ymd + 'T00:00:00Z') + n * 86400000; return new Date(t).toISOString().slice(0, 10); }

/* ------------------------------ Rule Studio ------------------------------
   A clinician writes a rule in plain words. Code (or the AI) DRAFTS it, a human APPROVES it, and fixed code RUNS it.
   The plain-English read-back is written by code from the rule itself, never by the AI, so what the doctor
   reads is exactly what will run. */
const MAX_RULES = 10;
const NUMWORDS = { one: 1, once: 1, two: 2, twice: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
function numTok(x) { if (x == null) return null; const k = String(x).toLowerCase(); return /^\d+$/.test(k) ? +k : (NUMWORDS[k] || null); }

function normText(s) { return ' ' + String(s == null ? '' : s).toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim() + ' '; }
function symptomMatch(text, term) {
  const words = normText(text).trim().split(' ');
  const kws = String(term).toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  if (!kws.length) return false;
  return kws.every((k) => { const st = k.slice(0, Math.min(4, k.length)); return words.some((w) => w.startsWith(st)); });
}

function validateRule(r) {
  const bad = (e) => ({ ok: false, error: e });
  if (!r || typeof r !== 'object') return bad('Rule is missing.');
  const name = cleanName(r.name, 60); if (!name) return bad('Give the rule a name.');
  if (r.severity !== 'emergency' && r.severity !== 'notice') return bad('Choose emergency or notice.');
  const logic = r.logic === 'any' ? 'any' : 'all';
  if (!Array.isArray(r.conditions) || r.conditions.length < 1 || r.conditions.length > 4) return bad('A rule needs 1 to 4 conditions.');
  const conditions = [];
  for (const c of r.conditions) {
    if (!c || typeof c !== 'object') return bad('Bad condition.');
    if (c.type === 'reading') {
      const field = c.field === 'dia' ? 'dia' : c.field === 'sys' ? 'sys' : null;
      const op = c.op === '<=' ? '<=' : c.op === '>=' ? '>=' : null;
      const value = c.value, times = c.times, withinDays = c.withinDays;
      if (!field || !op) return bad('Reading conditions need sys or dia and a direction.');
      if (!Number.isInteger(value) || value < 30 || value > 300) return bad('The number must be between 30 and 300.');
      if (!Number.isInteger(times) || times < 1 || times > 10) return bad('Times must be 1 to 10.');
      if (!Number.isInteger(withinDays) || withinDays < 1 || withinDays > 30) return bad('Days must be 1 to 30.');
      conditions.push({ type: 'reading', field, op, value, times, withinDays });
    } else if (c.type === 'symptom') {
      const mode = c.mode === 'any' ? 'any' : 'all';
      const terms = Array.isArray(c.terms) ? c.terms.map((t) => cleanName(t, 40).toLowerCase()).filter(Boolean) : [];
      if (!terms.length || terms.length > 6) return bad('Add 1 to 6 symptom words.');
      const withinHours = c.withinHours;
      if (!Number.isInteger(withinHours) || withinHours < 1 || withinHours > 72) return bad('Hours must be 1 to 72.');
      conditions.push({ type: 'symptom', mode, terms, withinHours });
    } else return bad('Unknown condition type.');
  }
  return { ok: true, rule: { name, severity: r.severity, logic, conditions } };
}

function dayWord(n) { return n + ' day' + (n === 1 ? '' : 's'); }
function readback(rule) {
  const parts = rule.conditions.map((c) => {
    if (c.type === 'reading') {
      const f = c.field === 'sys' ? 'the top number (systolic)' : 'the bottom number (diastolic)';
      return f + ' is ' + c.value + (c.op === '>=' ? ' or higher' : ' or lower') + ', ' + (c.times === 1 ? 'at least once' : 'at least ' + c.times + ' times') + ' in the last ' + dayWord(c.withinDays);
    }
    const list = c.terms.join(c.mode === 'any' ? ' or ' : ' and ');
    return 'the person reports ' + list + ' within the last ' + c.withinHours + ' hour' + (c.withinHours === 1 ? '' : 's');
  });
  const lead = rule.conditions.length === 1 ? 'When ' : (rule.logic === 'any' ? 'When ANY of these is true: ' : 'When ALL of these are true: ');
  const what = rule.severity === 'emergency' ? 'ACTION: rings the caregivers like a call and tells the person to call 112.' : 'ACTION: sends a heads-up to the caregivers and the clinician. It does not ring.';
  return lead + parts.join('; ') + '. ' + what;
}

function evaluateRule(rule, ctx) {
  const evidence = []; let results = [];
  for (const c of rule.conditions) {
    if (c.type === 'reading') {
      const from = ctx.now - c.withinDays * 86400000;
      const hits = ctx.readings.filter((r) => r.t >= from && (c.op === '>=' ? r[c.field] >= c.value : r[c.field] <= c.value));
      const met = hits.length >= c.times; results.push(met);
      if (met) hits.slice(-c.times).forEach((r) => evidence.push({ title: r.date, text: r.sys + '/' + r.dia + ' (rule: ' + (c.field === 'sys' ? 'top' : 'bottom') + ' number ' + (c.op === '>=' ? '>= ' : '<= ') + c.value + ')' }));
    } else {
      const from = ctx.now - c.withinHours * 3600000;
      const recent = ctx.symptoms.filter((x) => x.t >= from);
      const text = recent.map((x) => x.text).join(' . ');
      const met = c.mode === 'any' ? c.terms.some((t) => symptomMatch(text, t)) : c.terms.every((t) => symptomMatch(text, t));
      results.push(met);
      if (met) recent.slice(-3).forEach((x) => evidence.push({ title: new Date(x.t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC', text: 'Reported: "' + x.text + '"' }));
    }
  }
  const fired = rule.logic === 'any' ? results.some(Boolean) : results.every(Boolean);
  return { fired, evidence: fired ? evidence : [] };
}

// Turns a plain sentence into a DRAFT rule. Plain code, no AI. Returns null if it cannot understand.
function parseRuleText(raw) {
  const t = ' ' + String(raw || '').toLowerCase().replace(/[’"“”]/g, '').replace(/\s+/g, ' ').trim() + ' ';
  if (t.trim().length < 6) return null;
  const conds = []; let rest = t;
  const wnum = '(\\d+|one|two|three|four|five|six|seven|once|twice)';
  const days = (new RegExp('(?:in|within|over|during)(?: the)?(?: last| past)? ' + wnum + ' days?')).exec(t);
  const withinDays = days ? Math.min(30, Math.max(1, numTok(days[1]) || 3)) : 3;
  const tm = (new RegExp('(?:\\b' + wnum + ' times\\b|\\b(once|twice)\\b)')).exec(t);
  const times = tm ? Math.min(10, Math.max(1, numTok(tm[1] || tm[2]) || 1)) : 1;
  const re = /(systolic|top number|upper number|\bsys\b|diastolic|bottom number|lower number|\bdia\b)[^0-9]{0,30}?(at least|above|over|greater than|higher than|more than|below|under|less than|lower than|>=|<=|>|<)?\s*(\d{2,3})/g;
  let m;
  while ((m = re.exec(t))) {
    const field = /^(diastolic|bottom|lower|dia)/.test(m[1].trim()) ? 'dia' : 'sys';
    const w = (m[2] || 'at least');
    let op = /below|under|less|lower|<=|</.test(w) ? '<=' : '>=';
    let value = +m[3];
    if (/^(above|over|greater|higher|more|>)/.test(w) && w !== '>=') value += 1;
    if (/^(below|under|less|lower|<)/.test(w) && w !== '<=') value -= 1;
    conds.push({ type: 'reading', field, op, value, times, withinDays });
    rest = rest.replace(m[0], ' ');
  }
  const sm = /(?:reports?|reporting|mentions?|says?|complains? of|complaining of|has|have|experiences?|experiencing|symptoms? of|monitor(?:ing)? for|watch(?:ing)? for|tracks?|if (?:she|he|they|the patient|the person) (?:gets?|feels?)|gets?|feels?)\s+(.+)$/.exec(rest);
  if (sm) {
    const FILL = /\b(the|a|an|any|some|my|her|his|their|of|from|if|when|they|she|he|patient|person|then|also|alert|notify|ring|me|us|and then|as well|please|within|in|hours?|today|days?|last|past|\d+)\b/g;
    const anyMode = / or /.test(sm[1]) && !/ and /.test(sm[1]);
    const terms = sm[1].split(/,| and | or | with | plus | together with /).map((x) => x.replace(FILL, ' ').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim()).filter((x) => x && x.split(' ').length <= 3 && !/\b(systolic|diastolic|pressure|number|sys|dia|reading|readings)\b/.test(x));
    if (terms.length) {
      const hh = /(\d+|one|two|three|four|five|six)\s*hours?/.exec(t);
      conds.push({ type: 'symptom', mode: anyMode ? 'any' : 'all', terms: [...new Set(terms)].slice(0, 6), withinHours: hh ? Math.min(72, Math.max(1, numTok(hh[1]) || 24)) : 24 });
    }
  }
  if (!conds.length) return null;
  const severity = /\b(ring|emergency|urgent|immediately|alarm|call me)\b/.test(t) ? 'emergency' : 'notice';
  const nm = String(raw).trim().replace(/\s+/g, ' ');
  const v = validateRule({ name: nm.charAt(0).toUpperCase() + nm.slice(1, 60), severity, logic: 'all', conditions: conds });
  return v.ok ? v.rule : null;
}

/* fixed emergency words (same list the app uses on the phone). Plain code, no AI. */
const EMERGENCY_WORDS = ['chest pain', 'chest dey pain', 'chest dey hurt', 'pain in my chest', 'pain in chest',
  'cannot breathe', "can't breathe", 'cant breathe', 'no fit breathe', 'difficulty breathing', 'hard to breathe',
  'face is drooping', 'face drooping', 'slurred', 'weak on one side', 'one side weak', 'one side of my body',
  'fainted', 'passed out', 'unconscious', 'vomiting blood', 'coughing blood', 'severe headache'];
function serverEmergency(text) {
  const t = normText(text);
  for (const w of EMERGENCY_WORDS) if (t.indexOf(' ' + w.replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim() + ' ') > -1 || t.indexOf(w) > -1) return true;
  return /\bhead\b|headache/.test(t) && /blur|double vision|cannot see|can't see|cant see|no see/.test(t);
}
function looksLikeSymptom(text) {
  return /(headache|head |dizz|vision|blur|pain|ache|nause|vomit|breath|swell|chest|faint|weak|numb|sweat|palpit|cough|fever|tired|sick)/i.test(String(text || ''));
}

/* ------------------------------ proof receipts ------------------------------
   Every line of an alert's timeline is chained to the one before it with SHA-256. Anyone holding a
   receipt link can recompute the chain in their browser and see if a single word was changed. */
async function seal(a, pid, env) {
  if (a.v !== 2) { a.v = 2; a.entries = []; a.salt = null; a.head = null; }
  a.entries = a.entries || [];
  for (let i = a.entries.length; i < a.log.length; i++) { const e = await chainAppend(a, pid, a.id, kindOf(a.log[i].text), a.log[i].text, a.log[i].t); delete e.text; }
  a.signature = await signHead(env, pid, a.id, a.head);
}

/* ------------------------------ alert chain (household) ------------------------------ */
function logLine(a, t, text) { a.log.push({ t, text }); }
function joinedChain(h) {
  return h.caregivers.filter((c) => c.tokenHash && (c.role || 'caregiver') === 'caregiver').sort((x, y) => x.order - y.order).map((c) => ({ id: c.id, name: c.name }));
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
  if (h.alert) { h.history = h.history || []; h.history.unshift(h.alert); h.history = h.history.slice(0, 5); }
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
    log: a.log, head: a.head || null,
  };
}

/* ------------------------------ the household Durable Object ------------------------------ */
const DOSE_SLOTS = ['morning', 'afternoon', 'evening', 'night'];
function cleanSlots(a) { return Array.isArray(a) ? DOSE_SLOTS.filter((x) => a.includes(x)) : []; }

// Summary of the newest push attempt for the subscriptions matching pred. No endpoint, no keys, no message text.
function pushDiag(h, pred) {
  const subs = (h.pushSubs || []).filter(pred), st = h.pushStatus || {};
  if (!subs.length) return { subscribed: false };
  const all = subs.map((x) => st[x.eh] || {}).sort((a, b) => (b.lastAttemptAt || 0) - (a.lastAttemptAt || 0));
  const max = (k) => all.reduce((m, x) => Math.max(m, x[k] || 0), 0) || null;
  return { subscribed: true, phones: subs.length, lastAttemptAt: all[0].lastAttemptAt || null, lastState: all[0].lastState || null, lastHttp: all[0].lastHttp || null, lastAcceptedAt: max('lastAcceptedAt'), lastDisplayedAt: max('lastDisplayedAt') };
}

// What a person may see about one push attempt: a state and an HTTP code. Never the endpoint, keys or message text.
function diagView(r) {
  const word = { accepted: 'The push service accepted the request. This does not prove the phone showed it.', gone: 'The phone subscription expired and was removed. Turn alerts on again on that phone.', rejected: 'The push service refused the request. Turn alerts off and on again on that phone.', throttled: 'The push service asked us to slow down. Try again in a minute.', service_error: 'The push service had a temporary problem. Try again shortly.', network_error: 'The server could not reach the push service. Try again shortly.' };
  return { state: r.state, http: r.http, message: word[r.state] || r.state };
}

export class AlertHub {
  constructor(state, env) {
    this.state = state;
    this.env = env || {};
    this.escalateMs = Number((env || {}).ESCALATE_MS) || DEFAULT_ESCALATE_MS;
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
  limited(keyId, now) {
    this.rl = this.rl || new Map();
    const arr = (this.rl.get(keyId) || []).filter((t) => now - t < 60000);
    if (arr.length >= 60) { this.rl.set(keyId, arr); return Math.max(1, Math.ceil((60000 - (now - arr[0])) / 1000)); }
    arr.push(now); this.rl.set(keyId, arr); return 0;
  }
  async auth(h, req) {
    const now = Date.now();
    const key = req.headers.get('X-Orbit-Key');
    if (key) {
      const km = /^ox_([a-z0-9]{8})_([a-z0-9]{24})$/.exec(key);
      if (!km || km[1] !== h.pid) return null;
      const kh = await sha(km[2]);
      const k = (h.apiKeys || []).find((x) => x.hash === kh);
      if (!k) return null;
      k.lastUsedAt = now;
      return { role: 'api', id: k.id, label: k.label, scopes: k.scopes || LEGACY_SCOPES, sim: !!k.sim, retry: this.limited(k.id, now) };
    }
    const hdr = req.headers.get('Authorization') || '';
    const om = /^Bearer (oxt_([a-z0-9]{8})_[a-z0-9]{32})$/.exec(hdr);
    if (om) {
      if (om[2] !== h.pid) return null;
      const th = await sha(om[1]);
      const t = ((await this.state.storage.get('tokens')) || []).find((x) => x.hash === th && x.exp > now);
      const k = t && (h.apiKeys || []).find((x) => x.id === t.keyId);
      return k ? { role: 'api', id: k.id, label: k.label, scopes: t.scopes, sim: !!k.sim, via: 'oauth', retry: this.limited(k.id, now) } : null;
    }
    const m = /^Bearer ([a-z0-9]{20,64})$/.exec(hdr);
    if (!m) return null;
    const hash = await sha(m[1]);
    if (hash === h.tokenHash) return { role: 'patient' };
    const c = h.caregivers.find((x) => x.tokenHash && x.tokenHash === hash);
    return c ? { role: c.role || 'caregiver', id: c.id } : null;
  }

  /* ---- Web Push: honest states ----
     accepted      = the phone vendor's push service took the request (HTTP 2xx). This is NOT proof the phone showed anything.
     displayed     = the phone's own service worker ran and reported back that it showed the notification.
     gone          = push service says the subscription no longer exists (404/410). We remove it.
     rejected      = 400/401/403/413 (our request was refused; subscription kept so you can diagnose).
     throttled     = 429. service_error = 5xx. network_error = we could not reach the push service. */
  ev(h, now, kind, state, to, http) {
    h.events = h.events || [];
    const e = { t: now, kind, state, to: to || null }; if (http) e.http = http;
    h.events.push(e); if (h.events.length > 60) h.events = h.events.slice(-60);
  }
  async push(h, ehs, now, kind) {
    const cfg = PUSH_KIND[kind] || PUSH_KIND.alert, results = [];
    h.pushStatus = h.pushStatus || {};
    const subs = (h.pushSubs || []).filter((x) => ehs.includes(x.eh));
    let v = null;
    try { v = await vapidKeys(this.state.storage); } catch (e) { console.error('vapid error:', e && e.message); }
    await Promise.all(subs.map(async (sub) => {
      let res = null, state = 'network_error';
      if (v) {
        for (let attempt = 0; attempt < 2; attempt++) { // one retry, only for network errors and 5xx
          try {
            res = await fetch(sub.endpoint, { method: 'POST', headers: { TTL: String(cfg.ttl), Urgency: cfg.urgency, Authorization: await vapidAuth(v, sub.endpoint, this.env) } });
            if (res.status < 500) break;
          } catch (e) { res = null; }
        }
        if (res) { const c = res.status; state = c >= 200 && c < 300 ? 'accepted' : (c === 404 || c === 410) ? 'gone' : c === 429 ? 'throttled' : c >= 500 ? 'service_error' : 'rejected'; }
      } else state = 'rejected';
      const http = res ? res.status : 0, prev = h.pushStatus[sub.eh] || {};
      h.pushStatus[sub.eh] = { ...prev, lastAttemptAt: now, lastState: state, lastHttp: http, lastKind: kind, fails: state === 'accepted' ? 0 : (prev.fails || 0) + 1, lastAcceptedAt: state === 'accepted' ? now : (prev.lastAcceptedAt || null) };
      this.ev(h, now, kind, state, sub.role + (sub.id ? ':' + sub.id : ''), http);
      results.push({ eh: sub.eh, role: sub.role, state, http });
    }));
    const dead = results.filter((r) => r.state === 'gone').map((r) => r.eh);
    if (dead.length) { h.pushSubs = h.pushSubs.filter((x) => !dead.includes(x.eh)); dead.forEach((e) => { delete h.pushStatus[e]; }); }
    return results;
  }
  subsFor(h, pred) { return (h.pushSubs || []).filter(pred).map((x) => x.eh); }
  say(h, ehs, msg, now) { h.pushQ = h.pushQ || {}; ehs.forEach((e) => { h.pushQ[e] = { ...msg, t: now }; }); const keep = new Set((h.pushSubs || []).map((x) => x.eh)); Object.keys(h.pushQ).forEach((k) => { if (!keep.has(k)) delete h.pushQ[k]; }); }
  // Save the message text FIRST (the phone fetches it when the push arrives), then send the wake-up push.
  async deliver(h, ehs, msg, now, kind, label) {
    if (!ehs.length) { this.ev(h, now, kind, 'no_subscription', label); return []; }
    this.say(h, ehs, msg, now);
    await this.state.storage.put('h', h);
    return this.push(h, ehs, now, kind);
  }

  // Looks at the alert and the tablet schedule, tells the right phones, and sets the next wake-up time.
  async afterChange(h, now) {
    try {
      h.pushSubs = h.pushSubs || []; h.pushQ = h.pushQ || {};
      const a = h.alert, mark = a ? a.id + '|' + a.status + '|' + a.idx : '';
      if (a && h.lastPushed !== mark) {
        h.lastPushed = mark;
        const t = target(a), name = h.name || 'Someone';
        let ehs = [], msg = null, kind = 'emergency', label = 'caregivers';
        if (a.status === 'ringing' && t) { kind = a.idx > 0 ? 'escalation' : 'emergency'; label = 'caregiver:' + t.id; ehs = this.subsFor(h, (x) => x.role === 'caregiver' && x.id === t.id); msg = { title: 'Orbit-X ALERT: ' + name + ' needs help', body: (a.sys ? 'Reading ' + a.sys + '/' + a.dia + '. ' : '') + 'Tap to answer now.', tag: 'orbit-alert', urgent: true }; }
        else if (a.status === 'unanswered') { kind = 'unanswered'; ehs = this.subsFor(h, (x) => x.role === 'caregiver' || x.role === 'patient'); msg = { title: 'Orbit-X: no one answered', body: 'Please call ' + name + ' now. If it is an emergency call 112.', tag: 'orbit-alert', urgent: true }; }
        else if (a.status === 'cancelled') { kind = 'cancel_notice'; ehs = this.subsFor(h, (x) => x.role === 'caregiver'); msg = { title: 'Orbit-X: alert cancelled', body: name + ' says they are okay.', tag: 'orbit-alert' }; }
        else if (a.status === 'answered' || a.status === 'handled') { kind = 'handled_notice'; ehs = this.subsFor(h, (x) => x.role === 'caregiver' && x.id !== a.answeredBy); msg = { title: 'Orbit-X: someone is helping', body: 'Another caregiver is handling ' + name + "'s alert.", tag: 'orbit-alert' }; }
        if (msg) await this.deliver(h, ehs, msg, now, kind, label);
        if (a.status === 'answered' && a.answeredBy) { // tell the person help has answered so they can open the app and talk
          const who2 = nameOf(a, a.answeredBy) || 'A caregiver';
          const pe = this.subsFor(h, (x) => x.role === 'patient');
          if (pe.length) await this.deliver(h, pe, { title: 'Orbit-X: ' + who2 + ' answered', body: 'Open Orbit-X to talk to ' + who2 + ' now.', tag: 'orbit-alert', urgent: true }, now, 'answered_notice', 'patient');
        }
      }
      await this.doseCheck(h, now);
      await this.schedule(h, now);
    } catch (e) { console.error('afterChange error:', e && e.message); }
  }

  // Tablet reminders. The person gets a gentle reminder; caregivers get a heads-up only if the person allows it.
  // Each reminder is sent at most once (h.sent), so a repeated alarm or retry cannot spam anyone.
  async doseCheck(h, now) {
    const slots = h.slots || []; if (!slots.length) return;
    h.sent = h.sent || {};
    const tz = h.tz || 0, tzn = h.tzName || '';
    const lp = localParts(now, tz, tzn), name = h.name || 'Someone';
    const logged = new Set((h.doses || []).map((d) => d.date + '|' + d.slot));
    for (const date of [dayShift(lp.date, -1), lp.date]) { // yesterday too: a late alarm must not lose the 23:00 heads-up
      for (const slot of slots) {
        const key = date + '|' + slot;
        if (logged.has(key)) continue;
        const remindAt = localTime(date, REMIND_HOUR[slot], tz, tzn), missAt = localTime(date, MISSED_HOUR[slot], tz, tzn);
        if (now >= remindAt && remindAt > h.createdAt && !h.sent['r|' + key]) {
          h.sent['r|' + key] = 1;
          if (now - remindAt < 2 * 3600000) {
            const ehs = this.subsFor(h, (x) => x.role === 'patient');
            await this.deliver(h, ehs, { title: 'Orbit-X: your ' + slot + ' tablet', body: 'Tap I took my tablet when you have taken it.', tag: 'orbit-dose' }, now, 'reminder', 'patient');
          } else this.ev(h, now, 'reminder', 'window_passed', 'patient');
        }
        if (now >= missAt && missAt > h.createdAt && !h.sent['m|' + key]) {
          h.sent['m|' + key] = 1;
          if (h.tabletAlerts !== false && joinedChain(h).length) {
            if (now - missAt < 3 * 3600000) {
              h.notices = h.notices || [];
              h.notices.push({ id: 'd' + now + slot, t: now, kind: 'missed_dose', text: name + ' has not logged the ' + slot + ' tablet yet.' });
              if (h.notices.length > 30) h.notices = h.notices.slice(-30);
              const ehs = this.subsFor(h, (x) => x.role === 'caregiver');
              await this.deliver(h, ehs, { title: 'Orbit-X: tablet not logged', body: name + ' has not logged the ' + slot + ' tablet yet. A call or message may help.', tag: 'orbit-dose-' + slot }, now, 'missed_dose', 'caregivers');
            } else this.ev(h, now, 'missed_dose', 'window_passed', 'caregivers');
          }
        }
      }
    }
    Object.keys(h.sent).forEach((k) => { const d = k.split('|')[1]; if (d && d < dayShift(lp.date, -3)) delete h.sent[k]; });
  }

  // Sets the Durable Object alarm for the earliest thing that needs to happen next.
  async schedule(h, now) {
    const times = [];
    const a = h.alert;
    if (a && a.status === 'ringing') times.push(a.ringStart + this.escalateMs + 300);
    if ((h.slots || []).length) {
      const tz = h.tz || 0, tzn = h.tzName || '', lp = localParts(now, tz, tzn);
      for (const off of [0, 1, 2]) for (const slot of h.slots) for (const hr of [REMIND_HOUR[slot], MISSED_HOUR[slot]]) { const t = localTime(dayShift(lp.date, off), hr, tz, tzn); if (t > now + 1000) times.push(t); }
    }
    if (!times.length) { if (h.alarmAt) { h.alarmAt = 0; try { await this.state.storage.deleteAlarm(); } catch (e) { /* none */ } } return; }
    const next = Math.max(now + 1000, Math.min(...times));
    if (h.alarmAt && h.alarmAt > now && h.alarmAt === next) {
      // Already set. Self-heal if the platform lost it (getAlarm() returns null); otherwise avoid extra writes.
      let cur; try { cur = typeof this.state.storage.getAlarm === 'function' ? await this.state.storage.getAlarm() : undefined; } catch (e) { cur = undefined; }
      if (cur === undefined || cur) return;
    }
    h.alarmAt = next;
    try { await this.state.storage.setAlarm(next); } catch (e) { console.error('alarm error:', e && e.message); }
  }

  async alarm() {
    const h = await this.state.storage.get('h');
    if (!h) return;
    const now = Date.now();
    if (h.alert) { advance(h.alert, now, this.escalateMs); await seal(h.alert, h.pid, this.env); }
    await this.afterChange(h, now);
    await this.state.storage.put('h', h);
  }

  stateView(h, who, now) {
    return {
      ok: true, now, role: who.role, pid: h.pid,
      me: who.role === 'caregiver' || who.role === 'clinician' ? { id: who.id, name: (h.caregivers.find((c) => c.id === who.id) || {}).name, role: who.role } : null,
      profile: { name: h.name, slots: h.slots, phone: h.phone || '', createdAt: h.createdAt, createdDate: h.createdDate, accountType: h.accountType || 'legacy', org: h.org || '', tabletAlerts: h.tabletAlerts !== false, tz: h.tz || 0, tzName: h.tzName || '', alertsOn: (h.pushSubs || []).some((x) => x.role === who.role && (x.id || null) === (who.id || null)), push: pushDiag(h, (x) => x.role === who.role && (x.id || null) === (who.id || null)), nextReminderAt: h.alarmAt || null },
      caregivers: who.role === 'patient' ? h.caregivers.map((c) => ({ id: c.id, name: c.name, order: c.order, joined: !!c.tokenHash, status: c.tokenHash ? 'joined' : (c.invitedAt && now - c.invitedAt > INVITE_TTL_MS ? 'expired' : 'invited'), invitedAt: c.invitedAt || null, joinedAt: c.joinedAt || null, role: c.role || 'caregiver', phone: c.phone || '', alertsOn: (h.pushSubs || []).some((x) => x.id === c.id), push: pushDiag(h, (x) => x.id === c.id) })) : undefined,
      events: who.role === 'patient' ? (h.events || []).slice(-20) : undefined,
      careNumbers: who.role === 'caregiver' ? { patient: h.phone || '' } : undefined,
      rules: (h.rules || []).map((r) => ({ id: r.id, name: r.name, severity: r.severity, author: r.author, readback: r.readback, createdAt: r.createdAt })),
      notices: (h.notices || []).slice(-20),
      symptoms: (h.symptoms || []).slice(-20),
      apiKeys: who.role === 'patient' ? (h.apiKeys || []).map((k) => ({ id: k.id, label: k.label, createdAt: k.createdAt, scopes: k.scopes || LEGACY_SCOPES, simulated: !!k.sim, lastUsedAt: k.lastUsedAt || null })) : undefined,
      readings: h.readings.slice(-120), doses: h.doses.slice(-240),
      alert: alertView(h.alert, who, now, this.escalateMs),
    };
  }

  // Runs the clinician's approved rules. Fixed code: same input, same answer, every time.
  runRules(h, now) {
    const ctx = { readings: h.readings, symptoms: h.symptoms, now };
    for (const r of h.rules) {
      if (now - (h.rulesFired[r.id] || 0) < 12 * 3600000) continue;
      const res = evaluateRule(r, ctx);
      if (!res.fired) continue;
      h.rulesFired[r.id] = now;
      if (r.severity === 'emergency') {
        const prev = h.alert, last = h.readings[h.readings.length - 1];
        const a = startAlert(h, { why: 'Rule: ' + r.name, sys: last && r.conditions.some((c) => c.type === 'reading') ? last.sys : null, dia: last && r.conditions.some((c) => c.type === 'reading') ? last.dia : null }, now);
        if (a !== prev) {
          logLine(a, now, 'Rule matched: ' + r.name + ' (written by ' + r.author + ')');
          res.evidence.forEach((e) => logLine(a, now, e.title + ': ' + e.text));
        }
      } else {
        h.notices.push({ id: 'n' + now, t: now, ruleId: r.id, ruleName: r.name, text: 'A rule matched: ' + r.name, evidence: res.evidence });
        if (h.notices.length > 30) h.notices = h.notices.slice(-30);
      }
    }
  }

  // The AI may only DRAFT a rule as JSON. The draft is validated by code, then a clinician reads the
  // code-written read-back and approves it. The AI never runs a rule and never decides an emergency.
  async draftWithSpark(text) {
    try {
      const out = await metaChat(this.env, { temperature: 0, messages: [
        { role: 'system', content: 'You convert a clinician instruction into a JSON alert rule. Output ONLY JSON, no words. Schema: {"name":string,"severity":"emergency"|"notice","logic":"all"|"any","conditions":[{"type":"reading","field":"sys"|"dia","op":">="|"<=","value":int,"times":int,"withinDays":int} | {"type":"symptom","mode":"all"|"any","terms":[string],"withinHours":int}]}. Use "notice" unless the instruction clearly asks for an emergency or ringing. Do not invent thresholds that were not given. If the instruction cannot be expressed, output {"error":"cannot"}.' },
        { role: 'user', content: text },
      ] });
      const m = /\{[\s\S]*\}/.exec(out || ''); if (!m) return null;
      const v = validateRule(JSON.parse(m[0]));
      return v.ok ? v.rule : null;
    } catch (e) { console.error('draft error:', e && e.message); return null; }
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
      const slots = Array.isArray(body.slots) ? cleanSlots(body.slots) : [];
      const token = rand(40);
      h = { v: 1, pid: String(body.pid || ''), name, slots, phone: cleanPhone(body.phone), createdAt: now, createdDate: validDate(body.today, now) ? body.today : new Date(now).toISOString().slice(0, 10),
        tokenHash: await sha(token), caregivers: [], readings: [], doses: [], alert: null, nextCid: 1,
        accountType: body.accountType === 'provider' ? 'provider' : 'individual', org: cleanName(body.org, 60), tz: Number.isInteger(body.tz) && Math.abs(body.tz) <= 840 ? body.tz : 0, tzName: validTzName(body.tzName), tabletAlerts: true, events: [], pushStatus: {} };
      await this.state.storage.put('h', h);
      await this.afterChange(h, now); // sets the first reminder alarm right away when tablet times were chosen
      await this.state.storage.put('h', h);
      return json({ ok: true, pid: h.pid, token, accountType: h.accountType, remindersScheduled: !!h.alarmAt });
    }
    if (!h) return bad(404, 'not_found');
    h.rules = h.rules || []; h.rulesFired = h.rulesFired || {}; h.symptoms = h.symptoms || []; h.notices = h.notices || [];
    h.apiKeys = h.apiKeys || []; h.shares = h.shares || []; h.history = h.history || []; h.nextRid = h.nextRid || 1;

    if (action === 'receipt') {
      const sid = new URL(req.url).searchParams.get('s') || '';
      const sh = h.shares.find((x) => x.id === sid);
      if (!sh) return bad(404, 'no_receipt');
      if (sh.kind !== 'handoff') { const al = [h.alert, ...h.history].filter(Boolean).find((x) => x.id === sh.alertId); if (al && al.v !== 2) { await seal(al, h.pid, this.env); await this.state.storage.put('h', h); } }
      const D = await loadForReceipt(this.state.storage);
      const r = await publicReceipt(this.env, h.pid, sh, D, h);
      return r ? json(r) : bad(404, 'no_receipt');
    }
    if (action === 'pushmsg') {
      const e = new URL(req.url).searchParams.get('e') || '';
      const q = h.pushQ && /^[a-f0-9]{64}$/.test(e) ? h.pushQ[e] : null;
      return q ? json({ ok: true, title: q.title, body: q.body, tag: q.tag || 'orbit', urgent: !!q.urgent, t: q.t }) : json({ ok: true, title: 'Orbit-X', body: 'Open Orbit-X to see what is new.', tag: 'orbit' });
    }
    if (action === 'pushack') { // the phone's service worker reports that it really displayed the notification
      const e = new URL(req.url).searchParams.get('e') || '';
      if (!/^[a-f0-9]{64}$/.test(e) || !(h.pushSubs || []).some((x) => x.eh === e)) return bad(404, 'unknown_subscription');
      if (this.limited('ack:' + e, now)) return bad(429, 'rate_limited');
      h.pushStatus = h.pushStatus || {}; h.pushStatus[e] = { ...(h.pushStatus[e] || {}), lastDisplayedAt: now };
      await this.state.storage.put('h', h);
      return json({ ok: true });
    }
    if (action === 'briefpublic') return handleConnect({ h, storage: this.state.storage, env: this.env, who: { role: 'link' }, body, now, req, action });
    if (action === 'v1token') {
      return oauthToken({ storage: this.state.storage }, h, body, this.env, now);
    }

    if (action === 'join') {
      this.jf = (this.jf || []).filter((t) => now - t < 600000);
      if (this.jf.length >= 10) return json({ ok: false, error: 'too_many_attempts', retryAfterSeconds: Math.ceil((600000 - (now - this.jf[0])) / 1000) }, 429, { 'Retry-After': String(Math.ceil((600000 - (now - this.jf[0])) / 1000)) });
      const secretHash = await sha(String(body.secret || ''));
      const c = h.caregivers.find((x) => x.secretHash && x.secretHash === secretHash);
      if (!c) { this.jf.push(now); return bad(404, 'invalid_code'); }
      if (c.invitedAt && now - c.invitedAt > INVITE_TTL_MS) return bad(410, 'invite_expired');
      const token = rand(40);
      c.tokenHash = await sha(token); c.secretHash = null; c.joinedAt = now;
      this.ev(h, now, 'invite', 'joined', (c.role || 'caregiver') + ':' + c.id);
      await this.state.storage.put('h', h);
      return json({ ok: true, pid: h.pid, token, id: c.id, name: c.name, role: c.role || 'caregiver', patientName: h.name });
    }

    const who = await this.auth(h, req);
    if (!who) return bad(401, 'unauthorized');
    const before = JSON.stringify(h);
    let extra = {}, status = 200, error = null;
    const fail = (s, e) => { status = s; error = e; };
    if (h.alert) advance(h.alert, now, this.escalateMs);
    const isPatient = who.role === 'patient';
    if (who.retry) return new Response(JSON.stringify({ ok: false, error: 'rate_limited', retryAfterSeconds: who.retry }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(who.retry), 'Cache-Control': 'no-store' } });
    if (WORKSPACE_ACTIONS.has(action) || V1_ACTIONS.has(action)) {
      const res = await handleConnect({ h, storage: this.state.storage, env: this.env, who, body, now, req, action });
      if (JSON.stringify(h) !== before) await this.state.storage.put('h', h);
      return res || bad(404, 'unknown_action');
    }

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
        this.runRules(h, now);
        extra.emergency = emergency;
        break;
      }
      case 'dose': {
        if (!isPatient) { fail(403, 'patient_only'); break; }
        if (!DOSE_SLOTS.includes(body.slot) || !validDate(body.date, now)) { fail(400, 'bad_dose'); break; }
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
        if (activeAlert(h.alert) || (h.alert && h.alert.status === 'unanswered')) { h.alert.status = 'cancelled'; logLine(h.alert, now, h.name + ' says they are okay. Alert cancelled'); }
        else fail(409, 'no_alert');
        break;
      }
      case 'undose': {
        if (!isPatient) { fail(403, 'patient_only'); break; }
        if (!DOSE_SLOTS.includes(body.slot) || !validDate(body.date, now)) { fail(400, 'bad_dose'); break; }
        h.doses = h.doses.filter((d) => !(d.date === body.date && d.slot === body.slot));
        break;
      }
      case 'ice': { // network helpers for the in-app voice call. STUN always; TURN too when Cloudflare TURN secrets are set.
        if (who.role !== 'patient' && who.role !== 'caregiver') { fail(403, 'forbidden'); break; }
        let servers = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
        if (this.env.TURN_KEY_ID && this.env.TURN_API_TOKEN) {
          try {
            const r = await fetch('https://rtc.live.cloudflare.com/v1/turn/keys/' + encodeURIComponent(this.env.TURN_KEY_ID) + '/credentials/generate-ice-servers', {
              method: 'POST', headers: { Authorization: 'Bearer ' + this.env.TURN_API_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 7200 }) });
            if (r.ok) { const j = await r.json(); if (Array.isArray(j.iceServers)) servers = servers.concat(j.iceServers); }
          } catch (e) { console.error('turn error:', e && e.message); }
        }
        extra.iceServers = servers; extra.turn = servers.length > 1;
        break;
      }
      case 'rtc': { // signalling for a live voice call between the person and the caregiver who answered
        const a = h.alert;
        const okRole = isPatient || (who.role === 'caregiver' && a && a.answeredBy === who.id);
        if (!a || !okRole || a.status !== 'answered') { fail(409, 'no_call'); break; }
        if (!h.rtc || h.rtc.aid !== a.id) h.rtc = { aid: a.id, offerId: 0, offer: null, answer: null, ended: false };
        const r = h.rtc, op = String(body.op || 'poll'), sdp = typeof body.sdp === 'string' ? body.sdp : '';
        const okSdp = sdp.length > 20 && sdp.length <= 12000 && sdp.startsWith('v=0');
        if (op === 'offer' && !isPatient && okSdp) { r.offerId = now; r.offer = sdp; r.answer = null; r.ended = false; logLine(a, now, 'Voice call started'); }
        else if (op === 'answer' && isPatient && okSdp && Number(body.offerId) === r.offerId && !r.answer) { r.answer = sdp; }
        else if (op === 'end') { r.ended = true; }
        extra.rtc = { offerId: r.offerId, offer: isPatient ? r.offer : null, answer: isPatient ? null : r.answer, ended: r.ended };
        break;
      }
      case 'answer': case 'decline': case 'handled': {
        if (who.role !== 'caregiver') { fail(403, 'caregiver_only'); break; }
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
        const irole = body.role === 'clinician' ? 'clinician' : 'caregiver';
        if (h.caregivers.filter((x) => (x.role || 'caregiver') === irole).length >= (irole === 'clinician' ? 3 : MAX_CAREGIVERS)) { fail(409, 'too_many'); break; }
        const secret = rand(6);
        const c = { id: 'c' + h.nextCid++, name, phone: cleanPhone(body.phone), role: irole, order: irole === 'caregiver' ? h.caregivers.filter((x) => (x.role || 'caregiver') === 'caregiver').length + 1 : 0, secretHash: await sha(secret), tokenHash: null, joinedAt: null, invitedAt: now };
        h.caregivers.push(c);
        extra.code = inviteCode(h.pid, secret); extra.caregiverId = c.id;
        break;
      }
      case 'reinvite': {
        if (!isPatient) { fail(403, 'patient_only'); break; }
        const c = h.caregivers.find((x) => x.id === body.id);
        if (!c) { fail(404, 'no_caregiver'); break; }
        const secret = rand(6);
        c.secretHash = await sha(secret); c.tokenHash = null; c.joinedAt = null; c.invitedAt = now;
        h.pushSubs = (h.pushSubs || []).filter((x) => x.id !== c.id); // the old phone no longer belongs to this person
        extra.code = inviteCode(h.pid, secret); extra.caregiverId = c.id;
        break;
      }
      case 'remove': {
        if (!isPatient) { fail(403, 'patient_only'); break; }
        const i = h.caregivers.findIndex((x) => x.id === body.id);
        if (i < 0) { fail(404, 'no_caregiver'); break; }
        const gone = h.caregivers[i].id; h.caregivers.splice(i, 1);
        h.pushSubs = (h.pushSubs || []).filter((x) => x.id !== gone); // a removed caregiver must stop receiving alerts
        h.caregivers.filter((x) => (x.role || 'caregiver') === 'caregiver').forEach((c, k) => { c.order = k + 1; });
        break;
      }
      case 'profile': {
        if (!isPatient) { fail(403, 'patient_only'); break; }
        if (body.name !== undefined) { const n = cleanName(body.name); if (!n) { fail(400, 'name_required'); break; } h.name = n; }
        if (body.phone !== undefined) h.phone = cleanPhone(body.phone);
        if (Array.isArray(body.slots)) h.slots = cleanSlots(body.slots);
        if (Number.isInteger(body.tz) && Math.abs(body.tz) <= 840) h.tz = body.tz;
        if (body.tzName !== undefined) h.tzName = validTzName(body.tzName);
        if (typeof body.tabletAlerts === 'boolean') h.tabletAlerts = body.tabletAlerts;
        break;
      }
      case 'pushkey': { extra.key = (await vapidKeys(this.state.storage)).pub; break; }
      case 'pushsub': {
        if (!['patient', 'caregiver', 'clinician'].includes(who.role)) { fail(403, 'not_allowed'); break; }
        const sub = body.sub, ep = sub && typeof sub.endpoint === 'string' ? sub.endpoint : '';
        if (!validPushEndpoint(ep, this.env)) { fail(400, 'bad_subscription'); break; }
        const eh = await sha(ep);
        h.pushSubs = (h.pushSubs || []).filter((x) => x.eh !== eh);
        h.pushSubs.push({ eh, endpoint: ep, role: who.role, id: who.id || null, t: now });
        if (h.pushSubs.length > 12) h.pushSubs = h.pushSubs.slice(-12);
        h.pushQ = h.pushQ || {}; h.pushStatus = h.pushStatus || {};
        h.pushStatus[eh] = { ...(h.pushStatus[eh] || {}), subscribedAt: now };
        h.pushQ[eh] = { title: 'Orbit-X', body: 'Alerts are on for this phone.', tag: 'orbit-ready', t: now };
        if (body.confirm === true) { extra.diag = (await this.deliver(h, [eh], h.pushQ[eh], now, 'ready', who.role)).map(diagView); }
        extra.eh = eh;
        break;
      }
      case 'pushoff': {
        const gone = (h.pushSubs || []).filter((x) => x.role === who.role && (x.id || null) === (who.id || null)).map((x) => x.eh);
        h.pushSubs = (h.pushSubs || []).filter((x) => !gone.includes(x.eh));
        gone.forEach((e) => { delete (h.pushStatus || {})[e]; });
        break;
      }
      case 'testpush': {
        const mine = (h.pushSubs || []).filter((x) => x.role === who.role && (x.id || null) === (who.id || null)).map((x) => x.eh);
        if (!mine.length) { fail(409, 'alerts_not_on'); break; }
        h.pushQ = h.pushQ || {};
        const results = await this.deliver(h, mine, { title: 'Orbit-X test', body: 'This is a test. Your phone can get alerts.', tag: 'orbit-test' }, now, 'test', who.role);
        extra.diag = results.map(diagView);
        break;
      }
      case 'delete': {
        if (!isPatient) { fail(403, 'patient_only'); break; }
        try { await this.state.storage.deleteAlarm(); } catch (e) { /* none */ }
        await this.state.storage.deleteAll();
        return json({ ok: true, deleted: true });
      }

      case 'symptom': {
        if (!isPatient) { fail(403, 'patient_only'); break; }
        const text = cleanName(body.text, 200);
        if (!text) { fail(400, 'text_required'); break; }
        h.symptoms.push({ t: now, text });
        if (h.symptoms.length > 100) h.symptoms = h.symptoms.slice(-100);
        const fixed = serverEmergency(text);
        if (fixed) startAlert(h, { why: text }, now);
        this.runRules(h, now);
        extra.emergency = fixed;
        break;
      }
      case 'draft': {
        if (who.role !== 'clinician') { fail(403, 'clinician_only'); break; }
        const text = cleanName(body.text, 400);
        if (!text) { fail(400, 'text_required'); break; }
        let rule = parseRuleText(text), source = 'parser';
        if (!rule && this.env.MODEL_API_KEY) { rule = await this.draftWithSpark(text); source = 'spark'; }
        if (!rule) { fail(422, 'cannot_parse'); break; }
        extra.draft = { rule, readback: readback(rule), source };
        break;
      }
      case 'rulesave': {
        if (who.role !== 'clinician') { fail(403, 'clinician_only'); break; }
        const v = validateRule(body.rule);
        if (!v.ok) { fail(400, 'bad_rule'); extra.reason = v.error; break; }
        if (h.rules.length >= MAX_RULES) { fail(409, 'too_many_rules'); break; }
        const me = h.caregivers.find((c) => c.id === who.id) || {};
        h.rules.push({ id: 'r' + h.nextRid++, ...v.rule, author: me.name || 'Clinician', createdAt: now, readback: readback(v.rule) });
        break;
      }
      case 'ruledel': {
        if (who.role !== 'clinician') { fail(403, 'clinician_only'); break; }
        const i = h.rules.findIndex((r) => r.id === body.id);
        if (i < 0) { fail(404, 'no_rule'); break; }
        h.rules.splice(i, 1); delete h.rulesFired[body.id];
        break;
      }
      case 'share': {
        if (who.role === 'api') { fail(403, 'not_allowed'); break; }
        const al = (body.alertId && [h.alert, ...h.history].filter(Boolean).find((x) => x.id === body.alertId)) || h.alert || h.history[0];
        if (!al) { fail(404, 'no_alert'); break; }
        let sh = h.shares.find((x) => x.alertId === al.id);
        if (!sh) { sh = { id: rand(10), alertId: al.id, t: now }; h.shares.push(sh); if (h.shares.length > 10) h.shares = h.shares.slice(-60); }
        extra.shareId = sh.id;
        break;
      }
      case 'apikey': {
        if (!isPatient) { fail(403, 'patient_only'); break; }
        if (h.accountType === 'individual') { fail(403, 'provider_only'); break; }
        if (h.apiKeys.length >= 5) { fail(409, 'too_many_keys'); break; }
        const scopes = Array.isArray(body.scopes) ? [...new Set(body.scopes.filter((x) => SCOPES.includes(x)))] : LEGACY_SCOPES;
        if (!scopes.length) { fail(400, 'no_valid_scopes'); extra.allowed = SCOPES; break; }
        const secret = rand(24), label = cleanName(body.label, 30) || 'My app';
        const kid = 'k' + now;
        h.apiKeys.push({ id: kid, label, hash: await sha(secret), createdAt: now, scopes, sim: body.simulated === true });
        extra.key = 'ox_' + h.pid + '_' + secret; extra.keyId = kid; extra.scopes = scopes;
        break;
      }
      case 'apikeydel': {
        if (!isPatient) { fail(403, 'patient_only'); break; }
        const i = h.apiKeys.findIndex((k) => k.id === body.id);
        if (i < 0) { fail(404, 'no_key'); break; }
        h.apiKeys.splice(i, 1);
        break;
      }
      case 'signal': case 'apistate': {
        if (who.role !== 'api' && !(isPatient && action === 'signal')) { fail(403, 'api_only'); break; }
        if (who.role === 'api' && !who.scopes.includes(action === 'signal' ? 'events:write' : 'events:read')) { fail(403, 'insufficient_scope'); extra.required = action === 'signal' ? 'events:write' : 'events:read'; break; }
        if (action === 'apistate') break;
        const type = body.type;
        if (type === 'reading') {
          const sys = body.sys, dia = body.dia, date = validDate(body.date, now) ? body.date : new Date(now).toISOString().slice(0, 10);
          if (!Number.isInteger(sys) || !Number.isInteger(dia) || sys < 50 || sys > 300 || dia < 30 || dia > 200 || sys <= dia) { fail(400, 'bad_reading'); break; }
          h.readings.push({ t: now, date, sys, dia });
          if (h.readings.length > 400) h.readings = h.readings.slice(-400);
          if (isEmergencyReading(sys, dia)) startAlert(h, { sys, dia, why: 'High reading' }, now);
          this.runRules(h, now);
        } else if (type === 'symptom') {
          const text = cleanName(body.text, 200);
          if (!text) { fail(400, 'text_required'); break; }
          h.symptoms.push({ t: now, text }); if (h.symptoms.length > 100) h.symptoms = h.symptoms.slice(-100);
          if (serverEmergency(text)) startAlert(h, { why: text }, now);
          this.runRules(h, now);
        } else if (type === 'fall' || type === 'sos') {
          startAlert(h, { why: cleanName(body.why, 120) || (type === 'fall' ? 'Fall detected' : 'Help requested') }, now);
        } else { fail(400, 'bad_type'); break; }
        break;
      }
      default: return bad(404, 'unknown_action');
    }

    if (h.alert) await seal(h.alert, h.pid, this.env);
    await this.afterChange(h, now);
    if (error) { if (JSON.stringify(h) !== before) await this.state.storage.put('h', h); return json({ ok: false, error, ...extra }, status); }
    if (who.role === 'api') {
      const al = h.alert; let receipt = null;
      if (al) { let sh = h.shares.find((x) => x.alertId === al.id); if (!sh) { sh = { id: rand(10), alertId: al.id, t: now }; h.shares.push(sh); h.shares = h.shares.slice(-60); } receipt = '/receipt.html?p=' + h.pid + '&s=' + sh.id; }
      if (JSON.stringify(h) !== before) await this.state.storage.put('h', h);
      return json({ ok: true, now, alert: alertView(al, { role: 'api' }, now, this.escalateMs), receipt });
    }
    if (JSON.stringify(h) !== before) await this.state.storage.put('h', h);
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
  if (!env.MODEL_API_KEY) return json({ error: 'not_configured', message: 'The AI assistant is not set up on this server (MODEL_API_KEY is missing). Everything else in Orbit-X still works.' }, 503, cors);
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
  const okey = req.headers.get('X-Orbit-Key'); if (okey) headers.set('X-Orbit-Key', okey);
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
  // public, read-only proof receipt. The long random share id is the key.
  const rc = /^\/api\/receipt\/([a-z0-9]{8})\/([a-z0-9]{10})$/.exec(p);
  if (rc && req.method === 'GET') return relay(await forward(hub(env, 'h:' + rc[1]), '/h/receipt?s=' + rc[2], req, undefined), cors);
  // Orbit Connect v1 API
  if (p.startsWith('/api/v1/') && p !== '/api/v1/signals' && p !== '/api/v1/alert') return handleV1(req, env, url, cors);
  // Orbit API for partner apps: send a signal, read the live alert.
  if ((p === '/api/v1/signals' && req.method === 'POST') || (p === '/api/v1/alert' && req.method === 'GET')) {
    const km = /^ox_([a-z0-9]{8})_[a-z0-9]{24}$/.exec(req.headers.get('X-Orbit-Key') || '');
    if (!km) return json({ ok: false, error: 'missing_or_bad_key' }, 401, cors);
    const text = req.method === 'POST' ? await req.text() : undefined;
    if (text && text.length > 4000) return json({ error: 'too_large' }, 413, cors);
    return relay(await forward(hub(env, 'h:' + km[1]), p === '/api/v1/signals' ? '/h/signal' : '/h/apistate', req, text), cors);
  }
  // Personal workspace (patient session only)
  const wm = /^\/api\/w\/([a-z0-9]{8})\/([a-z]{2,12})$/.exec(p);
  if (wm) {
    if (!WORKSPACE_ACTIONS.has(wm[2]) || wm[2] === 'briefpublic') return json({ error: 'Not found' }, 404, cors);
    const get = req.method === 'GET' && ['wstate', 'docget', 'auditlog'].includes(wm[2]);
    if (!get && req.method !== 'POST') return json({ error: 'Not found' }, 404, cors);
    const text = req.method === 'POST' ? await req.text() : undefined;
    if (text && text.length > 90000) return json({ error: 'too_large' }, 413, cors);
    return relay(await forward(hub(env, 'h:' + wm[1]), '/h/' + wm[2] + url.search, req, text), cors);
  }
  const pm = /^\/api\/push\/msg\/([a-z0-9]{8})$/.exec(p);
  if (pm && req.method === 'GET') return relay(await forward(hub(env, 'h:' + pm[1]), '/h/pushmsg' + url.search, req, undefined), cors);
  const am = /^\/api\/push\/ack\/([a-z0-9]{8})$/.exec(p);
  if (am && req.method === 'POST') return relay(await forward(hub(env, 'h:' + am[1]), '/h/pushack' + url.search, req, ''), cors);
  const bm = /^\/api\/brief\/([a-z0-9]{8})$/.exec(p);
  if (bm && req.method === 'GET') return relay(await forward(hub(env, 'h:' + bm[1]), '/h/briefpublic' + url.search, req, undefined), cors);
  const m = /^\/api\/h\/([a-z0-9]{8})\/([a-z]{2,10})$/.exec(p);
  if (m) {
    const get = req.method === 'GET' && m[2] === 'state';
    const post = req.method === 'POST' && ['bp', 'dose', 'sos', 'cancel', 'answer', 'decline', 'handled', 'invite', 'reinvite', 'remove', 'profile', 'delete', 'symptom', 'draft', 'rulesave', 'ruledel', 'share', 'apikey', 'apikeydel', 'signal', 'pushkey', 'pushsub', 'pushoff', 'testpush', 'undose', 'ice', 'rtc'].includes(m[2]);
    if (!get && !post) return json({ error: 'Not found' }, 404, cors);
    const text = post ? await req.text() : undefined;
    if (text && text.length > (m[2] === 'rtc' ? 14000 : 4000)) return json({ error: 'too_large' }, 413, cors);
    return relay(await forward(hub(env, 'h:' + m[1]), '/h/' + m[2], req, text), cors);
  }
  return json({ error: 'Not found' }, 404, cors);
}

async function handleV1(req, env, url, cors) {
  if (!env.ALERTS) return json({ error: 'store_not_configured' }, 503, cors);
  const p = url.pathname.replace(/\/+$/, ''); const M = req.method;
  let action = null, qs = '', needBody = M === 'POST';
  const hid = /^\/api\/v1\/handoffs\/(ho_[a-z0-9]{10})(?:\/(receive|acknowledge))?$/.exec(p);
  const vr = /^\/api\/v1\/receipts\/(ho_[a-z0-9]{10})\/verify$/.exec(p);
  if (p === '/api/v1/oauth/token' && M === 'POST') action = 'v1token';
  else if (p === '/api/v1/records' && (M === 'POST' || M === 'GET')) { action = 'v1records'; qs = url.search; }
  else if (p === '/api/v1/records/validate' && M === 'POST') action = 'v1validate';
  else if (p === '/api/v1/connectors' && M === 'GET') action = 'v1connectors';
  else if (p === '/api/v1/events' && M === 'POST') action = 'v1events';
  else if (p === '/api/v1/handoffs' && M === 'POST') action = 'v1handoffcreate';
  else if (hid && M === 'GET' && !hid[2]) { action = 'v1handoffget'; qs = '?id=' + hid[1]; }
  else if (hid && M === 'POST' && hid[2] === 'receive') { action = 'v1handoffreceive'; qs = '?id=' + hid[1]; }
  else if (hid && M === 'POST' && hid[2] === 'acknowledge') { action = 'v1handoffack'; qs = '?id=' + hid[1]; }
  else if (vr && M === 'GET') { action = 'v1verify'; qs = '?id=' + vr[1]; }
  else if (p === '/api/v1/audit' && M === 'GET') action = 'v1audit';
  if (!action) return json({ ok: false, error: 'not_found' }, 404, cors);
  const text = needBody ? await req.text() : undefined;
  if (text && text.length > 260000) return json({ ok: false, error: 'payload_too_large', limitBytes: 260000 }, 413, cors);
  let pid = null, send = text;
  if (action === 'v1token') {
    let body = {}; try { const ct = req.headers.get('Content-Type') || ''; body = /json/.test(ct) || /^\s*\{/.test(text || '') ? JSON.parse(text || '{}') : Object.fromEntries(new URLSearchParams(text || '')); } catch { return json({ error: 'invalid_request' }, 400, cors); }
    const cm = /^(?:ox_)?([a-z0-9]{8})$/.exec(String(body.client_id || ''));
    if (!cm) return json({ error: 'invalid_client', error_description: 'client_id is your 8-character Orbit id' }, 401, cors);
    pid = cm[1]; send = JSON.stringify(body);
  } else {
    const km = /^ox_([a-z0-9]{8})_[a-z0-9]{24}$/.exec(req.headers.get('X-Orbit-Key') || '') || /^Bearer oxt_([a-z0-9]{8})_[a-z0-9]{32}$/.exec(req.headers.get('Authorization') || '');
    if (!km) return json({ ok: false, error: 'unauthorized', message: 'Send X-Orbit-Key, or Authorization: Bearer <access_token> from /api/v1/oauth/token.' }, 401, cors);
    pid = km[1];
  }
  const res = await forward(hub(env, 'h:' + pid), '/h/' + action + qs, req, send);
  const out = relay(res, cors); const ra = res.headers.get('Retry-After'); if (ra) out.headers.set('Retry-After', ra);
  return out;
}

async function handleAiStatus(req, env, url, cors) {
  const out = { ok: true, mode: aiMode(env), provider: aiMode(env) === 'mock' ? 'mock' : providerName(env), configuredModel: env.MODEL_TEXT || null, keyPresent: Boolean(env.MODEL_API_KEY) };
  if (url.searchParams.get('probe') === '1' && env.MODEL_API_KEY) {
    try { const ids = await listModels(env); out.models = ids.slice(0, 40); out.museModels = ids.filter((x) => /muse/i.test(x)); } catch (e) { out.probeError = String(e && e.message || '').slice(0, 120); }
  }
  return json(out, 200, cors);
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
      return json({ ok: true, app: 'orbit-x', time: new Date().toISOString(), metaKeyConfigured: Boolean(env.MODEL_API_KEY), aiMode: aiMode(env) }, 200, cors);
    }
    if (url.pathname === '/api/ai/status' && req.method === 'GET') return handleAiStatus(req, env, url, cors);
    if (url.pathname === '/api/assistant' && req.method === 'POST') return handleAssistant(req, env, cors);
    if (url.pathname === '/api/explain' && req.method === 'POST') return handleExplain(req, env, cors);
    if (url.pathname.startsWith('/api/alert/')) return env.ALERTS ? handleDemoAlert(req, env, url, cors) : json({ error: 'Alert store not configured' }, 503, cors);
    if (url.pathname === '/api/create' || url.pathname === '/api/join' || url.pathname.startsWith('/api/h/') || url.pathname.startsWith('/api/v1/') || url.pathname.startsWith('/api/receipt/') || url.pathname.startsWith('/api/w/') || url.pathname.startsWith('/api/brief/') || url.pathname.startsWith('/api/push/')) return handleHousehold(req, env, url, cors);
    if (url.pathname === '/api/whatsapp/webhook') return handleWhatsApp(req, env, url);

    return json({ error: 'Not found' }, 404, cors);
  },
};

// Orbit-X alert chain. Pure functions: no I/O, fully unit-tested.
// The chain, the timers and the rules are fixed code. No AI is involved.

export const CHAIN = ['preye', 'mamaebi'];
export const NAMES = { preye: 'Preye', mamaebi: 'Mama Ebi' };
export const DEFAULT_ESCALATE_MS = 20000;

function logLine(a, now, text) { a.log.push({ t: now, text }); }

export function validRole(r) { return CHAIN.includes(r); }

// Starts an alert. If one is already active, returns it unchanged (idempotent).
export function startAlert(existing, input, now) {
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
export function advance(a, now, escalateMs) {
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

export function answer(a, role, now) {
  if (!a || a.status !== 'ringing' || CHAIN[a.idx] !== role) return { ok: false, error: 'not_your_call' };
  a.status = 'answered'; a.answeredBy = role;
  logLine(a, now, NAMES[role] + ' answered');
  return { ok: true };
}

export function decline(a, role, now) {
  if (!a || a.status !== 'ringing' || CHAIN[a.idx] !== role) return { ok: false, error: 'not_your_call' };
  escalate(a, now, NAMES[role] + ' declined');
  return { ok: true };
}

export function handled(a, role, now) {
  if (!a || a.status !== 'answered' || a.answeredBy !== role) return { ok: false, error: 'not_your_alert' };
  a.status = 'handled'; a.handledBy = role;
  logLine(a, now, NAMES[role] + ' marked handled');
  return { ok: true };
}

// What a phone is allowed to see. now lets clients show a countdown without clock skew.
export function view(a, role, now, escalateMs) {
  if (!a) return { alert: null, now };
  const target = a.status === 'ringing' ? CHAIN[a.idx] : null;
  const secondsLeft = a.status === 'ringing' ? Math.max(0, Math.ceil((escalateMs - (now - a.ringStart)) / 1000)) : 0;
  return { now, alert: {
    id: a.id, status: a.status, target, secondsLeft, sys: a.sys, dia: a.dia, why: a.why,
    answeredBy: a.answeredBy, handledBy: a.handledBy, exhausted: a.exhausted, log: a.log, startedAt: a.startedAt,
    mine: role ? (target === role || a.answeredBy === role) : false,
  } };
}

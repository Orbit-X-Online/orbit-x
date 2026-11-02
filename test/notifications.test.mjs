// Notification lifecycle, caregiver boundaries, input validation, missing credentials and FHIR checks.
// Runs the real worker against a fake Durable Object store and a fake push service. No network, no cost.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker, { AlertHub } from '../src/worker.js';
import { validateBundle, validateResource } from '../src/fhir.js';

class Store { constructor(){ this.m = new Map(); this.alarm = null; }
  async get(k){ return this.m.has(k) ? structuredClone(this.m.get(k)) : undefined; }
  async put(k, v){ this.m.set(k, structuredClone(v)); }
  async delete(k){ return this.m.delete(k); }
  async deleteAll(){ this.m.clear(); }
  async setAlarm(t){ this.alarm = t; }
  async getAlarm(){ return this.alarm; }
  async deleteAlarm(){ this.alarm = null; } }
const hubs = new Map();
const env = { ESCALATE_MS: '20000', ALLOWED_ORIGINS: '', ASSETS: { fetch: async () => new Response('<html>') },
  ALERTS: { idFromName: (n) => n, get: (n) => { if (!hubs.has(n)) hubs.set(n, new AlertHub({ storage: new Store() }, env)); const hub = hubs.get(n); return { fetch: (r) => hub.fetch(r) }; } } };
const realNow = Date.now; let clock = Date.UTC(2026, 9, 28, 7, 0, 0);
Date.now = () => clock;
const pushes = []; let pushHandler = async () => new Response('', { status: 201 });
globalThis.fetch = async (url, init) => { pushes.push({ url: String(url), init }); return pushHandler(String(url), init); };
const call = async (method, path, body, token, env2) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token && token.startsWith('ox_')) headers['X-Orbit-Key'] = token; else if (token) headers.Authorization = 'Bearer ' + token;
  const r = await worker.fetch(new Request('https://t.test' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env2 || env);
  const j = await r.json().catch(() => ({})); j._s = r.status; return j;
};
const store = (pid) => hubs.get('h:' + pid).state.storage;
const alarmNow = (pid) => hubs.get('h:' + pid).alarm();
const sub = (id) => ({ sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/' + id + 'y'.repeat(40), keys: { p256dh: 'a', auth: 'b' } } });
let n = 0; const ok = (name) => console.log('  ok ' + (++n) + ' ' + name);
const at = (d, h, m = 0) => Date.UTC(2026, 9, d, h, m, 0);

// ---------- A. scheduling starts at account creation
let p = await call('POST', '/api/create', { name: 'Alex', slots: ['morning'], today: '2026-10-28', tz: 0, accountType: 'individual' });
assert.equal(p.remindersScheduled, true); assert.equal(store(p.pid).alarm, at(28, 8)); ok('new account with a tablet time schedules its first reminder immediately');
let none = await call('POST', '/api/create', { name: 'Clinic', slots: [], today: '2026-10-28', accountType: 'provider', org: 'C' });
assert.equal(none.remindersScheduled, false); assert.equal(store(none.pid).alarm, null); ok('account without tablet times sets no alarm');

// ---------- B. editing the schedule reschedules; removing it clears the alarm
const P = '/api/h/' + p.pid + '/';
let r = await call('POST', P + 'profile', { slots: ['evening'] }, p.token); assert.equal(store(p.pid).alarm, at(28, 18)); ok('changing tablet times reschedules the alarm');
r = await call('POST', P + 'profile', { slots: ['morning'] }, p.token); assert.equal(store(p.pid).alarm, at(28, 8));
r = await call('POST', P + 'profile', { slots: [] }, p.token); assert.equal(store(p.pid).alarm, null); ok('removing all tablet times clears the alarm');
r = await call('POST', P + 'profile', { slots: ['morning'] }, p.token);

// ---------- C. daylight saving: 08:00 New York time is 12:00Z before 1 Nov 2026 and 13:00Z after
clock = Date.UTC(2026, 9, 31, 12, 30, 0);
let ny = await call('POST', '/api/create', { name: 'Nia', slots: ['morning'], today: '2026-10-31', tz: -240, tzName: 'America/New_York', accountType: 'individual' });
assert.equal(store(ny.pid).alarm, Date.UTC(2026, 9, 31, 15, 0)); // 11:00 EDT heads-up time on the same day
clock = Date.UTC(2026, 10, 1, 0, 0, 0); await alarmNow(ny.pid);
assert.equal(store(ny.pid).alarm, Date.UTC(2026, 10, 1, 2, 0)); // 22:00 EDT last-chance check
clock = Date.UTC(2026, 10, 1, 2, 5, 0); await alarmNow(ny.pid);
assert.equal(store(ny.pid).alarm, Date.UTC(2026, 10, 1, 13, 0)); ok('daylight-saving change: next reminder lands on 08:00 local (EST), not an hour off');
let bad = await call('POST', '/api/create', { name: 'Zed', slots: ['morning'], today: '2026-11-01', tz: 0, tzName: 'Not/AZone', accountType: 'individual' });
assert.equal(bad.ok, true); assert.equal(store(bad.pid).alarm, Date.UTC(2026, 10, 1, 8, 0)); ok('invalid time-zone name is ignored safely (falls back to the fixed offset)');

// ---------- D. household with caregivers + phones
clock = at(28, 7);
p = await call('POST', '/api/create', { name: 'Alex', slots: ['morning'], today: '2026-10-28', tz: 0, accountType: 'individual' });
const Q = '/api/h/' + p.pid + '/';
r = await call('POST', Q + 'invite', { name: 'Mum', phone: '+2348012345678' }, p.token); const code1 = r.code;
r = await call('GET', Q + 'state', null, p.token);
assert.equal(r.caregivers[0].status, 'invited'); assert.equal(r.caregivers[0].joined, false); ok('invite shows status "invited" until the person joins');
const j1 = await call('POST', '/api/join', { code: code1 }); assert.ok(j1.ok);
r = await call('GET', Q + 'state', null, p.token); assert.equal(r.caregivers[0].status, 'joined'); ok('invite shows status "joined" after joining');
r = await call('POST', Q + 'invite', { name: 'Joe', phone: '+2348099999999' }, p.token); const code2 = r.code;
clock += 8 * 86400000; r = await call('POST', '/api/join', { code: code2 }); assert.equal(r._s, 410); assert.equal(r.error, 'invite_expired');
r = await call('GET', Q + 'state', null, p.token); assert.equal(r.caregivers.find((c) => c.name === 'Joe').status, 'expired'); ok('invites expire after 7 days and say so');
clock = at(28, 7);

// ---------- E. push results are reported honestly
r = await call('POST', Q + 'pushkey', {}, j1.token); assert.ok(r.key);
pushes.length = 0; pushHandler = async () => new Response('', { status: 201 });
r = await call('POST', Q + 'pushsub', { ...sub('mum'), confirm: true }, j1.token); assert.ok(r.ok); const mumEh = r.eh; assert.equal(r.diag[0].state, 'accepted');
r = await call('POST', Q + 'pushsub', sub('alex'), p.token); const alexEh = r.eh;
r = await call('POST', Q + 'testpush', {}, p.token); assert.equal(r.diag[0].state, 'accepted'); assert.equal(r.diag[0].http, 201);
assert.ok(!JSON.stringify(r).includes('fcm.googleapis.com')); assert.ok(/not prove/.test(r.diag[0].message)); ok('2xx = "accepted by push service" and the message says it is not proof of display');
pushHandler = async () => new Response('no', { status: 403 });
r = await call('POST', Q + 'testpush', {}, p.token); assert.equal(r.diag[0].state, 'rejected'); r = await call('GET', Q + 'state', null, p.token); assert.equal(r.profile.alertsOn, true); ok('403 = rejected, subscription kept for diagnosis');
pushHandler = async () => new Response('', { status: 429 }); r = await call('POST', Q + 'testpush', {}, p.token); assert.equal(r.diag[0].state, 'throttled'); ok('429 = throttled');
pushes.length = 0; pushHandler = async () => new Response('', { status: 503 });
r = await call('POST', Q + 'testpush', {}, p.token); assert.equal(r.diag[0].state, 'service_error'); assert.equal(pushes.length, 2); ok('5xx is retried once, then reported as a push-service error');
pushes.length = 0; pushHandler = async () => { throw new Error('offline'); };
r = await call('POST', Q + 'testpush', {}, p.token); assert.equal(r.diag[0].state, 'network_error'); assert.equal(pushes.length, 2); ok('network failure reported, never shown as success');
pushHandler = async () => new Response('', { status: 410 });
r = await call('POST', Q + 'testpush', {}, p.token); assert.equal(r.diag[0].state, 'gone'); r = await call('GET', Q + 'state', null, p.token); assert.equal(r.profile.alertsOn, false); ok('410 removes the expired subscription');
r = await call('POST', Q + 'testpush', {}, p.token); assert.equal(r._s, 409); assert.equal(r.error, 'alerts_not_on'); ok('test with no subscription gives an actionable error');
pushHandler = async () => new Response('', { status: 201 });
r = await call('POST', Q + 'pushsub', sub('alex'), p.token);

// ---------- F. payload is saved BEFORE the push is sent
{
  let seen = null;
  pushHandler = async (url) => { const h = store(p.pid).m.get('h'); if (url.includes('mum')) seen = h.pushQ && h.pushQ[mumEh]; return new Response('', { status: 201 }); };
  r = await call('POST', Q + 'bp', { sys: 190, dia: 125, date: '2026-10-28' }, p.token);
  assert.ok(seen && /ALERT/.test(seen.title)); ok('message text is already stored when the push request leaves (phone can fetch it)');
  pushHandler = async () => new Response('', { status: 201 });
  const msg = await call('GET', '/api/push/msg/' + p.pid + '?e=' + mumEh); assert.ok(/ALERT/.test(msg.title)); ok('service worker can retrieve the stored message');
  await call('POST', Q + 'cancel', {}, p.token);
}

// ---------- G. phone-reported display (the only real "shown" evidence)
r = await call('POST', '/api/push/ack/' + p.pid + '?e=' + alexEh); assert.ok(r.ok);
r = await call('GET', Q + 'state', null, p.token); assert.ok(r.profile.push.lastDisplayedAt); ok('phone confirmation is recorded separately from push acceptance');
r = await call('POST', '/api/push/ack/' + p.pid + '?e=' + 'a'.repeat(64)); assert.equal(r._s, 404);
r = await call('POST', '/api/push/ack/' + p.pid + '?e=zzz'); assert.equal(r._s, 404); ok('ack for unknown/invalid subscription is refused');

// ---------- H. subscription safety
for (const ep of ['https://evil.example/x'.padEnd(40, 'a'), 'http://fcm.googleapis.com/fcm/send/' + 'a'.repeat(30), 'https://fcm.googleapis.com.evil.test/' + 'a'.repeat(30), 'https://user:pw@fcm.googleapis.com/' + 'a'.repeat(30)]) {
  r = await call('POST', Q + 'pushsub', { sub: { endpoint: ep } }, p.token); assert.equal(r._s, 400, ep);
}
ok('only real push-service hosts over https are accepted (no server-side request to arbitrary URLs)');
let prov = await call('POST', '/api/create', { name: 'Clinic', slots: [], today: '2026-10-28', accountType: 'provider', org: 'C' });
const key = (await call('POST', '/api/h/' + prov.pid + '/apikey', { label: 'k' }, prov.token)).key;
r = await call('POST', '/api/h/' + prov.pid + '/pushsub', sub('apikey'), key); assert.equal(r._s, 403); ok('API keys cannot register phone subscriptions');

// ---------- I. due / overdue / duplicate / late alarms
pushes.length = 0; clock = at(28, 8, 5); await alarmNow(p.pid); await alarmNow(p.pid); await alarmNow(p.pid);
assert.equal(pushes.filter((x) => x.url.includes('alex')).length, 1); ok('repeated alarm execution sends the 08:00 reminder once');
pushes.length = 0; clock = at(28, 13, 0); await alarmNow(p.pid);
assert.equal(pushes.filter((x) => x.url.includes('mum')).length, 1); ok('late alarm (13:00) still sends the missed-tablet heads-up (within its window)');
r = await call('GET', Q + 'state', null, p.token); assert.ok(r.events.some((e) => e.kind === 'missed_dose' && e.state === 'accepted')); assert.ok(r.events.every((e) => !('text' in e) && !('body' in e))); ok('audit events record kind and state only, no health text');
r = await call('POST', Q + 'dose', { slot: 'morning', date: '2026-10-29' }, p.token);
pushes.length = 0; clock = Date.UTC(2026, 9, 29, 9, 0, 0) - 0; await alarmNow(p.pid); assert.equal(pushes.length, 0); ok('a dose that is already logged triggers nothing');
// very late alarm: window passed -> logged as such, nobody is pinged with a stale reminder
{
  clock = at(28, 7);
  const q = await call('POST', '/api/create', { name: 'Late', slots: ['morning'], today: '2026-10-28', tz: 0, accountType: 'individual' });
  await call('POST', '/api/h/' + q.pid + '/pushsub', sub('late'), q.token);
  pushes.length = 0; clock = at(28, 20, 0); await alarmNow(q.pid);
  assert.equal(pushes.length, 0); const s = await call('GET', '/api/h/' + q.pid + '/state', null, q.token);
  assert.ok(s.events.some((e) => e.kind === 'reminder' && e.state === 'window_passed')); ok('a reminder that is hours overdue is not sent stale, and the skip is recorded');
}
// a lost platform alarm is re-created
clock = at(28, 7); { const q = await call('POST', '/api/create', { name: 'Heal', slots: ['morning'], today: '2026-10-28', tz: 0, accountType: 'individual' });
  store(q.pid).alarm = null; await call('GET', '/api/h/' + q.pid + '/state', null, q.token); assert.equal(store(q.pid).alarm, at(28, 8)); ok('a lost Durable Object alarm is detected and recreated'); }

// ---------- J. caregiver boundaries
clock = at(28, 7);
const other = await call('POST', '/api/create', { name: 'Other', slots: [], today: '2026-10-28', accountType: 'individual' });
r = await call('GET', Q + 'state', null, other.token); assert.equal(r._s, 401);
r = await call('GET', Q + 'state'); assert.equal(r._s, 401);
r = await call('GET', Q + 'state', null, j1.token); assert.equal(r.role, 'caregiver'); assert.equal(r.caregivers, undefined); assert.equal(r.apiKeys, undefined); assert.equal(r.events, undefined);
r = await call('POST', Q + 'bp', { sys: 120, dia: 80, date: '2026-10-28' }, j1.token); assert.equal(r._s, 403);
r = await call('POST', Q + 'invite', { name: 'X' }, j1.token); assert.equal(r._s, 403);
r = await call('POST', '/api/h/' + other.pid + '/state'.replace('/state', '/pushsub'), sub('x'), j1.token); assert.equal(r._s, 401);
r = await call('GET', '/api/h/' + other.pid + '/state', null, key); assert.equal(r._s, 401);
ok('unrelated users, caregivers and other households cannot read or change this household');
// the person can never remove or lock out a caregiver
r = await call('POST', Q + 'remove', { id: 'c1' }, p.token); assert.equal(r._s, 403); assert.equal(r.error, 'caregiver_protected');
r = await call('POST', Q + 'reinvite', { id: 'c1' }, p.token); assert.equal(r._s, 403); assert.equal(r.error, 'caregiver_protected');
r = await call('GET', Q + 'state', null, p.token); assert.ok(r.caregivers.some((c) => c.id === 'c1' && c.joined));
r = await call('GET', Q + 'state', null, j1.token); assert.equal(r._s, 200); // the caregiver's own access still works
ok('the person cannot remove or re-invite (lock out) a caregiver who has joined');
r = await call('POST', Q + 'reinvite', { id: 'c2' }, p.token); assert.ok(r.ok && r.code); ok('an invite nobody has used yet can still get a fresh code');
r = await call('POST', Q + 'invite', { name: 'NoPhone' }, p.token); assert.equal(r._s, 400); assert.equal(r.error, 'phone_required');
r = await call('POST', Q + 'invite', { name: 'NoPhone', phone: 'abc' }, p.token); assert.equal(r._s, 400); ok('a caregiver needs a phone number so the SMS fallback can reach them');
pushes.length = 0; await call('POST', Q + 'sos', { why: 'test' }, p.token);
assert.ok(pushes.length >= 0); await call('POST', Q + 'cancel', {}, p.token);

// ---------- L. tablet amounts (how many tablets, not only the time)
clock = at(28, 9);
const dq = await call('POST', '/api/create', { name: 'Dose', slots: ['morning', 'evening'], doseQty: { morning: 2, evening: 99, night: 1 }, today: '2026-10-28', tz: 0, accountType: 'individual' });
const DQ = '/api/h/' + dq.pid + '/';
r = await call('GET', DQ + 'state', null, dq.token); assert.deepEqual(r.profile.doseQty, { morning: 2, night: 1 }); ok('usual tablets per time is stored; out-of-range amounts (99) are dropped');
r = await call('POST', DQ + 'dose', { slot: 'morning', date: '2026-10-28' }, dq.token); assert.equal(r.doses[0].qty, 2); ok('logging with no amount uses the usual amount');
r = await call('POST', DQ + 'dose', { slot: 'morning', date: '2026-10-28', qty: 3 }, dq.token); assert.equal(r.doses.length, 1); assert.equal(r.doses[0].qty, 3); ok('logging the same time again corrects the amount, never duplicates');
r = await call('POST', DQ + 'dose', { slot: 'evening', date: '2026-10-28', qty: 1 }, dq.token); assert.equal(r.doses.find((d) => d.slot === 'evening').qty, 1);
r = await call('POST', DQ + 'dose', { slot: 'evening', date: '2026-10-28', qty: '4' }, dq.token); assert.equal(r.doses.find((d) => d.slot === 'evening').qty, 4);
for (const q of [0, 11, 1.5, -2, 'x', {}, [2]]) { r = await call('POST', DQ + 'dose', { slot: 'night', date: '2026-10-28', qty: q }, dq.token); assert.equal(r._s, 400, 'qty ' + JSON.stringify(q)); }
ok('invalid tablet amounts (0, 11, 1.5, negative, text, objects) are refused');
r = await call('POST', DQ + 'profile', { doseQty: { morning: 5, afternoon: 0 } }, dq.token); assert.deepEqual(r.profile.doseQty, { morning: 5 });
r = await call('POST', DQ + 'dose', { slot: 'morning', date: '2026-10-27' }, dq.token); assert.equal(r.doses.find((d) => d.date === '2026-10-27').qty, 5); ok('changing the usual amount applies to new doses');

// ---------- M. SMS and phone fallback
clock = at(28, 10);
const sm = await call('POST', '/api/create', { name: 'Sms', slots: [], today: '2026-10-28', tz: 0, accountType: 'individual' });
const SM = '/api/h/' + sm.pid + '/';
r = await call('POST', SM + 'invite', { name: 'Auntie', phone: '08012345678' }, sm.token); const jc = await call('POST', '/api/join', { code: r.code }); assert.ok(jc.ok);
pushes.length = 0; await call('POST', SM + 'sos', { why: 'x' }, sm.token);
r = await call('GET', SM + 'state', null, sm.token); assert.ok(r.events.some((e) => e.kind === 'sms' && e.state === 'not_configured')); ok('with no SMS provider set up, the alert log says so plainly');
await call('POST', SM + 'cancel', {}, sm.token);
env.AT_USERNAME = 'OrbitX'; env.AT_API_KEY = 'atk';
pushes.length = 0; await call('POST', SM + 'sos', { why: 'x' }, sm.token);
const smsCall = pushes.find((x) => x.url.includes('api.africastalking.com'));
assert.ok(smsCall, 'an SMS request was made to Africa\'s Talking'); assert.ok(String(smsCall.init.body).includes('%2B2348012345678'), 'local 0801... number became +234801...'); assert.equal(smsCall.init.headers.apiKey, 'atk');
r = await call('GET', SM + 'state', null, sm.token); assert.ok(r.events.some((e) => e.kind === 'sms' && e.state === 'sent')); ok('an SMS goes to the caregiver being alerted, with +234 numbers fixed automatically, even with no push');
await call('POST', SM + 'cancel', {}, sm.token);
pushHandler = async (u) => u.includes('africastalking') ? new Response('no', { status: 400 }) : new Response('', { status: 201 });
await call('POST', SM + 'sos', { why: 'y' }, sm.token); r = await call('GET', SM + 'state', null, sm.token);
assert.ok(r.events.some((e) => e.kind === 'sms' && e.state === 'rejected')); ok('a refused SMS is recorded as refused, not as sent');
pushHandler = async () => new Response('', { status: 201 }); delete env.AT_USERNAME; delete env.AT_API_KEY;

// ---------- J2. high BP and missed tablets text the caregiver automatically
env.AT_USERNAME = 'OrbitX'; env.AT_API_KEY = 'atk';
clock = at(30, 6); 
const hb = await call('POST', '/api/create', { name: 'Tolu', slots: ['morning'], today: '2026-10-30', tz: 0, accountType: 'individual' });
const HB = '/api/h/' + hb.pid + '/';
r = await call('POST', HB + 'invite', { name: 'Sis', phone: '08055550000' }, hb.token); assert.ok((await call('POST', '/api/join', { code: r.code })).ok);
const smsTexts = () => pushes.filter((x) => x.url.includes('africastalking')).map((x) => decodeURIComponent(String(x.init.body).replace(/\+/g, ' ')));
pushes.length = 0; await call('POST', HB + 'bp', { sys: 124, dia: 80, date: '2026-10-30' }, hb.token); assert.equal(smsTexts().length, 0); ok('a normal reading sends no text');
await call('POST', HB + 'bp', { sys: 148, dia: 94, date: '2026-10-30' }, hb.token);
assert.equal(smsTexts().length, 1); assert.match(smsTexts()[0], /148\/94.*high \(grade 1\)/i); ok('a 140/90+ reading texts the caregiver automatically with the number');
await call('POST', HB + 'bp', { sys: 152, dia: 96, date: '2026-10-30' }, hb.token); assert.equal(smsTexts().length, 1); ok('repeat high readings within 3 hours do not spam the caregiver');
await call('POST', HB + 'bp', { sys: 85, dia: 55, date: '2026-10-30' }, hb.token);
assert.equal(smsTexts().length, 2); assert.match(smsTexts()[1], /85\/55, low/); ok('a LOW reading (below 90/60) texts the caregiver too, even right after a high one');
clock = at(30, 6) + 4 * 3600000; await call('POST', HB + 'bp', { sys: 150, dia: 95, date: '2026-10-30' }, hb.token); assert.equal(smsTexts().length, 3); ok('a later high reading texts again');
pushes.length = 0; clock = at(30, 11, 5); await alarmNow(hb.pid);
assert.ok(smsTexts().some((t) => /not logged the morning tablet/.test(t))); ok('a missed tablet texts the caregiver at the heads-up time');
pushes.length = 0; clock = at(30, 22, 5); await alarmNow(hb.pid);
assert.ok(smsTexts().some((t) => /nearly over.*morning tablet/.test(t))); ok('a last-chance text goes out at 22:00 if the tablet is still not logged');
pushes.length = 0; await alarmNow(hb.pid); assert.equal(smsTexts().length, 0); ok('the last-chance text is sent only once per day');
clock = at(31, 6); await call('POST', HB + 'dose', { slot: 'morning', date: '2026-10-31', qty: 1 }, hb.token); pushes.length = 0; clock = at(31, 22, 5); await alarmNow(hb.pid);
assert.equal(smsTexts().length, 0); ok('no missed-tablet texts when the tablet was logged');
delete env.AT_USERNAME; delete env.AT_API_KEY;

// ---------- J3. caregivers can remove caregivers; the patient still cannot
env.AT_USERNAME = undefined; delete env.AT_USERNAME;
clock = at(31, 9);
const rm = await call('POST', '/api/create', { name: 'Ada', slots: [], today: '2026-10-31', tz: 0, accountType: 'individual' });
const RM = '/api/h/' + rm.pid + '/'; const toks = [];
for (const nm of ['Ann', 'Bob', 'Cy']) { r = await call('POST', RM + 'invite', { name: nm, phone: '08011112222' }, rm.token); const jj = await call('POST', '/api/join', { code: r.code }); assert.ok(jj.ok); toks.push(jj.token); }
r = await call('GET', RM + 'state', null, toks[0]); assert.equal(r.team.length, 3); assert.ok(r.team[0].you); ok('a caregiver sees the care team');
r = await call('POST', RM + 'remove', { id: 'c2' }, rm.token); assert.equal(r._s, 403); ok('the patient still cannot remove anyone');
r = await call('POST', RM + 'remove', { id: 'c1' }, toks[0]); assert.equal(r._s, 400); assert.equal(r.error, 'cannot_remove_self'); ok('a caregiver cannot remove themselves this way');
r = await call('POST', RM + 'remove', { id: 'c2' }, toks[0]); assert.equal(r._s, 200); assert.deepEqual(r.team.map((x) => x.name + x.order), ['Ann1', 'Cy2']); ok('a caregiver can remove another caregiver; order closes up');
r = await call('GET', RM + 'state', null, toks[1]); assert.equal(r._s, 401); ok('the removed caregiver is signed out');
await call('POST', RM + 'sos', { why: 'x' }, rm.token);
r = await call('POST', RM + 'remove', { id: 'c3' }, toks[0]); assert.equal(r._s, 409); assert.equal(r.error, 'alert_active'); ok('nobody can be removed during an active alert');

// ---------- J4. clinician rules really reach the family (alert + text), on save and on every new entry
env.AT_USERNAME = 'OrbitX'; env.AT_API_KEY = 'atk';
clock = at(31, 9);
const rl = await call('POST', '/api/create', { name: 'Funmi', slots: [], today: '2026-10-31', tz: 0, accountType: 'individual' });
const RL = '/api/h/' + rl.pid + '/';
r = await call('POST', RL + 'invite', { name: 'Kemi', phone: '08033334444' }, rl.token); assert.ok((await call('POST', '/api/join', { code: r.code })).ok);
r = await call('POST', RL + 'invite', { name: 'Isaac', role: 'clinician' }, rl.token); const drj = await call('POST', '/api/join', { code: r.code }); assert.ok(drj.ok);
const rtexts = () => pushes.filter((x) => x.url.includes('africastalking')).map((x) => decodeURIComponent(String(x.init.body).replace(/\+/g, ' ')));
const mkRule = async (text, sev) => { const d = await call('POST', RL + 'draft', { text }, drj.token); assert.ok(d.ok, text); return call('POST', RL + 'rulesave', { rule: { ...d.draft.rule, severity: sev } }, drj.token); };
pushes.length = 0;
r = await mkRule('Monitor for headaches and blurred vision', 'notice'); assert.ok(r.ok); assert.deepEqual(r.matchedNow, []); ok('a saved rule that does not match yet says so');
await call('POST', RL + 'symptom', { text: 'I have a headache and blurry vision' }, rl.token);
assert.ok(rtexts().some((t) => /care rule "[^"]*"/i.test(t) && /Funmi/.test(t))); ok('a symptom rule texts the caregiver when the patient reports those symptoms');
r = await call('GET', RL + 'state', null, drj.token); assert.ok(r.notices.some((x) => x.kind === 'rule' && x.ruleName)); ok('the clinician sees the rule alert, labelled as a rule');
pushes.length = 0; await call('POST', RL + 'symptom', { text: 'headache again, vision blurred' }, rl.token); assert.equal(rtexts().length, 0); ok('the same rule does not text again within 12 hours');
await call('POST', RL + 'bp', { sys: 168, dia: 104, date: '2026-10-31' }, rl.token); await call('POST', RL + 'bp', { sys: 170, dia: 102, date: '2026-10-31' }, rl.token);
pushes.length = 0;
r = await mkRule('Alert me if systolic is above 160 twice in 3 days', 'notice'); assert.ok(r.ok); assert.equal(r.matchedNow.length, 1);
assert.ok(rtexts().some((t) => /care rule/i.test(t) && /16[0-9]|170/.test(t))); ok('a new blood-pressure rule is checked against recent readings the moment it is saved, and alerts at once');
r = await mkRule('Ring the family if diastolic is above 100', 'emergency'); assert.ok(r.ok); assert.match(String(r.matchedNow[0]), /would ring/); r = await call('GET', RL + 'state', null, rl.token); assert.ok(!r.alert || r.alert.status === undefined || r.alert.status === 'cancelled' || !r.alert.active); ok('saving a ringing rule never rings the family by itself');
const rid = (await call('GET', RL + 'state', null, drj.token)).rules[0].id;
pushes.length = 0; r = await call('POST', RL + 'ruletest', { id: rid }, rl.token); assert.equal(r._s, 403); ok('the patient cannot send a rule test');
r = await call('POST', RL + 'ruletest', { id: rid }, drj.token); assert.ok(r.ok && r.tested); assert.equal(rtexts().length, 0);
r = await call('GET', RL + 'state', null, drj.token); assert.ok(r.notices.some((x) => x.kind === 'rule_test')); ok('a clinician can send a test alert; it texts nobody');
r = await call('POST', RL + 'docphone', { phone: 'abc' }, drj.token); assert.equal(r._s, 400); r = await call('POST', RL + 'docphone', { phone: '08055556666' }, rl.token); assert.equal(r._s, 403);
r = await call('POST', RL + 'docphone', { phone: '08055556666' }, drj.token); assert.ok(r.ok); assert.ok(/8055556666/.test(r.me.phone)); ok('only the doctor can set their own number, and bad numbers are refused');
clock = at(31, 22); pushes.length = 0; await call('POST', RL + 'bp', { sys: 150, dia: 104, date: '2026-10-31' }, rl.token);
const docTexts = () => pushes.filter((x) => x.url.includes('africastalking') && /8055556666/.test(decodeURIComponent(String(x.init.body)))).map((x) => decodeURIComponent(String(x.init.body).replace(/\+/g, ' ')));
assert.ok(docTexts().some((t) => /your rule/i.test(t) && /Funmi/.test(t) && /112/.test(t))); ok('an emergency rule the doctor wrote also texts the doctor');
clock = at(31, 23); pushes.length = 0; await call('POST', RL + 'bp', { sys: 151, dia: 105, date: '2026-10-31' }, rl.token); assert.equal(docTexts().filter((t) => /your rule/i.test(t)).length, 0); ok('the doctor is not texted again for the same rule within 12 hours');
delete env.AT_USERNAME; delete env.AT_API_KEY;

// ---------- J5. the app knows when the tablets will run out
env.AT_USERNAME = 'OrbitX'; env.AT_API_KEY = 'atk';
clock = at(31, 8);
const sp = await call('POST', '/api/create', { name: 'Bola', slots: ['morning', 'evening'], doseQty: { morning: 1, evening: 1 }, today: '2026-10-31', tz: 0, accountType: 'individual' });
const SP = '/api/h/' + sp.pid + '/';
r = await call('POST', SP + 'invite', { name: 'Tayo', phone: '08066667777' }, sp.token); assert.ok((await call('POST', '/api/join', { code: r.code })).ok);
const stxt = () => pushes.filter((x) => x.url.includes('africastalking')).map((x) => decodeURIComponent(String(x.init.body).replace(/\+/g, ' ')));
r = await call('POST', SP + 'profile', { supplyLeft: 9 }, sp.token); assert.equal(r.profile.supply.daysLeft, 4); assert.equal(r.profile.supply.daily, 2); ok('the app works out days left from the tablets in the pack and the daily amount');
pushes.length = 0; await call('POST', SP + 'dose', { slot: 'morning', date: '2026-10-31' }, sp.token); r = await call('GET', SP + 'state', null, sp.token); assert.equal(r.profile.supply.remaining, 8); assert.equal(stxt().length, 0); ok('each logged tablet counts down the pack; no text while there is enough');
await call('POST', SP + 'dose', { slot: 'evening', date: '2026-10-31' }, sp.token); clock = at(31, 9); await call('POST', SP + 'dose', { slot: 'morning', date: '2026-11-01' }, sp.token).catch(() => {});
r = await call('POST', SP + 'profile', { supplyLeft: 5 }, sp.token); assert.equal(r.profile.supply.daysLeft, 2);
assert.ok(stxt().some((t) => /run out in about 2 days/.test(t))); ok('the family is texted when 3 days or fewer are left');
pushes.length = 0; await call('POST', SP + 'profile', { name: 'Bola' }, sp.token); assert.equal(stxt().length, 0); ok('the running-low text is sent once');
r = await call('POST', SP + 'profile', { supplyLeft: -3 }, sp.token); assert.equal(r._s, 400); r = await call('POST', SP + 'profile', { supplyLeft: null }, sp.token); assert.equal(r.profile.supply, null); ok('bad pack sizes are refused and the tracker can be cleared');
delete env.AT_USERNAME; delete env.AT_API_KEY;

// ---------- J6. pharmacist refill requests; reminders stop when the pack is finished
env.AT_USERNAME = 'OrbitX'; env.AT_API_KEY = 'atk';
clock = at(31, 6);
const ph = await call('POST', '/api/create', { name: 'Kola', phone: '08011119999', slots: ['morning'], doseQty: { morning: 1 }, today: '2026-10-31', tz: 0, accountType: 'individual' });
const PH = '/api/h/' + ph.pid + '/';
r = await call('POST', PH + 'invite', { name: 'Sade', phone: '08022220000' }, ph.token); assert.ok((await call('POST', '/api/join', { code: r.code })).ok);
r = await call('POST', PH + 'profile', { pharmacist: { name: 'Care Pharmacy', phone: 'abc' } }, ph.token); assert.equal(r._s, 400); ok('a bad pharmacist number is refused');
r = await call('POST', PH + 'profile', { pharmacist: { name: 'Care Pharmacy', phone: '08033330000' } }, ph.token); assert.equal(r.profile.pharmacist.name, 'Care Pharmacy'); ok('the person can add their pharmacist');
const ptxt = () => pushes.filter((x) => x.url.includes('africastalking')).map((x) => decodeURIComponent(String(x.init.body).replace(/\+/g, ' ')));
pushes.length = 0; await call('POST', PH + 'profile', { supplyLeft: 3 }, ph.token);
assert.ok(ptxt().some((t) => /refill request.*Kola.*3 days/.test(t) && /8033330000/.test(t))); assert.ok(ptxt().some((t) => /Please help them get a refill/.test(t))); ok('the pharmacist and the family both get a refill message when 3 days are left');
pushes.length = 0; await call('POST', PH + 'dose', { slot: 'morning', date: '2026-10-31' }, ph.token); await call('POST', PH + 'profile', { name: 'Kola' }, ph.token); assert.equal(ptxt().filter((t) => /refill request/.test(t)).length, 0); ok('the pharmacist is told only once per level');
r = await call('POST', PH + 'profile', { supplyLeft: 1 }, ph.token); pushes.length = 0; r = await call('POST', PH + 'dose', { slot: 'morning', date: '2026-11-01' }, ph.token).catch(() => ({})); clock = at(31, 6) + 21 * 3600000; r = await call('POST', PH + 'profile', { supplyLeft: 0 }, ph.token);
assert.equal(r.profile.supply.remaining, 0); assert.ok(ptxt().some((t) => /refill request.*run out/.test(t))); ok('an empty pack sends a final refill request');
pushes.length = 0; clock = at(31, 11, 5); await alarmNow(ph.pid); clock = at(31, 22, 5); await alarmNow(ph.pid);
assert.equal(ptxt().filter((t) => /not logged|nearly over/.test(t)).length, 0); ok('no tablet reminders or missed-tablet texts once the pack is finished');
pushes.length = 0; clock = at(31, 8);
await call('POST', PH + 'profile', { supplyLeft: 1, pharmacist: { name: 'Other', phone: '08044440000' } }, ph.token); await call('POST', PH + 'profile', { supplyLeft: 2 }, ph.token); await call('POST', PH + 'profile', { supplyLeft: 0 }, ph.token);
assert.equal(ptxt().filter((t) => /refill request/.test(t)).length, 0); ok('changing the count or the pharmacist number again and again cannot spam anyone: one request per 20 hours at most');
clock = at(33, 6); pushes.length = 0; await call('POST', PH + 'profile', { supplyLeft: 1 }, ph.token); assert.equal(ptxt().filter((t) => /refill request/.test(t)).length, 1); ok('a day later a new request can go out, still only one');
r = await call('POST', PH + 'profile', { supplyLeft: 30 }, ph.token); assert.equal(r.profile.supply.daysLeft, 30); ok('entering a new pack restarts the count');
delete env.AT_USERNAME; delete env.AT_API_KEY;

// ---------- J7. the Orbit summary: code finds the numbers, the model only rewords them
clock = at(31, 9);
const ins = await call('POST', '/api/create', { name: 'Ife', slots: ['morning'], doseQty: { morning: 1 }, today: '2026-10-31', tz: 0, accountType: 'individual' });
const IN = '/api/h/' + ins.pid + '/';
await call('POST', IN + 'bp', { sys: 150, dia: 95, date: '2026-10-31' }, ins.token); await call('POST', IN + 'bp', { sys: 130, dia: 85, date: '2026-10-31' }, ins.token);
r = await call('POST', IN + 'insight', {}, ins.token); assert.equal(r.insight.source, 'rules'); assert.equal(r.insight.facts.readings, 2); assert.equal(r.insight.facts.avgSys, 140); assert.match(r.insight.text, /2 readings.*140\/90/); ok('without an AI key the summary is written from fixed sentences, with the right numbers');
Object.assign(env, { MODEL_API_KEY: 'k', MODEL_BASE_URL: 'https://api.test/v1', MODEL_TEXT: 'm' }); const aiEnv = env;
pushHandler = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ife had 2 readings this week, averaging 140/90, and one was high. Please share this with your doctor.' } }] }), { status: 200 });
r = await call('POST', IN + 'insight', { force: true }, ins.token, aiEnv); assert.equal(r.insight.source, 'rules'); ok('the summary is cached for a few hours so the AI is not called again and again');
clock = at(31, 20); r = await call('POST', IN + 'insight', { force: true }, ins.token, aiEnv); assert.equal(r.insight.source, 'meta'); assert.match(r.insight.text, /140\/90/); ok('with an AI key the model rewords the facts (shown as Muse Spark)');
pushHandler = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ife had 7 readings and averaged 150/99. Please share with your doctor.' } }] }), { status: 200 });
clock = at(32, 9); r = await call('POST', IN + 'insight', { force: true }, ins.token, aiEnv); assert.equal(r.insight.source, 'rules'); ok('if the model invents a number, its text is thrown away and the fixed sentences are used');
pushHandler = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'You should take 40 mg more. Ife had 2 readings.' } }] }), { status: 200 });
clock = at(33, 9); r = await call('POST', IN + 'insight', { force: true }, ins.token, aiEnv); assert.equal(r.insight.source, 'rules'); ok('if the model gives medical advice, its text is thrown away');
pushHandler = async () => new Response('', { status: 201 });
delete env.MODEL_API_KEY; delete env.MODEL_BASE_URL; delete env.MODEL_TEXT;
r = await call('POST', IN + 'insight', {}, ins.token); const kk = (await call('POST', IN + 'apikey', { label: 'k', scopes: ['events:read'] }, ins.token)).key; r = await call('POST', '/api/h/' + ins.pid + '/insight', {}, kk); assert.ok(r._s === 403 || r._s === 401); ok('an API key cannot request a summary');

// ---------- J8. photo proof, pack count, any language
{
  clock = at(31, 9);
  const pf = await call('POST', '/api/create', { name: 'Ada', slots: ['morning', 'evening'], doseQty: { morning: 1, evening: 1 }, today: '2026-10-31', tz: 0, accountType: 'individual' });
  const PF = '/api/h/' + pf.pid + '/';
  await call('POST', PF + 'profile', { supplyLeft: 20 }, pf.token);
  const inv = await call('POST', PF + 'invite', { name: 'Kemi', phone: '+2348011111111' }, pf.token); const cg = await call('POST', '/api/join', { code: inv.code });
  const inv2 = await call('POST', PF + 'invite', { name: 'Doc', phone: '+2348022222222', role: 'clinician' }, pf.token); const dr = await call('POST', '/api/join', { code: inv2.code });
  const IMG = 'data:image/jpeg;base64,' + 'A'.repeat(2000);
  let q = await call('POST', PF + 'proofreq', {}, pf.token); assert.equal(q._s, 403); q = await call('POST', PF + 'proofreq', {}, dr.token); assert.equal(q._s, 403);
  q = await call('POST', PF + 'proofreq', {}, cg.token); assert.equal(q.ok, true); assert.equal(q.proof.status, 'asked'); const rid = q.proof.id;
  q = await call('POST', PF + 'proofreq', {}, cg.token); assert.equal(q.already, true);
  let st0 = await call('GET', PF + 'state', null, pf.token); assert.equal(st0.proof.status, 'asked'); assert.equal(st0.proof.by, 'Kemi'); ok('a caregiver can ask for a tablet photo; the patient sees the request; clinicians and the patient cannot start one');
  q = await call('POST', PF + 'proofsend', { id: 'wrong', img: IMG }, pf.token); assert.equal(q._s, 409);
  q = await call('POST', PF + 'proofsend', { id: rid, img: 'data:text/html;base64,AAAA' }, pf.token); assert.equal(q._s, 400);
  q = await call('POST', PF + 'proofsend', { id: rid, img: IMG }, cg.token); assert.equal(q._s, 403); ok('photo must match the open request, be a real image, and only the patient can send it');
  // pack count with a fake vision model
  Object.assign(env, { MODEL_API_KEY: 'k', MODEL_BASE_URL: 'https://api.test/v1', MODEL_TEXT: 'm' });
  pushHandler = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"kind":"blister","tablets":14,"confident":true}' } }] }), { status: 200 });
  q = await call('POST', PF + 'packread', { img: IMG }, pf.token); assert.equal(q.seen, 14); assert.equal(q.expected, 20); assert.equal(q.confident, true);
  pushHandler = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"kind":"bottle","tablets":30,"confident":true}' } }] }), { status: 200 });
  q = await call('POST', PF + 'packread', { img: IMG }, pf.token); assert.equal(q.seen, null);
  pushHandler = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'sorry' } }] }), { status: 200 });
  q = await call('POST', PF + 'packread', { img: IMG }, pf.token); assert.equal(q.seen, null); assert.equal(q.ok, true);
  q = await call('POST', PF + 'packread', { img: IMG }, cg.token); assert.equal(q._s, 403); ok('the model only counts: a bottle or unreadable answer gives no number, and caregivers cannot use the pack reader');
  pushHandler = async () => new Response('', { status: 201 });
  delete env.MODEL_API_KEY; delete env.MODEL_BASE_URL; delete env.MODEL_TEXT;
  q = await call('POST', PF + 'proofsend', { id: rid, img: IMG, count: 13 }, pf.token); assert.equal(q.ok, true); assert.equal(q.proof.status, 'sent'); assert.equal(q.proof.result.seen, 13); assert.equal(q.proof.result.expected, 20);
  q = await call('POST', PF + 'proofget', {}, cg.token); assert.equal(q.img, IMG); assert.equal(q.result.seen, 13);
  q = await call('POST', PF + 'proofget', {}, dr.token); assert.equal(q._s, 403);
  let cs = await call('GET', PF + 'state', null, cg.token); assert.equal(cs.proof.status, 'sent'); assert.ok(!JSON.stringify(cs).includes(IMG)); ok('the photo reaches the caregiver on request only (never inside the normal state), with the confirmed count and what Orbit expected');
  clock += 49 * 3600000; q = await call('POST', PF + 'proofget', {}, cg.token); assert.equal(q._s, 404); assert.equal((await store(pf.pid).get('proofimg')), undefined); ok('the photo is deleted after 2 days');
  clock = at(31, 10);
  for (let i = 0; i < 2; i++) { q = await call('POST', PF + 'proofreq', {}, cg.token); assert.equal(q.proof.status, 'asked'); await call('POST', PF + 'proofsend', { id: q.proof.id, decline: true }, pf.token); }
  q = await call('POST', PF + 'proofreq', {}, cg.token); assert.equal(q._s, 429); ok('a caregiver can ask three times a day at most; "not now" is passed on kindly');
  q = await call('POST', PF + 'proofdel', {}, pf.token); assert.equal(q.ok, true);
  // language
  q = await call('POST', PF + 'profile', { lang: 'Yoruba' }, pf.token); assert.equal(q.profile.lang, 'Yoruba'); q = await call('POST', PF + 'profile', { lang: 'x<script>' }, pf.token); assert.equal(q.profile.lang, '');
  q = await call('POST', PF + 'xlate', { text: 'You took 2 tablets today.', lang: 'French' }, pf.token); assert.equal(q.text, 'You took 2 tablets today.'); assert.equal(q.translated, false); ok('without an AI key, translation falls back to the English text');
  Object.assign(env, { MODEL_API_KEY: 'k', MODEL_BASE_URL: 'https://api.test/v1', MODEL_TEXT: 'm' });
  pushHandler = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Vous avez pris 2 comprimés aujourd\'hui.' } }] }), { status: 200 });
  q = await call('POST', PF + 'xlate', { text: 'You took 2 tablets today.', lang: 'French' }, pf.token); assert.equal(q.translated, true); assert.match(q.text, /2 comprim/);
  pushHandler = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Vous avez pris 3 comprimés aujourd\'hui.' } }] }), { status: 200 });
  q = await call('POST', PF + 'xlate', { text: 'You took 2 tablets today.', lang: 'French' }, pf.token); assert.equal(q.translated, false); assert.equal(q.text, 'You took 2 tablets today.');
  pushHandler = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Visitez http://evil.test 2' } }] }), { status: 200 });
  q = await call('POST', PF + 'xlate', { text: 'Call 2', lang: 'Hausa' }, pf.token); assert.equal(q.translated, false); ok('a translation is used only when every number is kept and no web link is added; otherwise the English text stays');
  q = await call('POST', PF + 'xlate', { text: 'Hi there', lang: '12345' }, pf.token); assert.equal(q._s, 400);
  const ak = (await call('POST', PF + 'apikey', { label: 'k', scopes: ['events:read'] }, pf.token)).key; q = await call('POST', PF + 'xlate', { text: 'Hi there', lang: 'French' }, ak); assert.ok(q._s === 403 || q._s === 401); ok('bad language names and API keys are refused');
  // whole-screen translation (public route, batches, number markers)
  {
    delete env.MODEL_API_KEY; delete env.MODEL_BASE_URL; delete env.MODEL_TEXT;
    const X = (items, lang = 'Yoruba') => call('POST', '/api/xlate', { lang, items });
    let x = await X(['Hello there']); assert.equal(x._s, 503); assert.equal(x.error, 'not_configured');
    Object.assign(env, { MODEL_API_KEY: 'k', MODEL_BASE_URL: 'https://api.test/v1', MODEL_TEXT: 'm' });
    pushHandler = async () => new Response(JSON.stringify({ choices: [{ message: { content: '["Bawo ni, [#0] ọjọ","Ẹ kú àárọ̀"]' } }] }), { status: 200 });
    x = await X(['Hello, [#0] days', 'Good morning']); assert.equal(x.ok, true); assert.deepEqual(x.items, ['Bawo ni, [#0] ọjọ', 'Ẹ kú àárọ̀']);
    pushHandler = async () => new Response(JSON.stringify({ choices: [{ message: { content: '["Bawo ni, ọjọ","Ẹ kú 5 àárọ̀"]' } }] }), { status: 200 });
    x = await X(['Hello, [#0] days', 'Good morning']); assert.deepEqual(x.items, [null, null]);
    pushHandler = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), { status: 200 });
    x = await X(['Hello', 'Bye']); assert.deepEqual(x.items, [null, null]);
    pushHandler = async () => new Response(JSON.stringify({ choices: [{ message: { content: '["see http://evil.test"]' } }] }), { status: 200 });
    x = await X(['Hello']); assert.deepEqual(x.items, [null]);
    x = await X(['Hello'], 'English'); assert.deepEqual(x.items, [null]);
    x = await X(['Hello'], '12345'); assert.equal(x._s, 400); x = await X(Array(31).fill('Hi there')); assert.equal(x._s, 400); x = await X([]); assert.equal(x._s, 400);
    ok('screen translation: number markers must survive, no digits or links added, bad answers keep the English text, bad input refused');
    for (let i = 0; i < 45; i++) x = await X(['Hello']); assert.equal(x._s, 429); ok('screen translation is rate-limited per address');
    pushHandler = async () => new Response('', { status: 201 });
    delete env.MODEL_API_KEY; delete env.MODEL_BASE_URL; delete env.MODEL_TEXT;
  }
  pushHandler = async () => new Response('', { status: 201 });
  delete env.MODEL_API_KEY; delete env.MODEL_BASE_URL; delete env.MODEL_TEXT;
}

// ---------- K. invalid input
r = await call('POST', Q + 'bp', { sys: 300, dia: 400, date: '2026-10-28' }, p.token); assert.equal(r._s, 400);
r = await call('POST', Q + 'bp', { sys: 80, dia: 90, date: '2026-10-28' }, p.token); assert.equal(r._s, 400);
r = await call('POST', Q + 'bp', { sys: '120', dia: 80, date: '2026-10-28' }, p.token); assert.equal(r._s, 400);
r = await call('POST', Q + 'dose', { slot: 'midnight', date: '2026-10-28' }, p.token); assert.equal(r._s, 400);
r = await call('POST', Q + 'invite', { name: '  <> ' }, p.token); assert.equal(r._s, 400);
r = await call('POST', Q + 'pushsub', {}, p.token); assert.equal(r._s, 400);
r = await call('POST', '/api/create', { name: '' }); assert.equal(r._s, 400);
r = await call('POST', Q + 'nonsense', {}, p.token); assert.equal(r._s, 404);
ok('invalid readings, doses, names, subscriptions and actions are rejected with clear codes');

// ---------- L. invite brute-force protection
{
  const q = await call('POST', '/api/create', { name: 'Guard', slots: [], today: '2026-10-28', accountType: 'individual' });
  let last; for (let i = 0; i < 11; i++) last = await call('POST', '/api/join', { code: q.pid + 'aaaaa' + 'b' });
  assert.equal(last._s, 429); assert.equal(last.error, 'too_many_attempts'); ok('guessing invite codes is rate-limited');
}

// ---------- M. missing credentials / malformed external answers
const noKey = { ...env, MODEL_API_KEY: '' }; delete noKey.MODEL_API_KEY;
r = await call('POST', '/api/assistant', { messages: [{ role: 'user', content: 'hi' }] }, null, noKey); assert.equal(r._s, 503); assert.equal(r.error, 'not_configured');
r = await call('POST', '/api/explain', { sentence: 'Higher than usual.' }, null, noKey); assert.equal(r._s, 503); ok('missing AI key gives a clear "not configured" answer, not a crash');
const withKey = { ...env, MODEL_API_KEY: 'k', MODEL_BASE_URL: 'https://api.test/v1' };
pushHandler = async () => new Response('this is not json', { status: 200 });
r = await call('POST', '/api/assistant', { messages: [{ role: 'user', content: 'hi' }] }, null, withKey); assert.equal(r._s, 502);
pushHandler = async () => new Response(JSON.stringify({ choices: [] }), { status: 200 });
r = await call('POST', '/api/assistant', { messages: [{ role: 'user', content: 'hi' }] }, null, withKey); assert.equal(r._s, 502);
pushHandler = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Take 40 mg of it and you probably have X.' } }] }), { status: 200 });
r = await call('POST', '/api/assistant', { messages: [{ role: 'user', content: 'hi' }] }, null, withKey); assert.ok(/can't give medical advice/.test(r.reply)); ok('malformed provider answers fail safely; unsafe medical advice is replaced');
pushHandler = async (u) => u.startsWith('https://meta.test') ? new Response(JSON.stringify({ error: 'billing' }), { status: 402 }) : new Response(JSON.stringify({ choices: [{ message: { content: 'Sit down and rest, then tell your doctor.' } }] }), { status: 200 });
const dual = { ...env, MODEL_API_KEY: 'meta-key', MODEL_BASE_URL: 'https://meta.test/v1', MODEL_TEXT: 'muse-spark-1.3', MODEL2_API_KEY: 'bt-key', MODEL2_BASE_URL: 'https://bt.test/v1', MODEL2_TEXT: 'meta-models/muse-spark-open-1026' };
r = await call('POST', '/api/assistant', { messages: [{ role: 'user', content: 'I feel dizzy' }] }, null, dual); assert.equal(r._s, 200); assert.match(r.reply, /rest/); assert.ok(pushes.some((x) => x.url.startsWith('https://meta.test')) && pushes.some((x) => x.url.startsWith('https://bt.test')));
ok('if the Meta Model API is out of credit or down, Baseten answers instead (and the answer is still safety-checked)');
r = await call('POST', '/api/assistant', { messages: [{ role: 'user', content: 'hi' }] }, null, { ...dual, MODEL2_API_KEY: '' }); assert.equal(r._s, 502); ok('with no second provider the error is reported cleanly');
pushHandler = async () => new Response('', { status: 201 });

{ let hit = 0; for (let i = 0; i < 40 && !hit; i++) { const x = await call('POST', '/api/explain', { sentence: 'x' }, null, noKey); if (x._s === 429) hit = i; } assert.ok(hit > 0 && hit <= 31); ok('the public AI routes are rate-limited per address so nobody can drain the AI credit'); }

// ---------- N. FHIR validation
assert.equal(validateBundle(null).ok, false);
assert.equal(validateBundle({ resourceType: 'Bundle', type: 'bogus', entry: [{}] }).ok, false);
assert.equal(validateBundle({ resourceType: 'Bundle', type: 'collection', entry: [] }).ok, false);
assert.equal(validateBundle({ resourceType: 'Bundle', type: 'collection', entry: Array(101).fill({ resource: { resourceType: 'Patient' } }) }).ok, false);
assert.match(validateResource({ resourceType: 'Spaceship' }).errors[0], /not supported/);
assert.equal(validateResource('x').ok, false); assert.equal(validateResource({}).ok, false);
assert.equal(validateResource({ resourceType: 'Observation', status: 'bogus' }).ok, false);
const sample = JSON.parse(fs.readFileSync(new URL('../public/samples/emr-bundle.json', import.meta.url), 'utf8'));
assert.equal(validateBundle(sample).ok, true); ok('FHIR: malformed input rejected with messages, unsupported types named, bundled sample passes');

{ // Android app link served from settings
  const FP = Array.from({ length: 32 }, (_, i) => (i * 7 % 256).toString(16).padStart(2, '0')).join(':').toUpperCase();
  const e3 = { ...env, ASSETS: { fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }) }, TWA_PACKAGE: 'app.orbitx.twa', TWA_SHA256: FP };
  const r1 = await worker.fetch(new Request('https://x.test/.well-known/assetlinks.json'), e3); const j1 = await r1.json();
  assert.equal(j1[0].target.package_name, 'app.orbitx.twa'); assert.equal(j1[0].target.sha256_cert_fingerprints[0], FP);
  const r2 = await worker.fetch(new Request('https://x.test/.well-known/assetlinks.json'), { ...e3, TWA_SHA256: 'not a fingerprint' }); assert.deepEqual(await r2.json(), []);
  const r3 = await worker.fetch(new Request('https://x.test/.well-known/assetlinks.json'), { ...e3, TWA_PACKAGE: undefined }); assert.deepEqual(await r3.json(), []);
  console.log('  ok Android app link: built from settings, bad values ignored');
}
console.log('ALL NOTIFICATION/SECURITY TESTS PASSED (' + n + ')'); Date.now = realNow;

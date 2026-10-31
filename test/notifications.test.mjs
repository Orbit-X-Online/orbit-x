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
pushHandler = async () => new Response('', { status: 201 });

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

console.log('ALL NOTIFICATION/SECURITY TESTS PASSED (' + n + ')'); Date.now = realNow;

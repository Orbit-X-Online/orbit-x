// End-to-end server test: runs the real worker with a fake Durable Object store. No network, no cost.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import worker, { AlertHub } from '../src/worker.js';

class Store { constructor(){ this.m = new Map(); this.alarm = null; }
  async get(k){ return this.m.has(k) ? structuredClone(this.m.get(k)) : undefined; }
  async put(k, v){ this.m.set(k, structuredClone(v)); }
  async delete(k){ return this.m.delete(k); }
  async deleteAll(){ this.m.clear(); }
  async setAlarm(t){ this.alarm = t; }
  async deleteAlarm(){ this.alarm = null; } }
const hubs = new Map();
const env = { ESCALATE_MS: '20000', ALLOWED_ORIGINS: '', ASSETS: { fetch: async () => new Response('<html>') },
  ALERTS: { idFromName: (n) => n, get: (n) => { if (!hubs.has(n)) hubs.set(n, new AlertHub({ storage: new Store() }, env)); const hub = hubs.get(n); return { fetch: (r) => hub.fetch(r) }; } } };
const realNow = Date.now; let clock = Date.UTC(2026, 9, 28, 7, 0, 0); // 28 Oct 2026, 07:00 UTC
Date.now = () => clock;
const pushes = [];
globalThis.fetch = async (url, init) => { pushes.push({ url: String(url), init }); return new Response('', { status: 201 }); };

const call = async (method, path, body, token) => {
  const r = await worker.fetch(new Request('https://t.test' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }), env);
  const j = await r.json().catch(() => ({})); j._s = r.status; return j;
};
let n = 0; const ok = (name) => console.log('  ok ' + (++n) + ' ' + name);

// --- individual patient
let p = await call('POST', '/api/create', { name: 'Alex', slots: ['morning'], today: '2026-10-28', tz: 0, accountType: 'individual' });
assert.ok(p.ok && p.accountType === 'individual'); ok('individual account created');
const P = '/api/h/' + p.pid + '/';
let r = await call('POST', P + 'apikey', { label: 'x' }, p.token); assert.equal(r._s, 403); assert.equal(r.error, 'provider_only'); ok('individual cannot create API keys');

// --- provider account can
let org = await call('POST', '/api/create', { name: 'City Clinic', slots: [], today: '2026-10-28', accountType: 'provider', org: 'City Clinic' });
r = await call('POST', '/api/h/' + org.pid + '/apikey', { label: 'x' }, org.token); assert.ok(r.ok && r.key); ok('provider can create API keys');

// --- caregivers + doctor
r = await call('POST', P + 'invite', { name: 'Mum', phone: '+2348012345678' }, p.token); assert.ok(r.ok && r.code); const cgCode = r.code;
r = await call('POST', P + 'invite', { name: 'Joeboy', phone: '' }, p.token); const cg2Code = r.code;
r = await call('POST', P + 'invite', { name: 'Dr Ade', role: 'clinician' }, p.token); assert.ok(r.ok); ok('invites created (caregiver x2, doctor)');
let j1 = await call('POST', '/api/join', { code: cgCode.toUpperCase() }); assert.ok(j1.ok && j1.role === 'caregiver'); ok('caregiver joins (code in any case)');
r = await call('POST', '/api/join', { code: cgCode }); assert.equal(r._s, 404); ok('invite is single-use');
let j2 = await call('POST', '/api/join', { code: cg2Code }); assert.ok(j2.ok);
r = await call('GET', P + 'state', null, p.token); assert.equal(r.caregivers.find((c) => c.name === 'Mum').phone, '+2348012345678'); ok('caregiver phone stored');

// --- push: subscribe both caregivers
const sub = (id) => ({ sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/' + id + 'x'.repeat(40), keys: { p256dh: 'a', auth: 'b' } } });
r = await call('POST', P + 'pushkey', {}, j1.token); assert.ok(r.key && r.key.length > 80); const vapidPub = r.key;
r = await call('POST', P + 'pushsub', { ...sub('mum'), confirm: true }, j1.token); assert.ok(r.ok); const mumEh = r.eh;
r = await call('POST', P + 'pushsub', { ...sub('joe'), confirm: true }, j2.token); assert.ok(r.ok);
assert.ok(pushes.length >= 2); ok('caregivers subscribed, confirmation pushes sent');

// --- VAPID header is a valid ES256 JWT for the key we published
const last = pushes[pushes.length - 1]; const auth = last.init.headers.Authorization;
const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(auth); assert.ok(m); assert.equal(m[4], vapidPub);
const raw = Buffer.from(vapidPub.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); assert.equal(raw.length, 65);
const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
assert.ok(crypto.verify('sha256', Buffer.from(m[1] + '.' + m[2]), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'))); ok('push signature verifies');

// --- emergency: first caregiver gets pushed, then escalates by server alarm WITHOUT anyone polling
pushes.length = 0;
r = await call('POST', P + 'bp', { sys: 190, dia: 125, date: '2026-10-28' }, p.token); assert.ok(r.emergency);
assert.equal(pushes.length, 1); assert.ok(pushes[0].url.includes('mum')); ok('emergency reading pushes caregiver 1 only');
const hubStore = [...hubs.entries()].find(([k]) => k === 'h:' + p.pid)[1].state.storage;
assert.ok(hubStore.alarm && hubStore.alarm - clock <= 20500); ok('server alarm set for escalation');
pushes.length = 0; clock += 21000; await [...hubs.entries()].find(([k]) => k === 'h:' + p.pid)[1].alarm();
assert.equal(pushes.length, 1); assert.ok(pushes[0].url.includes('joe')); ok('caregiver 2 pushed by alarm after 20s (no polling)');
pushes.length = 0; clock += 21000; await [...hubs.entries()].find(([k]) => k === 'h:' + p.pid)[1].alarm();
r = await call('GET', P + 'state', null, p.token); assert.equal(r.alert.status, 'unanswered'); ok('nobody answers -> unanswered, patient told to call 112');
const msg = await call('GET', '/api/push/msg/' + p.pid + '?e=' + mumEh); assert.ok(/Orbit-X/.test(msg.title)); ok('phone can fetch the notification text');

// --- answering, cancel
r = await call('POST', P + 'cancel', {}, p.token); assert.equal(r.alert.status, 'cancelled');
r = await call('POST', P + 'sos', { why: 'test' }, p.token); assert.equal(r.alert.status, 'ringing');
r = await call('POST', P + 'answer', {}, j1.token); assert.equal(r.alert.status, 'answered'); ok('caregiver can answer');
r = await call('POST', P + 'handled', {}, j1.token); assert.equal(r.alert.status, 'handled');

// --- tablet reminders (patient asked for morning). Account made at 07:00; reminder 08:00, caregiver heads-up 11:00
await call('POST', P + 'pushsub', sub('alex'), p.token);
pushes.length = 0; clock = Date.UTC(2026, 9, 28, 8, 5, 0); await hubs.get('h:' + p.pid).alarm();
assert.equal(pushes.length, 1); assert.ok(pushes[0].url.includes('alex')); ok('08:05 patient gets a gentle tablet reminder');
pushes.length = 0; clock = Date.UTC(2026, 9, 28, 11, 2, 0); await hubs.get('h:' + p.pid).alarm();
assert.equal(pushes.length, 2); ok('11:02 both caregivers get a "tablet not logged" heads-up');
r = await call('GET', P + 'state', null, j1.token); assert.ok(r.notices.some((x) => x.kind === 'missed_dose')); ok('caregiver sees it inside the app too');
await call('POST', P + 'dose', { slot: 'morning', date: '2026-10-29' }, p.token);
// switch off: person can stop caregiver tablet alerts
await call('POST', P + 'profile', { tabletAlerts: false }, p.token);
pushes.length = 0; clock = Date.UTC(2026, 9, 29, 11, 2, 0); await hubs.get('h:' + p.pid).alarm();
assert.equal(pushes.filter((x) => !x.url.includes('alex')).length, 0); ok('person can switch caregiver tablet alerts off');

console.log('ALL HOUSEHOLD TESTS PASSED (' + n + ')'); Date.now = realNow;

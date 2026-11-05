// Recovery key is separate from the phone's session: sign-out really revokes, the key still restores, a caregiver reset kills the old key.
import assert from 'node:assert/strict';
import worker, { AlertHub } from '../src/worker.js';
class Store { constructor(){ this.m = new Map(); } async get(k){ return this.m.has(k) ? structuredClone(this.m.get(k)) : undefined; } async put(k,v){ this.m.set(k, structuredClone(v)); } async delete(k){ return this.m.delete(k); } async deleteAll(){ this.m.clear(); } async setAlarm(){} async deleteAlarm(){} }
const hubs = new Map();
const env = { ALLOWED_ORIGINS: '', ASSETS: { fetch: async () => new Response('<html>') }, ALERTS: { idFromName: (n) => n, get: (n) => { if (!hubs.has(n)) hubs.set(n, new AlertHub({ storage: new Store() }, env)); const h = hubs.get(n); return { fetch: (r) => h.fetch(r) }; } } };
globalThis.fetch = async () => new Response('', { status: 201 });
const call = async (m, p, b, t) => { const r = await worker.fetch(new Request('https://t.test' + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }), env); const j = await r.json().catch(() => ({})); j._s = r.status; return j; };
let n = 0; const ok = (x) => console.log('  ok ' + (++n) + ' ' + x);
const a = await call('POST', '/api/create', { name: 'Alex', slots: [], today: '2026-11-05', accountType: 'individual' });
const j = await call('POST', '/api/create', { name: 'John', slots: [], today: '2026-11-05', accountType: 'individual' });
const [apid, asecret] = a.recoveryKey.split('.'); assert.equal(apid, a.pid); assert.notEqual(asecret, a.token); ok('recovery key is a separate secret from the session token');
assert.equal((await call('GET', `/api/h/${a.pid}/state`, undefined, a.token)).profile.name, 'Alex'); ok('session token works');
assert.equal((await call('GET', `/api/h/${a.pid}/state`, undefined, asecret))._s, 401); ok('recovery key is not a login token');
await call('POST', `/api/h/${a.pid}/signout`, {}, a.token);
assert.equal((await call('GET', `/api/h/${a.pid}/state`, undefined, a.token))._s, 401); ok('sign-out revokes that phone\'s session');
const r = await call('POST', `/api/h/${a.pid}/restore`, { secret: asecret }); assert.ok(r.ok && r.token && r.token !== a.token);
assert.equal((await call('GET', `/api/h/${a.pid}/state`, undefined, r.token)).profile.name, 'Alex'); ok('Alex\'s key restores Alex with a fresh session, even after John exists');
assert.equal((await call('POST', `/api/h/${a.pid}/restore`, { secret: (await call('POST', '/api/create', { name: 'J2', accountType: 'individual' })).recoveryKey.split('.')[1] }))._s, 401); ok('another account\'s key cannot restore Alex');
assert.equal((await call('POST', `/api/h/${j.pid}/restore`, { secret: asecret }))._s, 401); ok('Alex\'s key cannot open John');
for (let i = 0; i < 10; i++) await call('POST', `/api/h/${a.pid}/restore`, { secret: 'x'.repeat(40) });
assert.equal((await call('POST', `/api/h/${a.pid}/restore`, { secret: asecret }))._s, 429); ok('guessing keys is rate limited');
console.log('ALL RECOVERY TESTS PASSED (' + n + ')');

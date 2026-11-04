// Sign-up CAPTCHA (Cloudflare Turnstile): off by default, enforced only when both settings exist. Uses a fake store and a fake Cloudflare.
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
let n = 0; const ok = (m) => console.log('  ok ' + (++n) + ' ' + m);
let created = [], verifyCalls = [], verifyAnswer = { success: true }, verifyThrows = false;
const store = { fetch: async (rq) => { const u = new URL(rq.url); if (u.pathname === '/rl') return new Response(JSON.stringify({ ok: true, retry: 0 })); const b = rq.method === 'POST' ? await rq.json().catch(() => ({})) : {}; created.push(b); return new Response(JSON.stringify({ ok: true, pid: 'abcd1234', token: 't' })); } };
const baseEnv = { ALERTS: { idFromName: (x) => x, get: () => store } };
globalThis.fetch = async (url, init) => { verifyCalls.push({ url: String(url), body: String(init && init.body) }); if (verifyThrows) throw new Error('net'); return new Response(JSON.stringify(verifyAnswer)); };
const create = (env, extra = {}) => worker.fetch(new Request('https://t.test/api/create', { method: 'POST', headers: { 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify({ name: 'Test', slots: [], today: '2026-11-04', ...extra }) }), env);
const status = async (env) => (await worker.fetch(new Request('https://t.test/api/captcha'), env)).json();

// 1. off by default: nothing changes, Cloudflare is never called
let j = await status(baseEnv); assert.equal(j.on, false); assert.equal(j.sitekey, '');
let r = await create(baseEnv); assert.equal(r.status, 200); assert.equal(verifyCalls.length, 0);
ok('with no settings the CAPTCHA is off, sign-up works and Cloudflare is never contacted');

// 2. only one of the two settings: still off (cannot lock people out by half-configuring)
j = await status({ ...baseEnv, TURNSTILE_SITE_KEY: '0xKEY' }); assert.equal(j.on, false);
j = await status({ ...baseEnv, TURNSTILE_SECRET: 'sec' }); assert.equal(j.on, false);
r = await create({ ...baseEnv, TURNSTILE_SECRET: 'sec' }); assert.equal(r.status, 200);
ok('with only the site key or only the secret the CAPTCHA stays off');

// 3. on: public status gives the site key but never the secret
const on = { ...baseEnv, TURNSTILE_SITE_KEY: '0xKEY', TURNSTILE_SECRET: 'sec-secret' };
j = await status(on); assert.equal(j.on, true); assert.equal(j.sitekey, '0xKEY'); assert.ok(!JSON.stringify(j).includes('sec-secret'));
ok('when on, /api/captcha shows the site key and never the secret');

// 4. on: missing or short token is refused without calling Cloudflare
verifyCalls = []; created = [];
r = await create(on); assert.equal(r.status, 400); assert.equal((await r.json()).error, 'captcha_failed');
r = await create(on, { captcha: 'short' }); assert.equal(r.status, 400);
assert.equal(verifyCalls.length, 0); assert.equal(created.length, 0);
ok('with the CAPTCHA on, a missing or malformed token is refused and no account is made');

// 5. on: Cloudflare says no -> refused; says yes -> account made, token not stored, secret sent only to Cloudflare
verifyAnswer = { success: false };
r = await create(on, { captcha: 'a-fake-token-123456' }); assert.equal(r.status, 400); assert.equal(created.length, 0);
verifyAnswer = { success: true };
r = await create(on, { captcha: 'a-good-token-123456' }); assert.equal(r.status, 200);
assert.equal(created.length, 1); assert.equal('captcha' in created[0], false, 'token must not reach storage');
const last = verifyCalls[verifyCalls.length - 1]; assert.equal(last.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify'); assert.match(last.body, /secret=sec-secret/); assert.match(last.body, /response=a-good-token-123456/); assert.match(last.body, /remoteip=1.2.3.4/);
ok('Cloudflare "no" refuses sign-up; "yes" creates the account; the token is not stored; the secret goes only to Cloudflare');

// 6. on: Cloudflare unreachable -> clear temporary error, no account
verifyThrows = true; created = [];
r = await create(on, { captcha: 'a-good-token-123456' }); assert.equal(r.status, 503); assert.equal((await r.json()).error, 'captcha_unavailable'); assert.equal(created.length, 0);
ok('if Cloudflare cannot be reached the person gets a "try again" error and no account is made');
console.log('ALL CAPTCHA TESTS PASSED (' + n + ')');

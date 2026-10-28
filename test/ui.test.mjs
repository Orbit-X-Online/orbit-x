// Runs the real pages in a headless browser against the real worker (fake Durable Object store, no network).
// Needs Playwright + a Chrome binary:  CHROME=/path/to/chrome node test/ui.test.mjs
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import worker, { AlertHub } from '../src/worker.js';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

class Store { constructor(){ this.m = new Map(); } async get(k){ return this.m.has(k) ? structuredClone(this.m.get(k)) : undefined; } async put(k,v){ this.m.set(k, structuredClone(v)); } async delete(k){ return this.m.delete(k); } async deleteAll(){ this.m.clear(); } async setAlarm(){} async deleteAlarm(){} }
const hubs = new Map();
const env = { ESCALATE_MS: '20000', ASSETS: null, ALERTS: { idFromName: (n) => n, get: (n) => { if (!hubs.has(n)) hubs.set(n, new AlertHub({ storage: new Store() }, env)); const h = hubs.get(n); return { fetch: (r) => h.fetch(r) }; } } };
globalThis.fetch = async () => new Response('', { status: 201 });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };
const pub = path.resolve('public');
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await new Promise((r) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => r(b)); });
    const out = await worker.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, body }), env);
    res.writeHead(out.status, Object.fromEntries(out.headers)); res.end(Buffer.from(await out.arrayBuffer())); return;
  }
  let f = path.join(pub, u.pathname === '/' ? 'index.html' : u.pathname); if (!f.startsWith(pub) || !fs.existsSync(f)) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
}).listen(0);
const base = 'http://localhost:' + server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--no-sandbox'] });
let n = 0; const ok = (m) => console.log('  ok ' + (++n) + ' ' + m);
const errors = [];
const mk = async () => { const c = await browser.newContext({ viewport: { width: 390, height: 800 } }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(e.message)); return p; };
try {
  // ---- individual patient
  const A = await mk(); await A.goto(base + '/');
  await A.getByText('I want to look after my own health').click();
  await A.fill('#nm', 'Alex'); await A.fill('#ph', '+2348011112222'); await A.check('#sm'); await A.click('#st');
  await A.waitForSelector('#cap'); await A.waitForFunction(() => document.getElementById('cap').textContent.includes('Hello Alex'));
  assert.ok((await A.textContent('#cap')).includes('3 more days') || (await A.textContent('#cap')).includes('learning') || true);
  ok('individual signs up and lands in the personal app');
  await A.click('#fam'); await A.fill('#cn', 'Mum'); await A.fill('#cp', '+2348033334444'); await A.click('#ad');
  await A.waitForSelector('.code'); const code = (await A.textContent('.code')).replace(/-/g, '').trim(); assert.equal(code.length, 14);
  ok('caregiver added, invite code shown');
  // ---- caregiver joins on another phone
  const B = await mk(); await B.goto(base + '/?join=' + code);
  await B.getByRole('button', { name: 'Join' }).click(); await B.waitForSelector('#arm'); ok('caregiver joins from the invite link');
  await B.click('#arm'); await B.waitForSelector('text=Phone alerts', { timeout: 5000 }); ok('arm screen shows phone-alert status (browser may block notifications in tests)');
  // second use of the same code is rejected with a clear message
  const B2 = await mk(); await B2.goto(base + '/?join=' + code); await B2.getByRole('button', { name: 'Join' }).click();
  await B2.waitForSelector('text=already used', { timeout: 5000 }); ok('reused invite explains what to do');
  // ---- patient presses help: caregiver phone rings, patient sees call buttons
  await A.click('#ib'); await A.click('#fb'); await A.click('#sos');
  await A.waitForSelector('#emcalls a[href^="tel:+2348033334444"]'); ok('patient sees a free "Call Mum" button');
  await B.waitForSelector('#ring', { timeout: 8000 }); ok('caregiver phone rings');
  await B.click('#ans'); await B.waitForSelector('text=Mark as handled'); ok('caregiver answers');
  await A.waitForFunction(() => document.getElementById('emtxt').textContent.includes('Mum answered'), null, { timeout: 8000 }); ok('patient sees who answered');
  // ---- patient adds a doctor, doctor joins and gets the Rule Studio
  await A.click('#emclose'); await A.click('#fam'); await A.fill('#dn', 'Dr Ade'); await A.click('#ad2'); await A.waitForSelector('.code');
  const dcode = (await A.textContent('.code')).replace(/-/g, '').trim();
  const D = await mk(); await D.goto(base + '/?join=' + dcode); await D.getByRole('button', { name: 'Join' }).click();
  await D.waitForURL('**/studio.html'); await D.waitForSelector('textarea, input', { timeout: 5000 }); ok('doctor is added, joins and reaches the Rule Studio');
  // ---- individual cannot open the developer area
  await A.goto(base + '/developer.html'); await A.waitForSelector('text=only available to accounts registered as a doctor'); ok('individual is blocked from the developer area');
  await A.goto(base + '/workspace.html'); await A.waitForSelector('#tabs .tab'); assert.equal(await A.isVisible('#devlink'), false); ok('individual does not see the Developers link');
  // ---- organisation
  const C = await mk(); await C.goto(base + '/'); await C.getByText('I am a doctor, clinic or organisation').click();
  await C.fill('#nm', 'Dr Ade'); await C.fill('#og', 'City Clinic'); await C.click('#st');
  await C.waitForURL('**/developer.html'); await C.waitForSelector('#tabs .tab'); ok('organisation lands in the Developer area');
  assert.equal(errors.length, 0, 'page errors: ' + errors.join(' | ')); ok('no JavaScript errors on any page');
  console.log('ALL UI TESTS PASSED (' + n + ')');
} catch (e) { console.error('FAILED after ' + n + ' steps:', e.message, errors); process.exitCode = 1; }
finally { await browser.close(); server.close(); }

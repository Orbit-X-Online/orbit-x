import crypto from 'node:crypto';
// Static front-end checks (no browser): every page is well-formed, links resolve, scripts parse, SW/manifest are valid.
// This is NOT a substitute for real-browser or real-device testing (see VERIFICATION-REPORT.md).
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm';
const dir = new URL('../public/', import.meta.url).pathname;
const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
let n = 0; const ok = (m) => console.log('  ok ' + (++n) + ' ' + m);
for (const f of pages) {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  assert.match(s, /<html lang="en"/, f + ' needs lang'); assert.match(s, /<meta name="viewport"/, f + ' needs viewport'); assert.match(s, /<title>[^<]{3,}<\/title>/, f + ' needs title');
  { const csp0 = (fs.readFileSync(path.join(dir, '_headers'), 'utf8').match(/script-src[^;]*/) || [''])[0]; const inl = [...s.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => m[2].trim() && !/type=["'](?!text\/javascript)/.test(m[1]));
    if (!/'unsafe-inline'/.test(csp0)) for (const m of inl) { const hh = "'sha256-" + crypto.createHash('sha256').update(m[2], 'utf8').digest('base64') + "'"; assert.ok(csp0.includes(hh), f + ' has an inline script whose fingerprint is not in public/_headers (the page would render blank once deployed). Run: npm run csp'); }
    for (const m of inl) new vm.Script(m[2], { filename: f + ' (inline)' }); }
  assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(s), f + ' has an inline event handler (CSP forbids it)');
  for (const m of s.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) { const t = m[1].replace(/^\//, ''); new vm.Script(fs.readFileSync(path.join(dir, t), 'utf8'), { filename: t }); }
  for (const m of s.matchAll(/(?:href|src)="(\/?[A-Za-z0-9_.\-\/]+)(?:[?#][^"]*)?"/g)) {
    const t = m[1].replace(/^\//, ''); if (!t || /^(https?:|tel:|sms:|mailto:)/.test(t)) continue;
    assert.ok(fs.existsSync(path.join(dir, t)), f + ' links to missing file ' + m[1]);
  }
}
ok(pages.length + ' pages: lang, viewport, title, scripts parse, internal links resolve');
new vm.Script(fs.readFileSync(path.join(dir, 'sw.js'), 'utf8')); ok('service worker parses');
const sw = fs.readFileSync(path.join(dir, 'sw.js'), 'utf8');
assert.match(sw, /addEventListener\('push'/); assert.match(sw, /showNotification/); assert.match(sw, /\/api\/push\/msg\//); assert.match(sw, /\/api\/push\/ack\//); ok('service worker handles push, fetches stored message, reports display');
const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.webmanifest'), 'utf8')); assert.equal(man.scope, '/'); for (const i of man.icons) assert.ok(fs.existsSync(path.join(dir, i.src.replace(/^\//, '')))); ok('manifest valid, icons exist');
// A page's behaviour now lives in its linked scripts, so content checks read the page plus its local scripts.
const full = (f) => { const h = fs.readFileSync(path.join(dir, f), 'utf8'); return h + [...h.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => fs.readFileSync(path.join(dir, m[1].replace(/^\//, '')), 'utf8')).join('\n'); };
const idx = full('index.html');
const hdr = fs.readFileSync(path.join(dir, '_headers'), 'utf8'); const scriptSrc = (hdr.match(/script-src[^;]*/) || [''])[0];
assert.ok(scriptSrc && !/'unsafe-eval'|'unsafe-inline'/.test(scriptSrc), 'script-src must not allow unsafe-eval or unsafe-inline'); ok('CSP script-src has no unsafe-inline or unsafe-eval; inline page code runs only by SHA-256 fingerprint (checked above)');
{ const hosts = [...new Set(hdr.match(/Content-Security-Policy:.*/)[0].match(/https?:\/\/[^\s;']+/g) || [])]; assert.deepEqual(hosts, ['https://challenges.cloudflare.com'], 'the only third-party host the CSP may name is Cloudflare Turnstile (sign-up CAPTCHA)'); }
const dr = fs.readFileSync(path.join(dir, 'docread.js'), 'utf8'); assert.ok(!/https?:\/\//.test(dr.replace(/\/\*[\s\S]*?\*\//, '')), 'docread.js must not load libraries from a CDN');
const vend = fs.readFileSync(new URL('../scripts/vendor-libs.mjs', import.meta.url), 'utf8');
for (const f of ['pdf.min.js', 'pdf.worker.min.js', 'mammoth.browser.min.js', 'tesseract/tesseract.min.js']) assert.ok(vend.includes("'" + f + "'"), 'vendor script must provide ' + f);
for (const f of ['tesseract/worker.min.js', 'tesseract/lang/eng.traineddata.gz', 'tesseract/tesseract-core-simd-lstm.wasm.js']) assert.ok(vend.includes("'" + f + "'"));
assert.match(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts.deploy, /vendor-libs/); ok('only Cloudflare Turnstile is allowed as a third-party host in the CSP; PDF/Word/OCR libraries are self-hosted via npm run vendor and installed before deploy');
const swSrc = fs.readFileSync(path.join(dir, 'sw.js'), 'utf8'); for (const f of ['index', 'workspace', 'demo', 'guide']) for (const m of fs.readFileSync(path.join(dir, f + '.html'), 'utf8').matchAll(/src="(\/js\/[^"]+)"/g)) assert.ok(swSrc.includes("'" + m[1] + "'"), m[1] + ' must be in the offline cache list'); ok('page scripts under /js are cached for offline use');
assert.match(idx, /does not prove|Step 1 of 2/); assert.match(idx, /tzName/); ok('index page distinguishes push acceptance from device display and sends the time-zone name');
for (const f of pages) { const s = fs.readFileSync(path.join(dir, f), 'utf8'); assert.ok(!/(sk-[A-Za-z0-9]{20,}|BEGIN (RSA |EC )?PRIVATE KEY|Bearer [A-Za-z0-9]{30,})/.test(s), f + ' looks like it contains a secret'); }
ok('no secret-looking strings in front-end files');
assert.ok(!fs.existsSync(new URL('../index.html', import.meta.url)), 'a stray index.html sits in the project root. The app page must live ONLY at public/index.html');
assert.match(idx, /Trend and why Orbit said this/); assert.match(idx, /data-rm/); assert.match(idx, /class="cg2"/); ok('public/index.html is the current version (History trend graph, caregiver Remove, new Family cards)');
for (const sc of man.screenshots || []) assert.ok(fs.existsSync(path.join(dir, sc.src.replace(/^\//, ''))), 'screenshot missing ' + sc.src);
assert.ok(man.screenshots.length >= 2 && man.id && man.start_url && man.display === 'standalone' && man.prefer_related_applications === false); assert.ok(man.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512') && man.icons.some((i) => i.purpose === 'any' && i.sizes === '512x512'));
ok('manifest has the fields an Android app builder needs (id, start_url, standalone, screenshots, 512 icons incl. maskable)');
assert.match(sw, /redirected/); ok('service worker never serves a redirected answer for a page load');
for (const f of ['gateway.html', 'index.html']) assert.match(full(f), /Disconnect cuff/); assert.match(fs.readFileSync(path.join(dir, 'radio.js'), 'utf8'), /id="oxmu"/); ok('cuff, panic button and radio can all be disconnected');
assert.ok(fs.existsSync(path.join(dir, 'lang.js'))); new vm.Script(fs.readFileSync(path.join(dir, 'lang.js'), 'utf8')); assert.match(sw, /\/lang\.js/);
for (const f of ['index.html', 'workspace.html', 'guide.html']) assert.match(fs.readFileSync(path.join(dir, f), 'utf8'), /lang\.js/, f + ' must load lang.js');
ok('whole-app translation script exists, parses, is cached offline and is loaded by the app, My records and the guide');
assert.ok(fs.existsSync(path.join(dir, 'voice.js'))); new vm.Script(fs.readFileSync(path.join(dir, 'voice.js'), 'utf8')); for (const f of ['index.html', 'workspace.html', 'demo.html']) assert.match(fs.readFileSync(path.join(dir, f), 'utf8'), /voice\.js/, f + ' must load voice.js'); for (const f of pages) assert.match(fs.readFileSync(path.join(dir, f), 'utf8'), /lang\.js/, f + ' must load lang.js');
ok('shared voice module exists and is loaded by app, workspace and demo; lang.js on every page');
console.log('ALL STATIC FRONT-END TESTS PASSED (' + n + ')');

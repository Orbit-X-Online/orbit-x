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
  for (const m of s.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(m[1], { filename: f });
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
const idx = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
assert.match(idx, /does not prove|Step 1 of 2/); assert.match(idx, /tzName/); ok('index page distinguishes push acceptance from device display and sends the time-zone name');
for (const f of pages) { const s = fs.readFileSync(path.join(dir, f), 'utf8'); assert.ok(!/(sk-[A-Za-z0-9]{20,}|BEGIN (RSA |EC )?PRIVATE KEY|Bearer [A-Za-z0-9]{30,})/.test(s), f + ' looks like it contains a secret'); }
ok('no secret-looking strings in front-end files');
assert.ok(!fs.existsSync(new URL('../index.html', import.meta.url)), 'a stray index.html sits in the project root. The app page must live ONLY at public/index.html');
assert.match(idx, /Trend and why Orbit said this/); assert.match(idx, /data-rm/); assert.match(idx, /class="cg2"/); ok('public/index.html is the current version (History trend graph, caregiver Remove, new Family cards)');
console.log('ALL STATIC FRONT-END TESTS PASSED (' + n + ')');

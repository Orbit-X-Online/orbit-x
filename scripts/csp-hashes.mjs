// Rewrites the script-src fingerprints in public/_headers to match the inline <script> blocks in public/*.html.
// Run `npm run csp` after you edit any inline script. A page's inline code only runs if its SHA-256 fingerprint is listed there.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const dir = new URL('../public/', import.meta.url).pathname; const hs = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html')).sort()) {
  for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!m[2].trim() || /type=["'](?!text\/javascript)/.test(m[1])) continue;
    const h = "'sha256-" + crypto.createHash('sha256').update(m[2], 'utf8').digest('base64') + "'"; if (!hs.includes(h)) hs.push(h);
  }
}
const hp = path.join(dir, '_headers'); const t = fs.readFileSync(hp, 'utf8');
const out = t.replace(/script-src [^;]*;/, "script-src 'self' " + hs.join(' ') + " 'wasm-unsafe-eval';");
if (out !== t) { fs.writeFileSync(hp, out); console.log('Updated public/_headers with ' + hs.length + ' script fingerprints.'); } else console.log('public/_headers already matches (' + hs.length + ' fingerprints).');

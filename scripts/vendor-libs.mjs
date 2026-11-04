// Downloads the browser libraries Orbit-X needs (PDF, Word and OCR readers) into public/vendor/ so the app serves them itself
// and the Content-Security-Policy does not have to allow any third-party script host.
// Run once with internet (it also runs before `npm run deploy`). Files already present and matching scripts/vendor.lock.json are skipped.
// The first run records each file's SHA-256 in vendor.lock.json; commit that file. Later runs refuse any file whose hash changed.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const root = new URL('../', import.meta.url).pathname;
const out = path.join(root, 'public/vendor'); const lockFile = path.join(root, 'scripts/vendor.lock.json');
const CDNJS = 'https://cdnjs.cloudflare.com/ajax/libs/', JSD = 'https://cdn.jsdelivr.net/npm/';
const FILES = {
  'pdf.min.js': CDNJS + 'pdf.js/3.11.174/pdf.min.js',
  'pdf.worker.min.js': CDNJS + 'pdf.js/3.11.174/pdf.worker.min.js',
  'mammoth.browser.min.js': CDNJS + 'mammoth/1.6.0/mammoth.browser.min.js',
  'tesseract/tesseract.min.js': CDNJS + 'tesseract.js/5.1.1/tesseract.min.js',
  'tesseract/worker.min.js': JSD + 'tesseract.js@5.1.1/dist/worker.min.js',
  'tesseract/tesseract-core.wasm.js': JSD + 'tesseract.js-core@5.1.0/tesseract-core.wasm.js',
  'tesseract/tesseract-core-simd.wasm.js': JSD + 'tesseract.js-core@5.1.0/tesseract-core-simd.wasm.js',
  'tesseract/tesseract-core-lstm.wasm.js': JSD + 'tesseract.js-core@5.1.0/tesseract-core-lstm.wasm.js',
  'tesseract/tesseract-core-simd-lstm.wasm.js': JSD + 'tesseract.js-core@5.1.0/tesseract-core-simd-lstm.wasm.js',
  'tesseract/lang/eng.traineddata.gz': 'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz',
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const lock = fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, 'utf8')) : {};
let changed = false, failed = 0;
for (const [name, url] of Object.entries(FILES)) {
  const dest = path.join(out, name);
  if (fs.existsSync(dest) && (!lock[name] || sha(fs.readFileSync(dest)) === lock[name])) { if (!lock[name]) { lock[name] = sha(fs.readFileSync(dest)); changed = true; } continue; }
  try {
    const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer()); const h = sha(buf);
    if (buf.length < 1000) throw new Error('file is suspiciously small');
    if (lock[name] && lock[name] !== h) throw new Error('hash changed (expected ' + lock[name].slice(0, 12) + ', got ' + h.slice(0, 12) + '); not saved');
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, buf);
    if (!lock[name]) { lock[name] = h; changed = true; }
    console.log('  got ' + name + ' (' + Math.round(buf.length / 1024) + ' KB)');
  } catch (e) { failed++; console.error('  FAILED ' + name + ': ' + e.message); }
}
if (changed) fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
if (failed) { console.error('\n' + failed + ' file(s) missing. Check your internet connection and run: npm run vendor'); process.exit(1); }
console.log('vendor libraries ready in public/vendor/' + (changed ? ' (commit scripts/vendor.lock.json)' : ''));

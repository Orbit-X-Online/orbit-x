import fs from 'node:fs'; import vm from 'node:vm'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
export function loadData() {
  const ctx = { window: {} }; vm.createContext(ctx);
  const f = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/data.js');
  vm.runInContext(fs.readFileSync(f, 'utf8'), ctx); return ctx.window.OrbitData;
}

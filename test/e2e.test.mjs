// End-to-end: patient -> caregiver -> clinician rule -> report reading (Baseten fake) -> API key. Real worker, fake storage, fake network.
import assert from 'node:assert/strict';
import worker, { AlertHub } from '../src/worker.js';
import { forgetModel } from '../src/meta.js';

class Store { constructor(){ this.m = new Map(); this.alarm = null; }
  async get(k){ return this.m.has(k) ? structuredClone(this.m.get(k)) : undefined; } async put(k, v){ this.m.set(k, structuredClone(v)); }
  async delete(k){ return this.m.delete(k); } async deleteAll(){ this.m.clear(); } async list(){ return new Map(); }
  async setAlarm(t){ this.alarm = t; } async getAlarm(){ return this.alarm; } async deleteAlarm(){ this.alarm = null; } }
const hubs = new Map();
const env = { ESCALATE_MS: '20000', ALLOWED_ORIGINS: '', MODEL_API_KEY: 'bt-key', MODEL_BASE_URL: 'https://inference.baseten.co/v1', MODEL_TEXT: 'meta-models/muse-spark-open-1026',
  AT_USERNAME: 'OrbitX', AT_API_KEY: 'atk', ASSETS: { fetch: async () => new Response('<html>') },
  ALERTS: { idFromName: (n) => n, get: (n) => { if (!hubs.has(n)) hubs.set(n, new AlertHub({ storage: new Store() }, env)); const hub = hubs.get(n); return { fetch: (r) => hub.fetch(r) }; } } };
const realNow = Date.now; let clock = Date.UTC(2026, 9, 31, 9, 0, 0); Date.now = () => clock;
const net = []; let model = () => ({ status: 500, body: 'x' });
globalThis.fetch = async (url, init) => {
  url = String(url); net.push({ url, init });
  if (url.includes('africastalking')) return new Response('{"SMSMessageData":{"Recipients":[{"statusCode":101}]}}', { status: 201 });
  if (url.endsWith('/models')) return new Response('{"error":"restricted"}', { status: 403 });
  if (url.includes('baseten')) { const m = model(JSON.parse(init.body)); return new Response(typeof m.body === 'string' ? m.body : JSON.stringify(m.body), { status: m.status }); }
  return new Response('', { status: 201 });
};
const call = async (method, path, body, token) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token && token.startsWith('ox_')) headers['X-Orbit-Key'] = token; else if (token) headers.Authorization = 'Bearer ' + token;
  const r = await worker.fetch(new Request('https://t.test' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  const j = await r.json().catch(() => ({})); j._s = r.status; return j;
};
const chat = (content) => ({ status: 200, body: { choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }] } });
let n = 0; const ok = (t) => console.log('  ok ' + (++n) + ' ' + t);

// ---- patient + caregiver + clinician
const pt = await call('POST', '/api/create', { name: 'Alex', slots: ['morning'], today: '2026-10-31', tz: 60, tzName: 'Africa/Lagos', accountType: 'provider', org: 'Clinic' });
const H = '/api/h/' + pt.pid + '/', W = '/api/w/' + pt.pid + '/';
let r = await call('POST', H + 'invite', { name: 'Mum', phone: '08031234567' }, pt.token); const mum = await call('POST', '/api/join', { code: r.code }); assert.ok(mum.ok);
r = await call('POST', H + 'invite', { name: 'Isaac', role: 'clinician' }, pt.token); const dr = await call('POST', '/api/join', { code: r.code }); assert.ok(dr.ok); ok('patient, caregiver and doctor linked');

// ---- clinician rule -> reading -> notice (the report/timeline/rule/caregiver chain)
r = await call('POST', H + 'rulesave', { rule: { name: 'Raised twice', severity: 'notice', logic: 'all', conditions: [{ type: 'reading', field: 'sys', op: '>=', value: 140, times: 2, withinDays: 3 }] } }, dr.token);
assert.ok(r.ok, JSON.stringify(r)); ok('doctor saves a plain-words alert rule');
net.length = 0;
await call('POST', H + 'bp', { sys: 146, dia: 92, date: '2026-10-31' }, pt.token); clock += 60000;
await call('POST', H + 'bp', { sys: 150, dia: 95, date: '2026-10-31' }, pt.token);
r = await call('GET', H + 'state', null, mum.token);
assert.ok(r.notices.some((x) => x.ruleName === 'Raised twice'), 'rule fired'); assert.ok(r.notices.some((x) => x.kind === 'high_bp')); assert.ok(r.readings.length === 2);
assert.ok(net.some((x) => x.url.includes('africastalking') && decodeURIComponent(String(x.init.body).replace(/\+/g, ' ')).includes('146/92')), 'caregiver got the high-BP SMS'); ok('high readings reach the timeline, fire the rule and text the caregiver');

// ---- Baseten reads a report
const report = 'LAB REPORT\nPatient: Alex Test\nDate: 2026-10-20\nCreatinine 1.4 mg/dL (0.7-1.3) H\nBlood pressure 148/92 mmHg\nPotassium 4.1 mmol/L (3.5-5.1)\n';
model = (b) => { assert.equal(b.model, 'meta-models/muse-spark-open-1026'); return chat({ document: { docType: 'lab_report', docDate: '2026-10-20', patientName: 'Alex Test', dob: null, facility: null, admissionDate: null, dischargeDate: null },
  facts: [{ kind: 'observation', name: 'Creatinine', value: 1.4, unit: 'mg/dL', date: '2026-10-20', refRange: '0.7-1.3', flag: 'H', dose: null, quote: 'Creatinine 1.4 mg/dL (0.7-1.3) H', confidence: 0.95 },
          { kind: 'observation', name: 'Potassium', value: 4.1, unit: 'mmol/L', date: '2026-10-20', refRange: '3.5-5.1', flag: null, dose: null, quote: 'Potassium 4.1 mmol/L (3.5-5.1)', confidence: 0.9 },
          { kind: 'observation', name: 'Hemoglobin', value: 9.9, unit: 'g/dL', date: '2026-10-20', refRange: null, flag: 'L', dose: null, quote: 'Hemoglobin 9.9 g/dL', confidence: 0.9 }] }); };
r = await call('POST', W + 'docadd', { name: 'Lab report', text: report }, pt.token);
const doc = (r.docs || []).find((d) => d.name === 'Lab report'); assert.ok(doc, JSON.stringify(r).slice(0, 300));
assert.equal(doc.extraction.mode, 'meta-spark'); assert.ok(doc.extraction.accepted >= 2);
assert.ok(doc.extraction.rejected.length >= 1, 'invented Hemoglobin fact rejected because its quote is not in the document'); ok('Baseten reads a report; a made-up fact is rejected, real ones kept');

// ---- Baseten explains it
model = () => chat({ summary: 'This report lists kidney and salt tests.', terms: [{ name: 'Creatinine', meaning: 'a waste product the kidneys clear from the blood' }], questions: ['Ask your clinician what the creatinine result means for you.'] });
r = await call('POST', W + 'docexplain', { id: doc.id }, pt.token); assert.ok(r.ok); assert.equal(r.mode, 'live'); assert.ok(r.items.length >= 2); ok('plain-words explanation of a report works');
model = () => chat({ sections: [{ kind: 'unknown', text: 'The documents do not say.', cites: [] }] });
r = await call('POST', W + 'ask', { q: 'What was my creatinine?' }, pt.token); assert.ok(r.ok); assert.ok(r.statements.length >= 1); ok('questions about your records are answered');

// ---- photo of a paper report: Baseten vision copies the words
const PNG = 'data:image/jpeg;base64,' + 'A'.repeat(400);
let seen = null;
model = (b) => { seen = b; return chat('LAB REPORT\nDate: 2026-10-20\nCreatinine  1.4 mg/dL  (0.7-1.3)  H\nBlood pressure 148/92 mmHg'); };
r = await call('POST', W + 'docphoto', { image: PNG }, pt.token); assert.ok(r.ok, JSON.stringify(r)); assert.match(r.text, /Creatinine/);
const um = seen.messages[1].content; assert.ok(Array.isArray(um) && um.some((x) => x.type === 'image_url' && x.image_url.url === PNG), 'image sent in the standard image_url format'); ok('Baseten vision reads a photo of a paper report and returns its text');
r = await call('POST', W + 'docphoto', { image: 'not an image' }, pt.token); assert.equal(r._s, 400); ok('a non-image upload is refused');
r = await call('POST', W + 'docphoto', { image: PNG }, mum.token); assert.equal(r._s, 403); ok('only the patient can send photos for reading');
model = () => ({ status: 400, body: '{"error":"image input is not supported for this model"}' });
r = await call('POST', W + 'docphoto', { image: PNG }, pt.token); assert.equal(r.ok, false); assert.equal(r.error, 'vision_unsupported'); ok('if the endpoint cannot take images the app is told, and falls back to reading on the phone');
model = () => chat('NO_TEXT'); r = await call('POST', W + 'docphoto', { image: PNG }, pt.token); assert.equal(r.error, 'no_text_found'); ok('a photo with no text is reported clearly');
forgetModel();

// ---- Baseten down: report still saved by the rule-based reader, nothing crashes
forgetModel(); model = () => ({ status: 402, body: '{"error":"payment required"}' });
r = await call('POST', W + 'docadd', { name: 'Second report', text: 'LAB REPORT\nDate: 2026-10-25\nPotassium 4.4 mmol/L (3.5-5.1)\nBlood pressure 138/88 mmHg\n' }, pt.token);
const d2 = (r.docs || []).find((d) => d.name === 'Second report'); assert.ok(d2); assert.equal(d2.extraction.mode, 'rules'); assert.ok(/no_credits|402/.test(d2.extraction.aiError || '') || d2.extraction.aiError); ok('if the AI is unreachable the report is still saved and read by the rule-based reader');

// ---- API connection
forgetModel(); model = () => chat('ok');
r = await call('POST', H + 'apikey', { label: 'EMR link', scopes: ['events:write', 'events:read', 'records:read'] }, pt.token); assert.ok(r.key && r.key.startsWith('ox_'));
const key = r.key;
r = await call('POST', '/api/v1/signals', { type: 'reading', sys: 124, dia: 80 }, key); assert.ok(r.ok, JSON.stringify(r));
r = await call('POST', '/api/v1/signals', { type: 'reading', sys: 186, dia: 112 }, key); assert.ok(r.ok && r.alert && r.alert.status === 'ringing', 'emergency from an API reading starts an alert');
r = await call('GET', '/api/v1/alert', null, key); assert.ok(r.ok && r.alert); ok('partner API: readings accepted, emergency reading starts the alert, alert can be read back');
r = await call('POST', '/api/v1/events', { type: 'fall', reason: 'Fall sensor' }, key); assert.equal(r._s, 202); assert.ok(r.eventId); ok('connect API accepts an event');
r = await call('GET', '/api/v1/records', null, key); assert.ok(r.ok); assert.ok(r.count >= 2); ok('connect API lists the facts Baseten extracted');
r = await call('GET', '/api/v1/records', null, 'ox_' + pt.pid + '_' + 'a'.repeat(24)); assert.equal(r._s, 401); ok('a wrong API key is refused');
r = await call('POST', H + 'bp', { sys: 120, dia: 80, date: '2026-10-31' }, key); assert.notEqual(r._s, 200); ok('an API key cannot act as the patient');

// ---- AI status page
r = await worker.fetch(new Request('https://t.test/api/ai/status?test=1'), env); const j = await r.json();
assert.equal(j.provider, 'Baseten (Meta Muse Spark Open)'); assert.equal(j.configuredModel, 'meta-models/muse-spark-open-1026'); assert.equal(j.test.ok, true); ok('AI status test reports Baseten live and working');

console.log('ALL END-TO-END TESTS PASSED (' + n + ')'); Date.now = realNow;

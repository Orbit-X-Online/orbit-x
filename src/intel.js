// Orbit Intelligence: pure, deterministic logic. No network, no AI, no storage.
// AI (src/ai.js) may propose extractions and wording; everything here decides what is accepted,
// calculates every number, finds conflicts, and checks every citation.

/* ------------------------------------------------------------------ units + analytes */
export function normUnit(u) {
  return String(u || '').toLowerCase().replace(/[µμ]/g, 'u').replace(/\s+/g, '').replace(/m²/g, 'm2').replace(/sqm/g, 'm2')
    .replace(/1\.73m2/, '1.73m2');
}
const f = (x) => (v) => v * x;
const same = (v) => v;
export const ANALYTES = {
  hba1c: { label: 'HbA1c', loinc: '4548-4', unit: '%', ucum: '%', aliases: ['hba1c', 'hb a1c', 'a1c', 'glycated hemoglobin', 'glycosylated hemoglobin', 'glycohemoglobin', 'glycated haemoglobin', 'hemoglobin a1c'], conv: { '%': same, 'mmol/mol': (v) => v * 0.09148 + 2.152 } },
  glucose_fasting: { label: 'Fasting glucose', loinc: '1558-6', unit: 'mg/dL', ucum: 'mg/dL', aliases: ['fasting glucose', 'fasting blood glucose', 'fasting blood sugar', 'fbg', 'fbs', 'glucose fasting', 'glucose (fasting)'], conv: { 'mg/dl': same, 'mmol/l': f(18.016) } },
  glucose: { label: 'Glucose', loinc: '2345-7', unit: 'mg/dL', ucum: 'mg/dL', aliases: ['glucose', 'blood glucose', 'random glucose', 'random blood sugar'], conv: { 'mg/dl': same, 'mmol/l': f(18.016) } },
  ldl: { label: 'LDL cholesterol', loinc: '13457-7', unit: 'mg/dL', ucum: 'mg/dL', aliases: ['ldl cholesterol', 'ldl-c', 'ldl'], conv: { 'mg/dl': same, 'mmol/l': f(38.67) } },
  hdl: { label: 'HDL cholesterol', loinc: '2085-9', unit: 'mg/dL', ucum: 'mg/dL', aliases: ['hdl cholesterol', 'hdl-c', 'hdl'], conv: { 'mg/dl': same, 'mmol/l': f(38.67) } },
  chol: { label: 'Total cholesterol', loinc: '2093-3', unit: 'mg/dL', ucum: 'mg/dL', aliases: ['total cholesterol', 'cholesterol total', 'cholesterol'], conv: { 'mg/dl': same, 'mmol/l': f(38.67) } },
  trig: { label: 'Triglycerides', loinc: '2571-8', unit: 'mg/dL', ucum: 'mg/dL', aliases: ['triglycerides', 'triglyceride', 'tg'], conv: { 'mg/dl': same, 'mmol/l': f(88.57) } },
  creatinine: { label: 'Creatinine', loinc: '2160-0', unit: 'mg/dL', ucum: 'mg/dL', aliases: ['creatinine', 'serum creatinine'], conv: { 'mg/dl': same, 'umol/l': (v) => v / 88.4 } },
  egfr: { label: 'eGFR', loinc: '62238-1', unit: 'mL/min/1.73m2', ucum: 'mL/min/{1.73_m2}', aliases: ['egfr', 'estimated gfr', 'gfr'], conv: { 'ml/min/1.73m2': same, 'ml/min': same } },
  potassium: { label: 'Potassium', loinc: '2823-3', unit: 'mmol/L', ucum: 'mmol/L', aliases: ['potassium', 'serum potassium', 'k+'], conv: { 'mmol/l': same, 'meq/l': same } },
  sodium: { label: 'Sodium', loinc: '2951-2', unit: 'mmol/L', ucum: 'mmol/L', aliases: ['sodium', 'serum sodium', 'na+'], conv: { 'mmol/l': same, 'meq/l': same } },
  hemoglobin: { label: 'Hemoglobin', loinc: '718-7', unit: 'g/dL', ucum: 'g/dL', aliases: ['hemoglobin', 'haemoglobin', 'hgb', 'hb'], conv: { 'g/dl': same, 'g/l': (v) => v / 10 } },
  sbp: { label: 'Systolic blood pressure', loinc: '8480-6', unit: 'mmHg', ucum: 'mm[Hg]', aliases: ['systolic blood pressure', 'systolic'], conv: { mmhg: same } },
  dbp: { label: 'Diastolic blood pressure', loinc: '8462-4', unit: 'mmHg', ucum: 'mm[Hg]', aliases: ['diastolic blood pressure', 'diastolic'], conv: { mmhg: same } },
  weight: { label: 'Body weight', loinc: '29463-7', unit: 'kg', ucum: 'kg', aliases: ['body weight', 'weight'], conv: { kg: same, lb: f(0.45359237), lbs: f(0.45359237) } },
};
const LOINC_TO_KEY = Object.fromEntries(Object.entries(ANALYTES).map(([k, a]) => [a.loinc, k]));
export function keyFromLoinc(code) { return LOINC_TO_KEY[String(code || '')] || null; }

export function normName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9+\-\/() ]/g, ' ').replace(/\s+/g, ' ').trim(); }

// Longest alias wins, whole-word match, so "fasting glucose" never becomes plain "glucose".
const ALIAS_LIST = Object.entries(ANALYTES).flatMap(([k, a]) => a.aliases.map((al) => [al, k])).sort((x, y) => y[0].length - x[0].length);
export function canonKey(name) {
  const n = ' ' + normName(name) + ' ';
  for (const [al, k] of ALIAS_LIST) if (n.includes(' ' + al + ' ') || n.includes(' ' + al + '(') || n.startsWith(' ' + al + ' ')) return k;
  return null;
}
export function convertToCanon(key, value, unit) {
  const a = ANALYTES[key]; if (!a || typeof value !== 'number' || !isFinite(value)) return null;
  const fn = a.conv[normUnit(unit)];
  if (!fn) return null;
  return { value: Math.round(fn(value) * 1000) / 1000, unit: a.unit };
}

/* ------------------------------------------------------------------ small helpers */
export function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }
export function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s; }
export function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
const squash = (s) => String(s || '').toLowerCase().replace(/[ \s]+/g, ' ').trim();
export function quoteInText(quote, text) { const q = squash(quote); return q.length >= 3 && squash(text).includes(q); }
function round(v, d = 2) { const p = Math.pow(10, d); return Math.round(v * p) / p; }
function numbersIn(s) { return (String(s).match(/\d+(?:[.,]\d+)?/g) || []).map((x) => x.replace(',', '.')); }
export function fmtNum(v) { return String(round(v, 3)); }

/* ------------------------------------------------------------------ extraction: schema validation */
export const KINDS = ['observation', 'medication', 'allergy', 'condition', 'encounter'];
export const DOC_TYPES = ['lab_report', 'discharge_summary', 'other'];

// Accepts what a model (or the rule parser) proposes and returns only facts that pass every check.
// A fact survives only if its quote really appears in the document and its number really appears in the quote.
export function validateExtraction(raw, text, docId) {
  const rejected = []; const facts = [];
  const doc = { docType: 'other', docDate: null, patientName: null, dob: null, facility: null, admissionDate: null, dischargeDate: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'not_an_object', doc, facts, rejected };
  const d = raw.document && typeof raw.document === 'object' ? raw.document : {};
  if (DOC_TYPES.includes(d.docType)) doc.docType = d.docType;
  for (const k of ['docDate', 'admissionDate', 'dischargeDate', 'dob']) if (isDate(d[k]) && text.includes(String(d[k]).slice(0, 4))) doc[k] = d[k];
  for (const k of ['patientName', 'facility']) if (typeof d[k] === 'string' && d[k].trim() && d[k].length <= 80 && squash(text).includes(squash(d[k]))) doc[k] = d[k].trim();
  if (!Array.isArray(raw.facts)) return { ok: false, error: 'facts_not_array', doc, facts, rejected };
  let n = 0;
  for (const x of raw.facts.slice(0, 80)) {
    const why = (r) => rejected.push({ name: x && x.name ? String(x.name).slice(0, 40) : '?', reason: r });
    if (!x || typeof x !== 'object') { why('not_object'); continue; }
    if (!KINDS.includes(x.kind)) { why('bad_kind'); continue; }
    const name = typeof x.name === 'string' ? x.name.trim() : '';
    if (!name || name.length > 80) { why('bad_name'); continue; }
    const quote = typeof x.quote === 'string' ? x.quote.trim() : '';
    if (quote.length < 3 || quote.length > 300) { why('bad_quote'); continue; }
    if (!quoteInText(quote, text)) { why('quote_not_in_document'); continue; }
    let value = null;
    if (x.value !== null && x.value !== undefined) {
      if (typeof x.value !== 'number' || !isFinite(x.value)) { why('bad_value'); continue; }
      value = x.value;
      const shown = numbersIn(quote).map(Number);
      if (!shown.includes(value) && !shown.includes(round(value, 1)) && !shown.includes(round(value, 2))) { why('value_not_in_quote'); continue; }
    }
    if (x.kind === 'observation' && value === null) { why('observation_needs_value'); continue; }
    const unit = typeof x.unit === 'string' && x.unit.trim() && x.unit.length <= 24 ? x.unit.trim() : null;
    if (unit && !squash(quote).includes(squash(unit).replace(/\s/g, '')) && !squash(quote).replace(/\s/g, '').includes(squash(unit).replace(/\s/g, ''))) { why('unit_not_in_quote'); continue; }
    const date = isDate(x.date) ? x.date : null;
    let conf = typeof x.confidence === 'number' && x.confidence >= 0 && x.confidence <= 1 ? x.confidence : 0.5;
    const fact = {
      id: 'f_' + docId + '_' + (++n), docId, kind: x.kind, name, value, unit, date,
      text: typeof x.text === 'string' ? x.text.slice(0, 200) : quote.slice(0, 200),
      refRange: typeof x.refRange === 'string' && x.refRange.length <= 40 ? x.refRange : null,
      flag: x.flag === 'H' || x.flag === 'L' ? x.flag : null,
      dose: typeof x.dose === 'string' && x.dose.length <= 80 ? x.dose : null,
      quote, confidence: conf,
    };
    finishFact(fact);
    facts.push(fact);
  }
  return { ok: true, doc, facts, rejected };
}

// Adds deterministic fields: canonical key, normalised value, review status.
export function finishFact(fact) {
  fact.canon = null; fact.nv = null; fact.nu = null;
  if (fact.kind === 'observation') {
    fact.canon = canonKey(fact.name);
    if (fact.canon) { const c = convertToCanon(fact.canon, fact.value, fact.unit); if (c) { fact.nv = c.value; fact.nu = c.unit; } else fact.canon = fact.canon + ''; }
    if (fact.canon && fact.nv === null) { fact.unitProblem = true; }
  }
  fact.status = fact.confidence < 0.6 ? 'low_confidence' : 'documented';
  return fact;
}

/* ------------------------------------------------------------------ extraction: deterministic rule parser */
const UNIT_RE = '(?:%|mg\\/dL|mmol\\/L|mmol\\/mol|[µμu]mol\\/L|g\\/dL|g\\/L|mEq\\/L|mL\\/min\\/1\\.73\\s?m(?:2|²)|mmHg|kg|lbs?)';
const ROW = new RegExp('^\\s*([A-Za-z][A-Za-z0-9 \\-\\(\\)\\/\\+\\.]{1,40}?)\\s*[:\\-]?\\s{1,}(\\d+(?:\\.\\d+)?)\\s*(' + UNIT_RE + ')\\s*(?:\\(?\\s*(?:ref(?:erence)?\\.?:?\\s*)?((?:\\d+(?:\\.\\d+)?\\s*-\\s*\\d+(?:\\.\\d+)?)|(?:[<>]=?\\s*\\d+(?:\\.\\d+)?))\\s*\\)?)?\\s*(?:\\(?(\\d{4}-\\d{2}-\\d{2})\\)?)?\\s*([HL])?\\s*$', 'i');
const ROW_COLS = new RegExp('^\\s*([A-Za-z][A-Za-z0-9 \\-\\(\\)\\/\\+\\.]{1,40}?)\\s{2,}(\\d+(?:\\.\\d+)?)\\s+(' + UNIT_RE + ')\\s*(?:((?:\\d+(?:\\.\\d+)?\\s*-\\s*\\d+(?:\\.\\d+)?)|(?:[<>]=?\\s*\\d+(?:\\.\\d+)?)))?\\s*([HL])?\\s*$', 'i');
const BP_RE = /^\s*(?:blood pressure(?: at discharge)?|bp)\s*[:\-]?\s*(\d{2,3})\s*\/\s*(\d{2,3})\s*mmHg\s*(?:\(?(\d{4}-\d{2}-\d{2})\)?)?\s*$/i;
const HEAD_RE = /^\s*(diagnos[ie]s|conditions?|problems?|allerg(?:y|ies)|(?:discharge |current )?medications?|medicines)\s*(?::\s*(.*))?$/i;
const DATE_LINES = [
  ['docDate', /^\s*(?:report date|document date|date of report|date issued|date)\s*[:\-]\s*(\d{4}-\d{2}-\d{2})/im],
  ['collected', /^\s*(?:collected|collection date|sample date)\s*[:\-]\s*(\d{4}-\d{2}-\d{2})/im],
  ['admissionDate', /^\s*admission date\s*[:\-]\s*(\d{4}-\d{2}-\d{2})/im],
  ['dischargeDate', /^\s*discharge date\s*[:\-]\s*(\d{4}-\d{2}-\d{2})/im],
  ['dob', /(?:dob|date of birth)\s*[:\-]\s*(\d{4}-\d{2}-\d{2})/i],
];
export function extractRules(text, docId) {
  const lines = String(text).split(/\r?\n/);
  const meta = { docType: 'other', docDate: null, collected: null, patientName: null, dob: null, facility: null, admissionDate: null, dischargeDate: null };
  const low = text.toLowerCase();
  if (/discharge summary/.test(low)) meta.docType = 'discharge_summary';
  else if (/laborator|lab report|diagnostics|pathology/.test(low)) meta.docType = 'lab_report';
  const pm = /patient\s*(?:name)?\s*[:\-]\s*([A-Za-z][A-Za-z .'\-]{1,60}?)(?:\s{2,}|\s+(?:dob|date of birth|sex|age)\b|$)/im.exec(text);
  if (pm) meta.patientName = pm[1].trim();
  const fm = /^(.{4,70}?)\s+(?:[—–-]{1,2}\s*)?(?:laboratory report|lab report|discharge summary)/im.exec(text);
  if (fm) meta.facility = fm[1].replace(/[—–-]+\s*$/, '').trim();
  for (const [k, re] of DATE_LINES) { const m = re.exec(text); if (m && isDate(m[1])) meta[k] = m[1]; }
  const effective = meta.collected || meta.docDate || null;
  const facts = []; let n = 0; let section = null;
  const add = (o) => { facts.push(finishFact({ id: 'f_' + docId + '_' + (++n), docId, value: null, unit: null, date: effective, text: o.quote, refRange: null, flag: null, dose: null, confidence: 0.92, ...o })); };
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim()) continue;
    const hm = HEAD_RE.exec(line);
    if (hm && !/^\s*[-•*]/.test(line)) {
      const h = hm[1].toLowerCase(); const rest = (hm[2] || '').trim();
      section = /allerg/.test(h) ? 'allergy' : /medic/.test(h) ? 'medication' : 'condition';
      if (rest) {
        for (const part of rest.split(/;|,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean)) addSection(section, part, add, effective);
        section = null;
      }
      continue;
    }
    const bm = BP_RE.exec(line);
    if (bm) {
      const dt = bm[3] && isDate(bm[3]) ? bm[3] : effective; const q = line.trim();
      add({ kind: 'observation', name: 'Systolic blood pressure', value: +bm[1], unit: 'mmHg', date: dt, quote: q, text: q });
      add({ kind: 'observation', name: 'Diastolic blood pressure', value: +bm[2], unit: 'mmHg', date: dt, quote: q, text: q });
      continue;
    }
    if (/^\s*[-•*]\s+/.test(line) && section) { addSection(section, line.replace(/^\s*[-•*]\s+/, '').trim(), add, effective); continue; }
    if (/^\s*[-•*]\s+/.test(line) && !section) continue;
    const mc = ROW_COLS.exec(line); const mr = mc ? null : ROW.exec(line);
    const m = mc ? [mc[0], mc[1], mc[2], mc[3], mc[4], null, mc[5]] : mr;
    if (m && !/^(date|patient|dob|report|collected|admission|discharge|page)\b/i.test(m[1])) {
      const dt = m[5] && isDate(m[5]) ? m[5] : effective;
      const flag = (m[6] || '').toUpperCase() || null;
      add({ kind: 'observation', name: m[1].trim(), value: +m[2], unit: m[3].replace(/μ/g, 'µ'), refRange: m[4] ? m[4].replace(/\s+/g, '') : null, flag: flag === 'H' || flag === 'L' ? flag : null, date: dt, quote: line.trim(), text: line.trim() });
      continue;
    }
    const rm = /^\s*(?:request form )?(?:medication|medicine)s?(?: on request form)?\s*[:\-]\s*(.+)$/i.exec(line);
    if (rm) { addSection('medication', rm[1].trim(), add, effective); continue; }
    if (!/^\s*[-•*]/.test(line) && !hm) section = null;
  }
  return { ok: true, doc: { ...meta, docDate: meta.docDate || meta.collected }, facts, rejected: [] };
}
function addSection(section, part, add, date) {
  if (!part || /^(none|nil|n\/a|nkda|no known)/i.test(part)) return;
  if (section === 'medication') {
    const m = /^([A-Za-z][A-Za-z\-]+(?: [A-Za-z\-]+)?)\s+(\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|ml|units?|iu)\b.*)$/i.exec(part);
    if (m) add({ kind: 'medication', name: m[1].trim(), dose: m[2].trim().slice(0, 80), quote: part, text: part });
    else add({ kind: 'medication', name: part.replace(/\s+\d.*$/, '').trim().slice(0, 60) || part.slice(0, 60), dose: null, quote: part, text: part, confidence: 0.7 });
  } else if (section === 'allergy') {
    add({ kind: 'allergy', name: part.replace(/\s*\(.*\)\s*$/, '').trim().slice(0, 60), quote: part, text: part, date: null });
  } else {
    add({ kind: 'condition', name: part.replace(/\s*\(.*\)\s*$/, '').trim().slice(0, 80), quote: part, text: part, date: null });
  }
}

/* ------------------------------------------------------------------ comparison (deterministic) */
export function refOutside(fact) {
  if (!fact.refRange || typeof fact.value !== 'number') return null;
  const r = fact.refRange.replace(/\s+/g, '');
  let m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(r);
  if (m) return fact.value < +m[1] ? 'below' : fact.value > +m[2] ? 'above' : 'within';
  m = /^<=?(\d+(?:\.\d+)?)$/.exec(r); if (m) return fact.value > +m[1] || (!r.includes('=') && fact.value === +m[1]) ? 'above' : 'within';
  m = /^>=?(\d+(?:\.\d+)?)$/.exec(r); if (m) return fact.value < +m[1] || (!r.includes('=') && fact.value === +m[1]) ? 'below' : 'within';
  return null;
}
function usable(fact) { return fact.kind === 'observation' && fact.canon && fact.nv !== null && fact.date && fact.status !== 'rejected'; }
export function seriesByKey(facts) {
  const out = {};
  for (const x of facts.filter(usable)) (out[x.canon] = out[x.canon] || []).push(x);
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return out;
}
export function compareFacts(facts) {
  const comps = []; const latest = [];
  const S = seriesByKey(facts);
  for (const key of Object.keys(S)) {
    const arr = S[key]; const a = ANALYTES[key];
    latest.push({ key, label: a.label, factId: arr[arr.length - 1].id });
    for (let i = 1; i < arr.length; i++) {
      const x = arr[i - 1], y = arr[i];
      if (x.date === y.date) continue; // same-day disagreement is a conflict, not a change
      const delta = round(y.nv - x.nv, 3); const pct = x.nv !== 0 ? round((delta / Math.abs(x.nv)) * 100, 1) : null;
      const ap = pct === null ? 0 : Math.abs(pct);
      comps.push({
        id: 'cmp_' + fnv(x.id + '>' + y.id), key, label: a.label, unit: a.unit, from: x.id, to: y.id,
        fromDate: x.date, toDate: y.date, days: daysBetween(x.date, y.date), fromValue: x.nv, toValue: y.nv, delta, pct,
        direction: delta === 0 ? 'same' : delta > 0 ? 'up' : 'down', magnitude: ap < 2 ? 'unchanged' : ap < 10 ? 'small' : 'notable',
        converted: x.nu !== x.unit || y.nu !== y.unit || normUnit(x.unit) !== normUnit(y.unit),
        toOutsideRef: refOutside(y), toFlag: y.flag,
      });
    }
  }
  return { comparisons: comps, latest };
}

/* ------------------------------------------------------------------ conflicts and inconsistencies */
function nameTokens(s) { return normName(s).split(' ').filter(Boolean).sort().join(' '); }
export function findConflicts(docs, facts, todayStr) {
  const out = []; const add = (type, severity, title, detail, evidence, docIds = []) => out.push({ id: 'c_' + fnv(type + evidence.join(',') + docIds.join(',')), type, severity, title, detail, evidence, docIds });
  // 1) same analyte, same date, different values (after unit conversion)
  const byKeyDate = {};
  for (const x of facts.filter(usable)) (byKeyDate[x.canon + '|' + x.date] = byKeyDate[x.canon + '|' + x.date] || []).push(x);
  for (const arr of Object.values(byKeyDate)) {
    for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i], b = arr[j];
      if (a.docId === b.docId && a.id === b.id) continue;
      const tol = Math.max(Math.abs(b.nv) * 0.02, 1e-6);
      if (Math.abs(a.nv - b.nv) > tol) {
        const L = ANALYTES[a.canon].label;
        add('value_conflict', 'high', L + ' differs between sources on ' + a.date,
          fmtNum(a.value) + ' ' + a.unit + ' (' + docLabel(docs, a.docId) + ') vs ' + fmtNum(b.value) + ' ' + b.unit + ' (' + docLabel(docs, b.docId) + '). Orbit did not choose one.', [a.id, b.id], [a.docId, b.docId]);
      }
    }
  }
  // 2) identity
  const withName = docs.filter((d) => d.meta && d.meta.patientName);
  for (let i = 1; i < withName.length; i++) {
    if (nameTokens(withName[i].meta.patientName) !== nameTokens(withName[0].meta.patientName))
      add('identity_mismatch', 'high', 'Patient name differs between documents', '"' + withName[0].meta.patientName + '" in ' + withName[0].name + ' vs "' + withName[i].meta.patientName + '" in ' + withName[i].name + '.', [], [withName[0].id, withName[i].id]);
  }
  const withDob = docs.filter((d) => d.meta && d.meta.dob);
  for (let i = 1; i < withDob.length; i++) {
    if (withDob[i].meta.dob !== withDob[0].meta.dob)
      add('identity_mismatch', 'high', 'Date of birth differs between documents', withDob[0].meta.dob + ' in ' + withDob[0].name + ' vs ' + withDob[i].meta.dob + ' in ' + withDob[i].name + '. This may be a typo in one document.', [], [withDob[0].id, withDob[i].id]);
  }
  // 3) dates inside a document
  for (const d of docs) {
    const m = d.meta || {};
    if (m.admissionDate && m.dischargeDate && m.dischargeDate < m.admissionDate)
      add('date_inconsistency', 'high', 'Discharge date is before admission date', d.name + ': admitted ' + m.admissionDate + ', discharged ' + m.dischargeDate + '.', [], [d.id]);
    if (m.docDate && todayStr && m.docDate > todayStr) add('date_inconsistency', 'medium', 'Document is dated in the future', d.name + ' is dated ' + m.docDate + '.', [], [d.id]);
    if (m.docDate) for (const x of facts.filter((x) => x.docId === d.id && x.date && x.date > m.docDate))
      add('date_inconsistency', 'medium', 'A result is dated after its own document', x.name + ' is dated ' + x.date + ' but ' + d.name + ' is dated ' + m.docDate + '.', [x.id], [d.id]);
  }
  // 4) medicines: same-date different dose is a conflict; across dates it is reported as a documented difference
  const meds = facts.filter((x) => x.kind === 'medication');
  const docsWithMeds = docs.filter((d) => meds.some((m) => m.docId === d.id)).sort((a, b) => ((a.meta && a.meta.docDate) || '').localeCompare((b.meta && b.meta.docDate) || ''));
  for (let i = 1; i < docsWithMeds.length; i++) {
    const A = docsWithMeds[i - 1], B = docsWithMeds[i];
    const ma = meds.filter((m) => m.docId === A.id), mb = meds.filter((m) => m.docId === B.id);
    const sameDay = A.meta && B.meta && A.meta.docDate && A.meta.docDate === B.meta.docDate;
    for (const y of mb) {
      const x = ma.find((m) => normName(m.name) === normName(y.name));
      if (!x) add('medication_difference', 'info', y.name + ' appears in ' + B.name + ' but not in ' + A.name, 'Listed in the later document only. This may be a new prescription or an omission. Orbit cannot tell which.', [y.id], [A.id, B.id]);
      else if (normName(x.dose) !== normName(y.dose)) add(sameDay ? 'value_conflict' : 'medication_difference', sameDay ? 'high' : 'info', y.name + ' dose is written differently', '"' + (x.dose || 'no dose') + '" in ' + A.name + ' vs "' + (y.dose || 'no dose') + '" in ' + B.name + '.' + (sameDay ? ' Same date, so this is a conflict.' : ' Different dates, so this may be an intended change.'), [x.id, y.id], [A.id, B.id]);
    }
    for (const x of ma) if (!mb.find((m) => normName(m.name) === normName(x.name))) add('medication_difference', 'info', x.name + ' is in ' + A.name + ' but not in ' + B.name, 'Listed in the earlier document only. It may have been stopped or simply not listed.', [x.id], [A.id, B.id]);
  }
  // 5) an allergen named exactly like a listed medicine
  for (const al of facts.filter((x) => x.kind === 'allergy'))
    for (const m of meds) if (normName(al.name) && normName(al.name) === normName(m.name)) add('allergy_medication_overlap', 'high', 'A listed medicine has the same name as a documented allergy', m.name + ' is listed as a medicine and "' + al.name + '" as an allergy.', [al.id, m.id], [al.docId, m.docId]);
  return out;
}
function docLabel(docs, id) { const d = docs.find((x) => x.id === id); return d ? d.name : id; }

/* ------------------------------------------------------------------ timeline */
export function buildTimeline(docs, facts) {
  const ev = [];
  for (const d of docs) {
    const m = d.meta || {};
    if (m.docDate) ev.push({ date: m.docDate, type: 'document', title: d.name, detail: (m.docType || '').replace('_', ' '), docId: d.id });
    if (m.admissionDate) ev.push({ date: m.admissionDate, type: 'encounter', title: 'Admission', detail: d.name, docId: d.id });
    if (m.dischargeDate) ev.push({ date: m.dischargeDate, type: 'encounter', title: 'Discharge', detail: d.name, docId: d.id });
  }
  for (const x of facts) {
    if (!x.date) continue;
    if (x.kind === 'observation') ev.push({ date: x.date, type: 'observation', title: x.name + ' ' + fmtNum(x.value) + ' ' + (x.unit || ''), detail: x.flag ? 'flagged ' + x.flag + ' in the source' : '', factId: x.id, docId: x.docId, source: x.source || null });
    else ev.push({ date: x.date, type: x.kind, title: x.name + (x.dose ? ' ' + x.dose : ''), detail: '', factId: x.id, docId: x.docId, source: x.source || null });
  }
  return ev.sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));
}

/* ------------------------------------------------------------------ evidence statements (what code can prove) */
export function describeComparison(c) {
  const dir = c.direction === 'same' ? 'was unchanged' : (c.direction === 'up' ? 'rose' : 'fell');
  let s = c.label + ' ' + dir + (c.direction === 'same' ? '' : ' from ' + fmtNum(c.fromValue) + ' to ' + fmtNum(c.toValue) + ' ' + c.unit + (c.pct !== null ? ' (' + (c.pct > 0 ? '+' : '') + fmtNum(c.pct) + '%)' : '')) + ' between ' + c.fromDate + ' and ' + c.toDate + ' (' + c.days + ' days).';
  if (c.converted) s += ' Units were converted to ' + c.unit + ' by Orbit.';
  return s;
}
export function evidenceStatements(state) {
  const { facts, comparisons, conflicts, latest } = state; const out = []; let i = 0;
  const E = (kind, text, cites) => out.push({ id: 'e' + (++i), kind, text, cites });
  for (const c of comparisons) E('documented', describeComparison(c), [c.from, c.to, c.id]);
  for (const k of conflicts.filter((x) => x.type !== 'medication_difference')) E('conflict', k.title + '. ' + k.detail, [...k.evidence, k.id]);
  for (const k of conflicts.filter((x) => x.type === 'medication_difference')) E('documented', k.title + '. ' + k.detail, [...k.evidence, k.id]);
  void latest; void facts;
  return out;
}
export function citeUniverse(state) {
  const set = new Set();
  for (const f2 of state.facts) set.add(f2.id);
  for (const c of state.comparisons) set.add(c.id);
  for (const k of state.conflicts) set.add(k.id);
  return set;
}

/* ------------------------------------------------------------------ AI output: validate before showing */
export const UNSAFE_ADVICE = /\b(you should|you must|you need to|stop taking|start taking|increase (?:the |your )?dose|decrease (?:the |your )?dose|double (?:the |your )?dose|skip (?:a |the |your )?dose|take \d|diagnos(?:e|is|ed|ing)|you have (?:a |an )?(?:disease|diabetes|kidney|condition)|is dangerous|is safe to|safe to take|prescrib|treatment plan|recommend(?:ed)? (?:that )?you)\b/i;
export function validateExplanation(raw, universe, allowedText) {
  const sections = []; const dropped = [];
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sections)) return { ok: false, error: 'bad_shape', sections, dropped };
  const allowedNums = new Set(numbersIn(allowedText).map((n) => String(Number(n))));
  for (const s of raw.sections.slice(0, 12)) {
    const bad = (r) => dropped.push({ reason: r, text: String(s && s.text || '').slice(0, 80) });
    if (!s || typeof s.text !== 'string' || !s.text.trim() || s.text.length > 500) { bad('bad_text'); continue; }
    const kind = ['documented', 'interpretation', 'conflict', 'unknown'].includes(s.kind) ? s.kind : null;
    if (!kind) { bad('bad_kind'); continue; }
    const cites = Array.isArray(s.cites) ? s.cites.filter((c) => typeof c === 'string') : [];
    if (cites.some((c) => !universe.has(c))) { bad('unknown_citation'); continue; }
    if (kind !== 'unknown' && cites.length === 0) { bad('missing_citation'); continue; }
    if (UNSAFE_ADVICE.test(s.text)) { bad('medical_advice_blocked'); continue; }
    const nums = numbersIn(s.text).map((n) => String(Number(n)));
    if (nums.some((n) => !allowedNums.has(n))) { bad('number_not_in_evidence'); continue; }
    sections.push({ kind, text: s.text.trim(), cites });
  }
  return { ok: sections.length > 0 && sections.length >= dropped.length, sections, dropped, error: sections.length ? null : 'nothing_valid' };
}

/* ------------------------------------------------------------------ Ask My Records: deterministic routing + retrieval */
export function routeQuestion(q) {
  const t = String(q || '').toLowerCase();
  if (/inconsisten|conflict|disagree|mismatch|contradict|differ/.test(t)) return 'conflicts';
  if (/medic|drug|tablet|pill|prescri/.test(t)) return 'medications';
  if (/allerg/.test(t)) return 'allergies';
  if (/summary|summar|brief|clinician|doctor|appointment/.test(t)) return 'brief';
  if (/changed|change|difference|compare|trend|since/.test(t)) return 'changes';
  if (/recent|latest|last|newest|current/.test(t)) return 'latest';
  return 'search';
}
export function answerQuestion(question, state) {
  const intent = routeQuestion(question); const { facts, comparisons, conflicts, docs } = state; const t = String(question).toLowerCase();
  const st = []; const E = (kind, text, cites) => st.push({ kind, text, cites });
  const D = (id) => (docs.find((d) => d.id === id) || {}).name || id;
  if (!facts.length) return { intent, statements: [{ kind: 'unknown', text: 'No documents have been analysed yet, so there is nothing to answer from.', cites: [] }] };
  if (intent === 'changes') {
    if (!comparisons.length) E('unknown', 'Orbit found no analyte that appears in two documents with different dates, so no change can be calculated yet.', []);
    for (const c of comparisons) E('documented', describeComparison(c), [c.from, c.to, c.id]);
    E('unknown', 'Orbit reports the size of each change. It does not decide whether a change matters clinically.', []);
  } else if (intent === 'latest') {
    const key = Object.keys(ANALYTES).find((k) => ANALYTES[k].aliases.some((al) => t.includes(al)) || t.includes(ANALYTES[k].label.toLowerCase()));
    const S = seriesByKey(facts);
    const keys = key ? [key] : Object.keys(S);
    for (const k of keys) { const arr = S[k]; if (!arr) { E('unknown', 'No documented ' + ANALYTES[k].label + ' result was found.', []); continue; } const x = arr[arr.length - 1]; E('documented', 'Most recent documented ' + ANALYTES[k].label + ': ' + fmtNum(x.value) + ' ' + x.unit + ' on ' + x.date + ' (' + D(x.docId) + ').', [x.id]); }
  } else if (intent === 'medications') {
    const withMeds = docs.filter((d) => facts.some((x) => x.kind === 'medication' && x.docId === d.id)).sort((a, b) => ((b.meta && b.meta.docDate) || '').localeCompare((a.meta && a.meta.docDate) || ''));
    const pick = /discharge/.test(t) ? withMeds.find((d) => d.meta && d.meta.docType === 'discharge_summary') || withMeds[0] : withMeds[0];
    if (!pick) E('unknown', 'No medicines are documented in the analysed documents.', []);
    else { E('documented', 'Medicines listed in ' + pick.name + (pick.meta && pick.meta.docDate ? ' (' + pick.meta.docDate + ')' : '') + ':', []); for (const m of facts.filter((x) => x.kind === 'medication' && x.docId === pick.id)) E('documented', m.name + (m.dose ? ' ' + m.dose : ' (no dose written)'), [m.id]); }
    for (const k of conflicts.filter((x) => x.type === 'medication_difference')) E('conflict', k.title + '. ' + k.detail, [...k.evidence, k.id]);
  } else if (intent === 'allergies') {
    const al = facts.filter((x) => x.kind === 'allergy');
    if (!al.length) E('unknown', 'No allergies are documented. That does not mean there are none.', []); else for (const x of al) E('documented', 'Documented allergy: ' + x.text + ' (' + D(x.docId) + ').', [x.id]);
  } else if (intent === 'conflicts') {
    if (!conflicts.length) E('documented', 'Orbit found no conflicts or inconsistencies in the documents it has read.', []);
    for (const k of conflicts) E(k.type === 'medication_difference' ? 'documented' : 'conflict', k.title + '. ' + k.detail, [...k.evidence, k.id]);
  } else if (intent === 'brief') {
    E('documented', 'Use the Appointment Brief tab for a shareable summary built from these records.', []);
  } else {
    const words = t.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !['the', 'what', 'was', 'were', 'and', 'for', 'are', 'any', 'does', 'did', 'about', 'with', 'from', 'have', 'has', 'show', 'tell', 'record', 'records'].includes(w));
    const hits = facts.filter((x) => words.some((w) => normName(x.name).includes(w) || normName(x.text).includes(w))).slice(0, 12);
    if (!hits.length) E('unknown', 'Nothing in the analysed documents matches that question.', []);
    for (const x of hits) E('documented', x.name + (x.value !== null ? ' ' + fmtNum(x.value) + ' ' + (x.unit || '') : x.dose ? ' ' + x.dose : '') + (x.date ? ' on ' + x.date : '') + ' (' + D(x.docId) + ').', [x.id]);
  }
  return { intent, statements: st };
}

/* ------------------------------------------------------------------ appointment brief */
export function buildBrief(state, patientName, todayStr) {
  const { facts, comparisons, conflicts, docs } = state; const D = (id) => (docs.find((d) => d.id === id) || {}).name || id;
  const L = []; const src = []; const S = (docId) => { let i = src.indexOf(docId); if (i < 0) { src.push(docId); i = src.length - 1; } return '[S' + (i + 1) + ']'; };
  L.push('APPOINTMENT BRIEF (draft prepared by Orbit-X from documents the patient provided)');
  L.push('Patient: ' + patientName + '   Prepared: ' + todayStr); L.push('');
  const meds = []; const lastMedDoc = docs.filter((d) => facts.some((x) => x.kind === 'medication' && x.docId === d.id)).sort((a, b) => ((b.meta && b.meta.docDate) || '').localeCompare((a.meta && a.meta.docDate) || ''))[0];
  if (lastMedDoc) for (const m of facts.filter((x) => x.kind === 'medication' && x.docId === lastMedDoc.id)) meds.push('- ' + m.name + (m.dose ? ' ' + m.dose : '') + ' ' + S(m.docId));
  L.push('MEDICINES LISTED IN THE MOST RECENT DOCUMENT THAT LISTS THEM' + (lastMedDoc ? ' (' + lastMedDoc.name + ')' : '')); L.push(meds.length ? meds.join('\n') : '- None documented'); L.push('');
  const al = facts.filter((x) => x.kind === 'allergy');
  L.push('DOCUMENTED ALLERGIES'); L.push(al.length ? al.map((x) => '- ' + x.text + ' ' + S(x.docId)).join('\n') : '- None documented (this does not mean there are none)'); L.push('');
  const cond = facts.filter((x) => x.kind === 'condition');
  L.push('DOCUMENTED DIAGNOSES'); L.push(cond.length ? cond.map((x) => '- ' + x.name + ' ' + S(x.docId)).join('\n') : '- None documented'); L.push('');
  L.push('MOST RECENT DOCUMENTED RESULTS');
  const Sx = seriesByKey(facts);
  const rows = Object.keys(Sx).map((k) => { const x = Sx[k][Sx[k].length - 1]; return '- ' + ANALYTES[k].label + ': ' + fmtNum(x.value) + ' ' + x.unit + ' on ' + x.date + (x.flag ? ' (flagged ' + x.flag + ' in source)' : '') + ' ' + S(x.docId); });
  L.push(rows.length ? rows.join('\n') : '- None'); L.push('');
  L.push('WHAT CHANGED BETWEEN DOCUMENTS (calculated by code)');
  L.push(comparisons.length ? comparisons.map((c) => '- ' + describeComparison(c) + ' ' + S(facts.find((x) => x.id === c.to).docId)).join('\n') : '- No comparable results yet'); L.push('');
  const open = conflicts.filter((c) => c.type !== 'medication_difference');
  L.push('THINGS TO CONFIRM WITH THE CLINICIAN (differences between my documents)');
  L.push(open.length ? open.map((c) => '- ' + c.title + '. ' + c.detail).join('\n') : '- No inconsistencies found'); L.push('');
  const md = conflicts.filter((c) => c.type === 'medication_difference'); if (md.length) { L.push('MEDICINE DIFFERENCES BETWEEN DOCUMENTS'); L.push(md.map((c) => '- ' + c.title + '. ' + c.detail).join('\n')); L.push(''); }
  L.push('MY QUESTIONS'); L.push('- (add your own questions here)'); L.push('');
  L.push('SOURCES'); L.push(src.length ? src.map((id, i) => '[S' + (i + 1) + '] ' + D(id)).join('\n') : '-'); L.push('');
  L.push('Orbit-X reads and compares documents. It does not diagnose, treat or advise. Values are as written in the source documents; Orbit converted units where noted.');
  return L.join('\n');
}

// FHIR R4 subset: structural validation, import to Orbit facts, and export bundles.
// This is NOT a full conformance validator. It checks the required elements and value sets of the
// resource types below, which is what Orbit Connect actually relies on.
import { ANALYTES, canonKey, keyFromLoinc, finishFact, convertToCanon, isDate, normName, fnv } from './intel.js';

export const SUPPORTED = ['Patient', 'Organization', 'Practitioner', 'Encounter', 'Observation', 'Condition', 'MedicationRequest', 'AllergyIntolerance', 'DiagnosticReport', 'DocumentReference', 'Provenance', 'Consent', 'AuditEvent'];
const VS = {
  obsStatus: ['registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error', 'unknown'],
  medStatus: ['active', 'on-hold', 'cancelled', 'completed', 'entered-in-error', 'stopped', 'draft', 'unknown'],
  medIntent: ['proposal', 'plan', 'order', 'original-order', 'reflex-order', 'filler-order', 'instance-order', 'option'],
  encStatus: ['planned', 'arrived', 'triaged', 'in-progress', 'onleave', 'finished', 'cancelled', 'entered-in-error', 'unknown'],
  drStatus: ['registered', 'partial', 'preliminary', 'final', 'amended', 'corrected', 'appended', 'cancelled', 'entered-in-error', 'unknown'],
  docStatus: ['current', 'superseded', 'entered-in-error'],
  consentStatus: ['draft', 'proposed', 'active', 'rejected', 'inactive', 'entered-in-error'],
  gender: ['male', 'female', 'other', 'unknown'],
};
const isStr = (x) => typeof x === 'string' && x.length > 0;
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const isDT = (s) => typeof s === 'string' && /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/.test(s);
const isRef = (r) => isObj(r) && isStr(r.reference);
const hasCode = (c) => isObj(c) && ((Array.isArray(c.coding) && c.coding.some((x) => isObj(x) && (isStr(x.code) || isStr(x.display)))) || isStr(c.text));

export function validateResource(r, path = 'resource') {
  const errors = [], warnings = [];
  const E = (p, m) => errors.push(path + '.' + p + ': ' + m);
  const W = (p, m) => warnings.push(path + '.' + p + ': ' + m);
  if (!isObj(r)) return { ok: false, errors: [path + ': must be a JSON object'], warnings };
  const t = r.resourceType;
  if (!isStr(t)) return { ok: false, errors: [path + '.resourceType: required'], warnings };
  if (!SUPPORTED.includes(t)) return { ok: false, errors: [path + '.resourceType: "' + t + '" is not supported by Orbit Connect (supported: ' + SUPPORTED.join(', ') + ')'], warnings };
  if (r.id !== undefined && !/^[A-Za-z0-9\-.]{1,64}$/.test(String(r.id))) E('id', 'must match [A-Za-z0-9\\-.]{1,64}');
  const subj = () => { if (!isRef(r.subject)) E('subject', 'required Reference with "reference"'); else if (!/^Patient\//.test(r.subject.reference) && !/^urn:/.test(r.subject.reference)) W('subject', 'expected Patient/<id>'); };
  switch (t) {
    case 'Patient':
      if (r.gender !== undefined && !VS.gender.includes(r.gender)) E('gender', 'must be one of ' + VS.gender.join('|'));
      if (r.birthDate !== undefined && !isDate(r.birthDate)) E('birthDate', 'must be YYYY-MM-DD');
      if (r.name !== undefined && (!Array.isArray(r.name) || !r.name.every(isObj))) E('name', 'must be an array of HumanName');
      break;
    case 'Organization': if (!isStr(r.name) && !(Array.isArray(r.identifier) && r.identifier.length)) E('name', 'name or identifier required by Orbit (R4 invariant org-1)'); break;
    case 'Practitioner': if (r.name !== undefined && !Array.isArray(r.name)) E('name', 'must be an array'); break;
    case 'Observation':
      if (!VS.obsStatus.includes(r.status)) E('status', 'required; one of ' + VS.obsStatus.join('|'));
      if (!hasCode(r.code)) E('code', 'required CodeableConcept');
      subj();
      if (r.effectiveDateTime !== undefined && !isDT(r.effectiveDateTime)) E('effectiveDateTime', 'invalid FHIR dateTime');
      if (r.valueQuantity !== undefined) { const q = r.valueQuantity; if (!isObj(q) || typeof q.value !== 'number' || !isFinite(q.value)) E('valueQuantity.value', 'must be a number'); else if (!isStr(q.unit) && !isStr(q.code)) E('valueQuantity', 'unit or code required'); }
      if (r.component !== undefined) {
        if (!Array.isArray(r.component)) E('component', 'must be an array');
        else r.component.forEach((c, i) => { if (!hasCode(c && c.code)) E('component[' + i + '].code', 'required'); if (c && c.valueQuantity !== undefined && (typeof c.valueQuantity.value !== 'number')) E('component[' + i + '].valueQuantity.value', 'must be a number'); });
      }
      if (r.valueQuantity === undefined && r.valueString === undefined && r.valueCodeableConcept === undefined && !r.component && !r.dataAbsentReason) W('value[x]', 'no value present (R4 invariant obs-6 requires dataAbsentReason)');
      break;
    case 'Condition': subj(); if (r.code !== undefined && !hasCode(r.code)) E('code', 'invalid CodeableConcept'); else if (r.code === undefined) E('code', 'required by Orbit'); break;
    case 'AllergyIntolerance': if (!isRef(r.patient)) E('patient', 'required Reference'); if (!hasCode(r.code)) E('code', 'required CodeableConcept'); break;
    case 'MedicationRequest':
      if (!VS.medStatus.includes(r.status)) E('status', 'required; one of ' + VS.medStatus.join('|'));
      if (!VS.medIntent.includes(r.intent)) E('intent', 'required; one of ' + VS.medIntent.join('|'));
      if (!r.medicationCodeableConcept && !r.medicationReference) E('medication[x]', 'medicationCodeableConcept or medicationReference required'); else if (r.medicationCodeableConcept && !hasCode(r.medicationCodeableConcept)) E('medicationCodeableConcept', 'invalid');
      subj();
      if (r.authoredOn !== undefined && !isDT(r.authoredOn)) E('authoredOn', 'invalid dateTime');
      break;
    case 'Encounter':
      if (!VS.encStatus.includes(r.status)) E('status', 'required; one of ' + VS.encStatus.join('|'));
      if (!isObj(r.class) || !isStr(r.class.code)) E('class', 'required Coding with code');
      if (r.period !== undefined) { if (r.period.start && !isDT(r.period.start)) E('period.start', 'invalid dateTime'); if (r.period.end && !isDT(r.period.end)) E('period.end', 'invalid dateTime'); if (r.period.start && r.period.end && r.period.end < r.period.start) E('period', 'end is before start (R4 invariant per-1)'); }
      break;
    case 'DiagnosticReport': if (!VS.drStatus.includes(r.status)) E('status', 'required; one of ' + VS.drStatus.join('|')); if (!hasCode(r.code)) E('code', 'required CodeableConcept'); break;
    case 'DocumentReference':
      if (!VS.docStatus.includes(r.status)) E('status', 'required; one of ' + VS.docStatus.join('|'));
      if (!Array.isArray(r.content) || !r.content.length || !r.content.every((c) => isObj(c) && isObj(c.attachment))) E('content', 'required: at least one { attachment }');
      break;
    case 'Provenance':
      if (!Array.isArray(r.target) || !r.target.length || !r.target.every(isRef)) E('target', 'required: at least one Reference');
      if (!isStr(r.recorded)) E('recorded', 'required instant');
      if (!Array.isArray(r.agent) || !r.agent.length) E('agent', 'required: at least one agent');
      break;
    case 'Consent':
      if (!VS.consentStatus.includes(r.status)) E('status', 'required; one of ' + VS.consentStatus.join('|'));
      if (!isObj(r.scope)) E('scope', 'required CodeableConcept'); if (!Array.isArray(r.category) || !r.category.length) E('category', 'required');
      break;
    case 'AuditEvent': if (!isObj(r.type)) E('type', 'required Coding'); if (!isStr(r.recorded)) E('recorded', 'required instant'); if (!Array.isArray(r.agent) || !r.agent.length) E('agent', 'required'); if (!isObj(r.source)) E('source', 'required'); break;
    default: break;
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function validateBundle(b) {
  if (!isObj(b) || b.resourceType !== 'Bundle') return { ok: false, errors: ['body must be a FHIR Bundle (resourceType "Bundle") or a single supported resource'], warnings: [], entries: [] };
  if (!['collection', 'transaction', 'batch', 'document'].includes(b.type)) return { ok: false, errors: ['Bundle.type: required; one of collection|transaction|batch|document'], warnings: [], entries: [] };
  if (!Array.isArray(b.entry) || !b.entry.length) return { ok: false, errors: ['Bundle.entry: at least one entry required'], warnings: [], entries: [] };
  if (b.entry.length > 100) return { ok: false, errors: ['Bundle.entry: at most 100 entries per request'], warnings: [], entries: [] };
  const entries = b.entry.map((e, i) => ({ index: i, resource: e && e.resource, ...validateResource(e && e.resource, 'entry[' + i + '].resource') }));
  return { ok: entries.every((e) => e.ok), errors: entries.flatMap((e) => e.errors), warnings: entries.flatMap((e) => e.warnings), entries };
}

/* ------------------------------------------------------------------ import: FHIR resource -> Orbit fact(s) */
const cc = (c) => { if (!c) return { text: '', code: null, system: null }; const x = (c.coding || [])[0] || {}; return { text: c.text || x.display || x.code || '', code: x.code || null, system: x.system || null }; };
const d10 = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);

export function resourceToFacts(r, ctx) {
  const out = []; const base = { docId: ctx.sysId, confidence: 1, source: { type: 'connector', system: ctx.system, importedAt: ctx.importedAt, resourceType: r.resourceType, resourceId: r.id || null, simulated: !!ctx.simulated } };
  const mk = (o) => { const f = finishFact({ value: null, unit: null, date: null, text: '', refRange: null, flag: null, dose: null, quote: '', ...base, ...o }); f.hash = fnv(JSON.stringify([f.kind, f.canon || normName(f.name), f.date, f.value, normName(f.unit), normName(f.dose)])); return f; };
  const obsOne = (code, q, date, extra = {}) => {
    const c = cc(code); const keyL = c.system && /loinc/i.test(c.system) ? keyFromLoinc(c.code) : null; const key = keyL || canonKey(c.text);
    const name = (key && ANALYTES[key].label) || c.text || 'Observation';
    const unit = q.unit || q.code || null;
    const o = mk({ kind: 'observation', name, value: q.value, unit, date, text: name + ' ' + q.value + ' ' + (unit || ''), quote: 'FHIR Observation' + (r.id ? '/' + r.id : ''), ...extra });
    if (keyL && !o.canon) { o.canon = keyL; const cv = convertToCanon(keyL, q.value, unit); if (cv) { o.nv = cv.value; o.nu = cv.unit; } }
    if (r.interpretation && r.interpretation[0]) { const ic = cc(r.interpretation[0]).code; if (ic === 'H' || ic === 'L') o.flag = ic; }
    if (Array.isArray(r.referenceRange) && r.referenceRange[0] && r.referenceRange[0].low && r.referenceRange[0].high) o.refRange = r.referenceRange[0].low.value + '-' + r.referenceRange[0].high.value;
    o.hash = fnv(JSON.stringify([o.kind, o.canon || normName(o.name), o.date, o.value, normName(o.unit)]));
    return o;
  };
  switch (r.resourceType) {
    case 'Observation': {
      const date = d10(r.effectiveDateTime) || d10(r.issued);
      if (r.valueQuantity) out.push(obsOne(r.code, r.valueQuantity, date));
      if (Array.isArray(r.component)) for (const c of r.component) if (c.valueQuantity) out.push(obsOne(c.code, c.valueQuantity, date));
      break;
    }
    case 'Condition': out.push(mk({ kind: 'condition', name: cc(r.code).text || 'Condition', date: d10(r.onsetDateTime) || d10(r.recordedDate), text: cc(r.code).text, quote: 'FHIR Condition' + (r.id ? '/' + r.id : '') })); break;
    case 'AllergyIntolerance': out.push(mk({ kind: 'allergy', name: cc(r.code).text || 'Allergy', date: d10(r.recordedDate), text: cc(r.code).text, quote: 'FHIR AllergyIntolerance' + (r.id ? '/' + r.id : '') })); break;
    case 'MedicationRequest': {
      const di = Array.isArray(r.dosageInstruction) && r.dosageInstruction[0] ? r.dosageInstruction[0].text || null : null;
      out.push(mk({ kind: 'medication', name: cc(r.medicationCodeableConcept).text || 'Medication', dose: di, date: d10(r.authoredOn), text: cc(r.medicationCodeableConcept).text + (di ? ' ' + di : ''), quote: 'FHIR MedicationRequest' + (r.id ? '/' + r.id : '') }));
      break;
    }
    case 'Encounter': out.push(mk({ kind: 'encounter', name: 'Encounter (' + ((r.class && r.class.code) || 'unknown class') + ')', date: d10(r.period && r.period.start), text: 'Encounter ' + (d10(r.period && r.period.start) || '') + (r.period && r.period.end ? ' to ' + d10(r.period.end) : ''), quote: 'FHIR Encounter' + (r.id ? '/' + r.id : '') })); break;
    default: break; // Patient, Organization, Practitioner, DiagnosticReport, DocumentReference, Provenance, Consent, AuditEvent are validated and logged but carry no Orbit fact
  }
  return out;
}

/* ------------------------------------------------------------------ export: Orbit facts -> FHIR Bundle (collection) with Provenance */
export function factsToBundle(patient, facts, opts) {
  const now = opts.now; const entries = []; const pref = 'Patient/' + patient.id;
  entries.push({ fullUrl: 'urn:uuid:' + patient.id, resource: { resourceType: 'Patient', id: patient.id, name: [{ text: patient.name }], ...(patient.dob ? { birthDate: patient.dob } : {}) } });
  const prov = [];
  for (const f of facts) {
    const id = 'o' + f.id.replace(/[^a-z0-9]/gi, '').slice(0, 30); let res = null;
    if (f.kind === 'observation') {
      const a = f.canon ? ANALYTES[f.canon] : null;
      res = { resourceType: 'Observation', id, status: 'final', code: a ? { coding: [{ system: 'http://loinc.org', code: a.loinc, display: a.label }], text: a.label } : { text: f.name }, subject: { reference: pref },
        ...(f.date ? { effectiveDateTime: f.date } : {}), valueQuantity: a && f.nv !== null ? { value: f.nv, unit: a.unit, system: 'http://unitsofmeasure.org', code: a.ucum } : { value: f.value, unit: f.unit || '1' } };
    } else if (f.kind === 'medication') res = { resourceType: 'MedicationRequest', id, status: 'active', intent: 'order', medicationCodeableConcept: { text: f.name }, subject: { reference: pref }, ...(f.dose ? { dosageInstruction: [{ text: f.dose }] } : {}), ...(f.date ? { authoredOn: f.date } : {}) };
    else if (f.kind === 'condition') res = { resourceType: 'Condition', id, subject: { reference: pref }, code: { text: f.name }, clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] } };
    else if (f.kind === 'allergy') res = { resourceType: 'AllergyIntolerance', id, patient: { reference: pref }, code: { text: f.name } };
    if (!res) continue;
    entries.push({ fullUrl: 'urn:uuid:' + id, resource: res });
    prov.push({ resourceType: 'Provenance', id: 'p' + id, target: [{ reference: res.resourceType + '/' + id }], recorded: now, agent: [{ who: { display: 'Orbit-X (assembled from patient-provided records)' } }],
      entity: [{ role: 'source', what: { display: (f.source && f.source.type === 'connector' ? 'Connector: ' + (f.source.system || '') : 'Document: ' + (f.docName || f.docId)) } }] });
  }
  for (const p of prov) entries.push({ fullUrl: 'urn:uuid:' + p.id, resource: p });
  return { resourceType: 'Bundle', type: 'collection', timestamp: now, entry: entries };
}

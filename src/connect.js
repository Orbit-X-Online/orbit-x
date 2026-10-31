// Orbit Connect + Orbit Intelligence: server actions that run inside one household's Durable Object.
// Every household is its own tenant: nothing here can read another household's storage.
import { ANALYTES, normName, compareFacts, findConflicts, buildTimeline, evidenceStatements, citeUniverse, answerQuestion, buildBrief, extractRules, finishFact, convertToCanon, daysBetween, isDate, fnv, fmtNum, quoteInText } from './intel.js';
import { validateBundle, validateResource, resourceToFacts, factsToBundle } from './fhir.js';
import { extractWithAI, explainWithAI, suggestMappings, explainDocWithAI, readPhotoWithAI, aiMode, providerName } from './ai.js';

export const WORKSPACE_ACTIONS = new Set(['wstate', 'docadd', 'docdel', 'docget', 'ask', 'brief', 'briefshare', 'briefrevoke', 'decide', 'suggest', 'mapconfirm', 'consent', 'auditlog', 'wipe', 'briefpublic', 'docexplain', 'docretry', 'docphoto']);
export const V1_ACTIONS = new Set(['v1records', 'v1validate', 'v1connectors', 'v1events', 'v1handoffcreate', 'v1handoffget', 'v1handoffreceive', 'v1handoffack', 'v1verify', 'v1audit']);
export const SCOPES = ['records:write', 'records:read', 'events:write', 'events:read', 'handoff:create', 'handoff:receive', 'audit:read'];
export const LEGACY_SCOPES = ['events:write', 'events:read'];

/* ------------------------------------------------------------------ crypto helpers */
const ALPH = '23456789abcdefghjkmnpqrstuvwxyz';
export function rand(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); let s = ''; for (const x of b) s += ALPH[x % ALPH.length]; return s; }
export async function sha(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
export async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return [...new Uint8Array(s)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export async function signHead(env, pid, id, head) { return env && env.RECEIPT_SECRET ? hmac(env.RECEIPT_SECRET, 'orbit-x|' + pid + '|' + id + '|' + head) : null; }

// Receipt chain. h = sha(prev | t | kind | d), where d = sha(secretSalt | privateText). Public receipts show kind, time, d and h only,
// so nobody can read the private text, and anybody can recompute the chain.
export async function chainGenesis(pid, id) { return sha('orbit-x|' + pid + '|' + id); }
export async function chainAppend(rec, pid, id, k, text, t) {
  rec.salt = rec.salt || rand(16); rec.entries = rec.entries || [];
  const prev = rec.entries.length ? rec.entries[rec.entries.length - 1].h : await chainGenesis(pid, id);
  const d = await sha(rec.salt + '|' + text);
  const e = { t, k, d, h: await sha(prev + '|' + t + '|' + k + '|' + d), text };
  rec.entries.push(e); rec.head = e.h; return e;
}
export async function chainVerify(pid, id, entries, head) {
  let prev = await chainGenesis(pid, id);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]; const h = await sha(prev + '|' + e.t + '|' + e.k + '|' + e.d);
    if (h !== e.h) return { ok: false, badIndex: i };
    prev = h;
  }
  if (head && head !== prev) return { ok: false, badIndex: entries.length - 1 };
  return { ok: true, badIndex: -1 };
}
export const KIND_LABEL = { trigger: 'Alert started', called: 'Caregiver notified', answered: 'Caregiver answered', escalated: 'Escalated to the next person', handled: 'Marked as handled', cancelled: 'Cancelled by the patient', unanswered: 'No one answered', rule: 'A rule matched', other: 'Other event',
  accepted: 'Event accepted', generated: 'Handoff generated', sent: 'Handoff sent (simulated delivery)', received: 'Handoff received', acknowledged: 'Handoff acknowledged' };
export function kindOf(text) {
  const t = String(text || '');
  if (/^Rule matched/i.test(t)) return 'rule';
  if (/cancel/i.test(t)) return 'cancelled';
  if (/marked handled/i.test(t)) return 'handled';
  if (/answered$/i.test(t.trim()) || /\banswered\b/i.test(t) && !/No answer|No one/i.test(t)) return 'answered';
  if (/No one answered|Call 112|unanswered/i.test(t)) return 'unanswered';
  if (/No answer|declined|alerted$/i.test(t)) return 'escalated';
  if (/is being called|being called/i.test(t)) return 'called';
  if (/Help requested|Reading|Symptoms reported|Emergency rule fired|Fall|Reported:/i.test(t)) return 'trigger';
  return 'other';
}

/* ------------------------------------------------------------------ small utilities */
const J = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const clean = (s, max = 80) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const dateOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const nameTok = (s) => normName(s).split(' ').filter(Boolean).sort().join(' ');
export function factHash(f) { return fnv(JSON.stringify([f.kind, f.canon || normName(f.name), f.date || null, f.value === undefined ? null : f.value, normName(f.unit), normName(f.dose)])); }

/* ------------------------------------------------------------------ storage access */
async function load(ctx) {
  const s = ctx.storage;
  const [docs, facts, intel, imports, audit, handoffs, events, tokens] = await Promise.all(['docs', 'facts', 'intel', 'imports', 'audit', 'handoffs', 'events', 'tokens'].map((k) => s.get(k)));
  return { docs: docs || [], facts: facts || [], intel: intel || { nextDoc: 1, decisions: {}, brief: null, bshares: [] }, imports: imports || [], audit: audit || [], handoffs: handoffs || [], events: events || [], tokens: tokens || [] };
}
async function save(ctx, D, keys) { for (const k of keys) await ctx.storage.put(k, D[k]); }
async function logAudit(ctx, D, actor, action, outcome, detail) {
  D.audit.push({ t: ctx.now, actor, action, outcome, detail: clean(detail, 140) });
  if (D.audit.length > 300) D.audit = D.audit.slice(-300);
  await ctx.storage.put('audit', D.audit);
}
const actorOf = (who) => who.role === 'patient' ? 'patient' : who.role === 'api' ? 'api:' + clean(who.label || who.id, 30) : who.role;

function computeState(D, ctx) {
  const docs = D.docs; const facts = D.facts;
  const { comparisons, latest } = compareFacts(facts);
  const conflicts = findConflicts(docs, facts, dateOf(ctx.now)).map((c) => ({ ...c, decision: D.intel.decisions[c.id] || null }));
  return { docs, facts, comparisons, latest, conflicts };
}
function refsFor(ids, st) {
  const refs = {}; const dn = (id) => (st.docs.find((d) => d.id === id) || {}).name || id;
  for (const id of ids) {
    const f = st.facts.find((x) => x.id === id);
    if (f) { refs[id] = { type: 'fact', label: f.name + (f.value !== null && f.value !== undefined ? ' ' + fmtNum(f.value) + ' ' + (f.unit || '') : f.dose ? ' ' + f.dose : ''), date: f.date, docId: f.docId, docName: dn(f.docId), quote: f.quote, status: f.status, extractor: f.source && f.source.extractor, sourceType: f.source && f.source.type, simulated: !!(f.source && f.source.simulated) }; continue; }
    const c = st.comparisons.find((x) => x.id === id); if (c) { refs[id] = { type: 'comparison', label: c.label + ' change (calculated by code)', from: c.from, to: c.to }; continue; }
    const k = st.conflicts.find((x) => x.id === id); if (k) refs[id] = { type: 'conflict', label: k.title };
  }
  return refs;
}
function publicFact(f, docs) {
  const d = docs.find((x) => x.id === f.docId);
  return { id: f.id, docId: f.docId, docName: d ? d.name : f.docId, kind: f.kind, name: f.name, canon: f.canon, value: f.value, unit: f.unit, nv: f.nv, nu: f.nu, date: f.date, refRange: f.refRange, flag: f.flag, dose: f.dose, quote: f.quote, confidence: f.confidence, status: f.status, source: f.source || null, corroboratedBy: f.corroboratedBy || [], mapping: f.mapping || null };
}
function wstateView(D, ctx) {
  const st = computeState(D, ctx); const h = ctx.h;
  return {
    ok: true, now: ctx.now, patient: h.name, signed: Boolean(ctx.env.RECEIPT_SECRET),
    ai: { mode: aiMode(ctx.env), provider: aiMode(ctx.env) === 'mock' ? 'mock' : providerName(ctx.env), model: ctx.env.MODEL_TEXT && ctx.env.MODEL_TEXT !== 'auto' ? ctx.env.MODEL_TEXT : (aiMode(ctx.env) === 'live' ? 'auto (Muse Spark Open)' : null) },
    docs: D.docs.map((d) => ({ id: d.id, name: d.name, kind: d.kind, meta: d.meta, uploadedAt: d.uploadedAt, size: d.size, extraction: d.extraction, factCount: D.facts.filter((f) => f.docId === d.id).length })),
    facts: D.facts.map((f) => publicFact(f, D.docs)), comparisons: st.comparisons, conflicts: st.conflicts, latest: st.latest,
    timeline: buildTimeline(D.docs, D.facts).map((e) => ({ ...e, docName: (D.docs.find((d) => d.id === e.docId) || {}).name })),
    brief: D.intel.brief, bshares: (D.intel.bshares || []).filter((s) => s.exp > ctx.now && !s.revoked).map((s) => ({ id: s.id, exp: s.exp, created: s.created })),
    consent: ctx.h.consent || defaultConsent(), imports: D.imports.slice(-20).reverse(), handoffs: D.handoffs.slice(-10).reverse().map((x) => handoffPublic(x, true)), events: D.events.slice(-10).reverse(),
  };
}
export function defaultConsent() { return { emergencyHandoff: false, categories: { allergies: true, medications: true, conditions: true, readings: true }, updatedAt: null }; }

/* ------------------------------------------------------------------ documents (Experience 1) */
async function extractDoc(ctx, text, docId) {
  const rules = extractRules(text, docId);
  const info = { mode: 'rules', model: null, ms: 0, aiError: null, accepted: 0, rejected: [], supplemented: 0 };
  if (aiMode(ctx.env) !== 'off') {
    const ai = await extractWithAI(ctx.env, text, docId);
    if (ai.ok) {
      const facts = ai.result.facts; let doc = ai.result.doc;
      for (const k of Object.keys(rules.doc)) if (!doc[k] && rules.doc[k]) doc[k] = rules.doc[k];
      // keep code-found results the model missed, clearly marked
      let n = 0;
      for (const rf of rules.facts) if (!facts.some((x) => x.kind === rf.kind && normName(x.name) === normName(rf.name) && x.value === rf.value && (x.dose || null) === (rf.dose || null))) { n++; facts.push({ ...rf, id: 'f_' + docId + '_r' + n, source: { extractor: 'rules' } }); }
      for (const f of facts) if (!f.source) f.source = { extractor: ai.mode === 'mock' ? 'mock' : 'meta-spark' };
      info.mode = ai.mode === 'mock' ? 'mock' : 'meta-spark'; info.model = ai.model; info.ms = ai.ms; info.rejected = ai.result.rejected || []; info.supplemented = n;
      return { doc, facts, info };
    }
    info.aiError = ai.error + (ai.detail ? ' (' + ai.detail + ')' : ''); info.ms = ai.ms || 0; info.model = ai.model || null; info.rejected = ai.rejected || [];
  }
  for (const f of rules.facts) f.source = { extractor: 'rules' };
  return { doc: rules.doc, facts: rules.facts, info };
}
async function docadd(ctx, D) {
  const name = clean(ctx.body.name, 80) || 'Untitled document';
  const text = String(ctx.body.text || '').replace(/\r\n/g, '\n').slice(0, 40000);
  if (text.trim().length < 20) return J({ ok: false, error: 'text_too_short' }, 400);
  if (D.docs.filter((d) => d.kind !== 'connector').length >= 8) return J({ ok: false, error: 'too_many_documents' }, 409);
  const hash = await sha(text);
  if (D.docs.some((d) => d.hash === hash)) return J({ ok: false, error: 'duplicate_document' }, 409);
  const id = 'd' + (D.intel.nextDoc++);
  const ex = await extractDoc(ctx, text, id);
  const meta = ex.doc; ex.info.accepted = ex.facts.length;
  for (const f of ex.facts) { f.source = { type: 'document', docId: id, docName: name, ...f.source }; f.hash = factHash(f); }
  D.docs.push({ id, name, kind: 'document', meta, uploadedAt: ctx.now, size: text.length, hash, extraction: ex.info });
  D.facts.push(...ex.facts);
  await ctx.storage.put('doc:' + id, text);
  await logAudit(ctx, D, actorOf(ctx.who), 'document.add', 'ok', name + ' via ' + ex.info.mode + ' (' + ex.facts.length + ' facts)');
  await save(ctx, D, ['docs', 'facts', 'intel']);
  return J(wstateView(D, ctx));
}
async function docdel(ctx, D) {
  const id = String(ctx.body.id || ''); const d = D.docs.find((x) => x.id === id);
  if (!d) return J({ ok: false, error: 'not_found' }, 404);
  D.docs = D.docs.filter((x) => x.id !== id); D.facts = D.facts.filter((f) => f.docId !== id);
  for (const f of D.facts) if (f.corroboratedBy) f.corroboratedBy = f.corroboratedBy.filter((c) => c.docId !== id);
  await ctx.storage.delete('doc:' + id);
  await logAudit(ctx, D, 'patient', 'document.delete', 'ok', d.name); await save(ctx, D, ['docs', 'facts']);
  return J(wstateView(D, ctx));
}

// Plain-language help for one document: what each term is, in everyday words, plus questions to ask a clinician.
async function docexplain(ctx, D) {
  const id = String(ctx.body.id || ''); const d = D.docs.find((x) => x.id === id);
  if (!d) return J({ ok: false, error: 'not_found' }, 404);
  const facts = D.facts.filter((f) => f.docId === id);
  const ex = await explainDocWithAI(ctx.env, d, facts);
  const items = facts.slice(0, 40).map((f) => ({ id: f.id, name: f.name, value: f.value, unit: f.unit, dose: f.dose, flag: f.flag, refRange: f.refRange, date: f.date, quote: f.quote }));
  await logAudit(ctx, D, 'patient', 'document.explain', 'ok', d.name + ' [' + ex.mode + ']');
  return J({ ok: true, id, name: d.name, mode: ex.mode, model: ex.model, aiError: ex.aiError || null, summary: ex.summary, terms: ex.terms, questions: ex.questions, items });
}
// Photo of a paper report: the AI copies the words, the person checks them, and only then are they analysed.
async function docphoto(ctx, D) {
  const img = String(ctx.body.image || '');
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(img) || img.length < 200) return J({ ok: false, error: 'bad_image' }, 400);
  if (img.length > 1600000) return J({ ok: false, error: 'image_too_large' }, 413);
  const r = await readPhotoWithAI(ctx.env, img);
  await logAudit(ctx, D, 'patient', 'document.photo', r.ok ? 'ok' : 'failed', r.ok ? 'read by ' + (r.model || 'AI') + ' (' + r.text.length + ' characters)' : r.error);
  if (!r.ok) return J({ ok: false, error: r.error, detail: r.detail || null }, r.error === 'bad_image' ? 400 : 200);
  return J({ ok: true, text: r.text, model: r.model, ms: r.ms, unclear: r.unclear });
}
// Run the AI reading again for a document that fell back to the rule-based parser.
async function docretry(ctx, D) {
  const id = String(ctx.body.id || ''); const d = D.docs.find((x) => x.id === id);
  if (!d || d.kind === 'connector') return J({ ok: false, error: 'not_found' }, 404);
  const text = await ctx.storage.get('doc:' + id); if (!text) return J({ ok: false, error: 'no_source_text' }, 409);
  const ex = await extractDoc(ctx, text, id); ex.info.accepted = ex.facts.length;
  if (ex.info.aiError && D.facts.some((f) => f.docId === id) && ex.facts.length < D.facts.filter((f) => f.docId === id).length) return J({ ok: false, error: 'ai_still_unavailable', detail: ex.info.aiError }, 502);
  for (const f of ex.facts) { f.source = { type: 'document', docId: id, docName: d.name, ...f.source }; f.hash = factHash(f); }
  D.facts = D.facts.filter((f) => f.docId !== id).concat(ex.facts); d.meta = ex.doc; d.extraction = ex.info;
  await logAudit(ctx, D, 'patient', 'document.retry', ex.info.aiError ? 'fallback' : 'ok', d.name + ' via ' + ex.info.mode + ' (' + ex.facts.length + ' facts)');
  await save(ctx, D, ['docs', 'facts']);
  return J(wstateView(D, ctx));
}
async function docget(ctx, D) {
  const id = new URL(ctx.req.url).searchParams.get('id') || '';
  const d = D.docs.find((x) => x.id === id); if (!d) return J({ ok: false, error: 'not_found' }, 404);
  if (d.kind === 'connector') return J({ ok: true, id, name: d.name, kind: 'connector', text: null, note: 'Imported through Orbit Connect. The source is the original FHIR resource, shown in each fact.' });
  return J({ ok: true, id, name: d.name, kind: d.kind, text: await ctx.storage.get('doc:' + id) });
}

/* ------------------------------------------------------------------ ask, brief, review */
async function ask(ctx, D) {
  const q = clean(ctx.body.q, 300); if (q.length < 3) return J({ ok: false, error: 'question_required' }, 400);
  const st = computeState(D, ctx); const ans = answerQuestion(q, st);
  const universe = citeUniverse(st);
  const allowed = ans.statements.map((s) => s.text).join(' ') + ' ' + evidenceStatements(st).map((s) => s.text).join(' ') + ' ' + st.facts.map((f) => [f.value, f.date, f.nv].join(' ')).join(' ');
  let explanation = null, ai = { mode: aiMode(ctx.env), used: false };
  const worth = ans.statements.some((s) => s.kind !== 'unknown');
  if (worth && aiMode(ctx.env) !== 'off') {
    const ex = await explainWithAI(ctx.env, q, ans.statements, universe, allowed);
    ai = { mode: ex.mode || aiMode(ctx.env), used: !!ex.ok, model: ex.model || null, ms: ex.ms || 0, error: ex.ok ? null : ex.error, dropped: ex.dropped || [] };
    if (ex.ok) explanation = ex.sections;
  }
  const cited = new Set(); ans.statements.forEach((s) => s.cites.forEach((c) => cited.add(c))); (explanation || []).forEach((s) => s.cites.forEach((c) => cited.add(c)));
  await logAudit(ctx, D, 'patient', 'ask', 'ok', q.slice(0, 80) + ' [' + ans.intent + (ai.used ? ', ai' : '') + ']');
  return J({ ok: true, question: q, intent: ans.intent, statements: ans.statements, explanation, ai, refs: refsFor([...cited], st) });
}
async function brief(ctx, D) {
  const st = computeState(D, ctx);
  if (ctx.body.save) {
    const text = String(ctx.body.text || '').slice(0, 20000);
    D.intel.brief = { text, savedAt: ctx.now, edited: true }; await save(ctx, D, ['intel']); return J({ ok: true, brief: D.intel.brief });
  }
  const text = buildBrief({ facts: st.facts, comparisons: st.comparisons, conflicts: st.conflicts, docs: st.docs }, ctx.h.name, dateOf(ctx.now));
  D.intel.brief = { text, savedAt: ctx.now, edited: false }; await save(ctx, D, ['intel']);
  return J({ ok: true, brief: D.intel.brief });
}
async function briefshare(ctx, D) {
  if (!D.intel.brief) return J({ ok: false, error: 'no_brief' }, 409);
  const hours = Math.min(168, Math.max(1, Number(ctx.body.hours) || 24)); const token = rand(24);
  D.intel.bshares = (D.intel.bshares || []).filter((s) => s.exp > ctx.now && !s.revoked).slice(-4);
  const sid = rand(8); D.intel.bshares.push({ id: sid, hash: await sha(token), exp: ctx.now + hours * 3600000, created: ctx.now });
  await logAudit(ctx, D, 'patient', 'brief.share', 'ok', 'expires in ' + hours + ' h'); await save(ctx, D, ['intel']);
  return J({ ok: true, link: '/brief.html?p=' + ctx.h.pid + '&s=' + sid + '.' + token, exp: ctx.now + hours * 3600000 });
}
async function briefrevoke(ctx, D) {
  const s = (D.intel.bshares || []).find((x) => x.id === ctx.body.id); if (!s) return J({ ok: false, error: 'not_found' }, 404);
  s.revoked = true; await logAudit(ctx, D, 'patient', 'brief.revoke', 'ok', s.id); await save(ctx, D, ['intel']); return J({ ok: true });
}
// Public capability link, created by the patient, expiring and revocable. Shows only the brief text the patient chose to share.
async function briefpublic(ctx, D) {
  const raw = new URL(ctx.req.url).searchParams.get('s') || ''; const m = /^([a-z0-9]{8})\.([a-z0-9]{24})$/.exec(raw);
  const s = m && (D.intel.bshares || []).find((x) => x.id === m[1]);
  if (!s || s.revoked || s.exp < ctx.now || s.hash !== await sha(m[2]) || !D.intel.brief) return J({ ok: false, error: 'link_invalid_or_expired' }, 404);
  await logAudit(ctx, D, 'link', 'brief.view', 'ok', s.id);
  return J({ ok: true, text: D.intel.brief.text, preparedBy: 'Orbit-X, from documents the patient provided', exp: s.exp });
}
async function decide(ctx, D) {
  const id = String(ctx.body.id || ''); const st = computeState(D, ctx);
  if (!st.conflicts.some((c) => c.id === id)) return J({ ok: false, error: 'not_found' }, 404);
  const dec = ['acknowledged', 'dismissed'].includes(ctx.body.decision) ? ctx.body.decision : null; if (!dec) return J({ ok: false, error: 'bad_decision' }, 400);
  D.intel.decisions[id] = { decision: dec, note: clean(ctx.body.note, 160), t: ctx.now };
  await logAudit(ctx, D, 'patient', 'conflict.' + dec, 'ok', id); await save(ctx, D, ['intel']);
  return J(wstateView(D, ctx)); // source facts are never changed by a review decision
}
async function suggest(ctx, D) {
  const names = [...new Set(D.facts.filter((f) => f.kind === 'observation' && !f.canon && !f.mapping).map((f) => f.name))].slice(0, 20);
  if (!names.length) return J({ ok: true, suggestions: [], note: 'Every test name was recognised by the fixed list.' });
  const r = await suggestMappings(ctx.env, names, Object.keys(ANALYTES));
  if (!r.ok) return J({ ok: true, suggestions: [], ai: { used: false, error: r.error }, names });
  return J({ ok: true, suggestions: r.matches, ai: { used: true, model: r.model, ms: r.ms }, names });
}
async function mapconfirm(ctx, D) {
  const f = D.facts.find((x) => x.id === ctx.body.factId); const key = String(ctx.body.key || '');
  if (!f || !ANALYTES[key] || f.kind !== 'observation') return J({ ok: false, error: 'bad_request' }, 400);
  const cv = convertToCanon(key, f.value, f.unit); if (!cv) return J({ ok: false, error: 'unit_not_convertible' }, 422);
  f.canon = key; f.nv = cv.value; f.nu = cv.unit; f.mapping = { by: 'patient', suggestedBy: clean(ctx.body.suggestedBy, 40) || null, t: ctx.now }; f.hash = factHash(f);
  await logAudit(ctx, D, 'patient', 'mapping.confirm', 'ok', f.name + ' -> ' + key); await save(ctx, D, ['facts']);
  return J(wstateView(D, ctx));
}
async function consent(ctx, D) {
  const c = ctx.h.consent || defaultConsent(); const b = ctx.body;
  if (typeof b.emergencyHandoff === 'boolean') c.emergencyHandoff = b.emergencyHandoff;
  if (b.categories && typeof b.categories === 'object') for (const k of Object.keys(c.categories)) if (typeof b.categories[k] === 'boolean') c.categories[k] = b.categories[k];
  c.updatedAt = ctx.now; ctx.h.consent = c;
  await logAudit(ctx, D, 'patient', 'consent.update', 'ok', JSON.stringify({ e: c.emergencyHandoff, ...c.categories }));
  return J(wstateView(D, ctx));
}
async function wipe(ctx, D) {
  for (const d of D.docs) await ctx.storage.delete('doc:' + d.id);
  D.docs = []; D.facts = []; D.imports = []; D.handoffs = []; D.events = []; D.intel = { nextDoc: 1, decisions: {}, brief: null, bshares: [] };
  ctx.h.shares = (ctx.h.shares || []).filter((s) => s.kind !== 'handoff');
  await logAudit(ctx, D, 'patient', 'workspace.wipe', 'ok', 'documents, facts, imports and handoffs removed'); await save(ctx, D, ['docs', 'facts', 'imports', 'handoffs', 'events', 'intel']);
  return J(wstateView(D, ctx));
}

/* ------------------------------------------------------------------ Orbit Connect: FHIR import (Experience 2) */
function outcome(severity, code, diag) { return { severity, code, diagnostics: diag }; }
async function v1records(ctx, D) {
  const who = ctx.who;
  if (ctx.req.method === 'GET') {
    if (!hasScope(who, 'records:read')) return deny(ctx, D, 'records:read');
    const sp = new URL(ctx.req.url).searchParams; const kind = sp.get('kind');
    const rows = D.facts.filter((f) => !kind || f.kind === kind).slice(-200).map((f) => publicFact(f, D.docs));
    await logAudit(ctx, D, actorOf(who), 'records.list', 'ok', rows.length + ' facts');
    return J({ ok: true, count: rows.length, records: rows });
  }
  if (!hasScope(who, 'records:write')) return deny(ctx, D, 'records:write');
  const dry = ctx.dry === true; const body = ctx.body;
  const isBundle = body && body.resourceType === 'Bundle';
  const v = isBundle ? validateBundle(body) : { ...validateResource(body, 'resource'), entries: [{ index: 0, resource: body, ...validateResource(body, 'resource') }] };
  if (!v.entries || !v.entries.length) {
    await logAudit(ctx, D, actorOf(who), dry ? 'records.validate' : 'records.import', 'error', 'invalid payload');
    return J({ ok: false, error: 'validation_failed', resourceType: 'OperationOutcome', issue: v.errors.map((e) => outcome('error', 'structure', e)) }, 422);
  }
  const atomic = isBundle && body.type === 'transaction';
  const allValid = v.entries.every((e) => e.ok);
  const importId = 'im_' + rand(8); const sysLabel = clean(who.label || 'External system', 40);
  const results = v.entries.map((e) => ({ index: e.index, resourceType: e.resource && e.resource.resourceType, id: e.resource && e.resource.id || null, outcome: e.ok ? 'valid' : 'invalid', errors: e.errors, warnings: e.warnings, factIds: [] }));
  const report = { id: importId, t: ctx.now, system: sysLabel, simulated: !!who.sim, dryRun: dry, received: v.entries.length, accepted: 0, duplicates: 0, rejected: results.filter((r) => r.outcome === 'invalid').length, newConflicts: [], status: 'accepted', errors: v.errors.slice(0, 20) };
  if (dry) { report.status = allValid ? 'valid' : 'invalid'; await logAudit(ctx, D, actorOf(who), 'records.validate', allValid ? 'ok' : 'error', report.received + ' resources, ' + report.rejected + ' invalid'); return J({ ok: allValid, importId: null, status: report.status, dryRun: true, results, warnings: v.warnings }, allValid ? 200 : 422); }
  if (atomic && !allValid) {
    report.status = 'rejected'; D.imports.push(report); D.imports = D.imports.slice(-50); await logAudit(ctx, D, actorOf(who), 'records.import', 'error', 'transaction rejected: ' + report.rejected + ' invalid'); await save(ctx, D, ['imports']);
    return J({ ok: false, error: 'transaction_rejected', importId, status: 'rejected', resourceType: 'OperationOutcome', issue: v.errors.map((e) => outcome('error', 'invalid', e)), results }, 422);
  }
  // identity gate: a record about somebody else must never be merged into this person's history
  for (const e of v.entries) if (e.ok && e.resource.resourceType === 'Patient') {
    const nm = e.resource.name && e.resource.name[0] && (e.resource.name[0].text || [].concat(e.resource.name[0].given || [], e.resource.name[0].family || []).join(' '));
    if (nm && nameTok(nm) !== nameTok(ctx.h.name)) {
      report.status = 'rejected'; D.imports.push(report); await logAudit(ctx, D, actorOf(who), 'records.import', 'denied', 'patient mismatch'); await save(ctx, D, ['imports']);
      return J({ ok: false, error: 'patient_mismatch', importId, status: 'rejected', message: 'The Patient resource does not match the person who owns this Orbit-X record. Nothing was imported.' }, 409);
    }
  }
  const before = new Set(findConflicts(D.docs, D.facts, dateOf(ctx.now)).map((c) => c.id));
  const importedAt = new Date(ctx.now).toISOString(); const sysId = 'sys_' + importId.slice(3);
  const newFacts = []; let n = 0;
  for (const e of v.entries) {
    const res = results[e.index]; if (!e.ok) continue;
    const resHash = fnv(JSON.stringify(e.resource));
    const facts = resourceToFacts(e.resource, { sysId, system: sysLabel, importedAt, simulated: !!who.sim });
    if (!facts.length) { res.outcome = 'validated_no_fact'; continue; }
    res.outcome = 'imported';
    for (const f of facts) {
      f.hash = factHash(f); f.source.importId = importId; f.source.resourceHash = resHash;
      const dup = D.facts.find((x) => x.hash === f.hash) || newFacts.find((x) => x.hash === f.hash);
      if (dup) { dup.corroboratedBy = dup.corroboratedBy || []; dup.corroboratedBy.push({ system: sysLabel, importId, simulated: !!who.sim, resourceType: e.resource.resourceType, resourceId: e.resource.id || null, t: ctx.now, docId: sysId }); res.outcome = 'duplicate'; res.factIds.push(dup.id); report.duplicates++; continue; }
      f.id = 'f_' + sysId + '_' + (++n); newFacts.push(f); res.factIds.push(f.id); report.accepted++;
    }
  }
  if (newFacts.length || report.duplicates) {
    let doc = D.docs.find((d) => d.kind === 'connector' && d.system === sysLabel);
    if (!doc) { doc = { id: sysId, name: 'EMR import: ' + sysLabel + (who.sim && !/simulated/i.test(sysLabel) ? ' (simulated)' : ''), kind: 'connector', system: sysLabel, meta: { docType: 'connector', docDate: null, patientName: ctx.h.name }, uploadedAt: ctx.now, size: 0, extraction: { mode: 'connector', model: null } }; D.docs.push(doc); }
    for (const f of newFacts) f.docId = doc.id, f.source.docId = doc.id;
    for (const f of D.facts) if (f.corroboratedBy) for (const c of f.corroboratedBy) if (c.docId === sysId) c.docId = doc.id;
    D.facts.push(...newFacts);
    const dates = D.facts.filter((f) => f.docId === doc.id && f.date).map((f) => f.date).sort(); doc.meta.docDate = dates[dates.length - 1] || dateOf(ctx.now); doc.size = D.facts.filter((f) => f.docId === doc.id).length;
  }
  const after = findConflicts(D.docs, D.facts, dateOf(ctx.now)); report.newConflicts = after.filter((c) => !before.has(c.id)).map((c) => ({ id: c.id, title: c.title, type: c.type }));
  report.status = report.rejected ? (report.accepted || report.duplicates ? 'partial' : 'rejected') : 'accepted';
  D.imports.push(report); D.imports = D.imports.slice(-50);
  await logAudit(ctx, D, actorOf(who), 'records.import', report.status === 'rejected' ? 'error' : 'ok', sysLabel + ': +' + report.accepted + ' new, ' + report.duplicates + ' duplicate, ' + report.rejected + ' invalid');
  await save(ctx, D, ['docs', 'facts', 'imports']);
  return J({ ok: report.status !== 'rejected', importId, status: report.status, simulated: !!who.sim, counts: { received: report.received, newFacts: report.accepted, duplicates: report.duplicates, invalid: report.rejected }, newConflicts: report.newConflicts, results, warnings: v.warnings, provenance: { system: sysLabel, importedAt, simulated: !!who.sim }, next: 'The imported facts now appear in the patient timeline.' }, report.status === 'rejected' ? 422 : report.status === 'partial' ? 207 : 201);
}
async function v1connectors(ctx, D) {
  if (!hasScope(ctx.who, 'records:read') && !hasScope(ctx.who, 'records:write')) return deny(ctx, D, 'records:read');
  const by = {};
  for (const im of D.imports.filter((i) => !i.dryRun)) { const c = by[im.system] = by[im.system] || { name: im.system, simulated: im.simulated, imports: 0, accepted: 0, duplicates: 0, rejected: 0, lastImportAt: null, lastStatus: null, lastError: null }; c.imports++; c.accepted += im.accepted; c.duplicates += im.duplicates; c.rejected += im.rejected; c.lastImportAt = im.t; c.lastStatus = im.status; if (im.errors && im.errors.length) c.lastError = im.errors[0]; else if (im.status === 'accepted') c.lastError = null; }
  const keys = (ctx.h.apiKeys || []).filter((k) => (k.scopes || []).includes('records:write')).map((k) => ({ name: k.label, simulated: !!k.sim }));
  for (const k of keys) if (!by[k.name]) by[k.name] = { name: k.name, simulated: k.simulated, imports: 0, accepted: 0, duplicates: 0, rejected: 0, lastImportAt: null, lastStatus: 'idle', lastError: null };
  return J({ ok: true, connectors: Object.values(by).map((c) => ({ ...c, status: c.imports === 0 ? 'idle' : c.lastStatus === 'accepted' ? 'healthy' : c.lastStatus === 'partial' ? 'degraded' : 'failing' })), note: 'Connectors marked simulated are synthetic test systems, not real hospitals.' });
}

/* ------------------------------------------------------------------ events + handoff (Experience 3) */
export function hasScope(who, scope) { return who.role === 'patient' || (who.role === 'api' && (who.scopes || LEGACY_SCOPES).includes(scope)); }
async function deny(ctx, D, scope) { await logAudit(ctx, D, actorOf(ctx.who), ctx.action, 'denied', 'missing scope ' + scope); return J({ ok: false, error: 'insufficient_scope', required: scope }, 403); }

async function v1events(ctx, D) {
  if (!hasScope(ctx.who, 'events:write')) return deny(ctx, D, 'events:write');
  const type = ['emergency', 'fall', 'sos'].includes(ctx.body.type) ? ctx.body.type : null;
  if (!type) return J({ ok: false, error: 'bad_type', allowed: ['emergency', 'fall', 'sos'] }, 400);
  const ev = { id: 'ev_' + rand(10), type, reason: clean(ctx.body.reason, 160), source: clean(ctx.who.label || 'external', 40), simulated: !!ctx.who.sim, t: ctx.now, status: 'accepted' };
  D.events.push(ev); D.events = D.events.slice(-30);
  await logAudit(ctx, D, actorOf(ctx.who), 'event.accept', 'ok', type + ' ' + ev.id); await save(ctx, D, ['events']);
  return J({ ok: true, eventId: ev.id, status: 'accepted', simulated: ev.simulated, note: 'Accepted only. No handoff exists yet. Call POST /api/v1/handoffs with this eventId.' }, 202);
}
const HO_ORDER = ['accepted', 'generated', 'sent', 'received', 'acknowledged'];
function freshness(age) { return age === null ? 'undated' : age <= 60 ? 'recent' : age <= 365 ? 'older' : 'stale'; }
function assembleSummary(D, consentCfg, now) {
  const st = { docs: D.docs, facts: D.facts }; const today = dateOf(now); const items = []; const flags = [];
  const srcOf = (f) => { const d = D.docs.find((x) => x.id === f.docId) || {}; return f.source && f.source.type === 'connector' ? { type: 'connector', name: f.source.system, simulated: !!f.source.simulated, importedAt: f.source.importedAt } : { type: 'document', name: d.name || f.docId, docId: f.docId, extractor: f.source && f.source.extractor }; };
  const docDate = (f) => ((D.docs.find((x) => x.id === f.docId) || {}).meta || {}).docDate || null;
  const item = (cat, f, text) => { const dt = f.date || docDate(f); const age = dt && isDate(dt) ? daysBetween(dt, today) : null; items.push({ category: cat, text, factId: f.id, date: dt, ageDays: age, freshness: freshness(age), confidence: f.confidence, status: f.status, source: srcOf(f), corroboratedBy: (f.corroboratedBy || []).map((c) => c.system) }); };
  const c = consentCfg.categories;
  if (c.allergies) { const seen = new Set(); for (const f of D.facts.filter((x) => x.kind === 'allergy')) { const k = normName(f.name); if (seen.has(k)) continue; seen.add(k); item('allergy', f, 'Documented allergy: ' + f.text); } }
  if (c.medications) {
    const by = {}; for (const f of D.facts.filter((x) => x.kind === 'medication')) (by[normName(f.name)] = by[normName(f.name)] || []).push(f);
    for (const arr of Object.values(by)) { arr.sort((a, b) => ((b.date || docDate(b) || '')).localeCompare(a.date || docDate(a) || '')); const f = arr[0]; item('medication', f, 'Listed medicine: ' + f.name + (f.dose ? ' ' + f.dose : '')); if (arr.some((x) => normName(x.dose) !== normName(f.dose))) flags.push('Sources write the dose of ' + f.name + ' differently. Most recent listing shown.'); }
  }
  if (c.conditions) { const seen = new Set(); for (const f of D.facts.filter((x) => x.kind === 'condition')) { const k = normName(f.name); if (seen.has(k)) continue; seen.add(k); item('condition', f, 'Documented diagnosis: ' + f.name); } }
  if (c.readings) {
    const S = {}; for (const f of D.facts.filter((x) => x.kind === 'observation' && x.canon && x.nv !== null && x.date)) (S[f.canon] = S[f.canon] || []).push(f);
    const order = ['sbp', 'dbp', 'glucose_fasting', 'glucose', 'hba1c', 'creatinine', 'egfr', 'potassium'];
    for (const k of order) { const arr = S[k]; if (!arr) continue; arr.sort((a, b) => a.date.localeCompare(b.date)); const f = arr[arr.length - 1]; item('reading', f, ANALYTES[k].label + ' ' + fmtNum(f.value) + ' ' + f.unit + (f.flag ? ' (flagged ' + f.flag + ' in source)' : '')); const same = arr.filter((x) => x.date === f.date && Math.abs(x.nv - f.nv) > Math.abs(f.nv) * 0.02); if (same.length) flags.push('Sources disagree on ' + ANALYTES[k].label + ' on ' + f.date + '.'); }
  }
  const idRows = findConflicts(D.docs, D.facts, today).filter((x) => x.type === 'identity_mismatch'); if (idRows.length) flags.push('Identity details differ between source documents. Confirm identity independently.');
  void st;
  return { items, flags: [...new Set(flags)], notice: 'Compiled by Orbit-X from patient-provided and imported records. Not verified by a clinician. Not medical advice. Absence of an item does not mean it does not exist.' };
}
function handoffPublic(ho, withSummary) {
  return { id: ho.id, eventId: ho.eventId, status: ho.status, createdAt: ho.createdAt, requester: ho.requester, simulated: true, contentHash: ho.contentHash, states: ho.states, receipt: ho.receiptUrl, summary: withSummary ? ho.summary : undefined, fhirValid: ho.fhirValid, fhir: withSummary ? ho.fhir : undefined };
}
async function v1handoffcreate(ctx, D) {
  if (!hasScope(ctx.who, 'handoff:create')) return deny(ctx, D, 'handoff:create');
  const ev = D.events.find((e) => e.id === ctx.body.eventId);
  if (!ev) return J({ ok: false, error: 'event_not_found', message: 'Create an event first with POST /api/v1/events.' }, 404);
  const existing = D.handoffs.find((x) => x.eventId === ev.id); if (existing) return J({ ok: false, error: 'handoff_exists', handoffId: existing.id, status: existing.status }, 409);
  const cons = ctx.h.consent || defaultConsent();
  if (!cons.emergencyHandoff) { await logAudit(ctx, D, actorOf(ctx.who), 'handoff.create', 'denied', 'patient has not enabled emergency handoff'); return J({ ok: false, error: 'consent_required', message: 'The patient has not allowed emergency information handoff. Nothing was assembled or shared.' }, 403); }
  const rq = ctx.body.requester || {};
  const summary = assembleSummary(D, cons, ctx.now);
  const contentHash = await sha(JSON.stringify(summary));
  const iso = new Date(ctx.now).toISOString();
  const incl = D.facts.filter((f) => summary.items.some((i) => i.factId === f.id)).map((f) => ({ ...f, docName: (D.docs.find((d) => d.id === f.docId) || {}).name }));
  const fhir = factsToBundle({ id: 'patient-' + ctx.h.pid, name: ctx.h.name, dob: (D.docs.map((d) => d.meta && d.meta.dob).filter(Boolean).sort()[0]) || null }, incl, { now: iso });
  const fv = validateBundle(fhir);
  const ho = { id: 'ho_' + rand(10), eventId: ev.id, requester: { name: clean(rq.name, 60) || null, organization: clean(rq.organization, 80) || null }, createdAt: ctx.now, status: 'sent', summary, contentHash, fhir, fhirValid: fv.ok, states: [], entries: [], receiptUrl: null };
  const mark = async (state, t, actor, text) => { ho.states.push({ state, t, actor, simulated: state === 'sent' ? true : undefined }); await chainAppend(ho, ctx.h.pid, ho.id, state, text, t); };
  await mark('accepted', ev.t, 'api:' + ev.source, 'event ' + ev.id + ' accepted');
  await mark('generated', ctx.now, 'orbit', 'summary generated; hash ' + contentHash);
  await mark('sent', ctx.now, 'orbit', 'placed in simulated sandbox inbox (no real delivery)');
  ho.signature = await signHead(ctx.env, ctx.h.pid, ho.id, ho.head);
  ev.status = 'handoff_created';
  const sid = rand(10); ctx.h.shares = ctx.h.shares || []; ctx.h.shares.push({ id: sid, kind: 'handoff', refId: ho.id, t: ctx.now }); ctx.h.shares = ctx.h.shares.slice(-60);
  ho.receiptUrl = '/receipt.html?p=' + ctx.h.pid + '&s=' + sid;
  D.handoffs.push(ho); D.handoffs = D.handoffs.slice(-20);
  await logAudit(ctx, D, actorOf(ctx.who), 'handoff.create', 'ok', ho.id + ' items:' + summary.items.length); await save(ctx, D, ['handoffs', 'events']);
  return J({ ok: true, handoffId: ho.id, status: ho.status, simulatedDelivery: true, states: ho.states, contentHash, items: summary.items.length, fhirValid: fv.ok, receipt: ho.receiptUrl, note: 'Delivery to the receiving system is simulated. Status is "sent": it has not been received or acknowledged.' }, 201);
}
function findHandoff(D, ctx) { const id = new URL(ctx.req.url).searchParams.get('id') || ctx.body.id; return D.handoffs.find((x) => x.id === id); }
async function v1handoffget(ctx, D) {
  if (!hasScope(ctx.who, 'handoff:create') && !hasScope(ctx.who, 'handoff:receive')) return deny(ctx, D, 'handoff:create');
  const ho = findHandoff(D, ctx); if (!ho) return J({ ok: false, error: 'not_found' }, 404);
  return J({ ok: true, handoff: handoffPublic(ho, false) });
}
async function v1handoffreceive(ctx, D) {
  if (!hasScope(ctx.who, 'handoff:receive')) return deny(ctx, D, 'handoff:receive');
  const ho = findHandoff(D, ctx); if (!ho) return J({ ok: false, error: 'not_found' }, 404);
  if (HO_ORDER.indexOf(ho.status) < HO_ORDER.indexOf('received')) {
    ho.status = 'received'; const t = ctx.now; ho.states.push({ state: 'received', t, actor: 'api:' + clean(ctx.who.label || ctx.who.id, 30) }); await chainAppend(ho, ctx.h.pid, ho.id, 'received', 'summary fetched by receiving system', t);
    ho.signature = await signHead(ctx.env, ctx.h.pid, ho.id, ho.head);
  }
  await logAudit(ctx, D, actorOf(ctx.who), 'handoff.receive', 'ok', ho.id); await save(ctx, D, ['handoffs']);
  return J({ ok: true, handoff: handoffPublic(ho, true) });
}
async function v1handoffack(ctx, D) {
  if (!hasScope(ctx.who, 'handoff:receive')) return deny(ctx, D, 'handoff:receive');
  const ho = findHandoff(D, ctx); if (!ho) return J({ ok: false, error: 'not_found' }, 404);
  if (HO_ORDER.indexOf(ho.status) < HO_ORDER.indexOf('received')) { await logAudit(ctx, D, actorOf(ctx.who), 'handoff.acknowledge', 'denied', 'not received yet'); return J({ ok: false, error: 'invalid_transition', status: ho.status, message: 'A handoff must be received before it can be acknowledged.' }, 409); }
  if (ho.status !== 'acknowledged') {
    ho.status = 'acknowledged'; const by = clean(ctx.body.by, 60) || 'receiving clinician'; ho.states.push({ state: 'acknowledged', t: ctx.now, actor: 'api:' + clean(ctx.who.label || ctx.who.id, 30) }); ho.ackBy = by; await chainAppend(ho, ctx.h.pid, ho.id, 'acknowledged', 'acknowledged by ' + by, ctx.now);
    ho.signature = await signHead(ctx.env, ctx.h.pid, ho.id, ho.head);
  }
  await logAudit(ctx, D, actorOf(ctx.who), 'handoff.acknowledge', 'ok', ho.id); await save(ctx, D, ['handoffs']);
  return J({ ok: true, handoff: handoffPublic(ho, false) });
}
// Authenticated, server-side verification: recomputes the chain AND the content hash from what is stored.
async function v1verify(ctx, D) {
  if (!hasScope(ctx.who, 'handoff:create') && !hasScope(ctx.who, 'handoff:receive') && !hasScope(ctx.who, 'audit:read')) return deny(ctx, D, 'handoff:create');
  const ho = findHandoff(D, ctx); if (!ho) return J({ ok: false, error: 'not_found' }, 404);
  return J({ ok: true, verification: await verifyHandoff(ctx.env, ctx.h.pid, ho) });
}
export async function verifyHandoff(env, pid, ho) {
  const chain = await chainVerify(pid, ho.id, ho.entries, ho.head);
  const contentOk = (await sha(JSON.stringify(ho.summary))) === ho.contentHash;
  let sig = 'unsigned'; if (env.RECEIPT_SECRET) sig = ho.signature && ho.signature === await signHead(env, pid, ho.id, ho.head) ? 'valid' : 'invalid';
  return { chainIntact: chain.ok, badIndex: chain.badIndex, contentMatchesHash: contentOk, signature: sig, status: ho.status, integrityOk: chain.ok && contentOk && sig !== 'invalid',
    meaning: 'Integrity only: the record has not been changed since Orbit wrote it. It does not prove that the medical information is accurate or that any clinical event occurred.' };
}
export async function publicReceipt(env, pid, share, D, h) {
  if (share.kind === 'handoff') {
    const ho = D.handoffs.find((x) => x.id === share.refId); if (!ho) return null;
    const v = await verifyHandoff(env, pid, ho);
    return { ok: true, type: 'handoff', pid, id: ho.id, status: ho.status, simulated: true, contentHash: ho.contentHash, head: ho.head, signed: !!env.RECEIPT_SECRET, signature: v.signature, serverVerified: v.integrityOk, entries: ho.entries.map((e) => ({ t: e.t, k: e.k, label: KIND_LABEL[e.k] || e.k, d: e.d, h: e.h })), meaning: v.meaning };
  }
  const al = [h.alert, ...(h.history || [])].filter(Boolean).find((x) => x.id === share.alertId); if (!al || !al.entries) return null;
  const chain = await chainVerify(pid, al.id, al.entries, al.head);
  const sig = env.RECEIPT_SECRET ? (al.signature && al.signature === await signHead(env, pid, al.id, al.head) ? 'valid' : 'invalid') : 'unsigned';
  return { ok: true, type: 'alert', pid, id: al.id, status: al.status, head: al.head, signed: !!env.RECEIPT_SECRET, signature: sig, serverVerified: chain.ok && sig !== 'invalid', entries: al.entries.map((e) => ({ t: e.t, k: e.k, label: KIND_LABEL[e.k] || e.k, d: e.d, h: e.h })),
    meaning: 'Integrity only: this shows the sequence of alert steps has not been changed. It does not prove the medical situation was real or accurate.' };
}
async function v1audit(ctx, D) {
  if (!hasScope(ctx.who, 'audit:read')) return deny(ctx, D, 'audit:read');
  return J({ ok: true, events: D.audit.slice(-100).reverse() });
}
async function auditlog(ctx, D) { return J({ ok: true, events: D.audit.slice(-150).reverse() }); }

/* ------------------------------------------------------------------ OAuth 2.0 client-credentials (short-lived bearer tokens) */
export async function oauthToken(ctx, h, body, env, now) {
  const err = (s, e, d) => J({ error: e, error_description: d }, s);
  if (body.grant_type !== 'client_credentials') return err(400, 'unsupported_grant_type', 'Only client_credentials is supported.');
  const km = /^ox_([a-z0-9]{8})_([a-z0-9]{24})$/.exec(String(body.client_secret || ''));
  if (!km || km[1] !== h.pid) return err(401, 'invalid_client', 'client_secret must be the full API key (ox_<id>_<secret>).');
  const k = (h.apiKeys || []).find((x) => x.hash === null || x.hash === undefined ? false : true) && (h.apiKeys || []).find((x) => x.hash === km[2] ? true : false);
  void k;
  const kh = await sha(km[2]); const key = (h.apiKeys || []).find((x) => x.hash === kh);
  if (!key) return err(401, 'invalid_client', 'Unknown or revoked key.');
  const have = key.scopes || LEGACY_SCOPES;
  const want = body.scope ? String(body.scope).split(/\s+/).filter(Boolean) : have;
  if (want.some((s) => !have.includes(s))) return err(400, 'invalid_scope', 'Requested scope is not granted to this key.');
  const token = 'oxt_' + h.pid + '_' + rand(32);
  const tokens = ((await ctx.storage.get('tokens')) || []).filter((t) => t.exp > now).slice(-40);
  tokens.push({ hash: await sha(token), keyId: key.id, scopes: want, exp: now + 900000 });
  await ctx.storage.put('tokens', tokens);
  void env;
  return J({ access_token: token, token_type: 'Bearer', expires_in: 900, scope: want.join(' ') });
}

/* ------------------------------------------------------------------ dispatcher */
export async function handleConnect(ctx) {
  const a = ctx.action; ctx.dry = a === 'v1validate';
  const D = await load(ctx);
  if (a === 'briefpublic') return briefpublic(ctx, D);
  if (WORKSPACE_ACTIONS.has(a)) {
    if (ctx.who.role !== 'patient') { await logAudit(ctx, D, actorOf(ctx.who), a, 'denied', 'patient only'); return J({ ok: false, error: 'patient_only' }, 403); }
    switch (a) {
      case 'wstate': return J(wstateView(D, ctx));
      case 'docadd': return docadd(ctx, D);
      case 'docdel': return docdel(ctx, D);
      case 'docget': return docget(ctx, D);
      case 'docexplain': return docexplain(ctx, D);
      case 'docretry': return docretry(ctx, D);
      case 'docphoto': return docphoto(ctx, D);
      case 'ask': return ask(ctx, D);
      case 'brief': return brief(ctx, D);
      case 'briefshare': return briefshare(ctx, D);
      case 'briefrevoke': return briefrevoke(ctx, D);
      case 'decide': return decide(ctx, D);
      case 'suggest': return suggest(ctx, D);
      case 'mapconfirm': return mapconfirm(ctx, D);
      case 'consent': return consent(ctx, D);
      case 'auditlog': return auditlog(ctx, D);
      case 'wipe': return wipe(ctx, D);
      default: break;
    }
  }
  if (ctx.who.role !== 'api' && ctx.who.role !== 'patient') return J({ ok: false, error: 'forbidden' }, 403);
  switch (a) {
    case 'v1records': case 'v1validate': return v1records(ctx, D);
    case 'v1connectors': return v1connectors(ctx, D);
    case 'v1events': return v1events(ctx, D);
    case 'v1handoffcreate': return v1handoffcreate(ctx, D);
    case 'v1handoffget': return v1handoffget(ctx, D);
    case 'v1handoffreceive': return v1handoffreceive(ctx, D);
    case 'v1handoffack': return v1handoffack(ctx, D);
    case 'v1verify': return v1verify(ctx, D);
    case 'v1audit': return v1audit(ctx, D);
    default: return null;
  }
}
export async function loadForReceipt(storage) { const [handoffs] = await Promise.all([storage.get('handoffs')]); return { handoffs: handoffs || [] }; }
void quoteInText; void finishFact;

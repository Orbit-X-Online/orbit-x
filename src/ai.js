// AI layer. The model proposes; code in intel.js decides. Every call is observable and every failure is survivable.
import { metaChat, resolveModel, MetaError } from './meta.js';
export { resolveModel };
import { validateExtraction, validateExplanation, extractRules } from './intel.js';

export function aiMode(env) { return env.AI_MODE === 'mock' ? 'mock' : env.MODEL_API_KEY ? 'live' : 'off'; }
export function providerName(env) { const b = String(env.MODEL_BASE_URL || ''); return /baseten/i.test(b) ? 'Baseten (Meta Muse Spark Open)' : /meta\.ai/i.test(b) ? 'Meta Model API' : 'OpenAI-compatible endpoint'; }

function parseJson(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = t.indexOf('{'); if (a < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = a; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(t.slice(a, i + 1)); } catch { return null; } } }
  }
  return null;
}
function reason(e) { if (!(e instanceof MetaError)) return 'unexpected_error'; if (e.status === 504) return 'timeout'; if (e.status === 402) return 'no_credits'; if (e.status === 429) return 'rate_limited'; if (e.status === 404) return 'model_not_found'; if (e.status === 500) return 'not_configured'; if (e.status === 403) return 'key_rejected'; return 'provider_unavailable'; }

async function callJson(env, system, user, opts = {}) {
  const t0 = Date.now();
  try {
    const model = await resolveModel(env);
    const out = await metaChat(env, { model, temperature: 0.1, maxTokens: opts.maxTokens || 4000, timeoutMs: opts.timeoutMs || 60000, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
    const data = parseJson(out);
    if (!data) return { ok: false, error: 'malformed_json', model, ms: Date.now() - t0 };
    return { ok: true, data, model, ms: Date.now() - t0 };
  } catch (e) { return { ok: false, error: reason(e), detail: String(e && e.message || '').slice(0, 160), ms: Date.now() - t0 }; }
}

const EXTRACT_SYSTEM = `You extract structured facts from ONE synthetic medical document for a records-organising tool. Output ONLY one JSON object. No prose, no markdown.
Schema:
{"document":{"docType":"lab_report|discharge_summary|other","docDate":"YYYY-MM-DD|null","patientName":"string|null","dob":"YYYY-MM-DD|null","facility":"string|null","admissionDate":"YYYY-MM-DD|null","dischargeDate":"YYYY-MM-DD|null"},
"facts":[{"kind":"observation|medication|allergy|condition|encounter","name":"string","value":number|null,"unit":"string|null","date":"YYYY-MM-DD|null","refRange":"string|null","flag":"H|L|null","dose":"string|null","quote":"EXACT text copied from the document","confidence":0.0-1.0}]}
Rules:
- "quote" must be copied character for character from the document (one line). Facts without a real quote will be deleted.
- "value" must be a number printed inside the quote. Never calculate, convert, round or infer.
- Use the date printed for that result; if none, use the collection or report date. Use null if unknown.
- Do not add facts that are not written in the document. Do not give advice or interpretation.
- Blood pressure like 148/92 becomes two observations (Systolic blood pressure 148, Diastolic blood pressure 92) with the same quote.
- If unsure, lower the confidence instead of guessing.`;

export async function extractWithAI(env, text, docId) {
  if (aiMode(env) === 'mock') {
    const r = extractRules(text, docId);
    return { ok: true, mode: 'mock', model: 'mock (NOT a Meta model)', ms: 0, result: r };
  }
  if (aiMode(env) !== 'live') return { ok: false, error: 'not_configured' };
  const r = await callJson(env, EXTRACT_SYSTEM, 'DOCUMENT:\n"""\n' + text.slice(0, 24000) + '\n"""', { maxTokens: 3500 });
  if (!r.ok) return r;
  const v = validateExtraction(r.data, text, docId);
  if (!v.ok) return { ok: false, error: 'invalid_schema:' + v.error, model: r.model, ms: r.ms };
  if (!v.facts.length) return { ok: false, error: 'no_valid_facts', model: r.model, ms: r.ms, rejected: v.rejected };
  return { ok: true, mode: 'live', model: r.model, ms: r.ms, result: v };
}

const EXPLAIN_SYSTEM = `You explain differences between a person's own medical documents in plain, calm language. You are given EVIDENCE computed by code. Use ONLY that evidence.
Output ONLY one JSON object: {"sections":[{"kind":"documented|conflict|interpretation|unknown","text":"1-2 sentences","cites":["id", ...]}]}
Rules:
- kind "documented": restate evidence. kind "conflict": say sources disagree and that Orbit did not choose. kind "unknown": say what the documents do not tell us (cites may be empty). kind "interpretation": only a neutral reading of the size/direction of a change; never what it means for health.
- Every section except "unknown" must cite ids from the evidence list. Use ids exactly as given.
- Use only numbers and dates that appear in the evidence. Do not calculate new numbers.
- Never give medical advice, diagnosis, dosing, or say what the person should do. You may say "ask your clinician about this".
- At most 6 sections.`;

export async function explainWithAI(env, question, statements, universe, allowedText) {
  if (aiMode(env) === 'mock') {
    const secs = statements.slice(0, 6).map((s) => ({ kind: s.kind, text: s.text, cites: s.cites }));
    const v = validateExplanation({ sections: secs }, universe, allowedText);
    return { ok: v.ok, mode: 'mock', model: 'mock (NOT a Meta model)', ms: 0, sections: v.sections, dropped: v.dropped };
  }
  if (aiMode(env) !== 'live') return { ok: false, error: 'not_configured' };
  const ev = statements.map((s, i) => ({ n: i + 1, kind: s.kind, text: s.text, cites: s.cites }));
  const r = await callJson(env, EXPLAIN_SYSTEM, 'QUESTION: ' + String(question).slice(0, 300) + '\nEVIDENCE (JSON):\n' + JSON.stringify(ev), { maxTokens: 1500, timeoutMs: 30000 });
  if (!r.ok) return r;
  const v = validateExplanation(r.data, universe, allowedText);
  if (!v.ok) return { ok: false, error: 'explanation_rejected:' + (v.error || 'too_many_invalid'), model: r.model, ms: r.ms, dropped: v.dropped };
  return { ok: true, mode: 'live', model: r.model, ms: r.ms, sections: v.sections, dropped: v.dropped };
}

const RECON_SYSTEM = `You help match test names from medical documents to a fixed list of known tests. Output ONLY JSON: {"matches":[{"name":"exact input name","key":"one key from the list or null","confidence":0.0-1.0}]}. Use null when unsure. Do not invent keys.`;
export async function suggestMappings(env, names, keys) {
  if (aiMode(env) !== 'live' || !names.length) return { ok: false, error: aiMode(env) === 'mock' ? 'mock_no_suggestions' : 'not_configured' };
  const r = await callJson(env, RECON_SYSTEM, 'KNOWN KEYS: ' + JSON.stringify(keys) + '\nNAMES: ' + JSON.stringify(names.slice(0, 20)), { maxTokens: 800, timeoutMs: 20000 });
  if (!r.ok) return r;
  const out = (Array.isArray(r.data.matches) ? r.data.matches : []).filter((m) => m && typeof m.name === 'string' && names.includes(m.name) && typeof m.key === 'string' && keys.includes(m.key) && typeof m.confidence === 'number').map((m) => ({ name: m.name, key: m.key, confidence: Math.min(1, Math.max(0, m.confidence)) }));
  return { ok: true, model: r.model, ms: r.ms, matches: out };
}

/* ------------------------------------------------------------------ plain-language document explainer
   Helps a patient UNDERSTAND a document: what each test or medicine is, in everyday words, plus questions to ask a clinician.
   The numbers and flags come from facts found by code. The model only supplies the general meaning of a term, and the
   result is screened so it cannot diagnose, advise, or mention doses. */
export const GLOSSARY = [
  [/hba1c|a1c|glycated|glycosylated/i, 'A blood test that shows the average blood sugar level over about the last 2 to 3 months.'],
  [/glucose|blood sugar/i, 'The amount of sugar in the blood at the time the sample was taken.'],
  [/creatinine/i, 'A waste product made by muscles. Labs measure it to see how well the kidneys are filtering the blood.'],
  [/egfr|glomerular/i, 'An estimate of how well the kidneys filter blood, worked out from a creatinine result, age and sex.'],
  [/urea|bun/i, 'A waste product of protein breakdown that the kidneys remove. It is often reported together with creatinine.'],
  [/total cholesterol|^cholesterol/i, 'The total amount of cholesterol, a fatty substance in the blood.'],
  [/ldl/i, 'LDL is one type of cholesterol, often called the "bad" cholesterol because it can build up in blood vessels.'],
  [/hdl/i, 'HDL is one type of cholesterol, often called the "good" cholesterol because it helps carry cholesterol away.'],
  [/triglycer/i, 'A type of fat in the blood. Levels are affected by recent meals.'],
  [/haemoglobin|hemoglobin|^hb$|^hgb/i, 'The protein in red blood cells that carries oxygen around the body.'],
  [/wbc|white (blood )?cell|leuco|leukocyte/i, 'White blood cells are part of the immune system. The count shows how many are in a sample of blood.'],
  [/platelet/i, 'Small blood cell fragments that help blood to clot.'],
  [/potassium/i, 'A mineral in the blood that helps nerves and muscles, including the heart, work normally.'],
  [/sodium/i, 'A mineral in the blood that helps control fluid balance.'],
  [/alt|alanine/i, 'An enzyme found mostly in the liver. Labs measure it as one check of liver health.'],
  [/ast|aspartate/i, 'An enzyme found in the liver and other organs. Labs measure it as one check of liver health.'],
  [/tsh|thyroid stim/i, 'A hormone that tells the thyroid gland how much hormone to make.'],
  [/ferritin/i, 'A protein that stores iron. The level reflects the body\'s iron stores.'],
  [/systolic/i, 'The top blood pressure number: the pressure in the arteries when the heart beats.'],
  [/diastolic/i, 'The bottom blood pressure number: the pressure in the arteries between heartbeats.'],
  [/albumin/i, 'A protein made by the liver that is found in blood.'],
  [/bilirubin/i, 'A yellow substance made when red blood cells break down, processed by the liver.'],
  [/crp|c-reactive/i, 'A protein that rises in the blood when there is inflammation somewhere in the body.'],
  [/vitamin d/i, 'A vitamin the body needs for bones. The test shows the level in the blood.'],
];
const GUARD = /\b(diagnos\w*|prescri\w*|dos(e|es|age|ing)|you (have|probably have|likely have|might have|may have|are suffering)|(take|taking) (an? |some |your )?(extra|double|more|less|another)|stop taking|you should|you must|you need to|\d+\s?(mg|mcg|ml|g|units?)\b)/i;
export function safeMeaning(t) { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x && x.length <= 260 && !GUARD.test(x) ? x : ''; }
export function glossaryFor(name) { const g = GLOSSARY.find((r) => r[0].test(String(name || ''))); return g ? g[1] : ''; }

const DOC_SYSTEM = `You help a patient understand their own medical document in plain, calm words (reading age 12). You receive a list of facts already extracted by code.
Output ONLY one JSON object: {"summary":"2 short sentences saying what kind of document this is and what it lists","terms":[{"name":"exact name from the list","meaning":"one plain sentence: what this test, medicine or term is in general"}],"questions":["3 to 5 short questions the patient could ask their clinician about this document"]}
Rules: explain what a term IS, never what the person's result means for their health. No diagnosis, no advice, no medicine instructions, no doses, no numbers. Do not say "you have". Questions must be neutral (for example "What does this result mean for me?"). At most 12 terms.`;

export async function explainDocWithAI(env, doc, facts) {
  const names = []; for (const f of facts) if (f.name && !names.includes(f.name)) names.push(f.name);
  const listed = names.slice(0, 14);
  const out = { mode: 'glossary', model: null, terms: [], summary: '', questions: [] };
  if (aiMode(env) === 'live' && listed.length) {
    const r = await callJson(env, DOC_SYSTEM, 'DOCUMENT TYPE: ' + String((doc && doc.meta && doc.meta.docType) || 'document') + '\nFACTS: ' + JSON.stringify(listed), { maxTokens: 2500, timeoutMs: 45000 });
    if (r.ok && r.data) {
      out.mode = 'live'; out.model = r.model;
      out.summary = safeMeaning(r.data.summary);
      out.terms = (Array.isArray(r.data.terms) ? r.data.terms : []).filter((t) => t && listed.includes(t.name)).map((t) => ({ name: t.name, meaning: safeMeaning(t.meaning) })).filter((t) => t.meaning);
      out.questions = (Array.isArray(r.data.questions) ? r.data.questions : []).map((q) => String(q || '').replace(/\s+/g, ' ').trim()).filter((q) => q && q.length <= 140 && q.endsWith('?') && !GUARD.test(q)).slice(0, 5);
    } else out.aiError = r.error || 'unavailable';
  } else if (aiMode(env) === 'off') out.aiError = 'not_configured';
  // Fill every gap from the built-in glossary so the patient always gets something useful.
  for (const n of listed) if (!out.terms.some((t) => t.name === n)) { const g = glossaryFor(n); if (g) out.terms.push({ name: n, meaning: g, builtin: true }); }
  if (!out.summary) out.summary = 'This is a ' + String((doc && doc.meta && doc.meta.docType) || 'health document').replace(/_/g, ' ') + ' with ' + facts.length + ' item' + (facts.length === 1 ? '' : 's') + ' that Orbit could read.';
  if (!out.questions.length) out.questions = ['What do these results mean for me?', 'Is anything here something we should follow up on?', 'When should I have these checked again?'];
  return out;
}

/* ------------------------------------------------------------------ photo of a paper report -> text
   Muse Spark Open is a vision-language model. This step ONLY copies the words in the photo. It does not interpret anything.
   The person sees the copied text and checks it against the paper before it is analysed, and every later fact must quote it. */
const PHOTO_SYSTEM = `You are a careful transcriber of photos of medical documents. Copy ALL the text you can see, line by line, exactly as written. Keep every number, unit, date, name and reference range exactly as printed. Keep table rows on one line, with cells separated by two spaces.
Do NOT interpret, summarise, correct, translate, calculate or add anything. If a word or number cannot be read with certainty, write [unclear] in its place. If the picture contains no document text, reply with exactly NO_TEXT.
Output only the copied text. No introduction, no markdown.`;
export async function readPhotoWithAI(env, dataUrl) {
  if (aiMode(env) === 'mock') return { ok: false, error: 'mock_no_vision' };
  if (aiMode(env) !== 'live') return { ok: false, error: 'not_configured' };
  const t0 = Date.now();
  try {
    const model = await resolveModel(env);
    const out = await metaChat(env, { model, temperature: 0, maxTokens: 4000, timeoutMs: 60000, messages: [
      { role: 'system', content: PHOTO_SYSTEM },
      { role: 'user', content: [{ type: 'text', text: 'Copy the text in this photo.' }, { type: 'image_url', image_url: { url: dataUrl } }] },
    ] });
    let text = String(out || '').replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').replace(/\r\n/g, '\n').trim();
    if (/^NO_TEXT\b/i.test(text)) text = '';
    text = text.slice(0, 40000);
    if (text.length < 20) return { ok: false, error: 'no_text_found', model, ms: Date.now() - t0 };
    return { ok: true, text, model, ms: Date.now() - t0, unclear: (text.match(/\[unclear\]/gi) || []).length };
  } catch (e) {
    const m = String(e && e.message || '');
    const st = e && e.status;
    const vision = st !== 402 && st !== 401 && st !== 429 && st !== 504 && /image|vision|multimodal|multi-modal|modalit|content.*(string|type)|image_url/i.test(m);
    return { ok: false, error: vision ? 'vision_unsupported' : reason(e), detail: m.slice(0, 160), ms: Date.now() - t0 };
  }
}

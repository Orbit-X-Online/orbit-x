// AI layer. The model proposes; code in intel.js decides. Every call is observable and every failure is survivable.
import { metaChat, listModels, MetaError } from './meta.js';
import { validateExtraction, validateExplanation, extractRules } from './intel.js';

let modelCache = { id: null, at: 0 };
export function aiMode(env) { return env.AI_MODE === 'mock' ? 'mock' : env.MODEL_API_KEY ? 'live' : 'off'; }
export function providerName(env) { const b = String(env.MODEL_BASE_URL || ''); return /baseten/i.test(b) ? 'Baseten (Meta Muse Spark Open)' : /meta\.ai/i.test(b) ? 'Meta Model API' : 'OpenAI-compatible endpoint'; }

export async function resolveModel(env) {
  const want = String(env.MODEL_TEXT || '').trim();
  if (want && want.toLowerCase() !== 'auto') return want;
  if (modelCache.id && Date.now() - modelCache.at < 600000) return modelCache.id;
  const ids = await listModels(env);
  const pick = ids.find((x) => /muse[-_ ]?spark/i.test(x)) || ids.find((x) => /muse/i.test(x));
  if (!pick) throw new MetaError('No Muse model found for this key. Models: ' + ids.slice(0, 8).join(', '), 404);
  modelCache = { id: pick, at: Date.now() };
  return pick;
}

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
function reason(e) { if (!(e instanceof MetaError)) return 'unexpected_error'; if (e.status === 504) return 'timeout'; if (e.status === 429) return 'rate_limited'; if (e.status === 404) return 'model_not_found'; if (e.status === 500) return 'not_configured'; return 'provider_unavailable'; }

async function callJson(env, system, user, opts = {}) {
  const t0 = Date.now();
  try {
    const model = await resolveModel(env);
    const out = await metaChat(env, { model, temperature: 0.1, maxTokens: opts.maxTokens || 2500, timeoutMs: opts.timeoutMs || 45000, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
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

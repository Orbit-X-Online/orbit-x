// Safety policy tests: information only. No diagnosis, no cause links, no self-care or medicine advice, rule-based emergency handling.
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { preCheck, unsafe, guardText, SAFE_FALLBACK } from '../src/safety.js';
import { loadData } from './load-data.mjs';
let n = 0; const ok = (m) => console.log('  ok ' + (++n) + ' ' + m);

// 1. input pre-check
for (const q of ['I have chest pain', 'I cannot breathe properly', 'my face is drooping and my speech is slurred', 'she fainted', 'worst headache of my life', 'bleeding heavily', 'tengo dolor de pecho', 'douleur dans la poitrine'])
  assert.equal(preCheck(q)?.type, 'emergency', q);
for (const q of ['I want to die', 'I am thinking of killing myself', 'quiero morir']) assert.equal(preCheck(q)?.type, 'selfharm', q);
for (const q of ['Should I take another tablet?', 'Is 150/95 normal?', 'Do I have diabetes?', 'What medicine should I take for this?', 'how do I lower my blood pressure', 'Can I stop my tablets', 'what is wrong with me', 'Is my blood pressure dangerous?'])
  assert.equal(preCheck(q)?.type, 'advice', q);
for (const q of ['What is HbA1c?', 'What does creatinine mean as a term?', 'Explain the word systolic', 'Which tests are in my lab report?', 'hello']) assert.equal(preCheck(q), null, q);
assert.match(preCheck('chest pain').reply, /112/); assert.match(preCheck('I want to die').reply, /112/); assert.doesNotMatch(preCheck('should I stop my tablets').reply, /stop taking|you should/i);
ok('input pre-check: emergency, self-harm and advice requests get fixed replies; plain definition questions pass');

// 2. output guard
for (const t of ['Sit down and rest for a few minutes.', 'Sip some water and measure again.', 'A headache can be linked to high blood pressure.', 'Dizziness can go with low blood pressure.', 'You should take your tablet.', 'Take 5 mg of amlodipine.', 'This is probably caused by stress.', 'Your reading is normal, nothing to worry about.', 'You have hypertension.', 'I recommend a low salt diet.', 'Stay calm and stay where you are.', 'It is a sign of infection.', 'Try ibuprofen.', 'Please take it when you can.'])
  assert.ok(unsafe(t), 'should block: ' + t);
for (const t of ['Creatinine is a waste product made by muscles.', 'There were 5 readings this week, averaging 142/88. Please share this with your doctor.', 'Ask your doctor, nurse or pharmacist about this result.', 'Call 112 now.', 'Most recent documented HbA1c: 6.1 % on 2026-09-02.']) assert.ok(!unsafe(t) || /\d\s?%/.test(t), 'should pass: ' + t);
assert.equal(guardText('Sit down and rest.'), SAFE_FALLBACK);
ok('output guard blocks advice, cause links, self-care, medicine names/doses, reassurance; lets factual text through');

// 3. front-end fixed text
const D = loadData();
const guideText = JSON.stringify(D.SYMPTOMS.map((g) => [g.about, g.steps]));
assert.ok(!/\b(rest|sit|lie down|sip|drink|water|measure|caused|linked|can happen when|go with)\b/i.test(guideText), 'symptom guide must hold no self-care or cause text');
assert.ok(D.SYMPTOMS.every((g) => /112|chest|breath|sudden|weakness|fainting|sight|vomiting|swelling|pain|fever/i.test(g.urgent) && g.steps.length >= 1));
ok('symptom guide: no self-care or cause links; 112 warning signs kept');

// 4. API behaviour. Emergency/advice replies must work with NO model key, and must never call the model.
let calls = 0; globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: 'Sit down and rest. It is caused by stress.' } }] })); };
const post = (env, q) => worker.fetch(new Request('https://t.test/api/assistant', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: q }] }) }), env);
let r = await post({}, 'I have chest pain'); let j = await r.json();
assert.equal(r.status, 200); assert.equal(j.safety, 'emergency'); assert.match(j.reply, /112/); assert.equal(calls, 0);
r = await post({}, 'Should I double my tablets?'); j = await r.json(); assert.equal(j.safety, 'advice'); assert.equal(calls, 0);
r = await post({}, 'I want to hurt myself'); j = await r.json(); assert.equal(j.safety, 'selfharm'); assert.match(j.reply, /112/); assert.equal(calls, 0);
r = await post({ ASSISTANT_CHAT: 'on', MODEL_API_KEY: 'k', MODEL_BASE_URL: 'https://api.meta.ai/v1', MODEL_TEXT: 'm' }, 'What is a systolic reading?'); j = await r.json();
assert.equal(calls, 1, 'definition questions do reach the model once'); assert.equal(j.reply, SAFE_FALLBACK, 'unsafe model text is replaced');
ok('assistant route: rules answer with no key and no model call; unsafe model text is replaced by the fixed fallback');

// 5. explain route output guard
globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'This is caused by stress, so rest.' } }] }));
r = await worker.fetch(new Request('https://t.test/api/explain', { method: 'POST', body: JSON.stringify({ sentence: 'Your pressure averaged 150/95 over 4 days.', evidence: [] }) }), { MODEL_API_KEY: 'k', MODEL_BASE_URL: 'https://api.meta.ai/v1', MODEL_TEXT: 'm' });
j = await r.json(); assert.equal(j.text, 'Your pressure averaged 150/95 over 4 days.');
ok('explain route falls back to the code-written sentence when the model output is unsafe');
// 6. chat switch: with ASSISTANT_CHAT=off the model is never called, emergencies still get their fixed reply
calls = 0; globalThis.fetch = async () => { calls++; return new Response('{}'); };
const off = { MODEL_API_KEY: 'k', MODEL_BASE_URL: 'https://api.meta.ai/v1', ASSISTANT_CHAT: 'off' };
r = await post(off, 'tell me a joke'); j = await r.json(); assert.equal(j.safety, 'chat_off'); assert.match(j.reply, /not a chatbot/); assert.equal(calls, 0);
r = await post(off, 'I have chest pain'); j = await r.json(); assert.equal(j.safety, 'emergency');
ok('free-text chat can be switched off: fixed reply, no model call, emergency rules still work');

// 7. durable rate limit: counted in the Durable Object, survives a fresh worker instance, falls back when the store errors
const store = new Map(); let rlCalls = 0;
const stubEnv = { ALERTS: { idFromName: (n) => n, get: (n) => ({ fetch: async (rq) => { rlCalls++; const u = new URL(rq.url), lim = +u.searchParams.get('limit'); const l = store.get(n) || []; if (l.length >= lim) return new Response(JSON.stringify({ ok: false, retry: 77 })); l.push(1); store.set(n, l); return new Response(JSON.stringify({ ok: true, retry: 0 })); } }) } };
const hit = () => worker.fetch(new Request('https://t.test/api/xlate', { method: 'POST', headers: { 'CF-Connecting-IP': '9.9.9.9' }, body: JSON.stringify({ lang: 'French', items: ['Hello there'] }) }), { ...stubEnv, MODEL_API_KEY: 'k', MODEL_BASE_URL: 'https://api.meta.ai/v1' });
globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '["Bonjour"]' } }] }));
let last; for (let i = 0; i < 41; i++) last = await hit();
assert.equal(last.status, 429); assert.equal(last.headers.get('Retry-After'), '77'); assert.ok(rlCalls >= 41);
ok('translation route limit is enforced by the durable store (41st request in the window is refused with Retry-After)');

// 8. language coverage and lab units
for (const t of ['Mo ni ìrora àyà', 'Mo dákú', 'chest dey pain me', 'I no fit breathe', 'Maumivu ya kifua', 'je n’arrive pas à respirer']) assert.equal(preCheck(t) && preCheck(t).type, 'emergency', t);
assert.equal(preCheck('what does eGFR mean'), null);
ok('emergency wording in Yoruba, Pidgin, Swahili and French (with or without accents) goes to the fixed emergency screen');
assert.equal(unsafe('eGFR was 62 mL/min/1.73 m2 on 2026-03-12.'), false);
assert.equal(unsafe('Creatinine 1.4 mg/dL and glucose 5.4 mmol/L were documented.'), false);
for (const t of ['Take 5 mg daily.', 'Dose is 10 mg/day.', 'The label says 500 mg twice a day.']) assert.equal(!!unsafe(t), true, t);
ok('lab units (mg/dL, mL/min) are allowed in explanations; doses are still blocked');


// 9. chat is off by default: with no setting at all (or any value but "on") the model is never called
calls = 0; globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] })); };
for (const e of [{}, { ASSISTANT_CHAT: '' }, { ASSISTANT_CHAT: 'yes' }]) { r = await post({ MODEL_API_KEY: 'k', MODEL_BASE_URL: 'https://api.meta.ai/v1', ...e }, 'tell me a joke'); j = await r.json(); assert.equal(j.safety, 'chat_off'); }
assert.equal(calls, 0);
ok('free-text chat is off unless ASSISTANT_CHAT is exactly "on"; the model is never called by default');
console.log('ALL SAFETY TESTS PASSED (' + n + ')');

import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { forgetModel } from '../src/meta.js';

const env = { MODEL_API_KEY: 'k', MODEL_BASE_URL: 'https://api.meta.ai/v1', WHATSAPP_VERIFY_TOKEN: 'tok',
  ALLOWED_ORIGINS: 'https://orbit-x.online', ASSETS: { fetch: async () => new Response('<html>') } };
const call = (path, init) => worker.fetch(new Request('https://t.test' + path, init), env);
const ask = () => call('/api/assistant', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });

let r = await call('/api/health'); assert.equal(r.status, 200);
assert.equal((await r.json()).metaKeyConfigured, true);

r = await call('/'); assert.equal(await r.text(), '<html>');

r = await call('/api/assistant', { method: 'POST', body: '{"messages":[]}' }); assert.equal(r.status, 400);
r = await call('/api/assistant', { method: 'POST', body: 'nope' }); assert.equal(r.status, 400);
r = await call('/api/assistant', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'system', content: 'x' }] }) }); assert.equal(r.status, 400);

let sent;
globalThis.fetch = async (url, init) => { sent = { url, init }; return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] })); };
r = await ask();
assert.equal(r.status, 200); assert.equal((await r.json()).reply, 'hello');
assert.equal(sent.url, 'https://api.meta.ai/v1/chat/completions');
assert.equal(sent.init.headers.Authorization, 'Bearer k');
const b = JSON.parse(sent.init.body); assert.equal(b.model, 'muse-spark-1.3'); assert.equal(b.messages[0].role, 'system');
assert.equal('reasoning_effort' in b, false);

globalThis.fetch = async () => new Response('secret detail', { status: 500 });
r = await ask(); assert.equal(r.status, 502); assert.ok(!(await r.text()).includes('secret'));
globalThis.fetch = async () => new Response('slow down', { status: 429 });
r = await ask(); assert.equal(r.status, 429);

r = await call('/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=tok&hub.challenge=abc'); assert.equal(await r.text(), 'abc');
r = await call('/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=abc'); assert.equal(r.status, 403);

r = await call('/api/health', { headers: { Origin: 'https://orbit-x.online' } }); assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://orbit-x.online');
r = await call('/api/health', { headers: { Origin: 'https://evil.test' } }); assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);

console.log('ALL SMOKE TESTS PASSED');

// Baseten: must sign in with "Api-Key", not "Bearer"; falls back to the other scheme on 403.
{
  const benv = { MODEL_API_KEY: 'bk', MODEL_BASE_URL: 'https://inference.baseten.co/v1', ASSETS: env.ASSETS };
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, auth: init.headers.Authorization }); return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] })); };
  let rr = await worker.fetch(new Request('https://t.test/api/assistant', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) }), benv);
  assert.equal(rr.status, 200);
  assert.ok(calls.length > 0 && calls.every((c) => c.auth === 'Api-Key bk'), 'Baseten calls use Api-Key');
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push(init.headers.Authorization); return new Response('{"error":"please check the api-key you provided"}', { status: 403 }); };
  rr = await worker.fetch(new Request('https://t.test/api/ai/status?test=1'), { ...benv, MODEL_API_KEY: 'zz' });
  const sj = await rr.json(); assert.equal(sj.test.ok, false); assert.equal(sj.test.error, 'key_rejected'); assert.ok(seen.includes('Api-Key zz') && seen.includes('Bearer zz'), 'both sign-in methods tried');
  console.log('BASETEN AUTH TESTS PASSED');
}

// Baseten with a hackathon key: /models may be refused, the model "reasons" before answering, and a payment problem must be named.
{
  const benv = { MODEL_API_KEY: 'bk', MODEL_BASE_URL: 'https://inference.baseten.co/v1', ASSETS: env.ASSETS };
  const ask2 = () => worker.fetch(new Request('https://t.test/api/assistant', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) }), benv);
  // 1. /models refused (key limited to one model): chat still works with the known hackathon model name
  forgetModel(); let chatBody = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/models')) return new Response('{"error":"please check the api-key you provided"}', { status: 403 });
    chatBody = JSON.parse(init.body); return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }));
  };
  let rr = await ask2(); assert.equal(rr.status, 200); assert.equal(chatBody.model, 'meta-models/muse-spark-open-1026');
  // 2. the model used its whole budget thinking and returned no text: one retry with more room
  forgetModel(); const budgets = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/models')) return new Response('{}', { status: 404 });
    const b = JSON.parse(init.body); budgets.push(b.max_tokens);
    return new Response(JSON.stringify({ choices: [{ message: { content: budgets.length === 1 ? '' : 'Here is the answer.' }, finish_reason: budgets.length === 1 ? 'length' : 'stop' }] }));
  };
  rr = await ask2(); assert.equal(rr.status, 200); assert.equal(budgets.length, 2); assert.ok(budgets[1] > budgets[0] && budgets[0] >= 800);
  // 3. the live test asks for enough room, and a payment problem gets its own clear name
  forgetModel(); let probeBudget = 0;
  globalThis.fetch = async (url, init) => { if (String(url).endsWith('/models')) return new Response('{}', { status: 404 }); probeBudget = JSON.parse(init.body).max_tokens; return new Response('{"error":"payment required"}', { status: 402 }); };
  rr = await worker.fetch(new Request('https://t.test/api/ai/status?test=1'), benv);
  const pj = await rr.json(); assert.equal(pj.test.error, 'no_credits'); assert.ok(probeBudget >= 400);
  // 4. reasoning text inside <think> tags is stripped from the answer
  forgetModel();
  globalThis.fetch = async (url) => String(url).endsWith('/models') ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ choices: [{ message: { content: '<think>planning the answer</think>Calm and clear.' } }] }));
  rr = await ask2(); assert.equal((await rr.json()).reply, 'Calm and clear.');
  console.log('BASETEN RESTRICTED-KEY / REASONING TESTS PASSED');
}

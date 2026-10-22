import assert from 'node:assert/strict';
import worker from '../src/worker.js';

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

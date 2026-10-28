// Thin Meta Model API client. Server-side only: the key never reaches the browser.
// The API is OpenAI-compatible (base URL https://api.meta.ai/v1, Bearer MODEL_API_KEY).

// Lists model ids the key can use (GET {base}/models). Used to find the Muse Spark slug without guessing.
export async function listModels(env) {
  if (!env.MODEL_API_KEY) throw new MetaError('MODEL_API_KEY is not set', 500);
  const base = (env.MODEL_BASE_URL || 'https://api.meta.ai/v1').replace(/\/+$/, '');
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + env.MODEL_API_KEY }, signal: ctrl.signal });
    if (!res.ok) throw new MetaError('Models list ' + res.status, 502);
    const j = await res.json();
    return (Array.isArray(j.data) ? j.data : []).map((m) => m && m.id).filter((x) => typeof x === 'string');
  } catch (e) { if (e instanceof MetaError) throw e; throw new MetaError('Could not reach model provider', 502); } finally { clearTimeout(timer); }
}

export class MetaError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'MetaError';
    this.status = status;
  }
}

export async function metaChat(env, { messages, model, temperature = 0.3, maxTokens, timeoutMs }) {
  if (!env.MODEL_API_KEY) throw new MetaError('MODEL_API_KEY is not set', 500);

  const base = (env.MODEL_BASE_URL || 'https://api.meta.ai/v1').replace(/\/+$/, '');
  const body = {
    model: model || env.MODEL_TEXT || 'muse-spark-1.3',
    messages,
    temperature,
  };
  // Opt-in only, so an unsupported parameter can never break the call.
  if (env.MODEL_REASONING) body.reasoning_effort = env.MODEL_REASONING;
  if (maxTokens) body.max_tokens = maxTokens;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || Number(env.MODEL_TIMEOUT_MS) || 25000);
  try {
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.MODEL_API_KEY },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new MetaError('Meta API ' + res.status + ': ' + detail, res.status === 429 ? 429 : 502);
    }
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof text !== 'string') throw new MetaError('Unexpected Meta API response shape', 502);
    return text;
  } catch (err) {
    if (err instanceof MetaError) throw err;
    if (err && err.name === 'AbortError') throw new MetaError('Meta API timed out', 504);
    throw new MetaError('Could not reach Meta API', 502);
  } finally {
    clearTimeout(timer);
  }
}

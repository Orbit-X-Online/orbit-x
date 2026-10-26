// Durable Object: one instance per "room" holds the single live alert, so every phone sees the same state.
import { startAlert, advance, answer, decline, handled, view, validRole, DEFAULT_ESCALATE_MS } from './alert-logic.js';

const KEY = 'alert';

export class AlertHub {
  constructor(state, env) {
    this.state = state;
    this.escalateMs = Number(env.ESCALATE_MS) || DEFAULT_ESCALATE_MS;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const now = Date.now();
    const role = url.searchParams.get('role');
    let a = (await this.state.storage.get(KEY)) || null;
    const before = a && JSON.stringify(a);
    let result = { ok: true };

    if (req.method === 'POST') {
      let body = {};
      try { body = await req.json(); } catch { /* empty body is fine */ }
      const action = url.pathname.split('/').pop();
      a = advance(a, now, this.escalateMs);
      if (action === 'start') a = startAlert(a, body || {}, now);
      else if (action === 'reset') a = null;
      else if (!validRole(role)) result = { ok: false, error: 'bad_role' };
      else if (action === 'answer') result = answer(a, role, now);
      else if (action === 'decline') result = decline(a, role, now);
      else if (action === 'handled') result = handled(a, role, now);
      else result = { ok: false, error: 'unknown_action' };
    } else {
      a = advance(a, now, this.escalateMs);
    }

    const after = a && JSON.stringify(a);
    if (after !== before) { if (a) await this.state.storage.put(KEY, a); else await this.state.storage.delete(KEY); }
    return new Response(JSON.stringify({ ...result, ...view(a, validRole(role) ? role : null, now, this.escalateMs) }), {
      status: result.ok ? 200 : 409, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
}

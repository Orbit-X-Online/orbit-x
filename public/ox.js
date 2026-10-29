/* Shared helpers for the Orbit-X pages. Plain JS, no build step. */
window.OX = (function(){
  var SKEY = 'orbitx.session.v1';
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function session(){ try { return JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch(e){ return null; } }
  function need(role){ var s = session(); if (!s || s.role !== (role || 'patient')) { location.href = '/'; return null; } return s; }
  function api(method, path, body, headers){
    var s = session(), h = Object.assign({ 'Content-Type': 'application/json' }, headers || {});
    if (s && s.token && !h['X-Orbit-Key'] && !h.Authorization) h.Authorization = 'Bearer ' + s.token;
    return fetch(path, { method: method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)), cache: 'no-store' })
      .then(function(r){ return r.text().then(function(t){ var j; try { j = JSON.parse(t); } catch(e){ j = { raw: t.slice(0, 200) }; } j._status = r.status; return j; }); })
      .catch(function(){ return { ok: false, _status: 0, error: 'offline' }; });
  }
  function w(action, body, method){ var s = session(); return api(method || 'POST', '/api/w/' + s.pid + '/' + action, method === 'GET' ? undefined : (body || {})); }
  function ago(ms){ var d = new Date(ms); return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  function copy(text, btn){ function done(){ if (btn) { var o = btn.textContent; btn.textContent = 'Copied'; setTimeout(function(){ btn.textContent = o; }, 1300); } } try { navigator.clipboard.writeText(text).then(done, function(){ prompt('Copy this', text); }); } catch(e){ prompt('Copy this', text); } }
  function modal(){ var m = document.getElementById('modal'); if (!m) { m = document.createElement('div'); m.id = 'modal'; m.className = 'modal'; m.innerHTML = '<div class="sheet" id="sheet"></div>'; m.addEventListener('click', function(e){ if (e.target === m) m.classList.remove('on'); }); document.body.appendChild(m); document.addEventListener('keydown', function(e){ if (e.key === 'Escape') m.classList.remove('on'); }); } return m; }
  function openSheet(html){ var m = modal(); document.getElementById('sheet').innerHTML = html + '<div style="margin-top:14px"><button class="btn g" id="sheetclose">Close</button></div>'; m.classList.add('on'); document.getElementById('sheetclose').onclick = function(){ m.classList.remove('on'); }; }
  function aiBadge(ai){
    if (!ai) return '';
    var cls = ai.mode === 'live' ? 'live' : ai.mode === 'mock' ? 'mock' : 'off';
    var t = ai.mode === 'live' ? 'Meta Muse Spark Open via Baseten: live' : ai.mode === 'mock' ? 'MOCK AI (not a Meta model)' : 'AI off: rule-based only';
    return '<span class="badge ' + cls + '" title="' + esc(ai.provider || '') + '"><i></i>' + esc(t) + '</span>';
  }

  var BKEY = 'orbitx.session.backup';
  function today(){ var d = new Date(), p = function(n){ return ('0' + n).slice(-2); }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  // Opens a separate, pretend organisation account for the API demo. The person's own login is kept safe and can be restored.
  function enterSandbox(next){
    var cur = session();
    if (cur && cur.synthetic && cur.accountType === 'provider') { location.href = next || '/developer.html'; return Promise.resolve(true); }
    try { if (cur && !cur.synthetic) localStorage.setItem(BKEY, JSON.stringify(cur)); } catch(e){}
    return api('POST', '/api/create', { name: 'Amara Okafor', slots: [], today: today(), accountType: 'provider', org: 'Sandbox' }).then(function(j){
      if (!j || !j.ok) return false;
      try { localStorage.setItem(SKEY, JSON.stringify({ role: 'patient', pid: j.pid, token: j.token, name: 'Amara Okafor', synthetic: true, accountType: 'provider' })); } catch(e){ return false; }
      location.href = next || '/developer.html'; return true;
    });
  }
  function backBar(){
    var b = null; try { b = localStorage.getItem(BKEY); } catch(e){}
    var s = session(); if (!b || !s || !s.synthetic) return;
    var w = document.querySelector('.wrap'); if (!w) return;
    var d = document.createElement('div'); d.className = 'banner'; d.style.cssText = 'display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap';
    d.innerHTML = '<span>You are in the <b>demo sandbox</b> with a pretend patient.</span><button class="btn g s" id="bkacct">Back to my account</button>';
    w.insertBefore(d, w.firstChild);
    document.getElementById('bkacct').onclick = function(){ try { localStorage.setItem(SKEY, b); localStorage.removeItem(BKEY); } catch(e){} location.href = '/workspace.html'; };
  }
  try { backBar(); } catch(e){}
  return { enterSandbox: enterSandbox, esc: esc, session: session, need: need, api: api, w: w, ago: ago, copy: copy, openSheet: openSheet, aiBadge: aiBadge, SKEY: SKEY };
})();

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
  // The badge only says "live" after a real test call to the model succeeded. Tap it to see the test result.
  var aiTest = null;
  function aiBadge(ai){
    if (!ai) return '';
    var cls, t;
    if (ai.mode === 'mock') { cls = 'mock'; t = 'MOCK AI (not a Meta model)'; }
    else if (ai.mode !== 'live') { cls = 'off'; t = 'AI off: rule-based only'; }
    else if (aiTest === null) { cls = 'mock'; t = 'Checking the AI...'; }
    else if (aiTest.ok) { cls = 'live'; t = 'Meta Muse Spark Open via Baseten: live'; }
    else { cls = 'off'; t = 'AI key set but not working. Tap to see why'; }
    return '<button type="button" class="badge ' + cls + '" id="aibtn" style="background:none;color:inherit;cursor:pointer;font-family:inherit" title="' + esc(ai.provider || '') + '"><i></i>' + esc(t) + '</button>';
  }
  function checkAI(done){
    var c = null; try { c = JSON.parse(sessionStorage.getItem('orbitx.aitest') || 'null'); } catch(e){}
    if (c && Date.now() - c.at < 300000) { aiTest = c.r; if (done) done(); return; }
    api('GET', '/api/ai/status?test=1').then(function(j){
      aiTest = j && j.test ? j.test : { ok: false, error: 'Could not reach the server' };
      try { sessionStorage.setItem('orbitx.aitest', JSON.stringify({ at: Date.now(), r: aiTest })); } catch(e){}
      if (done) done();
    });
  }
  function aiDetails(){
    var r = aiTest || { ok: false, error: 'Not tested yet' };
    openSheet('<h2 style="margin-top:0">AI connection test</h2><div class="banner ' + (r.ok ? 'green' : 'red') + '">' + (r.ok ? 'The model answered. Document reading and plain-language explanations are using it.' : 'The model did not answer. Orbit keeps working with its built-in reader and word list, so nothing is lost.') + '</div>' +
      '<div class="kv"><span>Provider</span><span>' + esc(r.provider || '-') + '</span><span>Model</span><span>' + esc(r.model || '-') + '</span><span>Sign-in method</span><span>' + esc(r.authScheme || '-') + '</span><span>Time</span><span>' + (r.ms ? r.ms + ' ms' : '-') + '</span>' + (r.error ? '<span>Problem</span><span>' + esc(r.error) + '</span>' : '') + '</div>' +
      (r.hint ? '<p class="small">' + esc(r.hint) + '</p>' : '') + '<button class="btn" id="aire">Test again</button>');
    var b = document.getElementById('aire'); if (b) b.onclick = function(){ try { sessionStorage.removeItem('orbitx.aitest'); } catch(e){} aiTest = null; b.disabled = true; b.textContent = 'Testing...'; checkAI(function(){ aiDetails(); var el = document.getElementById('aib'); if (el) { el.innerHTML = aiBadge({ mode: 'live' }); bindBadge(); } }); };
  }
  function bindBadge(){ var b = document.getElementById('aibtn'); if (b) b.onclick = aiDetails; }
  function friendlyAiError(code){
    var c = String(code || '');
    if (/key_rejected/.test(c)) return 'The AI provider did not accept the access key.';
    if (/not_configured/.test(c)) return 'The AI is not switched on for this app.';
    if (/timeout/.test(c)) return 'The AI took too long to answer.';
    if (/rate_limited/.test(c)) return 'The AI is busy right now.';
    if (/model_not_found/.test(c)) return 'The AI model was not found.';
    if (/malformed|invalid_schema|no_valid_facts/.test(c)) return 'The AI answer could not be checked, so it was not used.';
    return 'The AI was not available this time.';
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
  return { enterSandbox: enterSandbox, esc: esc, session: session, need: need, api: api, w: w, ago: ago, copy: copy, openSheet: openSheet, aiBadge: aiBadge, checkAI: checkAI, bindBadge: bindBadge, friendlyAiError: friendlyAiError, SKEY: SKEY };
})();

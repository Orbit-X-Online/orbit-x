/* Orbit-X: any language, on every screen.
   Orbit-X is written in English and checked in English. This file asks the server to translate what is on the screen into the
   person's language, keeps every number exactly as it was, and remembers each translation on this phone.
   If a translation cannot be made, or fails the server's checks, the English text simply stays. Document text (<pre>), typed text,
   keys and charts are never translated. */
window.OXLang = (function () {
  var LANGS = [['English', 'en-NG'], ['Nigerian Pidgin', 'en-NG'], ['Yoruba', 'yo-NG'], ['Hausa', 'ha-NG'], ['Igbo', 'ig-NG'], ['French', 'fr-FR'], ['Spanish', 'es-ES'], ['Portuguese', 'pt-PT'], ['Arabic', 'ar-SA'], ['Swahili', 'sw-KE'], ['Hindi', 'hi-IN'], ['Chinese (Mandarin)', 'zh-CN'], ['German', 'de-DE'], ['Amharic', 'am-ET'], ['Zulu', 'zu-ZA'], ['Twi', 'ak-GH']];
  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lset(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function pid() { try { var s = JSON.parse(localStorage.getItem('orbitx.session.v1') || 'null'); return (s && s.pid) || ''; } catch (e) { return ''; } }
  function isEng(l) { return !l || /^(english|en)\b/i.test(l); }
  /* the chosen language: this account's choice, else this phone's choice, else the phone's own language */
  function chosen() { var l = ls('oxlang-' + pid()); if (l === null) l = ls('oxlang-'); return l; }
  function get() {
    var l = chosen();
    if (l === null || l === undefined) {
      try { var nl = (navigator.language || 'en').split('-')[0]; l = nl === 'en' ? '' : (new Intl.DisplayNames(['en'], { type: 'language' }).of(nl) || ''); } catch (e) { l = ''; }
    }
    return isEng(l) ? '' : String(l);
  }
  function tag() {
    var l = get(); if (!l) return '';
    for (var i = 0; i < LANGS.length; i++) if (LANGS[i][0].toLowerCase() === l.toLowerCase()) return LANGS[i][1];
    try { var nl = (navigator.language || '').split('-')[0]; if (nl && new Intl.DisplayNames(['en'], { type: 'language' }).of(nl) === l) return navigator.language; } catch (e) {}
    return '';
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function options() {
    var cur = chosen(); if (cur === null) cur = get(); var known = LANGS.some(function (x) { return x[0].toLowerCase() === String(cur).toLowerCase(); });
    var cs = isEng(cur) ? 'English' : cur;
    return LANGS.map(function (x) { return '<option value="' + esc(x[0]) + '"' + (x[0].toLowerCase() === cs.toLowerCase() ? ' selected' : '') + '>' + esc(x[0]) + '</option>'; }).join('') + '<option value="__o"' + (!known && !isEng(cur) ? ' selected' : '') + '>Other language...</option>';
  }
  /* remember a choice on this phone (and for this account), then let the caller save it on the server and reload */
  function set(name) { name = String(name || '').trim() || 'English'; lset('oxlang-', name); var p = pid(); if (p) lset('oxlang-' + p, name); return name; }
  function valid(name) { return /^[\p{L}\p{M}][\p{L}\p{M} ()'.\-]{1,39}$/u.test(String(name || '').trim()); }

  /* ---- translation engine ---- */
  var MEM = {}, BAD = {}, waiters = {}, queue = [], QT = {}, OUT = {}, timer = null, flushing = false, noticed = false, failUntil = 0;
  function hsh(t) { var h = 5381; for (var i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  function ckey(lang, tpl) { return 'oxtr:' + hsh(lang) + ':' + hsh(tpl) + ':' + tpl.length; }
  function tokenise(text) { var toks = [], tpl = text.replace(/\d+(?:[.,:\/]\d+)*/g, function (m) { toks.push(m); return '[#' + (toks.length - 1) + ']'; }); return { tpl: tpl, toks: toks }; }
  function detok(out, toks) { return out.replace(/\[#(\d+)\]/g, function (m, i) { return toks[+i] !== undefined ? toks[+i] : m; }); }
  function note(msg) {
    var el = document.getElementById('oxtrn');
    if (!msg) { if (el) el.style.display = 'none'; return; }
    if (!el) { el = document.createElement('div'); el.id = 'oxtrn'; el.setAttribute('role', 'status'); el.setAttribute('data-notr', ''); el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(10px + env(safe-area-inset-bottom,0px));max-width:92%;background:#0b1a33;border:1px solid #2b5a9c;color:#cfe6ff;border-radius:999px;padding:6px 14px;font-size:12.5px;z-index:50;text-align:center'; document.body.appendChild(el); }
    el.textContent = msg; el.style.display = '';
  }
  /* ask for the translation of one English template; cb(translatedTemplate or null) */
  function request(lang, tpl, cb) {
    var k = ckey(lang, tpl);
    if (MEM[k] !== undefined) { cb(MEM[k]); return; }
    var c = ls(k); if (c) { MEM[k] = c; OUT[c] = 1; cb(c); return; }
    if (BAD[k] || Date.now() < failUntil) { cb(null); return; }
    (waiters[k] = waiters[k] || []).push(cb);
    if (queue.indexOf(k) < 0) { queue.push(k); QT[k] = tpl; }
    clearTimeout(timer); timer = setTimeout(flush, 120);
  }
  function done(k, out) {
    var ws = waiters[k] || []; delete waiters[k];
    if (out) { MEM[k] = out; OUT[out] = 1; lset(k, out); } else BAD[k] = 1;
    ws.forEach(function (f) { try { f(out || null); } catch (e) {} });
  }
  function drop(k) { var ws = waiters[k] || []; delete waiters[k]; delete QT[k]; ws.forEach(function (f) { try { f(null); } catch (e) {} }); }
  function flush() {
    if (flushing) { timer = setTimeout(flush, 200); return; }
    var lang = get(); if (!lang || !queue.length) { note(''); return; }
    var keys = [], tpls = [], size = 0;
    while (queue.length && keys.length < 24 && size < 4500) { var k = queue.shift(); keys.push(k); tpls.push(QT[k]); size += QT[k].length; delete QT[k]; }
    flushing = true; note('Translating into ' + lang + '...');
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, to = setTimeout(function () { try { ctl && ctl.abort(); } catch (e) {} }, 50000);
    fetch('/api/xlate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: lang, items: tpls }), signal: ctl ? ctl.signal : undefined, cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._s = r.status; return j; }); })
      .catch(function () { return { _s: 0 }; })
      .then(function (j) {
        clearTimeout(to); flushing = false;
        var items = j && j.ok && Array.isArray(j.items) ? j.items : null;
        if (items) { keys.forEach(function (k, i) { done(k, typeof items[i] === 'string' && items[i] ? items[i] : null); }); if (queue.length) flush(); else note(''); return; }
        /* the server could not translate: stop asking for a minute, keep the English, say so once */
        failUntil = Date.now() + (j._s === 429 ? 120000 : 60000); keys.forEach(drop); queue.splice(0).forEach(drop);
        if (!noticed) { noticed = true; note(j._s === 503 ? 'Translation is not switched on for this app yet. Showing English.' : j._s === 429 ? 'Translating too often. Showing English for now.' : 'Could not translate just now. Showing English.'); setTimeout(function () { note(''); }, 6000); } else note('');
      });
  }
  /* translate one sentence for speech or a caption: Promise of the text in the person's language (or the same text) */
  function t(text) {
    var lang = get(); text = String(text || '');
    if (!lang || text.length < 4 || text.length > 600) return Promise.resolve(text);
    var tk = tokenise(text);
    return new Promise(function (res) { request(lang, tk.tpl, function (out) { var f = out ? detok(out, tk.toks) : text; OUT[f.trim()] = 1; res(f); }); });
  }

  /* ---- walk the page ---- */
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1, CODE: 1, PRE: 1, NOSCRIPT: 1, SVG: 1, CANVAS: 1, IFRAME: 1 };
  function skipEl(el) {
    for (; el && el.nodeType === 1; el = el.parentElement) {
      if (SKIP[String(el.tagName).toUpperCase()] || el.hasAttribute('data-notr') || el.getAttribute('translate') === 'no' || (el.classList && (el.classList.contains('notranslate') || el.classList.contains('code')))) return true;
    }
    return false;
  }
  var LETTERS = /[A-Za-z]{2,}/;
  function scan() {
    var lang = get(); if (!lang || !document.body) return;
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null), n, nodes = [];
    while ((n = w.nextNode())) nodes.push(n);
    nodes.forEach(function (node) {
      var v = node.nodeValue; if (!v || node.__oxv === v || OUT[v.trim()]) return;
      var core = v.trim(); if (core.length < 3 || !LETTERS.test(core) || !node.parentElement || skipEl(node.parentElement)) return;
      var pre = v.slice(0, v.indexOf(core)), suf = v.slice(pre.length + core.length), tk = tokenise(core);
      request(lang, tk.tpl, function (out) {
        if (!out || node.nodeValue !== v) return;
        var nv = pre + detok(out, tk.toks) + suf; OUT[nv.trim()] = 1; node.nodeValue = nv; node.__oxv = nv;
      });
    });
    ['placeholder', 'aria-label', 'title'].forEach(function (attr) {
      Array.prototype.forEach.call(document.querySelectorAll('[' + attr + ']'), function (el) {
        var v = el.getAttribute(attr), rec = el.__oxa = el.__oxa || {};
        if (!v || rec[attr] === v || OUT[v] || v.length < 3 || !LETTERS.test(v) || skipEl(el)) return;
        var tk = tokenise(v);
        request(lang, tk.tpl, function (out) { if (!out || el.getAttribute(attr) !== v) return; var nv = detok(out, tk.toks); el.setAttribute(attr, nv); rec[attr] = nv; });
      });
    });
  }
  var st = null;
  function schedule() { clearTimeout(st); st = setTimeout(scan, 150); }
  function start() {
    scan();
    try { new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true }); } catch (e) {}
    var l = tag(); if (l) try { document.documentElement.lang = l.split('-')[0]; } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  return { get: get, tag: tag, options: options, set: set, valid: valid, t: t, rescan: function () { noticed = false; scan(); }, LANGS: LANGS, isEng: isEng };
})();

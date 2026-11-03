/* Orbit-X voice: ONE app voice for every language, plus reliable listening.
   - Speaking: one voice is chosen once and remembered on this phone (localStorage "oxvoice"). It is used for every language, so Orbit always sounds like Orbit.
     (A single voice cannot pronounce every language equally well; that depends on the phone.)
   - Text is read in sentence chunks so playback starts fast and can be interrupted at once: tap the face, tap the mic, or leave the page.
   - Listening uses the language chosen in OXLang (the one authoritative setting), says exactly what went wrong, and retries once where a retry can help.
   - Safety: voice only reads text the app already produced and the server already checked. As a last guard, text that looks like advice is never spoken. */
window.OXVoice = (function () {
  var KEY = 'oxvoice', current = null, token = 0, rec = null, listening = false;
  var ADVICE = /\b(sit down|lie down|sit or lie|rest for|get some rest|sip|drink (some |a glass of )?water|measure (it |your (blood pressure|bp) )?again|you should|you must|take (an? )?(extra|double|another)|stop taking|diagnos\w+|caused by|linked to)\b/i;
  var FALLBACK = 'Orbit-X cannot give medical advice. Please ask your doctor, nurse or pharmacist. If this is urgent, call 112 now.';
  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lset(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function supported() { return !!(window.speechSynthesis && window.SpeechSynthesisUtterance); }
  function recSupported() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }

  function pickVoice() {
    if (!supported()) return null;
    var list = speechSynthesis.getVoices() || []; if (!list.length) return current;
    var saved = ls(KEY), v = null;
    if (saved) v = list.filter(function (x) { return x.name === saved; })[0] || null;
    if (!v) {
      var en = list.filter(function (x) { return /^en[-_]/i.test(x.lang); });
      v = en.filter(function (x) { return /female|samantha|google uk english female|google us english|aria|jenny|libby|natural/i.test(x.name); })[0] || en.filter(function (x) { return x.localService; })[0] || en[0] || list[0];
      if (v) lset(KEY, v.name);
    }
    current = v; return v;
  }
  if (supported()) { try { pickVoice(); speechSynthesis.onvoiceschanged = function () { pickVoice(); }; } catch (e) {} }

  function clean(text) {
    var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return ADVICE.test(t) ? FALLBACK : t;
  }
  function chunks(text) {
    var parts = text.match(/[^.!?\u3002\u061F]+[.!?\u3002\u061F]*\s*/g) || [text], out = [], buf = '';
    parts.forEach(function (p) { if ((buf + p).length > 170 && buf) { out.push(buf.trim()); buf = p; } else buf += p; });
    if (buf.trim()) out.push(buf.trim());
    return out.length ? out : [text];
  }
  function stop() {
    token++; // makes every pending chunk callback a no-op
    if (supported()) { try { speechSynthesis.cancel(); } catch (e) {} }
  }
  /* speak(text, {onstart, onend, rate}) - onend always fires exactly once, also when interrupted or when speech is unavailable */
  function speak(text, o) {
    o = o || {}; var t = clean(text), my = ++token, ended = false;
    function end() { if (ended) return; ended = true; try { o.onend && o.onend(); } catch (e) {} }
    if (!t) { end(); return; }
    if (!supported()) { try { o.onstart && o.onstart(); } catch (e) {} setTimeout(end, Math.min(3500, 600 + t.length * 35)); return; }
    try { speechSynthesis.cancel(); } catch (e) {}
    var v = pickVoice(), parts = chunks(t), i = 0, started = false;
    function next() {
      if (my !== token) { end(); return; }
      if (i >= parts.length) { end(); return; }
      var u = new SpeechSynthesisUtterance(parts[i++]); u.rate = o.rate || 0.95; u.pitch = 1;
      if (v) { u.voice = v; u.lang = v.lang; } // same voice for every language
      var moved = false, wd1 = null, wd2 = null;
      function go(fn) { if (moved) return; moved = true; clearTimeout(wd1); clearTimeout(wd2); fn(); }
      u.onstart = function () { clearTimeout(wd1); if (!started) { started = true; try { o.onstart && o.onstart(); } catch (e) {} } };
      u.onend = function () { go(next); };
      u.onerror = function (e) { if (e && (e.error === 'interrupted' || e.error === 'canceled')) { go(end); return; } go(next); };
      /* watchdog: some phones never fire start/end; do not stay stuck on "Speaking" */
      wd1 = setTimeout(function () { if (my !== token) { go(end); return; } go(function () { try { speechSynthesis.cancel(); } catch (e) {} next(); }); }, 5000);
      wd2 = setTimeout(function () { if (my !== token) { go(end); return; } go(function () { try { speechSynthesis.cancel(); } catch (e) {} next(); }); }, 6000 + parts[i - 1].length * 120);
      try { speechSynthesis.speak(u); } catch (e) { go(end); }
    }
    setTimeout(next, 30); // lets cancel() settle (Chrome drops a speak() sent in the same tick)
  }

  var MSG = {
    'not-allowed': 'The microphone is blocked. Allow the microphone for this site in your browser settings, or type instead.',
    'service-not-allowed': 'Voice input is not allowed here. Please type instead.',
    'no-speech': 'I did not hear anything. Tap the microphone and speak again, or type.',
    'audio-capture': 'I cannot find a microphone on this device. Please type instead.',
    'network': 'Voice input needs an internet connection. Please check your signal, or type instead.',
    'language-not-supported': 'This browser cannot listen in that language. Please type instead.',
    'aborted': '', 'unsupported': 'Voice input is not available on this browser. Please type instead.', 'start-failed': 'The microphone could not start. Please type instead.'
  };
  function langTag() { try { return (window.OXLang && OXLang.tag && OXLang.tag()) || 'en-US'; } catch (e) { return 'en-US'; } }
  /* listen({onstart, onend, onresult(text), onerror(message)}) - a second tap stops listening. */
  function listen(o) {
    o = o || {}; var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    stop(); // never listen while speaking
    if (!SR) { o.onerror && o.onerror(MSG.unsupported, 'unsupported'); return false; }
    if (listening && rec) { try { rec.stop(); } catch (e) {} return true; }
    var retried = false, got = false;
    function begin() {
      var r;
      try { r = new SR(); r.lang = langTag(); r.interimResults = false; r.maxAlternatives = 1; r.continuous = false; } catch (e) { o.onerror && o.onerror(MSG['start-failed'], 'start-failed'); return; }
      rec = r;
      r.onstart = function () { listening = true; try { o.onstart && o.onstart(); } catch (e) {} };
      r.onresult = function (e) { var t = e.results && e.results[0] && e.results[0][0] && e.results[0][0].transcript; if (t) { got = true; try { o.onresult && o.onresult(String(t).trim()); } catch (er) {} } };
      r.onerror = function (e) {
        var code = (e && e.error) || 'unknown';
        if ((code === 'no-speech' || code === 'network') && !retried && !got) { retried = true; listening = false; setTimeout(begin, 250); return; } // one retry where a retry can help
        listening = false; var m = MSG[code]; if (m === undefined) m = 'Voice input stopped (' + code + '). Please type instead.';
        if (m) { try { o.onerror && o.onerror(m, code); } catch (er) {} }
      };
      r.onend = function () { listening = false; try { o.onend && o.onend(); } catch (e) {} };
      try { r.start(); } catch (e) { listening = false; o.onerror && o.onerror(MSG['start-failed'], 'start-failed'); }
    }
    begin(); return true;
  }
  function isListening() { return listening; }

  // Interrupt on tap of the face, or when the page is left or hidden.
  document.addEventListener('click', function (e) { var t = e.target; if (t && t.closest && t.closest('.stage, .vface, #face, #vf')) stop(); }, true);
  window.addEventListener('pagehide', stop); document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); });
  return { speak: speak, stop: stop, listen: listen, supported: supported, recSupported: recSupported, isListening: isListening, voiceName: function () { return ls(KEY) || ''; } };
})();

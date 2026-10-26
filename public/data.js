/* Orbit-X demo data + plain-code insight engine.
   The patient is FICTIONAL. Nothing here is real health data or medical advice. */
(function (root) {
  'use strict';
  var HIGH_MARGIN = 16; // mmHg above the patient's own usual (baseline) counts as "higher"
  var OFFS = [0, 1, -1, 0, 2, -1, 0, 1, -2, 0];
  var RISE = {
    18: [138, 88], 19: [140, 89], 20: [143, 91], 21: [147, 92], 22: [150, 94], 23: [152, 95],
    24: [153, 96], 25: [155, 97], 26: [156, 98], 27: [160, 100], 28: [158, 98], 29: [148, 92], 30: [138, 88]
  };
  var MID = { 13: [131, 84], 14: [130, 84], 15: [132, 85], 16: [130, 83], 17: [131, 84] };
  var MISSED_EVENING = { 11: 1, 20: 1, 21: 1, 23: 1, 25: 1, 26: 1, 27: 1 };

  function buildDays() {
    var days = [];
    for (var d = 1; d <= 30; d++) {
      var sys, dia;
      if (d <= 10) { sys = 128 + OFFS[d - 1]; dia = OFFS[d - 1] > 0 ? 83 : 82; }
      else if (d === 11) { sys = 129; dia = 82; }
      else if (d === 12) { sys = 134; dia = 86; }
      else if (d <= 17) { sys = MID[d][0]; dia = MID[d][1]; }
      else { sys = RISE[d][0]; dia = RISE[d][1]; }
      days.push({ day: d, sys: sys, dia: dia, morning: true, evening: !MISSED_EVENING[d] });
    }
    return days;
  }

  function median(a) {
    var s = a.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function dayList(list) {
    var n = list.map(function (d) { return d.day; });
    return (n.length === 1 ? 'Day ' : 'Days ') + n.join(', ');
  }

  // Finds patterns with plain code. The AI only ever explains what this returns.
  function analyze(days, today) {
    var upto = days.filter(function (d) { return d.day <= today; });
    if (!upto.length) return { level: 'ok', sentence: 'No readings yet.', short: 'No readings yet.', evidence: [], streak: 0, missedCount: 0 };
    var baseline = median(upto.slice(0, 10).map(function (d) { return d.sys; }));
    var last = upto[upto.length - 1];
    var win = upto.slice(-7);
    var missed = win.filter(function (d) { return !d.evening; });
    var streak = 0;
    for (var i = upto.length - 1; i >= 0; i--) {
      if (upto[i].sys >= baseline + HIGH_MARGIN) streak++; else break;
    }
    var out = { level: 'ok', baseline: baseline, streak: streak, missedCount: missed.length, last: last, win: win, missed: missed, evidence: [] };

    if (streak >= 3 && missed.length >= 2) {
      out.level = 'pattern';
      out.sentence = 'Your pressure has been higher for ' + streak + ' days. You also missed ' + missed.length + ' evening tablets this week.';
      out.short = 'Your pressure has been higher for ' + streak + ' days. Want to see why?';
      out.suggestion = 'Want me to remind you earlier in the evening, with dinner?';
    } else if (!last.evening) {
      out.level = 'calm';
      out.sentence = 'You missed last night\'s evening tablet. One miss happens. Let\'s get back on track tonight.';
      out.short = out.sentence;
    } else {
      out.sentence = 'Your recent readings are close to your usual range. Keep going.';
      out.short = out.sentence;
    }

    if (missed.length) out.evidence.push({ title: dayList(missed), text: 'Evening tablet missed' });
    var first = win[0];
    if (win.length > 1 && last.sys > first.sys) {
      out.evidence.push({ title: 'Day ' + first.day + ' to day ' + last.day, text: first.sys + '/' + first.dia + ' rose to ' + last.sys + '/' + last.dia });
    }
    // an earlier, isolated miss that did NOT raise an alarm (shows the engine does not over-alert)
    var lone = null;
    for (var j = 0; j < upto.length; j++) {
      var u = upto[j];
      if (!u.evening && u.day < first.day) {
        var prev = upto[j - 1], next = upto[j + 1];
        if ((!prev || prev.evening) && (!next || next.evening)) { lone = u; break; }
      }
    }
    if (lone) out.evidence.push({ title: 'Day ' + lone.day, text: 'One missed dose, no alert (normal)' });
    return out;
  }

  function isEmergencyReading(sys, dia) { return sys >= 180 || dia >= 120; }

  var EMERGENCY = ['chest pain', 'chest dey pain', 'chest dey hurt', 'pain in my chest', 'pain in chest',
    'cannot breathe', "can't breathe", 'cant breathe', 'no fit breathe', 'difficulty breathing', 'hard to breathe',
    'face is drooping', 'face drooping', 'slurred', 'weak on one side', 'one side weak', 'one side of my body',
    'fainted', 'passed out', 'unconscious', 'vomiting blood', 'coughing blood', 'severe headache'];
  function detectEmergency(text) {
    var t = ' ' + String(text || '').toLowerCase().replace(/[\u2019]/g, "'").replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ') + ' ';
    for (var i = 0; i < EMERGENCY.length; i++) if (t.indexOf(EMERGENCY[i]) > -1) return true;
    var head = /\bhead\b|headache/.test(t);
    var vision = /blur|double vision|cannot see|can't see|cant see|no see/.test(t);
    return head && vision;
  }

  function parseCommand(text) {
    var t = String(text || '').toLowerCase().replace(/[\u2019]/g, "'");
    var m = t.match(/(\d{2,3})\s*(?:over|\/|by|on)\s*(\d{2,3})/);
    if (m) {
      var s = +m[1], d = +m[2];
      if (s >= 60 && s <= 260 && d >= 30 && d <= 160 && s > d) return { type: 'log_bp', sys: s, dia: d };
    }
    if (/(took|taken|swallowed|just took).*(tablet|pill|medicine|drug)|(tablet|pill|medicine).*(taken|done)/.test(t)) {
      if (/\bnot\b|haven't|have not|didn't|did not|\bno\b/.test(t)) return { type: 'missed_med' };
      return { type: 'log_med' };
    }
    if (/(history|my week|how was|how am i|\bwhy\b|explain|pattern|proof|evidence|trend)/.test(t)) return { type: 'explain' };
    if (/^\s*(hi|hello|hey|good (morning|evening|afternoon))/.test(t)) return { type: 'greet' };
    if (/^\s*(yes|yeah|yep|correct|ok|okay|save it|right)\b/.test(t)) return { type: 'yes' };
    if (/^\s*(no|nope|cancel|wrong)\b/.test(t)) return { type: 'no' };
    return { type: 'chat' };
  }

  var api = { buildDays: buildDays, analyze: analyze, isEmergencyReading: isEmergencyReading,
    detectEmergency: detectEmergency, parseCommand: parseCommand, HIGH_MARGIN: HIGH_MARGIN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.OrbitData = api;
})(typeof window !== 'undefined' ? window : this);

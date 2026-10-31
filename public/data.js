/* Orbit-X plain-code insight engine.
   buildDays/analyze power the FICTIONAL demo story. analyzeReal works on a real person's own logs.
   Nothing here is medical advice. */
(function (root) {
  'use strict';
  var MIN_DAYS = 3;     // days of readings needed before Orbit starts to spot changes (was 5)
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


  /* ------------------------------------------------------------------
     REAL users: patterns from a person's own logged readings and doses.
     Plain code only. The AI never decides what the pattern is.
     ------------------------------------------------------------------ */
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function addDays(ymd, n) {
    var p = ymd.split('-'); var t = Date.UTC(+p[0], +p[1] - 1, +p[2]) + n * 86400000;
    return new Date(t).toISOString().slice(0, 10);
  }
  function fmtDate(ymd) { var p = ymd.split('-'); return MONTHS[+p[1] - 1] + ' ' + (+p[2]); }
  function listDates(arr) { return arr.map(fmtDate).join(', '); }
  function slotWord(slot) { return ['morning', 'afternoon', 'evening', 'night'].indexOf(slot) > -1 ? slot : 'evening'; }

  /* Reading bands. The line that matters is WHO (2021): hypertension is 140/90 or higher, confirmed on two
     different days. The finer steps follow the ISH 2020 global guideline, which is built for use in Africa and
     Asia as well as Europe: normal below 130/85, high-normal 130-139 / 85-89, grade 1 at 140/90, grade 2 at 160/100.
     WHO publishes no emergency number, so 180/110 or higher, the "severe" line used by national guidelines, is
     where the fixed emergency rule starts. Below 90/60 is flagged as low. The HIGHER of the two numbers decides.
     A band describes ONE reading. It is never a diagnosis.
     code/label keep their old meaning for the insight engine; name/tone/note are for the screens. */
  function bpBand(sys, dia) {
    if (sys >= 180 || dia >= 110) return { code: 'severe', label: 'very high (180/110 or more)', name: 'Very high', tone: 'bad', note: 'Very high. If you have chest pain, trouble breathing, weakness, confusion or a severe headache, call 112 now.' };
    if (sys >= 160 || dia >= 100) return { code: 'high2', label: 'high (160/100 or more)', name: 'High (grade 2)', tone: 'bad', note: 'High. Please tell your doctor soon.' };
    if (sys >= 140 || dia >= 90) return { code: 'high1', label: 'at or above 140/90', name: 'High (grade 1)', tone: 'warn', note: 'High. One reading is not a diagnosis. If it stays there, please tell your doctor.' };
    if (sys < 90 || dia < 60) return { code: 'ok', label: 'below 140/90', name: 'Low', tone: 'low', low: true, note: 'Lower than the usual range. If you feel faint, dizzy or unwell, tell your doctor or call 112.' };
    if (sys >= 130 || dia >= 85) return { code: 'ok', label: 'below 140/90', name: 'Slightly raised', tone: 'watch', note: 'A little above normal, but below the high line.' };
    return { code: 'ok', label: 'below 140/90', name: 'Normal', tone: 'ok', note: 'In the normal range.' };
  }
  function slotList(list) {
    var seen = [], out = [];
    list.forEach(function (m) { if (seen.indexOf(m.slot) < 0) { seen.push(m.slot); out.push(slotWord(m.slot)); } });
    return out.length ? out.join(' and ') + (out.length > 1 ? ' tablets' : ' tablet') : '';
  }

  function analyzeReal(readings, doses, slots, today, createdDate) {
    slots = slots || [];
    var byDate = {};
    (readings || []).forEach(function (r) { byDate[r.date] = r; }); // later reading of a day wins
    var dates = Object.keys(byDate).sort();
    var n = dates.length;
    var out = { level: 'learning', n: n, baseline: null, streak: 0, missed: [], evidence: [], win: [], last: null };
    var gone = {};
    (doses || []).forEach(function (d) { gone[d.date + '|' + d.slot] = true; });

    // doses not logged on the 7 days before today (today is still in progress)
    var missed = [];
    for (var k = 7; k >= 1; k--) {
      var d = addDays(today, -k);
      if (d <= (createdDate || '0000-00-00')) continue;
      slots.forEach(function (sl) { if (!gone[d + '|' + sl]) missed.push({ date: d, slot: sl }); });
    }
    out.missed = missed;
    var missDates = {}, missSlots = {}; missed.forEach(function (m) { missDates[m.date] = true; (missSlots[m.date] = missSlots[m.date] || []).push(m.slot); });
    out.win = dates.slice(-7).map(function (dt) { return { date: dt, sys: byDate[dt].sys, dia: byDate[dt].dia, missed: !!missDates[dt], missedSlots: missSlots[dt] || [] }; });
    if (n) out.last = byDate[dates[n - 1]];
    out.lastDate = n ? dates[n - 1] : null;

    if (n < MIN_DAYS) {
      out.sentence = n === 0
        ? 'Tell me your blood pressure when you measure it, like 130 over 85. After a few days I will learn what is usual for you.'
        : 'I am learning what is usual for you. ' + (MIN_DAYS - n) + ' more day' + (MIN_DAYS - n === 1 ? '' : 's') + ' of readings and I can start spotting changes.';
      out.short = out.sentence; return out;
    }
    var base = median(dates.slice(0, 10).map(function (dt) { return byDate[dt].sys; }));
    out.baseline = base;
    out.band = bpBand(out.last.sys, out.last.dia);
    var gap = Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(out.lastDate + 'T00:00:00Z')) / 86400000);
    if (gap > 3) {
      out.level = 'stale';
      out.sentence = 'I have not seen a reading for ' + gap + ' days. Shall we log one?';
      out.short = out.sentence; return out;
    }
    var streak = 0;
    if (out.lastDate >= addDays(today, -3)) {
      for (var i = n - 1; i >= 0; i--) { if (byDate[dates[i]].sys >= base + HIGH_MARGIN) streak++; else break; }
    }
    out.streak = streak;
    var yest = addDays(today, -1);
    var missedYest = missed.filter(function (m) { return m.date === yest; });

    if (streak >= 3 && missed.length >= 2) {
      out.level = 'pattern';
      out.sentence = 'Your pressure has been higher than your usual for ' + streak + ' days. You also missed ' + missed.length + ' tablets this week.';
      out.short = 'Your pressure has been higher than your usual for ' + streak + ' days. Want to see why?';
      out.suggestion = 'Want me to remind you earlier in the evening, with dinner?';
    } else if (streak >= 3) {
      out.level = 'watch';
      out.sentence = 'Your pressure has been higher than your usual for ' + streak + ' days. You may want to share this with your doctor.';
      out.short = out.sentence;
    } else if (out.lastDate >= addDays(today, -1) && (out.last.sys >= base + HIGH_MARGIN || out.band.code !== 'ok')) {
      var lr = out.last.sys + '/' + out.last.dia, rel = out.last.sys >= base + HIGH_MARGIN;
      out.level = 'high';
      out.sentence = 'Your last reading, ' + lr + ', is ' + (rel ? 'higher than your usual of about ' + base + '.' : out.band.label + '.') +
        (missedYest.length ? ' You also did not log your ' + slotList(missedYest) + ' yesterday.' : '') +
        ' One reading is not a diagnosis. You may want to share this with your doctor.';
      out.short = out.sentence;
    } else if (missedYest.length) {
      out.level = 'calm';
      out.sentence = 'You did not log your ' + slotList(missedYest) + ' yesterday. One miss happens. Let us get back on track today.';
      out.short = out.sentence;
    } else {
      out.level = 'ok';
      out.sentence = 'Your recent readings are close to your usual range. Keep going.';
      out.short = out.sentence;
    }

    if (out.level === 'high') out.evidence.push({ title: fmtDate(out.lastDate), text: out.last.sys + '/' + out.last.dia + ' (your usual is about ' + base + '; this reading is ' + out.band.label + ')' });
    var hi = [];
    for (var j = n - 1; j >= 0 && out.level !== 'high' && hi.length < Math.min(streak, 4); j--) hi.unshift(dates[j]);
    hi.forEach(function (dt) { out.evidence.push({ title: fmtDate(dt), text: byDate[dt].sys + '/' + byDate[dt].dia + ' (your usual is about ' + base + ')' }); });
    ['morning', 'afternoon', 'evening', 'night'].forEach(function (sl) {
      var ds = missed.filter(function (m) { return m.slot === sl; }).map(function (m) { return m.date; });
      if (ds.length) out.evidence.push({ title: listDates(ds), text: slotWord(sl) + ' tablet not logged' });
    });
    return out;
  }

  // Which dose is "now"? Used when someone says "I took my tablet".
  function slotForNow(slots, hour) {
    if (!slots || !slots.length) return null;
    if (slots.length === 1) return slots[0];
    var centre = { morning: 8, afternoon: 14, evening: 19, night: 22 }, best = slots[0], bd = 99;
    slots.forEach(function (sl) { var c = centre[sl] == null ? 19 : centre[sl], d = Math.abs(hour - c); d = Math.min(d, 24 - d); if (d < bd) { bd = d; best = sl; } });
    return best;
  }

  function isEmergencyReading(sys, dia) { return sys >= 180 || dia >= 110; }

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


  var api = { buildDays: buildDays, analyze: analyze, analyzeReal: analyzeReal, slotForNow: slotForNow, addDays: addDays, fmtDate: fmtDate,
    isEmergencyReading: isEmergencyReading, detectEmergency: detectEmergency, parseCommand: parseCommand, HIGH_MARGIN: HIGH_MARGIN, bpBand: bpBand, slotList: slotList };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.OrbitData = api;
})(typeof window !== 'undefined' ? window : this);

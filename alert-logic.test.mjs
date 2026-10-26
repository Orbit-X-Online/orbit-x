import assert from 'node:assert/strict';
import { startAlert, advance, answer, decline, handled, view, DEFAULT_ESCALATE_MS as E } from '../src/alert-logic.js';

let a = startAlert(null, { sys: 186, dia: 114, why: 'High reading' }, 1000);
assert.equal(a.status, 'ringing'); assert.equal(view(a, 'preye', 1000, E).alert.target, 'preye');
assert.equal(view(a, 'preye', 1000, E).alert.secondsLeft, 20);
// idempotent start
assert.equal(startAlert(a, { sys: 1, dia: 1 }, 2000), a);
// before timeout: still Preye
advance(a, 1000 + E - 1, E); assert.equal(a.idx, 0);
// timeout: Mama Ebi
advance(a, 1000 + E, E); assert.equal(a.idx, 1); assert.equal(view(a, 'mamaebi', 1000 + E, E).alert.target, 'mamaebi');
// Preye can no longer answer
assert.equal(answer(a, 'preye', 1000 + E + 1).ok, false);
// Mama Ebi answers, only she can mark handled
assert.equal(answer(a, 'mamaebi', 1000 + E + 5).ok, true);
assert.equal(handled(a, 'preye', 1000 + E + 6).ok, false);
assert.equal(handled(a, 'mamaebi', 1000 + E + 7).ok, true);
assert.equal(a.status, 'handled');
// advance does nothing after handled
advance(a, 1e9, E); assert.equal(a.status, 'handled');
// late poll catches up through the whole chain and ends honestly
let b = startAlert(null, { why: 'chest dey pain' }, 0);
assert.equal(b.sys, null);
advance(b, E * 5, E); assert.equal(b.status, 'unanswered'); assert.equal(b.exhausted, true);
assert.ok(b.log.some(l => /call 112/.test(l.text)));
// decline escalates immediately; declining the last caregiver ends the chain
let c = startAlert(null, { sys: 190, dia: 120 }, 0);
assert.equal(decline(c, 'mamaebi', 1).ok, false);
assert.equal(decline(c, 'preye', 1).ok, true); assert.equal(c.idx, 1);
assert.equal(decline(c, 'mamaebi', 2).ok, true); assert.equal(c.status, 'unanswered');
// a new alert can start after an ended one
assert.equal(startAlert(c, { sys: 190, dia: 120 }, 99).status, 'ringing');
// input is sanitised
const d = startAlert(null, { sys: 9999, dia: 'x', why: 'a'.repeat(500) }, 5);
assert.equal(d.sys, null); assert.equal(d.why.length, 200);
console.log('ALERT LOGIC TESTS PASSED');

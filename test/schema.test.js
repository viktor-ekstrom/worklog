import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyWeek, getISOWeekInfo } from '../src/utils.js';
import { normalizeWeek, SchemaValidationError, validateWeek } from '../src/schema.js';

function validWeek(date = new Date(2026, 8, 28)) {
  const week = createEmptyWeek(date);
  week.entries.push({ id: 'a', type: 'work', date: week.startDate, title: 'Ship feature', summary: 'Done' });
  return week;
}

test('ISO week boundaries use ISO week-year', () => {
  assert.equal(getISOWeekInfo(new Date(2027, 0, 1)).key, '2026-W53');
  assert.equal(getISOWeekInfo(new Date(2027, 0, 4)).key, '2027-W01');
});

test('valid weekly document passes validation', () => {
  const result = validateWeek(validWeek());
  assert.equal(result.valid, true, result.issues.join('\n'));
});

test('legacy unversioned document migrates to v1', () => {
  const week = validWeek();
  delete week.schemaVersion;
  delete week.weeklyReflection;
  const migrated = normalizeWeek(week, 'legacy');
  assert.equal(migrated.schemaVersion, 1);
  assert.deepEqual(migrated.weeklyReflection, { highlights: [], outcomes: [], challenges: [], learnings: [] });
});

test('entry date must belong to its weekly file', () => {
  const week = validWeek();
  week.entries[0].date = '2026-10-05';
  assert.throws(() => normalizeWeek(week), SchemaValidationError);
});

test('duplicate entry ids are rejected', () => {
  const week = validWeek();
  week.entries.push({ ...week.entries[0] });
  assert.throws(() => normalizeWeek(week), /not valid WorkLog data/);
});

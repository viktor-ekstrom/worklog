import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyWeek } from '../src/utils.js';
import { createBackupPayload, mergeImportDocuments, parseImportDocument } from '../src/backup.js';

const week = createEmptyWeek(new Date(2026, 8, 28));

test('full backup can be parsed for restore', () => {
  const payload = createBackupPayload([week]);
  const parsed = parseImportDocument(JSON.stringify(payload), 'backup.json');
  assert.equal(parsed.kind, 'backup');
  assert.equal(parsed.weeks[0].week, '2026-W40');
});

test('old MVP backup format remains restorable', () => {
  const parsed = parseImportDocument(JSON.stringify({ schemaVersion: 1, exportedAt: 'x', weeks: [week] }), 'old-backup.json');
  assert.equal(parsed.kind, 'backup');
});

test('duplicate weeks across selected imports are rejected before writing', () => {
  const a = parseImportDocument(JSON.stringify(week), 'one.json');
  const b = parseImportDocument(JSON.stringify(week), 'two.json');
  assert.throws(() => mergeImportDocuments([a, b]), /more than once/);
});

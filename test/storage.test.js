import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyWeek } from '../src/utils.js';
import { applyImport, inspectImportFiles, readWeek, writeWeek } from '../src/storage.js';

function notFound(name) {
  const error = new Error(`${name} not found`);
  error.name = 'NotFoundError';
  return error;
}

class MemoryFileHandle {
  constructor(name, content = '') { this.kind = 'file'; this.name = name; this.content = content; }
  async getFile() { const content = this.content; return { text: async () => content }; }
  async createWritable() {
    const self = this;
    let pending = '';
    return {
      async write(value) { pending = typeof value === 'string' ? value : String(value); },
      async close() { self.content = pending; },
      async abort() {}
    };
  }
}

class MemoryDirectoryHandle {
  constructor(name = 'root') { this.kind = 'directory'; this.name = name; this.children = new Map(); }
  async getDirectoryHandle(name, { create = false } = {}) {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'directory') throw new Error(`${name} is not a directory`);
      return existing;
    }
    if (!create) throw notFound(name);
    const child = new MemoryDirectoryHandle(name); this.children.set(name, child); return child;
  }
  async getFileHandle(name, { create = false } = {}) {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'file') throw new Error(`${name} is not a file`);
      return existing;
    }
    if (!create) throw notFound(name);
    const child = new MemoryFileHandle(name); this.children.set(name, child); return child;
  }
  async *entries() { yield* this.children.entries(); }
}

class MemoryUpload {
  constructor(name, data) { this.name = name; this.data = data; }
  async text() { return this.data; }
}

function makeWeek() {
  const week = createEmptyWeek(new Date(2026, 8, 28));
  week.entries.push({ id: 'e1', type: 'work', date: '2026-09-28', title: 'Implemented storage hardening', summary: 'Done' });
  return week;
}

test('write creates canonical and last-known-good recovery copy', async () => {
  const root = new MemoryDirectoryHandle();
  const week = makeWeek();
  await writeWeek(root, week);
  const canonical = await (await (await root.getDirectoryHandle('2026')).getFileHandle('2026-W40.json')).getFile();
  const backup = await (await (await (await root.getDirectoryHandle('backups')).getDirectoryHandle('2026')).getFileHandle('2026-W40.json')).getFile();
  assert.deepEqual(JSON.parse(await canonical.text()), week);
  assert.deepEqual(JSON.parse(await backup.text()), week);
});

test('corrupted canonical file self-recovers from backup and preserves corrupt copy', async () => {
  const root = new MemoryDirectoryHandle();
  const week = makeWeek();
  await writeWeek(root, week);
  const year = await root.getDirectoryHandle('2026');
  const canonical = await year.getFileHandle('2026-W40.json');
  canonical.content = '{ definitely broken';

  const recovered = await readWeek(root, new Date(2026, 8, 28));
  assert.equal(recovered.entries[0].id, 'e1');
  assert.doesNotThrow(() => JSON.parse(canonical.content));
  const recoveryYear = await (await root.getDirectoryHandle('recovery')).getDirectoryHandle('2026');
  assert.equal([...recoveryYear.children.keys()].some(name => name.startsWith('2026-W40-')), true);
});

test('invalid existing canonical is never overwritten', async () => {
  const root = new MemoryDirectoryHandle();
  const year = await root.getDirectoryHandle('2026', { create: true });
  const file = await year.getFileHandle('2026-W40.json', { create: true });
  file.content = '{broken';
  await assert.rejects(() => writeWeek(root, makeWeek()), /Refusing to overwrite/);
  assert.equal(file.content, '{broken');
});

test('explicit restore can repair a corrupt canonical after preserving it', async () => {
  const root = new MemoryDirectoryHandle();
  const year = await root.getDirectoryHandle('2026', { create: true });
  const file = await year.getFileHandle('2026-W40.json', { create: true });
  file.content = '{broken';
  const week = makeWeek();
  await applyImport(root, { kind: 'backup', weeks: [week] });
  assert.equal((await readWeek(root, new Date(2026, 8, 28))).entries[0].id, 'e1');
  const recoveryYear = await (await root.getDirectoryHandle('recovery')).getDirectoryHandle('2026');
  assert.equal([...recoveryYear.children.keys()].length, 1);
});

test('full backup is completely validated before restore and then applied', async () => {
  const root = new MemoryDirectoryHandle();
  const first = makeWeek();
  const second = createEmptyWeek(new Date(2026, 9, 5));
  second.entries.push({ id: 'e2', type: 'meeting', date: '2026-10-05', title: 'Architecture sync' });
  const upload = new MemoryUpload('backup.json', JSON.stringify({ backupFormatVersion: 1, weeks: [first, second] }));
  const plan = await inspectImportFiles([upload]);
  assert.equal(plan.weeks.length, 2);
  await applyImport(root, plan);
  assert.equal((await readWeek(root, new Date(2026, 8, 28))).entries.length, 1);
  assert.equal((await readWeek(root, new Date(2026, 9, 5))).entries.length, 1);
});

test('invalid restore payload fails before anything is written', async () => {
  const root = new MemoryDirectoryHandle();
  const bad = makeWeek();
  bad.entries[0].date = '2026-11-01';
  const upload = new MemoryUpload('backup.json', JSON.stringify({ backupFormatVersion: 1, weeks: [bad] }));
  await assert.rejects(() => inspectImportFiles([upload]), /not valid WorkLog data/);
  assert.equal(root.children.size, 0);
});

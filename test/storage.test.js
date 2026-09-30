import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyWeek } from '../src/utils.js';
import { applyImport, inspectImportFiles, readWeek, writeWeek, readAllWeeks, saveEntry, removeEntry, saveReflection } from '../src/storage.js';

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
  async removeEntry(name) { this.children.delete(name); }
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
  await applyImport(root, { kind: 'backup', weeks: [week] }, { overwrite: true });
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


test('failed destination write preserves original entry and its backup', async () => {
  const root = new MemoryDirectoryHandle();
  const week = makeWeek(); await writeWeek(root, week);
  const next = createEmptyWeek(new Date(2026, 9, 5)); await writeWeek(root, next);
  const year = await root.getDirectoryHandle('2026');
  const file = await year.getFileHandle(next.week + '.json');
  file.createWritable = async () => { throw new Error('Disk full'); };
  await assert.rejects(() => saveEntry(root, {...week.entries[0], date:'2026-10-05'}, week.entries[0]), /Disk full/);
  assert.equal((await readWeek(root, new Date(2026,8,28))).entries.length, 1);
  const backup = await (await (await root.getDirectoryHandle('backups')).getDirectoryHandle('2026')).getFileHandle(week.week+'.json');
  assert.equal(JSON.parse(backup.content).entries.length, 1);
});

test('failed source cleanup leaves destination safe and reports duplicate risk', async () => {
  const root = new MemoryDirectoryHandle(); const week = makeWeek(); await writeWeek(root,week);
  const file = await (await root.getDirectoryHandle('2026')).getFileHandle(week.week+'.json');
  file.createWritable = async () => { throw new Error('Read only'); };
  await assert.rejects(() => saveEntry(root,{...week.entries[0],date:'2026-10-05'},week.entries[0]), /original could not be removed/);
  assert.equal((await readWeek(root,new Date(2026,9,5))).entries.length,1);
  assert.equal((await readWeek(root,new Date(2026,8,28))).entries.length,1);
});

test('successful cross-week move and stale edits', async () => {
  const root = new MemoryDirectoryHandle(); const week = makeWeek(); await writeWeek(root,week);
  const moved={...week.entries[0],date:'2026-10-05'};
  await saveEntry(root,moved,week.entries[0]);
  assert.equal((await readWeek(root,new Date(2026,8,28))).entries.length,0);
  await assert.rejects(()=>saveEntry(root,{...moved,title:'Stale'},week.entries[0]),/changed/);
  await removeEntry(root,moved);
  assert.equal((await readWeek(root,new Date(2026,9,5))).entries.length,0);
});

test('imports require confirmation and retain the previous version', async () => {
  const root=new MemoryDirectoryHandle(); const week=makeWeek(); await writeWeek(root,week);
  const replacement={...week,entries:[]}; const plan={kind:'backup',weeks:[replacement]};
  await assert.rejects(()=>applyImport(root,plan),/Confirm replacement/);
  assert.equal((await readWeek(root,new Date(2026,8,28))).entries.length,1);
  await applyImport(root,plan,{overwrite:true});
  const history=await (await root.getDirectoryHandle('history')).getDirectoryHandle('2026');
  assert.ok([...history.children.values()].some(file=>JSON.parse(file.content).entries.length===1));
});

test('unreadable weeks block full export rather than being omitted', async () => {
  const root=new MemoryDirectoryHandle(); await writeWeek(root,makeWeek());
  const year=await root.getDirectoryHandle('2026');
  (await year.getFileHandle('2026-W41.json',{create:true})).content='{broken';
  await assert.rejects(()=>readAllWeeks(root),/No complete backup/);
});

test('preservation failure never overwrites a corrupt file', async () => {
  const root=new MemoryDirectoryHandle(); const week=makeWeek(); await writeWeek(root,week);
  const file=await (await root.getDirectoryHandle('2026')).getFileHandle(week.week+'.json');file.content='{broken';
  const original=root.getDirectoryHandle.bind(root);
  root.getDirectoryHandle=async(name,options)=>{if(name==='recovery')throw new Error('Cannot preserve');return original(name,options)};
  await assert.rejects(()=>readWeek(root,new Date(2026,8,28)),/unreadable/);
  assert.equal(file.content,'{broken');
  await assert.rejects(()=>applyImport(root,{kind:'week',weeks:[week]},{overwrite:true}),/Cannot preserve/);
  assert.equal(file.content,'{broken');
});

test('newer schema is not auto-replaced by an older backup', async () => {
  const root=new MemoryDirectoryHandle(); const week=makeWeek(); await writeWeek(root,week);
  const file=await (await root.getDirectoryHandle('2026')).getFileHandle(week.week+'.json');
  file.content=JSON.stringify({...week,schemaVersion:2});
  await assert.rejects(()=>readWeek(root,new Date(2026,8,28)),/newer/);
  assert.equal(JSON.parse(file.content).schemaVersion,2);
});

test('concurrent saves retain both entries and stale reflection is rejected', async () => {
  const root=new MemoryDirectoryHandle(); const week=makeWeek();
  await Promise.all([saveEntry(root,week.entries[0]),saveEntry(root,{...week.entries[0],id:'e2'})]);
  assert.equal((await readWeek(root,new Date(2026,8,28))).entries.length,2);
  const reflection={...week.weeklyReflection,highlights:['Delivered']};
  await saveReflection(root,new Date(2026,8,28),reflection,week.weeklyReflection);
  await assert.rejects(()=>saveReflection(root,new Date(2026,8,28),reflection,week.weeklyReflection),/changed elsewhere/);
});

test('read-after-write rejects valid but incorrect content', async () => {
  const root=new MemoryDirectoryHandle(); const week=makeWeek(); await writeWeek(root,week);
  const file=await (await root.getDirectoryHandle('2026')).getFileHandle(week.week+'.json');
  const old=file.content; file.createWritable=async()=>({write:async()=>{},close:async()=>{file.content=old}});
  await assert.rejects(()=>writeWeek(root,{...week,entries:[]}),/failed verification/);
  assert.equal((await readWeek(root,new Date(2026,8,28))).entries.length,1);
});

test('failed first write removes the empty file so saving can be retried', async()=>{
 const root=new MemoryDirectoryHandle();const year=await root.getDirectoryHandle('2026',{create:true});
 const get=year.getFileHandle.bind(year);let fail=true;
 year.getFileHandle=async(name,options)=>{const file=await get(name,options);if(fail)file.createWritable=async()=>{throw new Error('Disk full')};return file};
 await assert.rejects(()=>saveEntry(root,makeWeek().entries[0]),/Disk full/);
 assert.equal(year.children.size,0);fail=false;
 await saveEntry(root,makeWeek().entries[0]);assert.equal((await readWeek(root,new Date(2026,8,28))).entries.length,1);
});

test('a failed recovery-copy refresh does not report an unsaved canonical entry', async()=>{
 const root=new MemoryDirectoryHandle();const get=root.getDirectoryHandle.bind(root);
 root.getDirectoryHandle=async(name,options)=>{if(name==='backups')throw new Error('Backup unavailable');return get(name,options)};
 await saveEntry(root,makeWeek().entries[0]);
 assert.equal((await readWeek(root,new Date(2026,8,28))).entries.length,1);
});

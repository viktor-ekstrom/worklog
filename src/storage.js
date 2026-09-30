import { createEmptyWeek, getISOWeekInfo, parseLocalDate } from './utils.js';
import { createBackupPayload, mergeImportDocuments, parseImportDocument } from './backup.js';
import { normalizeWeek } from './schema.js';

const DB_NAME = 'worklog-local';
const STORE = 'handles';
const KEY = 'workspace-directory';
const BACKUP_DIR = 'backups';
const RECOVERY_DIR = 'recovery';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export const supportsFileSystemAccess = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export async function getRememberedDirectory() {
  if (!supportsFileSystemAccess) return null;
  try { return await idbGet(KEY); } catch { return null; }
}

export async function chooseDirectory() {
  if (!supportsFileSystemAccess) throw new Error('Direct folder access is not supported in this browser. Use Microsoft Edge or Google Chrome on desktop.');
  const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'worklog-data' });
  try { await idbSet(KEY, handle); } catch (error) { console.warn('Folder connected, but could not remember it for next time.', error); }
  return handle;
}

export async function forgetDirectory() {
  await idbDelete(KEY);
}

export async function ensurePermission(handle, prompt = false) {
  if (!handle) return false;
  const options = { mode: 'readwrite' };
  if ((await handle.queryPermission(options)) === 'granted') return true;
  if (prompt && (await handle.requestPermission(options)) === 'granted') return true;
  return false;
}

async function getYearDirectory(root, year, create = false) {
  return root.getDirectoryHandle(String(year), { create });
}

async function getNestedYearDirectory(root, parentName, year, create = false) {
  const parent = await root.getDirectoryHandle(parentName, { create });
  return parent.getDirectoryHandle(String(year), { create });
}

async function readText(handle) {
  const file = await handle.getFile();
  return file.text();
}

async function writeText(handle, text) {
  const writable = await handle.createWritable();
  try {
    await writable.write(text);
    await writable.close();
  } catch (error) {
    try { await writable.abort?.(); } catch {}
    throw error;
  }
}

async function writeJSONFile(directory, filename, data) {
  const handle = await directory.getFileHandle(filename, { create: true });
  await writeText(handle, `${JSON.stringify(data, null, 2)}\n`);
  return handle;
}

async function readValidatedHandle(handle, source) {
  const text = await readText(handle);
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) { throw new Error(`${source} contains invalid JSON: ${error.message}`); }
  return { text, week: normalizeWeek(parsed, source) };
}

async function getBackupHandle(root, weekKey, create = false) {
  const year = Number(weekKey.slice(0, 4));
  const dir = await getNestedYearDirectory(root, BACKUP_DIR, year, create);
  return dir.getFileHandle(`${weekKey}.json`, { create });
}

async function saveRecoveryCopy(root, weekKey, rawText, parent = RECOVERY_DIR) {
  const year = Number(weekKey.slice(0, 4));
  const dir = await getNestedYearDirectory(root, parent, year, true);
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(16).slice(2)}`;
  const handle = await dir.getFileHandle(`${weekKey}-${stamp}.json`, { create: true });
  await writeText(handle, rawText);
  if (await readText(handle) !== rawText) throw new Error('Recovery copy failed verification. Original file was not replaced.');
}

function verifyWeekKey(week, key) {
  if (week.week !== key) throw new Error(`File ${key}.json contains ${week.week}. Rename or repair the file before continuing.`);
  return week;
}

async function recoverFromBackup(root, weekKey, corruptText) {
  try {
    const backupHandle = await getBackupHandle(root, weekKey, false);
    const { week } = await readValidatedHandle(backupHandle, `Recovery copy for ${weekKey}`);
    verifyWeekKey(week, weekKey);
    await saveRecoveryCopy(root, weekKey, corruptText);
    const yearDir = await getYearDirectory(root, Number(weekKey.slice(0, 4)), true);
    await writeJSONFile(yearDir, `${weekKey}.json`, week);
    return week;
  } catch {
    return null;
  }
}

async function readWeekHandleWithRecovery(root, weekKey, fileHandle) {
  const rawText = await readText(fileHandle);
  try {
    let parsed;
    try { parsed = JSON.parse(rawText); }
    catch (error) { throw new Error(`Invalid JSON: ${error.message}`); }
    if (Number(parsed?.schemaVersion) > 1) throw new Error('This file requires a newer WorkLog version.');
    return verifyWeekKey(normalizeWeek(parsed, weekKey), weekKey);
  } catch (error) {
    if (error?.name === 'NotAllowedError' || /newer WorkLog|Rename or repair/.test(error.message)) throw error;
    const recovered = await recoverFromBackup(root, weekKey, rawText);
    if (recovered) {
      console.warn(`${weekKey} was invalid and has been restored from its last known-good recovery copy.`);
      return recovered;
    }
    throw new Error(`${weekKey}.json is unreadable and no valid recovery copy is available. WorkLog did not modify it. ${error.message}`);
  }
}

export async function readWeek(root, date) {
  const info = getISOWeekInfo(date);
  try {
    const yearDir = await getYearDirectory(root, info.year, false);
    const fileHandle = await yearDir.getFileHandle(`${info.key}.json`, { create: false });
    return await readWeekHandleWithRecovery(root, info.key, fileHandle);
  } catch (error) {
    if (error?.name === 'NotFoundError') return createEmptyWeek(date);
    throw error;
  }
}

export async function writeWeek(root, inputWeek, { allowRepair = false } = {}) {
  const week = normalizeWeek(inputWeek, 'Week being saved');
  const year = Number(week.week.slice(0, 4));
  const yearDir = await getYearDirectory(root, year, true);
  const filename = `${week.week}.json`;

  let hadExisting = false;
  // Preserve the currently valid canonical file before replacing it.
  try {
    const existingHandle = await yearDir.getFileHandle(filename, { create: false });
    hadExisting = true;
    const { week: existing, text } = await readValidatedHandle(existingHandle, `Existing ${filename}`);
    verifyWeekKey(existing, week.week);
    await saveRecoveryCopy(root, week.week, text, 'history');
    const backupDir = await getNestedYearDirectory(root, BACKUP_DIR, year, true);
    await writeJSONFile(backupDir, filename, existing);
  } catch (error) {
    if (error?.name !== 'NotFoundError') {
      if (!allowRepair) {
        // Normal edits never overwrite a canonical file that is already invalid.
        throw new Error(`Refusing to overwrite ${filename} because the existing file is not valid. ${error.message}`);
      }
      // An explicit import/restore may repair it, but preserve the damaged bytes first.
      const damagedHandle = await yearDir.getFileHandle(filename, { create: false });
      await saveRecoveryCopy(root, week.week, await readText(damagedHandle));
    }
  }

  let canonicalHandle;
  try {
    canonicalHandle = await writeJSONFile(yearDir, filename, week);
  } catch (error) {
    // getFileHandle(create:true) can leave an empty file when the first write fails.
    if (!hadExisting) {
      try {
        const created = await yearDir.getFileHandle(filename);
        if ((await readText(created)) === '') await yearDir.removeEntry(filename);
      } catch {}
    }
    throw error;
  }

  // Read-after-write verification. If this fails, put the previous backup back.
  try {
    const saved = await readValidatedHandle(canonicalHandle, `Saved ${filename}`);
    if (JSON.stringify(saved.week) !== JSON.stringify(week)) throw new Error('Saved content does not match the requested data.');
  } catch (error) {
    const recovered = await recoverFromBackup(root, week.week, await readText(canonicalHandle));
    throw new Error(recovered
      ? `Saving ${filename} failed verification. The previous valid version was restored.`
      : `Saving ${filename} failed verification and no recovery copy was available. ${error.message}`);
  }

  // Keep a last-known-good copy even after the first successful save.
  try {
    const backupDir = await getNestedYearDirectory(root, BACKUP_DIR, year, true);
    await writeJSONFile(backupDir, filename, week);
  } catch (error) {
    // The canonical save succeeded. Do not invite a retry that could duplicate an entry.
    const message = `${filename} was saved, but its recovery copy could not be refreshed. Export a backup when possible. ${error.message}`;
    console.warn(message);
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('worklog-storage-warning', { detail: message }));
  }
  return week;
}

export async function readAllWeeks(root) {
  const weeks = [];
  const failures = [];
  for await (const [yearName, yearHandle] of root.entries()) {
    if (yearHandle.kind !== 'directory' || !/^\d{4}$/.test(yearName)) continue;
    for await (const [name, handle] of yearHandle.entries()) {
      if (handle.kind !== 'file' || !/^\d{4}-W\d{2}\.json$/.test(name)) continue;
      const weekKey = name.slice(0, -5);
      try {
        if (weekKey.slice(0, 4) !== yearName) throw new Error(`${name} is in the wrong year folder.`);
        weeks.push(await readWeekHandleWithRecovery(root, weekKey, handle));
      } catch (error) {
        failures.push(error.message);
      }
    }
  }
  if (failures.length) throw new Error(`Some weekly files could not be read. No complete backup or overview can be produced. ${failures.join(' ')}`);
  return weeks.sort((a, b) => a.week.localeCompare(b.week));
}

export async function inspectImportFiles(files) {
  const documents = [];
  for (const file of files) documents.push(parseImportDocument(await file.text(), file.name));
  return mergeImportDocuments(documents);
}

// Serializes cooperating tabs; version checks also reject stale entry edits.
export async function withWriteLock(action) {
  if (globalThis.navigator?.locks) return navigator.locks.request('worklog-writes', action);
  const previous = pendingWrite;
  let release;
  pendingWrite = new Promise(resolve => { release = resolve; });
  await previous;
  try { return await action(); } finally { release(); }
}
let pendingWrite = Promise.resolve();

export async function getImportConflicts(root, plan) {
  const conflicts = [];
  for (const week of plan.weeks) {
    try {
      const dir = await getYearDirectory(root, Number(week.week.slice(0, 4)));
      await dir.getFileHandle(`${week.week}.json`);
      conflicts.push(week.week);
    } catch (error) { if (error.name !== 'NotFoundError') throw error; }
  }
  return conflicts;
}

export async function applyImport(root, plan, { overwrite = false } = {}) {
  return withWriteLock(async () => {
    const validated = mergeImportDocuments([{ kind: plan.kind, weeks: plan.weeks.map(week => normalizeWeek(week)) }]);
    const conflicts = await getImportConflicts(root, validated);
    if (conflicts.length && !overwrite) throw new Error(`Import would replace existing weeks: ${conflicts.join(', ')}. Confirm replacement first.`);
    const imported = [];
    try {
      for (const week of validated.weeks) {
        await writeWeek(root, week, { allowRepair: true });
        imported.push(week.week);
      }
    } catch (error) {
      throw new Error(`Import stopped. ${imported.length} of ${validated.weeks.length} weeks completed. Previous files are preserved under history/ or recovery/. ${error.message}`);
    }
    return imported;
  });
}

export async function importWeekFiles(root, files, options) {
  return applyImport(root, await inspectImportFiles(files), options);
}

function assertUnchanged(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('This entry changed in another tab or file. Close the editor, refresh, and try again.');
}

export async function saveEntry(root, entry, existing = null) {
  return withWriteLock(async () => {
    const targetDate = parseLocalDate(entry.date);
    const target = await readWeek(root, targetDate);
    let source;
    if (existing) {
      source = target.week === getISOWeekInfo(parseLocalDate(existing.date)).key ? target : await readWeek(root, parseLocalDate(existing.date));
      assertUnchanged(source.entries.find(item => item.id === existing.id), existing);
    }
    const collision = target.entries.find(item => item.id === entry.id);
    if (collision && source !== target) throw new Error('An entry with this ID already exists in the destination week. Review it before retrying.');
    target.entries = target.entries.filter(item => item.id !== entry.id);
    target.entries.push(entry);
    // Validate the entire destination before touching either file. Save destination first.
    normalizeWeek(target);
    await writeWeek(root, target);
    if (source && source !== target) {
      source.entries = source.entries.filter(item => item.id !== entry.id);
      try { await writeWeek(root, source); }
      catch (error) { throw new Error(`Entry saved in the destination week, but the original could not be removed. Check both weeks before retrying. ${error.message}`); }
    }
    return entry;
  });
}

export async function removeEntry(root, entry) {
  return withWriteLock(async () => {
    const week = await readWeek(root, parseLocalDate(entry.date));
    assertUnchanged(week.entries.find(item => item.id === entry.id), entry);
    week.entries = week.entries.filter(item => item.id !== entry.id);
    return writeWeek(root, week);
  });
}

export async function saveReflection(root, date, reflection, previous) {
  return withWriteLock(async () => {
    const week = await readWeek(root, date);
    if (JSON.stringify(week.weeklyReflection) !== JSON.stringify(previous)) throw new Error('Reflection changed elsewhere. Reopen it before saving.');
    week.weeklyReflection = reflection;
    return writeWeek(root, week);
  });
}

export function downloadBackup(weeks) {
  const payload = createBackupPayload(weeks);
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `worklog-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

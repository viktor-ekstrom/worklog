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
  await idbSet(KEY, handle);
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

async function saveRecoveryCopy(root, weekKey, rawText) {
  try {
    const year = Number(weekKey.slice(0, 4));
    const dir = await getNestedYearDirectory(root, RECOVERY_DIR, year, true);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const handle = await dir.getFileHandle(`${weekKey}-${stamp}.corrupt.json`, { create: true });
    await writeText(handle, rawText);
  } catch (error) {
    console.warn('Could not preserve corrupt file in recovery folder.', error);
  }
}

async function recoverFromBackup(root, weekKey, corruptText) {
  try {
    const backupHandle = await getBackupHandle(root, weekKey, false);
    const { week } = await readValidatedHandle(backupHandle, `Recovery copy for ${weekKey}`);
    await saveRecoveryCopy(root, weekKey, corruptText);
    const yearDir = await getYearDirectory(root, Number(weekKey.slice(0, 4)), true);
    await writeJSONFile(yearDir, `${weekKey}.json`, week);
    return week;
  } catch {
    return null;
  }
}

async function readWeekHandleWithRecovery(root, weekKey, fileHandle) {
  let rawText = '';
  try {
    rawText = await readText(fileHandle);
    let parsed;
    try { parsed = JSON.parse(rawText); }
    catch (error) { throw new Error(`Invalid JSON: ${error.message}`); }
    return normalizeWeek(parsed, weekKey);
  } catch (error) {
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

  // Preserve the currently valid canonical file before replacing it.
  try {
    const existingHandle = await yearDir.getFileHandle(filename, { create: false });
    const { week: existing } = await readValidatedHandle(existingHandle, `Existing ${filename}`);
    const backupDir = await getNestedYearDirectory(root, BACKUP_DIR, year, true);
    await writeJSONFile(backupDir, filename, existing);
  } catch (error) {
    if (error?.name !== 'NotFoundError') {
      if (!allowRepair) {
        // Normal edits never overwrite a canonical file that is already invalid.
        throw new Error(`Refusing to overwrite ${filename} because the existing file is not valid. ${error.message}`);
      }
      // An explicit import/restore may repair it, but preserve the damaged bytes first.
      try {
        const damagedHandle = await yearDir.getFileHandle(filename, { create: false });
        await saveRecoveryCopy(root, week.week, await readText(damagedHandle));
      } catch {}
    }
  }

  const canonicalHandle = await writeJSONFile(yearDir, filename, week);

  // Read-after-write verification. If this fails, put the previous backup back.
  try {
    await readValidatedHandle(canonicalHandle, `Saved ${filename}`);
  } catch (error) {
    const recovered = await recoverFromBackup(root, week.week, await readText(canonicalHandle));
    throw new Error(recovered
      ? `Saving ${filename} failed verification. The previous valid version was restored.`
      : `Saving ${filename} failed verification and no recovery copy was available. ${error.message}`);
  }

  // Keep a last-known-good copy even after the first successful save.
  const backupDir = await getNestedYearDirectory(root, BACKUP_DIR, year, true);
  await writeJSONFile(backupDir, filename, week);
  return week;
}

export async function readAllWeeks(root) {
  const weeks = [];
  for await (const [yearName, yearHandle] of root.entries()) {
    if (yearHandle.kind !== 'directory' || !/^\d{4}$/.test(yearName)) continue;
    for await (const [name, handle] of yearHandle.entries()) {
      if (handle.kind !== 'file' || !/^\d{4}-W\d{2}\.json$/.test(name)) continue;
      const weekKey = name.slice(0, -5);
      try {
        weeks.push(await readWeekHandleWithRecovery(root, weekKey, handle));
      } catch (error) {
        console.error(error);
      }
    }
  }
  return weeks.sort((a, b) => a.week.localeCompare(b.week));
}

export async function inspectImportFiles(files) {
  const documents = [];
  for (const file of files) documents.push(parseImportDocument(await file.text(), file.name));
  return mergeImportDocuments(documents);
}

export async function applyImport(root, plan) {
  // The plan has already been completely parsed and validated before any write starts.
  const imported = [];
  for (const week of plan.weeks) {
    await writeWeek(root, week, { allowRepair: true });
    imported.push(week.week);
  }
  return imported;
}

export async function importWeekFiles(root, files) {
  const plan = await inspectImportFiles(files);
  return applyImport(root, plan);
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

import { createEmptyWeek, getISOWeekInfo } from './utils.js';

const DB_NAME = 'worklog-local';
const STORE = 'handles';
const KEY = 'workspace-directory';

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

export const supportsFileSystemAccess = 'showDirectoryPicker' in window;

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

export async function readWeek(root, date) {
  const info = getISOWeekInfo(date);
  try {
    const yearDir = await getYearDirectory(root, info.year, false);
    const fileHandle = await yearDir.getFileHandle(`${info.key}.json`, { create: false });
    const file = await fileHandle.getFile();
    const parsed = JSON.parse(await file.text());
    return { ...createEmptyWeek(date), ...parsed, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch (error) {
    if (error?.name === 'NotFoundError') return createEmptyWeek(date);
    throw error;
  }
}

export async function writeWeek(root, week) {
  const year = Number(String(week.week).slice(0, 4));
  const yearDir = await getYearDirectory(root, year, true);
  const fileHandle = await yearDir.getFileHandle(`${week.week}.json`, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(`${JSON.stringify(week, null, 2)}\n`);
  await writable.close();
}

export async function readAllWeeks(root) {
  const weeks = [];
  for await (const [yearName, yearHandle] of root.entries()) {
    if (yearHandle.kind !== 'directory' || !/^\d{4}$/.test(yearName)) continue;
    for await (const [name, handle] of yearHandle.entries()) {
      if (handle.kind !== 'file' || !/^\d{4}-W\d{2}\.json$/.test(name)) continue;
      try {
        const file = await handle.getFile();
        const parsed = JSON.parse(await file.text());
        if (Array.isArray(parsed.entries)) weeks.push(parsed);
      } catch (error) {
        console.warn(`Skipping unreadable worklog file ${yearName}/${name}`, error);
      }
    }
  }
  return weeks.sort((a, b) => String(a.week).localeCompare(String(b.week)));
}

export async function importWeekFiles(root, files) {
  const imported = [];
  for (const file of files) {
    const parsed = JSON.parse(await file.text());
    if (!parsed.week || !/^\d{4}-W\d{2}$/.test(parsed.week) || !Array.isArray(parsed.entries)) {
      throw new Error(`${file.name} is not a valid WorkLog weekly file.`);
    }
    await writeWeek(root, parsed);
    imported.push(parsed.week);
  }
  return imported;
}

export function downloadBackup(weeks) {
  const payload = { schemaVersion: 1, exportedAt: new Date().toISOString(), weeks };
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

import http from 'node:http';
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWeek } from './src/schema.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const dataRoot = resolve(process.env.WORKLOG_DATA_DIR || join(root, 'data'));
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
let writeQueue = Promise.resolve();

const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const fail = (res, status, message) => json(res, status, { error: message });
const validWeek = key => /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(key);
const weekFile = key => join(dataRoot, key.slice(0, 4), `${key}.json`);

async function readWeekFile(key) {
  const text = await readFile(weekFile(key), 'utf8');
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { throw new Error(`${key}.json contains invalid JSON: ${error.message}`); }
  return normalizeWeek(parsed, key);
}

async function listWeeks() {
  const output = [];
  let years = [];
  try { years = await readdir(dataRoot, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const year of years) {
    if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
    for (const file of await readdir(join(dataRoot, year.name), { withFileTypes: true })) {
      if (!file.isFile() || !/^\d{4}-W\d{2}\.json$/.test(file.name)) continue;
      output.push(await readWeekFile(file.name.slice(0, -5)));
    }
  }
  return output.sort((a, b) => a.week.localeCompare(b.week));
}

async function saveWeekFile(key, payload, { allowRepair = false } = {}) {
  const week = normalizeWeek(payload, key);
  if (week.week !== key) throw new Error(`File ${key}.json contains ${week.week}.`);
  const target = weekFile(key);
  await mkdir(join(dataRoot, key.slice(0, 4)), { recursive: true });
  try {
    await stat(target);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      await readWeekFile(key);
      await mkdir(join(dataRoot, 'history', key.slice(0, 4)), { recursive: true });
      await copyFile(target, join(dataRoot, 'history', key.slice(0, 4), `${key}-${stamp}.json`));
      await mkdir(join(dataRoot, 'backups', key.slice(0, 4)), { recursive: true });
      await copyFile(target, join(dataRoot, 'backups', key.slice(0, 4), `${key}.json`));
    } catch (error) {
      if (error?.code === 'ENOENT') throw error;
      await mkdir(join(dataRoot, 'recovery', key.slice(0, 4)), { recursive: true });
      await copyFile(target, join(dataRoot, 'recovery', key.slice(0, 4), `${key}-${stamp}.json`));
      if (!allowRepair) throw new Error(`Refusing to overwrite ${key}.json because the existing file is not valid. ${error.message}`);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(week, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
  return week;
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 2_000_000) throw new Error('Request body is too large.'); }
  try { return JSON.parse(body); } catch { throw new Error('Request body must be valid JSON.'); }
}

async function api(req, res, pathname) {
  const match = pathname.match(/^\/api\/weeks(?:\/([^/]+))?$/);
  if (!match) return false;
  const key = match[1] ? decodeURIComponent(match[1]) : null;
  if (key && !validWeek(key)) { fail(res, 400, 'Invalid ISO week key.'); return true; }
  try {
    if (req.method === 'GET' && !key) { json(res, 200, await listWeeks()); return true; }
    if (req.method === 'GET' && key) {
      try { json(res, 200, await readWeekFile(key)); }
      catch (error) { if (error.code === 'ENOENT') fail(res, 404, 'Week not found.'); else throw error; }
      return true;
    }
    if (req.method === 'PUT' && key) {
      const payload = await readBody(req);
      const result = await (writeQueue = writeQueue.catch(() => {}).then(() => saveWeekFile(key, payload, { allowRepair: req.headers['x-worklog-allow-repair'] === 'true' })));
      json(res, 200, result); return true;
    }
    fail(res, 405, 'Method not allowed.'); return true;
  } catch (error) { fail(res, 400, error.message); return true; }
}

const server = http.createServer(async (req, res) => {
  try {
    const raw = decodeURIComponent((req.url || '/').split('?')[0]);
    if (await api(req, res, raw)) return;
    if (raw.startsWith('/api/')) { fail(res, 404, 'API route not found.'); return; }
    const relativePath = raw === '/' ? 'index.html' : raw.replace(/^\/+/, '');
    const filePath = normalize(join(root, relativePath));
    if (relative(root, filePath).startsWith('..')) throw new Error('Invalid path');
    const info = await stat(filePath);
    const target = info.isDirectory() ? join(filePath, 'index.html') : filePath;
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); }
});

server.listen(port, '127.0.0.1', () => { console.log(`WorkLog running at http://localhost:${port}`); console.log(`WorkLog data directory: ${dataRoot}`); });

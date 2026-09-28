import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const html = await readFile(path.join(root, 'index.html'), 'utf8');
const css = await readFile(path.join(root, 'styles.css'), 'utf8');
const modulePaths = [
  'src/utils.js',
  'src/schema.js',
  'src/backup.js',
  'src/storage.js',
  'src/app.js'
];

function inlineModule(source) {
  return source
    .replace(/import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*/g, '')
    .replace(/\bexport\s+/g, '');
}

const jsParts = [];
for (const relativePath of modulePaths) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  jsParts.push(`\n// ---- ${relativePath} ----\n${inlineModule(source).trim()}\n`);
}

const standalone = html
  .replace('<link rel="stylesheet" href="./styles.css" />', `<style>\n${css}\n</style>`)
  .replace('<script type="module" src="./src/app.js"></script>', `<script>\n${jsParts.join('\n')}\n</script>`)
  .replace('<title>WorkLog</title>', '<title>WorkLog</title>\n  <!-- Standalone build: double-click this file in Edge or Chrome; no local server is required. -->');

await writeFile(path.join(root, 'WorkLog.html'), standalone, 'utf8');
console.log('Built WorkLog.html');

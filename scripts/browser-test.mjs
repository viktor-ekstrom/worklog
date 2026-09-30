import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.TEST_OUTPUT || path.join(root, 'test-results'));
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'worklog-e2e-'));
let failWrite = '';
const browser = await chromium.launch({headless:true, ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH, args:['--no-sandbox','--disable-gpu','--disable-software-rasterizer','--disable-dev-shm-usage']} : {})});
const context = await browser.newContext({viewport:{width:1440,height:1000}, timezoneId:'Europe/Stockholm',acceptDownloads:true});
const errors=[];const results=[];
const page=await context.newPage();await page.clock.setFixedTime(new Date('2026-09-30T08:00:00+02:00'));page.on('pageerror',e=>errors.push(e.message));
// Only the native picker/handle boundary is substituted. Operations use real temporary files.
await context.exposeBinding('fileBridge', async (_, op, relative, value) => {
  try {
    const full=path.resolve(data,relative || '.');
    if(full!==data && !full.startsWith(data+path.sep))throw new Error('Invalid test path');
    if(op==='dir'){if(value)await fs.mkdir(full,{recursive:true});const stat=await fs.stat(full);if(!stat.isDirectory())throw new Error('Not directory');}
    if(op==='file'){if(value)await fs.writeFile(full,'',{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e});await fs.stat(full);}
    if(op==='read')return {value:await fs.readFile(full,'utf8')};
    if(op==='write'){if(failWrite && relative.endsWith(failWrite))throw new Error('Simulated write failure');await fs.writeFile(full,value);}
    if(op==='remove')await fs.rm(full);
    if(op==='entries')return {value:(await fs.readdir(full,{withFileTypes:true})).map(e=>[e.name,e.isDirectory()?'directory':'file'])};
    return {value:null};
  } catch(error){return {error:error.message,name:error.code==='ENOENT'?'NotFoundError':'Error'}}
});
await context.addInitScript(() => {
  async function call(op,path,value){const r=await window.fileBridge(op,path,value);if(r.error){const e=new Error(r.error);e.name=r.name;throw e}return r.value}
  function handle(p,kind){return {kind,name:p.split('/').pop()||'WorkLog test folder',queryPermission:async()=> 'granted',requestPermission:async()=> 'granted',
    async getDirectoryHandle(name,options={}){const n=p?p+'/'+name:name;await call('dir',n,options.create);return handle(n,'directory')},
    async getFileHandle(name,options={}){const n=p?p+'/'+name:name;await call('file',n,options.create);return handle(n,'file')},
    async removeEntry(name){await call('remove',p?p+'/'+name:name)},
    async getFile(){const text=await call('read',p);return new File([text],this.name,{type:'application/json'})},
    async createWritable(){let text;return {write:async v=>{text=v},close:async()=>call('write',p,text),abort:async()=>{}}},
    async *entries(){for(const [name,k]of await call('entries',p))yield[name,handle(p?p+'/'+name:name,k)]}
  }}
  window.showDirectoryPicker=async()=>handle('','directory');
});
const check=async(name,fn)=>{await fn();results.push(name);console.log('PASS',name)};
const clickNav=async view=>{await page.locator('.nav-item[data-view="'+view+'"]').click();await page.locator('#content[data-view="'+view+'"]').waitFor();};
const waitSaved=async()=>page.locator('#entry-form').waitFor({state:'detached'});
const screenshot=async name=>{if(name!=='09-write-failure')await page.waitForFunction(()=>document.querySelectorAll('.toast').length===0);await page.screenshot({path:path.join(output,name+'.png'),fullPage:true});};
const getWeek=async key=>JSON.parse(await fs.readFile(path.join(data,key.slice(0,4),key+'.json'),'utf8'));
const add=async(type,title,date='2026-09-30',extras={})=>{
 await page.locator('#add-btn').click();await page.locator(`[data-entry-type="${type}"]`).click();
 await page.getByLabel('Title',{exact:true}).fill(title);await page.getByLabel('Date',{exact:true}).fill(date);
 await page.getByLabel('People',{exact:true}).fill('Anna, Johan');await page.getByLabel('Topics',{exact:true}).fill('Platform, WorkLog');
 for(const [name,value]of Object.entries(extras))await page.locator(`[name="${name}"]`).fill(value);
 await page.getByRole('button',{name:'Save',exact:true}).click();await waitSaved();
};
const openEntry=async title=>{await clickNav('search');await page.locator('#search-input').fill(title);await page.locator('.search-result').filter({hasText:title}).first().click();};
let server;
try {
 await page.goto(pathToFileURL(path.join(root,'WorkLog.html')).href);
 await check('Standalone file opens without server',async()=>{await page.getByRole('button',{name:'Connect folder',exact:true}).waitFor();assert.equal(errors.length,0);await screenshot('01-first-run');});
 await page.getByRole('button',{name:'Connect folder',exact:true}).click();
 await page.locator('#edit-reflection').waitFor();
 await check('Create all six entry types and write weekly JSON',async()=>{
   await add('meeting','Architecture sync','2026-09-30',{discussion:'Storage safety\nOffline access',contribution:'Proposed recovery design',decisions:'Keep portable JSON',followUps:'Review rollout | PLAT-42',references:'https://example.com/design'});
   await add('work','Shipped safer backups','2026-09-30',{summary:'Implemented verified writes',details:'Added failure tests',outcome:'Protected journal data'});
   await add('conversation','Product catch-up','2026-09-30',{summary:'Discussed roadmap',notes:'Focus on usability',contribution:'Shared feedback'});
   await add('decision','Keep weekly JSON','2026-09-30',{decision:'Use local files',context:'Offline corporate laptop',rationale:'Simple and portable'});
   await add('achievement','Released WorkLog','2026-09-30',{summary:'Delivered reliable journaling',impact:'Better year-end recall',references:'PROJ-123'});
   await add('note','Remember this','2026-09-30',{content:'<img src=x onerror=alert(1)> is plain text'});
   assert.equal((await getWeek('2026-W40')).entries.length,6);
 });
 await check('Entry detail, edit and safe text rendering',async()=>{
   await openEntry('Remember this');assert.match(await page.locator('.modal').innerText(),/<img/);assert.equal(await page.locator('.modal img').count(),0);
   await page.getByRole('button',{name:'Edit',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill('Remember the demo');
   await page.getByRole('button',{name:'Save',exact:true}).click();await waitSaved();
 });
 await check('Unsaved changes require confirmation',async()=>{
   await openEntry('Remember the demo');await page.getByRole('button',{name:'Edit',exact:true}).click();await page.getByLabel('Note',{exact:true}).fill('Unsaved');
   page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await page.locator('#entry-form').count(),1);
   page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Cancel',exact:true}).click();await waitSaved();
 });
 await check('Search, type filter, people and topics',async()=>{
   await clickNav('search');await page.locator('#search-input').fill('Anna');assert.equal(await page.locator('.search-result').count(),6);
   await page.locator('#search-type').selectOption('meeting');assert.equal(await page.locator('.search-result').count(),1);await screenshot('03-search');
   await page.locator('#search-type').selectOption('all');await clickNav('people');await page.getByText('Anna',{exact:true}).waitFor();await screenshot('04-people');
   await clickNav('topics');await page.getByText('Platform',{exact:true}).waitFor();
 });
 await check('Weekly reflection editor and month highlights',async()=>{
   await clickNav('week');await page.locator('#edit-reflection').click();
   for(const [name,value] of Object.entries({highlights:'Delivered safer WorkLog',outcomes:'Reliable backups',challenges:'Failure handling',learnings:'Test interrupted writes'}))await page.locator(`[name="${name}"]`).fill(value);
   await screenshot('05-reflection-editor');await page.getByRole('button',{name:'Save reflection'}).click();await page.locator('#reflection-form').waitFor({state:'detached'});
   assert.deepEqual((await getWeek('2026-W40')).weeklyReflection.highlights,['Delivered safer WorkLog']);
   await screenshot('02-week');await clickNav('month');await page.locator('[data-month-tab="highlights"]').click();await page.getByText('Delivered safer WorkLog',{exact:true}).waitFor();await screenshot('06-month-highlights');
   await page.locator('[data-month-tab="reflections"]').click();await page.getByText('1 outcomes · 1 learnings').waitFor();await page.locator('[data-month-tab="entries"]').click();
 });
 await check('Analytics and theme selection',async()=>{
   await clickNav('analytics');assert.equal(await page.locator('.stat-number').first().innerText(),'6');await screenshot('07-analytics');
   await clickNav('settings');await page.locator('#theme-select').selectOption('dark');assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');await screenshot('08-settings-dark');await page.locator('#theme-select').selectOption('light');
 });
 let backupPath;
 await check('Full backup download contains all six entries and reflection',async()=>{
   const downloadPromise=page.waitForEvent('download');await page.locator('#settings-backup').click();const download=await downloadPromise;backupPath=path.join(output,'test-backup.json');await download.saveAs(backupPath);
   const payload=JSON.parse(await fs.readFile(backupPath,'utf8'));assert.equal(payload.weeks[0].entries.length,6);assert.equal(payload.weeks[0].weeklyReflection.highlights.length,1);
 });
 await check('Import cancel, replacement confirmation and version history',async()=>{
   const payload=JSON.parse(await fs.readFile(backupPath,'utf8'));payload.weeks[0].entries=payload.weeks[0].entries.slice(0,5);
   const upload={name:'older-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(payload))};
   let chooserPromise=page.waitForEvent('filechooser');await page.locator('#settings-import').click();page.once('dialog',d=>d.dismiss());await (await chooserPromise).setFiles(upload);
   await page.waitForTimeout(100);assert.equal((await getWeek('2026-W40')).entries.length,6);
   chooserPromise=page.waitForEvent('filechooser');await page.locator('#settings-import').click();page.once('dialog',d=>d.accept());await (await chooserPromise).setFiles(upload);
   await page.getByText('Imported 1 weekly file.',{exact:true}).waitFor();assert.equal((await getWeek('2026-W40')).entries.length,5);
   const history=await fs.readdir(path.join(data,'history','2026'));assert.ok(history.length>0);
   chooserPromise=page.waitForEvent('filechooser');await page.locator('#settings-import').click();page.once('dialog',d=>d.accept());await (await chooserPromise).setFiles(backupPath);
   await page.waitForFunction(()=>document.querySelectorAll('.toast').length>0);await page.waitForTimeout(150);assert.equal((await getWeek('2026-W40')).entries.length,6);
 });
 await check('Cross-week move survives a failed destination write, then succeeds',async()=>{
   await openEntry('Remember the demo');await page.getByRole('button',{name:'Edit',exact:true}).click();await page.getByLabel('Date',{exact:true}).fill('2026-10-05');
   failWrite='2026-W41.json';await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Simulated write failure',{exact:true}).waitFor();
   assert.equal((await getWeek('2026-W40')).entries.length,6);await screenshot('09-write-failure');failWrite='';
   await assert.rejects(()=>fs.access(path.join(data,'2026','2026-W41.json')));
   await page.getByRole('button',{name:'Save',exact:true}).click();await waitSaved();assert.equal((await getWeek('2026-W40')).entries.length,5);assert.equal((await getWeek('2026-W41')).entries.length,1);
 });
 await check('Delete confirmation and persistence after reopen',async()=>{
   await openEntry('Remember the demo');await page.getByRole('button',{name:'Edit',exact:true}).click();page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Delete',exact:true}).click();await waitSaved();assert.equal((await getWeek('2026-W41')).entries.length,0);
   await page.reload();await page.getByRole('button',{name:'Connect folder',exact:true}).click();await clickNav('search');await page.locator('#search-input').fill('Architecture sync');assert.equal(await page.locator('.search-result').count(),1);
 });
 await check('Today navigation moves one day',async()=>{
   await clickNav('today');const before=await page.locator('#page-subtitle').innerText();await page.locator('#next-btn').click();await page.waitForFunction(before=>document.querySelector('#page-subtitle').textContent!==before,before);const after=await page.locator('#page-subtitle').innerText();assert.equal((Date.parse(after)-Date.parse(before))/86400000,1);
 });
 await check('Unreadable week blocks backup with visible warning',async()=>{
   await clickNav('settings');await fs.writeFile(path.join(data,'2026','2026-W42.json'),'{broken');
   await page.locator('#settings-backup').click();await page.locator('#notice-area').getByText(/No complete backup/).waitFor();await screenshot('10-backup-blocked');await fs.rm(path.join(data,'2026','2026-W42.json'));
 });
 await check('Responsive layout and keyboard shortcut',async()=>{
   await clickNav('week');await page.setViewportSize({width:390,height:844});await screenshot('11-mobile-layout');
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.setViewportSize({width:1440,height:1000});
   await page.locator('#page-title').click();await page.keyboard.press('n');await page.getByRole('heading',{name:'Add an entry'}).waitFor();await page.keyboard.press('Escape');
 });
 // Hosted modules, actual browser FileSystemDirectoryHandles (OPFS), IndexedDB reconnect.
 server=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'4178'},stdio:'pipe'});
 await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);});
 const nativeContext=await browser.newContext({viewport:{width:1440,height:1000}});
 await nativeContext.addInitScript(()=>{window.showDirectoryPicker=()=>navigator.storage.getDirectory()});
 const native=await nativeContext.newPage();native.on('pageerror',e=>errors.push(e.message));await native.goto('http://127.0.0.1:4178');
 await check('Hosted modules with native file handles, writes and remembered reconnect',async()=>{
   await native.getByRole('button',{name:'Connect folder',exact:true}).click();await native.locator('#edit-reflection').waitFor();
   await native.locator('#add-btn').click();await native.locator('[data-entry-type="note"]').click();await native.getByLabel('Title',{exact:true}).fill('Native file handle check');await native.getByRole('button',{name:'Save',exact:true}).click();await native.locator('#entry-form').waitFor({state:'detached'});
   await native.getByText('Native file handle check',{exact:true}).waitFor();
   await native.reload();await native.getByText('Native file handle check',{exact:true}).waitFor();
   await native.screenshot({path:path.join(output,'12-native-handles.png'),fullPage:true});
 });
 await check('Stale edits are rejected across actual browser tabs',async()=>{
   await native.getByText('Native file handle check',{exact:true}).click();await native.getByRole('button',{name:'Edit',exact:true}).click();
   const other=await nativeContext.newPage();other.on('pageerror',e=>errors.push(e.message));await other.goto('http://127.0.0.1:4178');
   await other.getByText('Native file handle check',{exact:true}).click();await other.getByRole('button',{name:'Edit',exact:true}).click();
   await other.getByLabel('Title',{exact:true}).fill('Changed in another tab');await other.getByRole('button',{name:'Save',exact:true}).click();await other.locator('#entry-form').waitFor({state:'detached'});
   await native.getByLabel('Title',{exact:true}).fill('Stale overwrite');await native.getByRole('button',{name:'Save',exact:true}).click();await native.getByText(/This entry changed in another tab/).waitFor();
   native.once('dialog',d=>d.accept());await native.getByRole('button',{name:'Cancel',exact:true}).click();await other.close();
 });
 await check('Forget folder and reconnect preserve files',async()=>{
   await native.locator('[data-view="settings"]').click();await native.locator('#settings-forget').click();await native.getByText('No folder selected',{exact:true}).waitFor();
   await native.locator('#settings-connect').click();await native.locator('.nav-item[data-view="week"]').click();await native.getByText('Changed in another tab',{exact:true}).waitFor();
 });
 await nativeContext.close();assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(output,'results.json'),JSON.stringify({browser:browser.version(),passed:results,errors,nativePicker:'Automated boundary; Windows dialog requires manual validation'},null,2));
 console.log(`${results.length} browser scenarios passed; no uncaught page errors. Screenshots: ${output}`);
} finally {await browser.close();server?.kill();await fs.rm(data,{recursive:true,force:true});}

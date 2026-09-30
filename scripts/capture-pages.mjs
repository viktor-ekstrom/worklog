import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.TEST_OUTPUT || path.join(root, 'test-results'));
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'worklog-e2e-'));
let failWrite = '';
const browser = await chromium.launch({headless:true, ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH, args:['--no-sandbox','--disable-gpu','--disable-software-rasterizer','--disable-dev-shm-usage']} : {})});
const context = await browser.newContext({viewport:{width:1280,height:900}, timezoneId:'Europe/Stockholm',acceptDownloads:true});
const errors=[];const results=[];
const page=await context.newPage();await page.clock.setFixedTime(new Date('2026-09-30T08:00:00+02:00'));page.on('pageerror',e=>errors.push(e.message));
// Exercise the real localhost backend against disposable data.
const server=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'4178',WORKLOG_DATA_DIR:data},stdio:'pipe'});
await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);server.once('exit',code=>reject(new Error(`Test server exited: ${code}`)));});
await context.route('**/api/weeks/*',async route=>{
 if(failWrite && route.request().method()==='PUT' && route.request().url().endsWith(failWrite.replace('.json',''))){
  await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Simulated write failure'})});
 } else await route.continue();
});
const check=async(name,fn)=>{await fn();results.push(name);console.log('PASS',name)};
const clickNav=async view=>{await page.locator('.nav-item[data-view="'+view+'"]').click();await page.locator('#content[data-view="'+view+'"]').waitFor();};
const waitSaved=async()=>page.locator('#entry-form').waitFor({state:'detached'});
const screenshot=async name=>{if(name!=='09-write-failure')await page.waitForFunction(()=>document.querySelectorAll('.toast').length===0);await page.screenshot({path:path.join(output,name+'.png'),fullPage:!(await page.locator('.modal').count())});};
const getWeek=async key=>JSON.parse(await fs.readFile(path.join(data,key.slice(0,4),key+'.json'),'utf8'));
const add=async(type,title,date='2026-09-30',extras={})=>{
 await page.locator('#add-btn').click();await page.locator(`[data-entry-type="${type}"]`).click();
 await page.getByLabel('Title',{exact:true}).fill(title);await page.getByLabel('Date',{exact:true}).fill(date);
 await page.getByLabel('People',{exact:true}).fill('Anna, Johan');await page.getByLabel('Topics',{exact:true}).fill('Platform, WorkLog');
 for(const [name,value]of Object.entries(extras))await page.locator(`[name="${name}"]`).fill(value);
 await page.getByRole('button',{name:'Save',exact:true}).click();await waitSaved();
};
const openEntry=async title=>{await clickNav('search');await page.locator('#search-input').fill(title);await page.locator('.search-result').filter({hasText:title}).first().click();};

const { createEmptyWeek, parseLocalDate } = await import('../src/utils.js');
const seed = createEmptyWeek(parseLocalDate('2026-09-30'));
seed.entries = [
 {id:'e1',type:'meeting',date:'2026-09-28',time:'09:00',title:'Platform planning',participants:['Anna','Johan'],topics:['Platform'],discussion:['Priorities for the next release','A simpler deployment process'],contribution:['Proposed a smaller first release'],decisions:['Start with the reporting workflow'],followUps:[{text:'Share the rollout plan',reference:'PLAT-42',done:false}],references:[{type:'link',value:'https://example.com/rollout'}]},
 {id:'e2',type:'work',date:'2026-09-28',time:'14:30',title:'Improved the data pipeline',participants:['Johan'],topics:['Data platform'],summary:'Removed a manual step from the daily reporting flow.',details:['Added validation before publishing','Documented the recovery steps'],outcome:'Reports are ready before the team starts work.'},
 {id:'e3',type:'conversation',date:'2026-09-29',time:'10:00',title:'Product catch-up with Sara',participants:['Sara'],topics:['Product'],summary:'Aligned on what the team needs from the next release.',notes:['Prioritise clarity over additional features'],contribution:['Shared examples from recent support questions']},
 {id:'e4',type:'decision',date:'2026-09-29',time:'15:00',title:'Keep the first release focused',participants:['Anna','Sara'],topics:['Product'],decision:'Ship the core reporting flow first.',context:'Several additional features were competing for time.',rationale:'A smaller release is easier to validate and support.'},
 {id:'e5',type:'achievement',date:'2026-09-30',time:'09:30',title:'First release ready for the team',participants:['Anna','Johan'],topics:['Platform'],summary:'Completed the release checklist and handover.',impact:'The team can use the new workflow independently.',references:[{type:'jira',value:'PLAT-42'}]},
 {id:'e6',type:'note',date:'2026-09-30',time:'11:00',title:'Ideas for the next retrospective',participants:[],topics:['Team'],content:'Discuss what made this release smoother and keep those habits.'}
];
seed.weeklyReflection={highlights:['Shipped a focused first release'],outcomes:['Removed a manual reporting step'],challenges:['Balancing scope with the deadline'],learnings:['Smaller releases are easier to support']};
await fs.mkdir(path.join(data,'2026'),{recursive:true});
await fs.writeFile(path.join(data,'2026','2026-W40.json'),JSON.stringify(seed));
for(let month=0;month<8;month++){
 const w=createEmptyWeek(new Date(2026,month,12));
 w.entries=Array.from({length:3+(month*3)%10},(_,i)=>({id:`sample-${month}-${i}`,type:['work','meeting','decision'][i%3],date:w.startDate,title:['Reporting improvements','Team planning','Agreed next steps'][i%3],summary:'Sample journal entry for the year overview.',topics:['Platform'],participants:['Anna']}));
 await fs.mkdir(path.join(data,w.week.slice(0,4)),{recursive:true});await fs.writeFile(path.join(data,w.week.slice(0,4),w.week+'.json'),JSON.stringify(w));
}
try {
 await page.goto('http://127.0.0.1:4178');
 await page.locator('#edit-reflection').waitFor();
 for(const [view,name]of [['today','01-today'],['week','02-week'],['month','03-month'],['search','04-search'],['people','05-people'],['topics','06-topics'],['analytics','07-analytics'],['settings','08-settings']]){
   await clickNav(view);
   if(view==='search')await page.locator('#search-input').fill('release');
   await screenshot(name);
 }
 await clickNav('month');await page.locator('[data-month-tab="highlights"]').click();await screenshot('09-month-highlights');await page.locator('[data-month-tab="reflections"]').click();await screenshot('10-month-reflections');
 await clickNav('week');await page.locator('#edit-reflection').click();await screenshot('11-reflection-editor');await page.keyboard.press('Escape');
 await page.locator('[data-entry-id="e1"]').click();await screenshot('12-entry-detail');await page.getByRole('button',{name:'Edit',exact:true}).click();await screenshot('13-edit-meeting');await page.keyboard.press('Escape');
 await page.locator('#add-btn').click();await screenshot('14-add-entry');await page.keyboard.press('Escape');
 for(const type of ['meeting','work','conversation','decision','achievement','note']){
   await page.locator('#add-btn').click();await page.locator(`[data-entry-type="${type}"]`).click();await screenshot('15-new-'+type);await page.keyboard.press('Escape');
 }
 await clickNav('settings');await page.locator('#theme-select').selectOption('dark');await screenshot('16-settings-dark');await page.locator('#theme-select').selectOption('light');
 await clickNav('week');await page.setViewportSize({width:390,height:844});await screenshot('17-week-mobile');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.deepEqual(errors,[]);console.log('Captured all pages, monthly tabs and dialogs. No page errors.');
} finally {await browser.close();server.kill();await fs.rm(data,{recursive:true,force:true});}

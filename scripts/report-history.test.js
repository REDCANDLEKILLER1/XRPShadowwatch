'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),http=require('http');
const browserType=require('playwright')[process.env.SW_TEST_BROWSER || 'chromium'];
const A=require('../src/db/github-archive'),H=require('../src/db/report-history');
const ROOT=path.join(__dirname,'..'),PORT=Number(process.env.SW_TEST_PORT||8236);
const date=n=>{const d=new Date();d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const id=(d,s)=>'SW-'+d.replace(/-/g,'')+'-'+s;
const oldDay=date(-1),priorDay=date(-2),folder=date(-3),current=date(0);
const oldId=id(oldDay,'OLDER'),priorId=id(priorDay,'PRIOR');
const original='Coffee & Crypto with Stone\nShadow Watch\n\nSaved original — not a fresh scan.\n<img src=x onerror="window.historyXss=1">\n';
const files=new Map(),calls=[];
function fixture(reportId,archiveDay,text){
  const root='reports/'+archiveDay.replace(/-/g,'/')+'/'+reportId;
  files.set(root+'/morning-report.txt',text);
  files.set(root+'/receipt.json',JSON.stringify({report_id:reportId,report_hash:A.sha(text),sealed_at:H.reportDay(reportId)+'T12:30:00Z',generated_at:archiveDay+'T10:00:00Z',coverage_complete:true}));
  files.set('reports/'+archiveDay.replace(/-/g,'/')+'/index.json',JSON.stringify([{report_id:reportId,report_hash:A.sha(text),sealed_at:H.reportDay(reportId)+'T12:30:00Z'}]));
}
fixture(oldId,oldDay,original);fixture(priorId,folder,'The day before yesterday\nExact saved text.\n');
let truncated=false,missing=false,offline=false,scans=0,retries=0,archiveAvailable=false,archiveAttempts=0;
const gh=async(method,p)=>{
  calls.push([method,p]);assert.equal(method,'GET','history is strictly read-only');
  if(p==='/git/ref/heads/'+A.BRANCH)return missing?null:{object:{sha:'pinned'}};
  if(p==='/git/trees/pinned')return {tree:[{path:'reports',type:'tree',sha:'reports-tree'}]};
  if(p==='/git/trees/reports-tree?recursive=1')return {truncated,tree:[...files.keys()].map(p=>({path:p.slice(8),type:'blob'}))};
  if(p.startsWith('/contents/')){assert(p.endsWith('?ref=pinned'),'all files read from the same commit');const file=files.get(p.slice(10).split('?')[0]);return file===undefined?null:{content:Buffer.from(file).toString('base64'),encoding:'base64',size:Buffer.byteLength(file)};}
  throw Error('UNEXPECTED '+p);
};
const deps={env:{SHADOWWATCH_GITHUB_ARCHIVE_TOKEN:'fixture-only'},gh};
async function serverChecks(){
  const list=await H.history({},deps);assert.equal(list.date,oldDay);assert.deepEqual(list.dates,[oldDay,priorDay]);
  const old=await H.history({action:'read',report_id:oldId,archive_day:oldDay},deps);assert.equal(old.text,original);
  const prior=await H.history({date:priorDay},deps);assert.equal(prior.reports[0].archive_day,folder,'browse by report day, not old checkpoint folder');
  const p='reports/'+oldDay.replace(/-/g,'/')+'/'+oldId+'/morning-report.txt';files.set(p,original+'tampered');
  await assert.rejects(()=>H.history({action:'read',report_id:oldId,archive_day:oldDay},deps),/HASH_MISMATCH/);files.set(p,original);
  await assert.rejects(()=>H.history({action:'read',report_id:'../../secrets',archive_day:oldDay},deps),/INVALID_REPORT_ID/);
  await assert.rejects(()=>H.history({date:'2026-02-30'},deps),/INVALID_REPORT_DATE/);
  truncated=true;await assert.rejects(()=>H.history({},deps),/INDEX_TOO_LARGE/);truncated=false;
  missing=true;assert.deepEqual((await H.history({},deps)).reports,[]);missing=false;
  assert(calls.every(c=>c[0]==='GET'));
  console.log('PASS read-only catalog, report-day selection, pinned reads, exact text, bad-hash rejection, input validation, empty/truncated archives');
}
const srv=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/report-history'){
    if(offline){res.writeHead(503);return res.end('{}');}
    try{const result=await H.history(Object.fromEntries(url.searchParams),deps);res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(result));}
    catch(e){res.writeHead(503,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:e.message}));}
  }
  if(url.pathname==='/api/delta'){scans++;res.writeHead(503);return res.end('{}');}
  if(url.pathname==='/api/report-archive'){
    archiveAttempts++;res.setHeader('Content-Type','application/json');
    if(!archiveAvailable){res.writeHead(503);return res.end('{"status":"FAILED"}');}
    retries++;return res.end('{"status":"ARCHIVED"}');
  }
  const file=path.resolve(ROOT,'.'+url.pathname);
  if(!file.startsWith(ROOT+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');fs.createReadStream(file).pipe(res);
});
(async()=>{
  await serverChecks();await new Promise(r=>srv.listen(PORT,'127.0.0.1',r));
  const browser=await browserType.launch({args:process.env.SW_TEST_BROWSER==='webkit'?[]:['--no-sandbox']});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,serviceWorkers:'block'});
    await page.route('**/*',r=>new URL(r.request().url()).origin==='http://127.0.0.1:'+PORT?r.continue():r.abort());
    await page.addInitScript(()=>{window.WebSocket=class{constructor(){this.readyState=3;setTimeout(()=>this.onerror&&this.onerror(),1);}close(){}send(){throw Error('OFFLINE');}addEventListener(){}removeEventListener(){}};});
    await page.goto('http://127.0.0.1:'+PORT+'/brief-console.html');await page.waitForSelector('#swSavedReportsButton');
    await page.click('#swSavedReportsButton');await page.waitForFunction(()=>document.querySelectorAll('#swSavedList .sw-saved-row').length===1);
    await page.click('#swSavedList .sw-saved-row');await page.waitForFunction(()=>!document.getElementById('swSavedReader').hidden);
    assert.equal(await page.locator('#swSavedText').textContent(),original);assert.equal(await page.evaluate(()=>window.historyXss),undefined);
    assert.equal(await page.locator('#swSavedText img').count(),0);
    const downloadPromise=page.waitForEvent('download');await page.click('#swSavedDownload');const download=await downloadPromise;
    assert.equal(fs.readFileSync(await download.path(),'utf8'),original);
    await page.click('#swSavedBack');await page.click('[data-saved-day="-2"]');await page.waitForFunction(d=>document.getElementById('swSavedDate').value===d,priorDay);
    await page.waitForFunction(()=>document.getElementById('swSavedList').textContent.includes('PRIOR'));
    await page.click('#swSavedList .sw-saved-row');await page.waitForFunction(()=>document.getElementById('swSavedText').textContent.startsWith('The day before'));
    const localId=id(current,'PHONE'),localText='Exact phone report\nSaved before upload.\n';
    await page.evaluate(async p=>{await SW_SAVED_REPORTS.capture(p);await SW_SAVED_REPORTS.mark(p.report_id,{status:'FAILED'});},{report_id:localId,generated_at:current+'T13:00:00Z',morning_report:localText,morning_hash:A.sha(localText),scan_id:'SC-PHONE',evidence_scan_id:'stored-v208-123456789abc',public_hash:'a'.repeat(32),full_hash:'b'.repeat(32)});
    await page.reload();await page.waitForSelector('#swSavedReportsButton');offline=true;
    await page.click('#swSavedReportsButton');await page.waitForFunction(()=>document.getElementById('swSavedNotice').textContent.includes('unavailable'));
    await page.click('#swSavedList .sw-saved-row');assert.equal(await page.locator('#swSavedText').textContent(),localText);
    assert(archiveAttempts>0,'returning to the app automatically retries a pending save');
    archiveAvailable=true;
    await page.click('#swSavedBack');await page.click('#swSavedRetry');
    await page.waitForFunction(()=>document.getElementById('swSavedList').textContent.includes('Saved to archive'));
    assert((await page.evaluate(()=>SW_SAVED_REPORTS.list())).some(r=>r.archive_status==='ARCHIVED'));
    assert.equal(retries,1,'retry uploads existing report once without a new scan');assert.equal(scans,0);
    await page.evaluate(async id=>{
      await SW_SAVED_REPORTS.mark(id,{status:'FAILED'});
      const originalFetch=window.fetch,originalTimer=window.setTimeout;
      window.fetch=(url,opts)=>url==='/api/report-archive'?new Promise(()=>{}):originalFetch(url,opts);
      window.setTimeout=(fn,ms,...args)=>originalTimer(fn,ms===20000?40:ms,...args);
      let timer;
      try { await Promise.race([SW_SAVED_REPORTS.retryPending(),new Promise((_,reject)=>{
        timer=originalTimer(()=>reject(Error('RETRY_STILL_HUNG')),2000);
      })]); } finally { clearTimeout(timer); window.fetch=originalFetch;window.setTimeout=originalTimer; }
      await SW_SAVED_REPORTS.retryPending();
    },localId);
    assert.equal(retries,2,'timed-out upload must release retry lock so the next attempt can save');

    await page.evaluate(d=>{localStorage.setItem('SW_BRIEF_ARCHIVE_V1',JSON.stringify({[d]:{date:d,text:'An older phone-only brief',savedAt:Date.parse(d)}}));},priorDay);
    assert((await page.evaluate(()=>SW_SAVED_REPORTS.list())).some(r=>r.text==='An older phone-only brief'));
    if(process.env.SW_HISTORY_SCREENSHOT){await page.click('#swSavedList .sw-saved-row');await page.screenshot({path:process.env.SW_HISTORY_SCREENSHOT});}
    const box=await page.locator('#swSavedReportsDialog').boundingBox();assert(box.x>=0&&box.x+box.width<=390&&box.height<=844);
    console.log('PASS mobile date browsing, exact original/download, no markup execution, saved phone copy after reload/offline, legacy archive, retry without scan');
  }finally{await browser.close();await new Promise(r=>srv.close(r));}
})().catch(e=>{console.error(e);process.exit(1);});

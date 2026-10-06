'use strict';
const assert=require('assert/strict'),fs=require('fs'),vm=require('vm');
const browserType=require('playwright')[process.env.SW_TEST_BROWSER||'chromium'];
const helper=fs.readFileSync('src/brief/50-durable-storage-20261006.js','utf8');
const history=fs.readFileSync('src/brief/49-history-storage-20261006.js','utf8');
const reports=fs.readFileSync('src/brief/48-saved-reports-20261005.js','utf8');
const payload={report_id:'SW-20261006-ABCDE',generated_at:'2026-10-06T13:00:00Z',morning_report:'Original working report\n🩸 XRPMan\n',morning_hash:'a'.repeat(64)};
(async()=>{
 const browser=await browserType.launch({args:process.env.SW_TEST_BROWSER==='webkit'?[]:['--no-sandbox']});
 try{
  const page=await browser.newPage();await page.route('http://storage.test/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><button id="swRunBtn">RUN</button>'}));
  async function load(fault){
   await page.goto('http://storage.test/');
   await page.evaluate(fault=>{
    const originalTimer=window.setTimeout;window.setTimeout=(fn,ms,...args)=>originalTimer(fn,ms===4000?40:ms,...args);
    window.nativeDB=window.indexedDB;
    if(fault==='open')Object.defineProperty(window,'indexedDB',{configurable:true,value:{open(){return {};}}});
    if(fault==='transaction'){
     const native=IDBDatabase.prototype.transaction;
     IDBDatabase.prototype.transaction=function(...args){if(window.stallTransactions)return {objectStore(){return {get(){return {};},put(){return {};},getAll(){return {};}};},abort(){}};return native.apply(this,args);};window.stallTransactions=true;
    }
    if(fault==='denied'){
     Object.defineProperty(window,'indexedDB',{configurable:true,value:{open(){throw Error('denied');}}});
     Storage.prototype.setItem=function(){throw Error('quota');};
    }
   },fault);
   await page.addScriptTag({content:helper});await page.addScriptTag({content:history});await page.addScriptTag({content:reports});
  }
  await load('open');
  let row=await page.evaluate(p=>SW_SAVED_REPORTS.capture(p),payload);
  assert.equal(row.persistence,'localstorage');assert.equal(row.text,payload.morning_report);
  await page.evaluate(()=>SW_HISTORY_STORAGE.write('shadowDiscoveryInbox','new inbox after database stall'));
  assert.equal(await page.evaluate(()=>localStorage.getItem('shadowDiscoveryInbox')),'new inbox after database stall');
  await load('open');
  assert.equal((await page.evaluate(()=>SW_SAVED_REPORTS.list())).find(r=>r.report_id===payload.report_id).text,payload.morning_report,'fallback survives reload exactly');
  await assert.rejects(()=>page.evaluate(p=>SW_SAVED_REPORTS.capture(p),{...payload,morning_hash:'b'.repeat(64)}),/PHONE_REPORT_CONFLICT/);
  await page.evaluate(()=>Object.defineProperty(window,'indexedDB',{configurable:true,value:window.nativeDB}));
  row=await page.evaluate(p=>SW_SAVED_REPORTS.capture(p),payload);assert.equal(row.persistence,'indexeddb','failed open is retried');
  assert.equal(await page.evaluate(id=>localStorage.getItem('SW_SAVED_REPORT_FALLBACK_V1:'+id),payload.report_id),null,'remove fallback only after verified disk write');
  await load('transaction');
  row=await page.evaluate(p=>SW_SAVED_REPORTS.capture(p),payload);assert.equal(row.persistence,'localstorage');
  await page.evaluate(()=>{window.stallTransactions=false;});
  row=await page.evaluate(p=>SW_SAVED_REPORTS.capture(p),payload);assert.equal(row.persistence,'indexeddb','timed-out connection is reopened');
  await load('denied');
  row=await page.evaluate(p=>SW_SAVED_REPORTS.capture(p),payload);assert.equal(row.persistence,'session');
  assert.equal((await page.evaluate(()=>SW_SAVED_REPORTS.list()))[0].text,payload.morning_report,'downloadable session copy survives both storage failures');
  await page.evaluate(()=>SW_SAVED_REPORTS.open());
  await page.waitForFunction(()=>document.getElementById('swSavedList').textContent.includes('This session only'));
 }finally{await browser.close();}
 // Exercise the real archive orchestration with phone storage deliberately hung.
 const source=fs.readFileSync('src/brief/02-core.js','utf8');
 const archive=source.slice(source.indexOf('async function archiveSealedReport('),source.indexOf("if(typeof window!=='undefined')window.retryGithubArchive"));
 let attempted=0,finishPhone,marked=0;
 const context={state:{indexRun:{scan_id:'stored-fixture'},morningStoryReport:payload.morning_report},window:{SW_SAVED_REPORTS:{capture:()=>new Promise(r=>{finishPhone=r;}),mark:async()=>{marked++;}}},log(){},uploadSealedReport:async p=>{assert.equal(p.morning_report,payload.morning_report);attempted++;return {response:{ok:true},result:{status:'ARCHIVED'}};}};
 vm.createContext(context);vm.runInContext(archive,context);
 const seal={...payload,scan_id:'sealed'};
 const result=await context.archiveSealedReport({},seal);assert.equal(result.status,'ARCHIVED');assert.equal(attempted,1);assert.equal(marked,0);
 finishPhone({persistence:'localstorage'});await new Promise(r=>setImmediate(r));assert.equal(marked,1,'late capture records finished archive');
 console.log('PASS stalled database opens/transactions, exact fallback reload, recovery, hash conflict, session-only disclosure, independent remote archive');
})().catch(e=>{console.error(e);process.exit(1);});

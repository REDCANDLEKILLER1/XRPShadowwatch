'use strict';
const assert=require('assert/strict'),fs=require('fs'),vm=require('vm');
const {chromium}=require('playwright');
const S=require('../api/evidence-scheduler')._test;
const J=require('../src/db/run-journal');
(async()=>{
 let calls=0;
 const skipped=await S.runScheduledAcquisition({resumeOnly:true,readState:async()=>({state:{}}),readJournal:async()=>({journal:null}),acquire:()=>{calls++;}});
 assert.equal(skipped.body.status,'NO_PENDING_RECOVERY');assert.equal(calls,0);
 const state={state_sha256:'a'.repeat(64),anchor_ledger:10};
 const journal=J.begin({report_id:'SW-20261006-EABCD',anchor_ledger:20,anchor_close:'2026-10-06T12:00:00Z',from_state_sha256:state.state_sha256});
 const advanced=await S.runScheduledAcquisition({resumeOnly:true,silent:true,readState:async()=>({state}),readJournal:async()=>({journal}),selectRoster:()=>({accounts:['rTest']}),acquireReader:()=>({stats:{requests:0}}),releaseReader:()=>{},acquire:async()=>{calls++;return {committed:true};}});
 assert.equal(advanced.body.status,'ADVANCED');assert.equal(calls,1);
 const context={document:{readyState:'loading',addEventListener(){}},window:{clearedMorningNewsSources:()=>[
 {title:'BlackRock still has no plans for an XRP ETF, signal bearish'},
 {title:'BlackRock still has no plans for an XRP ETF, signal bearish for XRP'},
 {title:'Ripple XRP payments expand to a new international banking corridor'}]}};
 vm.createContext(context);vm.runInContext(fs.readFileSync('src/brief/10-pipeline.js','utf8'),context);
 const news=context.window.PUBLIC_REPORT_PIPELINE_V1.helpers.summarizeNewsImpact({});
 assert.equal((news.summary.match(/BlackRock/g)||[]).length,1);
 assert.match(JSON.stringify(news),/banking corridor/);
 const browser=await chromium.launch({args:['--no-sandbox']});
 try{
 const page=await browser.newPage();
 await page.route('http://history.test/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));
 await page.goto('http://history.test/');
 await page.evaluate(()=>{localStorage.setItem('shadowDiscoveryInbox','old-inbox');localStorage.setItem('other-app','untouched');});
 const source=fs.readFileSync('src/brief/49-history-storage-20261006.js','utf8');
 await page.addScriptTag({content:source});
 assert.equal(await page.evaluate(()=>SW_HISTORY_STORAGE.ready),true);
 assert.equal(await page.evaluate(()=>SW_HISTORY_STORAGE.read('shadowDiscoveryInbox')),'old-inbox');
 assert.equal(await page.evaluate(()=>localStorage.getItem('shadowDiscoveryInbox')),null);
 assert.equal(await page.evaluate(()=>localStorage.getItem('other-app')),'untouched');
 await page.evaluate(async()=>{await SW_HISTORY_STORAGE.write('shadowwatch_blackbox_v34','x'.repeat(7*1024*1024));});
 await page.reload();await page.addScriptTag({content:source});await page.evaluate(()=>SW_HISTORY_STORAGE.ready);
 assert.equal(await page.evaluate(()=>SW_HISTORY_STORAGE.read('shadowwatch_blackbox_v34').length),7*1024*1024);
 await page.evaluate(()=>SW_HISTORY_STORAGE.remove('shadowwatch_blackbox_v34'));
 assert.equal(await page.evaluate(()=>SW_HISTORY_STORAGE.read('shadowwatch_blackbox_v34')),null);
 await page.reload();
 await page.evaluate(()=>{localStorage.setItem('shadowDiscoveryInbox','preserve-on-failure');Object.defineProperty(window,'indexedDB',{value:{open(){throw Error('blocked');}}});});
 await page.addScriptTag({content:source});
 assert.equal(await page.evaluate(()=>SW_HISTORY_STORAGE.ready),false);
 assert.equal(await page.evaluate(()=>localStorage.getItem('shadowDiscoveryInbox')),'preserve-on-failure');
 }finally{await browser.close();}
 console.log('PASS recovery gating, equivalent news, quota-sized history, reload, removal, migration failure');
})().catch(e=>{console.error(e);process.exit(1);});

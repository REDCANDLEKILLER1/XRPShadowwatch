'use strict';
const assert=require('assert/strict'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync(require('path').join(__dirname,'../src/brief/12-daily-gate.js'),'utf8');
function setup(){
  const data=new Map(), session=new Map(), shown=[];
  const storage=m=>({getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)});
  const window={MORNING_REPORT_FLOAT:{show:(text,sources,pack)=>shown.push({text,sources,pack})}};
  vm.runInNewContext(source,{window,localStorage:storage(data),sessionStorage:storage(session),
    document:{getElementById:()=>null},setTimeout:()=>{},setInterval:()=>{},clearTimeout:()=>{},Date});
  return {gate:window.SW_DAILY_GATE,data,shown,show:window.MORNING_REPORT_FLOAT.show};
}
const complete={watchlist_total:255,wallets_checked:255,wallets_failed:0,tx_scan_coverage:{
  target_wallets:255,complete_wallets:255,failed_wallets:0,truncated_wallets:0,unproven_wallets:0,
  unknown_status_wallets:0,not_checked_wallets:0,anchor_ok:true,counts_reconcile:true,full_window_complete:true}};
const text='CURRENT REPORT: '+('The ledger evidence in this scan is being described. '.repeat(12));
const old='PREVIOUS REPORT: '+('This is a different completed scan. '.repeat(15));
for(const enabled of [false,true]){
  const h=setup(); if(enabled)h.gate.enable();
  const cases=[{}, {...complete,wallets_checked:254}, {...complete,tx_scan_coverage:{...complete.tx_scan_coverage,full_window_complete:false}},
    {...complete,tx_scan_coverage:{...complete.tx_scan_coverage,failed_wallets:1}},
    {...complete,tx_scan_coverage:{...complete.tx_scan_coverage,anchor_ok:false}}];
  for(const p of cases){h.gate.gateDelivery(text,p);h.show(text,[],p);}
  assert.equal(h.gate.archiveList().length,0,'unfinished exports cannot take the first archive slot');
  assert.equal(h.gate.status().delivered_count,0,'unfinished exports cannot consume the daily lock');
  h.gate.gateDelivery(old,complete);
  assert.equal(h.gate.archiveList().length,1,'complete evidence may archive');
  const stored=h.data.get('SW_BRIEF_ARCHIVE_V1');
  assert.equal(h.gate.gateDelivery(text,cases[2]),text,'partial report cannot inherit a prior run text');
  h.show(text,[],cases[2]);assert.equal(h.shown.at(-1).text,text);
  h.gate.gateDelivery(text,complete);
  assert.equal(h.data.get('SW_BRIEF_ARCHIVE_V1'),stored,'existing first good report remains untouched');
}
console.log('ALL DAILY ARCHIVE PROOF CHECKS PASS');

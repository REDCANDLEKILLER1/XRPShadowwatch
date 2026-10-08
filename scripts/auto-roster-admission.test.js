'use strict';
const assert=require('assert/strict'),crypto=require('crypto'),fs=require('fs'),vm=require('vm');
const Auto=require('../src/db/auto-roster'),R=require('../src/db/roster'),Store=require('../src/db/github-store'),Journal=require('../src/db/run-journal'),Receipts=require('../src/db/backup-receipt');
const alphabet='rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
function address(i){const b=Buffer.alloc(21);b[20]=i;const sum=crypto.createHash('sha256').update(crypto.createHash('sha256').update(b).digest()).digest().subarray(0,4);let n=BigInt('0x'+Buffer.concat([b,sum]).toString('hex')),s='';while(n){s=alphabet[Number(n%58n)]+s;n/=58n;}let zeros=0;for(const x of b){if(x!==0)break;zeros++;}return 'r'.repeat(zeros)+s;}
const A=R.roster()[0].address,B=address(7),end=Date.now(),close=new Date(end).toISOString();
const row=(n,extra={})=>({hash:n.toString(16).padStart(64,'0'),validated:true,tx_type:'Payment',tx_result:'tesSUCCESS',currency:'XRP',amount_drops:'3000000000000',from_account:A,to_account:B,ledger_index:n+10,close_time:new Date(end-60000).toISOString(),observed_via:[A],...extra});
const anchor={anchor_close:close,anchor_ledger:1000};
(async()=>{
 assert(Auto.validAddress(A));assert(Auto.validAddress(B));assert(!Auto.validAddress(B.slice(0,-1)+'x'));
 const rows=[row(1),row(2)];const before=JSON.stringify(rows);const qualified=Auto.qualify(rows,[A],anchor);assert.equal(qualified.length,1);assert.equal(qualified[0].transaction_count,2);assert.equal(qualified[0].total_drops,'6000000000000');assert.equal(qualified[0].ownership,'UNKNOWN');assert.equal(JSON.stringify(rows),before);
 assert.equal(Auto.qualify([row(1),row(1)],[A],anchor).length,0,'replaying one transaction is not recurrence');
 assert.equal(Auto.qualify([row(1),row(2,{ledger_index:11})],[A],anchor).length,0);
 assert.equal(Auto.qualify(rows,[A,B],anchor).length,0);
 assert.equal(Auto.qualify([row(1,{amount_drops:'10000000000000'})],[A],anchor)[0].qualification_reason,'SINGLE_LARGE_10M');
 const incoming=rows.map(r=>({...r,from_account:B,to_account:A,observed_via:[A]}));assert.equal(Auto.qualify(incoming,[A],anchor)[0].address,B,'large unknown senders are traced too');
 for(const change of [{validated:false},{tx_result:'tecPATH_DRY'},{currency:'USD'},{tx_type:'EscrowFinish'},{amount_drops:'1'},{amount_drops:'1.2'},{issuer:A},{observed_via:[]},{from_account:B},{to_account:A},{ledger_index:1001},{close_time:new Date(end-73*3600000).toISOString()}])assert.equal(Auto.qualify([row(1),row(2,change)],[A],anchor).length,0,JSON.stringify(change));
 assert.throws(()=>Auto.qualify([row(1),row(1,{amount_drops:'4000000000000'})],[A],anchor),/CONFLICTING_HASH/);
 const fixture={...anchor,stored_checkpoint:true,failed_wallets:0,complete_wallets:1,target_wallets:1,wallets:[{address:A}],events:rows,window:{provenance:'OBSERVED',days_without_shards:[],shards_verified:2},state_sha256:'d'.repeat(64)};
 const readReport=async()=>fixture;assert.equal((await Auto.preview({readReport})).write_attempted,false);
 fixture.window.provenance='PARTIAL_RECONSTRUCTED';await assert.rejects(()=>Auto.preview({readReport}),/INCOMPLETE/);fixture.window.provenance='OBSERVED';
 assert.equal((await Auto.selection({env:{}})).auto_roster.status,'DISABLED');
 await assert.rejects(()=>Auto.selection({env:{SHADOWWATCH_AUTOROSTER_ENABLED:'true',SHADOWWATCH_EVIDENCE_TOKEN:'fixture',VERCEL_ENV:'preview'}}),/NON_PRODUCTION/);
 const receipt={schema:'shadowwatch-independent-restore/1',verified_at:close,evidence_anchor_close:close,source_commit:'a'.repeat(40),manifest_sha256:'b'.repeat(64),restore_verified:true,destination_uri:'https://offsite.example/private/backup',destination_verification:'OPERATOR_DOWNLOADED_AND_RESTORED'};
 assert(Receipts.status(receipt,end).independent_restore_verified);assert(!Receipts.status({...receipt,verified_at:new Date(end-25*3600000).toISOString()},end).independent_restore_verified);assert(!Receipts.status({...receipt,evidence_anchor_close:new Date(end-25*3600000).toISOString()},end).independent_restore_verified);assert.throws(()=>Receipts.destination('https://github.com/backup'),/REFUSED/);assert.throws(()=>Receipts.destination('https://user:secret@backup.example'),/REFUSED/);
 const originalPinned=Store.readPinnedState,originalRead=Store.readFile;
 try{
  Store.readPinnedState=async()=>({state:{wallets:[{address:A}]},ref:'c'.repeat(40),gh:()=>{}});let raw=null;Store.readFile=async()=>raw;
  const env={SHADOWWATCH_AUTOROSTER_ENABLED:'true',SHADOWWATCH_EVIDENCE_TOKEN:'fixture',VERCEL_ENV:'production'};
  assert.equal((await Auto.selection({env,readReport})).auto_roster.status,'BACKUP_NOT_VERIFIED');raw=JSON.stringify(receipt);
  assert.equal((await Auto.selection({env,readReport,health:async()=>({capacity_status:'CRITICAL'})})).auto_roster.status,'STORAGE_CRITICAL');
  fixture.events=Array.from({length:7},(_,i)=>[row(i*2+1,{to_account:address(i+1)}),row(i*2+2,{to_account:address(i+1)})]).flat();
  const selected=await Auto.selection({env,readReport,health:async()=>({capacity_status:'OK'})});assert.equal(selected.auto_roster.candidates.length,5);assert.equal(selected.accounts.length,R.select().accounts.length+5);
  const auto=selected.auto_roster;const journal=Journal.begin({report_id:'SW-20261008-TEST1',from_state_version:1,from_state_sha256:'d'.repeat(64),anchor_ledger:100,anchor_close:close,admitted_wallets:[B],auto_roster:auto});
  assert.deepEqual(JSON.parse(Journal.serialize(journal)).auto_roster,auto,'qualification receipts survive resumable work');assert.equal(Journal.canonical({...journal,auto_roster:null}).auto_roster,undefined,'old journals retain their exact schema');
 }finally{Store.readPinnedState=originalPinned;Store.readFile=originalRead;}
 // Real client synchronization boundary: only fully proved shared wallets join.
 const src=fs.readFileSync('src/brief/45-delta-evidence-index-20260911.js','utf8');const begin=src.indexOf('        if (result.failed_wallets === 0'),stop=src.indexOf('        run = result;',begin);
 const context={WATCHLIST:[],KNOWN:{},result:{failed_wallets:0,complete_wallets:2,target_wallets:2,anchor_ledger:100,wallets:[{address:B,proven:true,proven_through:100},{address:address(8),proven:false,proven_through:100}]}};vm.createContext(context);vm.runInContext(src.slice(begin,stop),context);assert.equal(context.WATCHLIST.length,1);vm.runInContext(src.slice(begin,stop),context);assert.equal(context.WATCHLIST.length,1);
 console.log('PASS automatic qualification: checksum/strict ledger evidence, deduplication, recurrence, source proof, incomplete windows, dry-run/write isolation, backup/capacity gates, bounded shared admission, journal receipts, proved-only client sync');
})().catch(e=>{console.error(e);process.exitCode=1;});

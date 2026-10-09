'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),zlib=require('zlib');
const F=require('../src/db/forensic-patterns'),E=require('./forensic-export'),B=require('../src/db/master-backup');
const S=require('../src/db/evidence-state'),Store=require('../src/db/github-store'),A=require('../src/db/github-archive');
const owner='rNxp4h8apvRis6mJf9Sh8C6iRxfrDWN7AV',other='rDAE53VfMvftPB4ogpWGWvzkQxfht6JPxr',stable=F.ASSETS[0];
const token=value=>({currency:stable.currency,issuer:stable.issuer,value});
const mod=(type,FinalFields,PreviousFields)=>({ModifiedNode:{LedgerEntryType:type,FinalFields,PreviousFields}});
function fixture(){const tx={Account:owner,TransactionType:'OfferCreate',TakerGets:'100000000',TakerPays:token('141'),Fee:'12',Sequence:7};
 const meta={TransactionResult:'tesSUCCESS',TransactionIndex:0,AffectedNodes:[
  mod('AccountRoot',{Account:owner,Balance:'899999988'},{Balance:'1000000000'}),
  mod('RippleState',{LowLimit:{issuer:owner},HighLimit:{issuer:stable.issuer},Balance:token('141')},{Balance:token('0')})]};
 const event={hash:'A'.repeat(64),ledger_index:100,transaction_index:0,close_time:'2026-10-09T00:00:00Z',tx_type:'OfferCreate',tx_result:'tesSUCCESS',validated:true,from_account:owner};
 return{event,payload:{hash:event.hash,raw_tx:tx,raw_meta:meta}};}
function inspect(f){return F.inspect(f.event,f.payload);}
(async()=>{
 const f=fixture(),sell=inspect(f);assert.equal(sell.status,'ANALYZED');assert.equal(sell.exchanges.length,1);
 assert.equal(sell.exchanges[0].xrp,'100');assert.equal(sell.exchanges[0].stable,'141');assert.equal(sell.exchanges[0].effective_price_fraction,'141/100');
 assert.equal(F.add('100000000000000000.123456789','1.000000001'),'100000000000000001.12345679');assert.equal(F.add('1e-81','2e-81'),'0.'+'0'.repeat(80)+'3');
 assert.equal(F.priceFraction('1.4100','1.00'),'141/100');
 const failed=fixture();failed.event.tx_result=failed.payload.raw_meta.TransactionResult='tecUNFUNDED_OFFER';assert.equal(inspect(failed).exchanges.length,0);
 const pending=fixture();pending.event.validated=false;assert.equal(inspect(pending).exchanges.length,0);
 const mismatch=fixture();mismatch.payload.raw_meta.TransactionIndex=1;assert.equal(inspect(mismatch).status,'PAYLOAD_EVENT_MISMATCH');
 const fake=fixture();fake.payload.raw_tx.TakerPays.issuer=other;fake.payload.raw_meta.AffectedNodes[1].ModifiedNode.FinalFields.HighLimit.issuer=other;assert.equal(inspect(fake).exchanges.length,0);
 const high=fixture(),line=high.payload.raw_meta.AffectedNodes[1].ModifiedNode;
 line.FinalFields.LowLimit.issuer=stable.issuer;line.FinalFields.HighLimit.issuer=owner;line.FinalFields.Balance.value='-141';assert.equal(inspect(high).exchanges[0].stable,'141');
 const buy=fixture();buy.payload.raw_tx.TakerGets=token('141');buy.payload.raw_tx.TakerPays='100000000';
 buy.payload.raw_meta.AffectedNodes[0].ModifiedNode.FinalFields.Balance='1099999988';
 buy.payload.raw_meta.AffectedNodes[1].ModifiedNode.FinalFields.Balance.value='-141';assert.equal(inspect(buy).exchanges[0].side,'BUY_XRP');
 const create=fixture();create.payload.raw_meta.AffectedNodes=[mod('AccountRoot',{Account:owner,Balance:'999999988'},{Balance:'1000000000'}),
  {CreatedNode:{LedgerEntryType:'Offer',NewFields:{Account:owner,Sequence:7}}}];
 assert.equal(inspect(create).exchanges.length,0);assert.equal(inspect(create).orders[0].stored_offer_created,true);
 const cancel=fixture();cancel.event.tx_type=cancel.payload.raw_tx.TransactionType='OfferCancel';cancel.payload.raw_tx.OfferSequence=6;
 cancel.payload.raw_meta.AffectedNodes=[mod('AccountRoot',{Account:owner,Balance:'999999988'},{Balance:'1000000000'}),
  {DeletedNode:{LedgerEntryType:'Offer',FinalFields:{Account:owner,Sequence:6,TakerGets:'100000000',TakerPays:token('141')}}}];
 assert.equal(inspect(cancel).orders[0].cancel_confirmed,true);assert.equal(inspect(cancel).exchanges.length,0);
 cancel.payload.raw_tx.OfferSequence=5;assert.equal(inspect(cancel).orders[0].cancel_confirmed,false);
 const payment=fixture();payment.event.tx_type=payment.payload.raw_tx.TransactionType='Payment';payment.payload.raw_tx.Destination=other;
 payment.payload.raw_tx.SendMax='100000000';payment.payload.raw_meta.delivered_amount=token('14.1');
 assert.equal(inspect(payment).exchanges.length,0);assert.equal(inspect(payment).payments[0].delivered.value,'14.1');
 payment.payload.raw_tx.Destination=owner;assert.equal(inspect(payment).exchanges[0].basis,'SELF_PAYMENT');
 delete payment.payload.raw_meta.delivered_amount;assert.equal(inspect(payment).exchanges.length,0);
 const maker=fixture();maker.payload.raw_tx.Account=other;maker.event.from_account=other;
 maker.payload.raw_meta.AffectedNodes[0].ModifiedNode.FinalFields.Balance='900000000';
 maker.payload.raw_meta.AffectedNodes.push({DeletedNode:{LedgerEntryType:'Offer',FinalFields:{Account:owner,Sequence:5,TakerGets:'0',TakerPays:token('0')},PreviousFields:{TakerGets:'100000000',TakerPays:token('141')}}});
 assert.equal(inspect(maker).exchanges[0].basis,'CONSUMED_OFFER_OWNER');
 delete maker.payload.raw_meta.AffectedNodes[2].DeletedNode.PreviousFields;assert.equal(inspect(maker).exchanges.length,0);
 const repeated=[0,1,2].map(i=>({...sell,hash:String(i).repeat(64),ledger_index:100+i}));
 assert.equal(F.summarize(repeated).flags[0].kind,'REPEATED_LIMIT_PRICE');
 assert.equal(F.summarize(repeated).wallets[0].stable_totals[F.assetKey(stable)].sell_xrp,'300');
 const transfers=Array.from({length:6},(_,i)=>({...sell,hash:String(i).repeat(64),ledger_index:100+i,close_time:new Date(Date.parse('2026-10-09T00:00Z')+i*600000).toISOString(),
  exchanges:[],orders:[],payments:[{from:owner,to:other,destination_tag:0,delivered:{currency:'XRP',issuer:null,value:'1'},cross_currency_requested:false}]}));
 assert.equal(F.summarize(transfers).flags[0].interval_seconds,600);
 transfers[3].close_time='2026-10-09T00:32:00Z';assert.equal(F.summarize(transfers).flags.length,0);
 const plan=E.retention({source_commit:'x',manifest_sha256:'s',total_bytes:6000000000,files:[
  {path:'evidence/2026/08/01/events.ndjson.gz',bytes:30},{path:'evidence/2026/08/02/payloads.ndjson.gz',bytes:40},{path:Store.STATE_PATH,bytes:10},
  {path:'evidence/2026/10/08/events.ndjson.gz',bytes:20}]},{now:'2026-10-09T00:00Z',flaggedDays:['2026-08-02']});
 assert.deepEqual(plan.files.map(e=>e.action),['ARCHIVE_CANDIDATE','KEEP_FLAGGED','KEEP_PROOF','KEEP_RECENT']);assert.equal(plan.archive_candidate_bytes,30);assert.equal(plan.deletion_enabled,false);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sw-forensic-'));
 try{
  const source=path.join(root,'source');fs.mkdirSync(source);
  const events=repeated.map(r=>({...f.event,hash:r.hash,ledger_index:r.ledger_index})),payloads=events.map(e=>({...f.payload,hash:e.hash}));
  const data={'evidence/2026/10/09/events.ndjson.gz':zlib.gzipSync(events.map(e=>JSON.stringify(e)).join('\n')+'\n'),
   'evidence/2026/10/09/payloads.ndjson.gz':zlib.gzipSync(payloads.map(e=>JSON.stringify(e)).join('\n')+'\n')};
  const state=S.genesis([{address:owner,scan_coverage_through:102}],{anchor_ledger:102,anchor_close:'2026-10-09T00:00:00Z',
   evidence_shards:Object.entries(data).map(([p,b])=>({path:p,sha256:B.sha256(b),rows:3}))});
  data[Store.STATE_PATH]=data[Store.historyPath(1)]=Buffer.from(S.serialize(state));
  // Obsolete shard survives in Git but is outside the canonical day manifest.
  data['evidence/2026/10/09/payloads.001.ndjson.gz']=zlib.gzipSync(JSON.stringify(payloads[0])+'\n');
  const files=Object.entries(data).map(([p,b])=>({path:p,bytes:b.length,sha256:B.sha256(b),git_blob_sha:B.blobSha(b)}));
  const manifest={schema:B.SCHEMA,source_commit:'a'.repeat(40),source_repository:A.EVIDENCE_REPO,source_tree:B.treeSha(files),files,file_count:files.length,total_bytes:files.reduce((n,e)=>n+e.bytes,0)};
  manifest.manifest_sha256=B.seal(manifest);
  for(const [p,b]of Object.entries(data)){fs.mkdirSync(path.dirname(path.join(source,p)),{recursive:true});fs.writeFileSync(path.join(source,p),b);}
  fs.writeFileSync(path.join(source,'manifest.json'),JSON.stringify(manifest));
  const dest=path.join(root,'export'),result=await E.exportForensics(source,dest);
  assert.equal(result.days[0].flags,1);assert.equal(result.days[0].payloads,3);
  assert.deepEqual(result.excluded_unselected_shards,['evidence/2026/10/09/payloads.001.ndjson.gz']);
  const wallet=JSON.parse(fs.readFileSync(path.join(dest,'wallets',owner,'2026-10-09.json')));assert.equal(wallet.stable_totals[F.assetKey(stable)].sell_xrp,'300');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dest,'wallets',owner,'index.json'))).lifetime_history_complete,false);
  assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(dest,'days/2026-10-09/flagged-payloads.ndjson.gz'))).toString().trim().split('\n').length,3);
  assert(fs.readFileSync(path.join(dest,'daily-exchange-totals.csv'),'utf8').includes('"300"'));
  assert(fs.readFileSync(path.join(dest,'daily-wallet-totals.csv'),'utf8').includes('"'+owner+'"'));
  assert(B.verify(source).verified);await assert.rejects(()=>E.exportForensics(source,dest),/EEXIST/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
 console.log('PASS exact amounts, fees, issuer identity, opposite trustline orientation, validated fills, no-fill orders, cancellation ambiguity, self-payment boundary, pattern thresholds, verified export, flagged originals, and non-deleting retention');
})().catch(e=>{console.error(e);process.exitCode=1;});

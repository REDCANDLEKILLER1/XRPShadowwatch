'use strict';
// Synthetic protocol/storage fixtures. Not captured network evidence.
const {Readable}=require('stream'),crypto=require('crypto'),R=require('../r2-master-backup');
const hash=n=>BigInt(n).toString(16).padStart(64,'0').toUpperCase();
const close=n=>946684800+844830000+n*4;
function fakeS3(){
 const objects=new Map(),versions=new Map();let writes=0;
 const fake={objects,versions,total:0,fail:null,get writes(){return writes;},async send(cmd){
  const p=cmd.input; if(p.Bucket!==R.BUCKET)throw Error('WRONG_BUCKET');if(fake.fail)fake.fail(cmd);
  if(cmd.constructor.name==='ListObjectsV2Command')return{Contents:[{Key:'existing',Size:fake.total},...[...objects].map(([Key,b])=>({Key,Size:b.length}))]};
  if(cmd.constructor.name==='GetObjectCommand'){
   if(!objects.has(p.Key)){const e=Error('missing');e.name='NoSuchKey';throw e;}
   return{Body:Readable.from([objects.get(p.Key)]),ETag:versions.get(p.Key)};
  }
  if(cmd.constructor.name==='PutObjectCommand'){
   if((p.IfNoneMatch==='*'&&objects.has(p.Key))||(p.IfMatch&&p.IfMatch!==versions.get(p.Key))){const e=Error('conflict');e.name='PreconditionFailed';throw e;}
   if(!p.IfNoneMatch&&!p.IfMatch)throw Error('UNCONDITIONAL_WRITE');if(p.ACL)throw Error('PUBLIC_WRITE');
   const b=Buffer.from(p.Body);objects.set(p.Key,b);versions.set(p.Key,crypto.createHash('sha256').update(b).digest('hex'));writes++;return{};
  }throw Error('UNEXPECTED_STORAGE_COMMAND');
 }};return fake;
}
function rpcFixture(){
 const fixture={tip:100,fail:null,wrongParent:false,calls:[],now(){return close(fixture.tip)*1000+5000;},async rpc(method,p){
  if(method!=='ledger')throw Error('WRITE_METHOD');fixture.calls.push(p);
  const index=p.ledger_index==='validated'?fixture.tip:p.ledger_index??Number(BigInt('0x'+p.ledger_hash));
  if(index===fixture.fail)throw Error('PRIVATE_ENDPOINT_FAILURE');
  const tx={hash:hash(100000+index),tx_json:{Account:'r9NpyVfLfUG8hatuCCHKzosyDtKnBdsEN3',TransactionType:'AccountSet',Fee:'12'},
   meta:{TransactionIndex:0,TransactionResult:'tesSUCCESS',AffectedNodes:[]}};
  return{validated:true,ledger_index:index,ledger_hash:hash(index),ledger:{closed:true,ledger_index:index,ledger_hash:hash(index),
   parent_hash:fixture.wrongParent?hash(1):hash(index-1),close_time:close(index)-946684800,
   transactions:p.transactions?(p.expand===false?[tx.hash]:[tx]):[]}};
 }};return fixture;
}
module.exports={fakeS3,rpcFixture,hash,close};

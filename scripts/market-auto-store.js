'use strict';
// Shared serialized R2 writer lane is mandatory. Failed reservations remain charged.
// Only a successfully finished/readback-verified call may settle its own reservation.
const {PutObjectCommand}=require('@aws-sdk/client-s3'),C=require('./market-collector'),R=require('./r2-master-backup');
const PREFIX='market-auto/v1/',CONTROL_BYTES=65536;
function store(s3){
 let reservation=null,attemptedBytes=0;
 const adapter={send:async cmd=>{
  if(cmd.constructor.name==='PutObjectCommand')attemptedBytes+=Buffer.byteLength(cmd.input.Body);
  return s3.send(cmd);
 }};
 const base=C.r2Store(adapter);
 async function immutable(key,value){const body=Buffer.from(JSON.stringify(value)+'\n');
  await s3.send(new PutObjectCommand({Bucket:R.BUCKET,Key:key,Body:body,IfNoneMatch:'*',ContentType:'application/json'}));
  await R.download(s3,key,body.length,require('../src/db/master-backup').sha256(body));
 }
 async function usage(day){
  const inv=await R.inventory(s3),reservations=new Map(),settled=new Map();
  for(const key of inv.objects.keys()){
   if(!key.startsWith(PREFIX+'budgets/'+day+'/'))continue;
   const m=key.match(/\/(reserved|settled)\/([a-f0-9-]{36})\/(\d+)\.json$/);
   if(!m||!Number.isSafeInteger(Number(m[3]))||Number(m[3])<=0)throw Error('AUTO_BUDGET_INVALID');
   const group=m[1]==='reserved'?reservations:settled;if(group.has(m[2]))throw Error('AUTO_BUDGET_DUPLICATE');group.set(m[2],Number(m[3]));
  }
  for(const [id,n]of settled)if(!reservations.has(id)||n>reservations.get(id))throw Error('AUTO_SETTLEMENT_INVALID');
  let dayBytes=0;for(const [id,n]of reservations)dayBytes+=settled.get(id)||n;
  return{total:inv.total,dayBytes};
 }
 async function reserve(day,id,bytes){
  if(reservation)throw Error('AUTO_RESERVATION_PENDING');
  const u=await usage(day);if(u.total+bytes>R.LIMIT||u.dayBytes+bytes>C.LIMITS.day)throw Error('PILOT_CAPACITY_STOP');
  await immutable(PREFIX+'budgets/'+day+'/reserved/'+id+'/'+bytes+'.json',{reserved_bytes:bytes});
  reservation={day,id,bytes};attemptedBytes=0;
 }
 async function settle(){
  if(!reservation)return;
  // Charge all attempted bodies (including overwrites), plus 4 KiB for reservation
  // and settlement records. Storage failures keep the full reservation.
  const n=attemptedBytes+4096,r=reservation;
  if(n>r.bytes)throw Error('AUTO_RESERVATION_EXCEEDED');
  await immutable(PREFIX+'budgets/'+r.day+'/settled/'+r.id+'/'+n+'.json',{charged_bytes:n});reservation=null;
 }
 async function control(day,id){
  const u=await usage(day);if(u.total+CONTROL_BYTES>R.LIMIT||u.dayBytes+CONTROL_BYTES>C.LIMITS.day)throw Error('PILOT_CAPACITY_STOP');
  // Two supervisor writes, each at most 24 KiB, fit in this nonrefundable charge.
  await immutable(PREFIX+'budgets/'+day+'/reserved/'+id+'/'+CONTROL_BYTES+'.json',{reserved_bytes:CONTROL_BYTES});
 }
 return{...base,usage,reserve,settle,control};
}
module.exports={store,PREFIX,CONTROL_BYTES};

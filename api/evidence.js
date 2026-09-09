'use strict';
const E=require('../src/db/evidence');
const db=require('../src/db/connection');
const {acquireReader,releaseReader}=require('../src/db/xrpl-reader');
module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store, max-age=0');
  res.setHeader('CDN-Cache-Control','no-store');
  res.setHeader('Vercel-CDN-Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  const input=req.method==='GET'?(req.query||{}):(req.body||{});
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
  if(req.method==='POST' && req.headers.origin){
    let origin;try{origin=new URL(req.headers.origin).host;}catch(_){return res.status(403).json({error:'INVALID_ORIGIN'});}
    if(origin!==req.headers.host)return res.status(403).json({error:'CROSS_ORIGIN_WRITE_REFUSED'});
  }
  const allowed=req.method==='GET'?['health','read','read-run','summary']:['begin','catchup'];
  if(!allowed.includes(input.action))return res.status(400).json({error:'ACTION_NOT_ALLOWED'});
  let reader;
  try{
    if(!db.isConfigured())return res.status(503).json({error:'EVIDENCE_STORE_UNAVAILABLE'});
    if(input.action==='health'){
      const h=await db.health();return res.status(h.reachable?200:503).json({configured:h.configured,reachable:h.reachable});
    }
    if(input.action==='begin'){
      reader=acquireReader();return res.json(await E.begin({start_ms:input.start_ms,end_ms:input.end_ms,accounts:input.accounts},reader));
    }
    if(typeof input.scan_id!=='string'||!/^idx-[a-f0-9-]{36}$/.test(input.scan_id))return res.status(400).json({error:'INVALID_SCAN_ID'});
    if(input.action==='summary')return res.json(await E.summary(input.scan_id));
    if(input.action==='read-run')return res.json(await E.readRunWindow(input.scan_id,input.after));
    if(typeof input.address!=='string'||!/^r[1-9A-HJ-NP-Za-km-z]{24,35}$/.test(input.address))return res.status(400).json({error:'INVALID_ADDRESS'});
    if(input.action==='read')return res.json(await E.readWindow(input.scan_id,input.address,input.after));
    reader=acquireReader();return res.json(await E.catchUp(input.scan_id,input.address,reader));
  }catch(e){
    const safe=String(e.message||'EVIDENCE_REQUEST_FAILED').replace(/postgres(?:ql)?:\/\/\S+/gi,'[database connection redacted]');
    if(input.scan_id&&input.address){
      try{await db.getExecutor()(`UPDATE scan_wallets SET status=$3,error=$4,updated_at=now() WHERE scan_id=$1 AND address=$2 AND status<>'COMPLETE'`,
        [input.scan_id,input.address,e.pending?'PENDING':'FAILED',safe]);}catch(_){}
    }
    const transport=reader?{...reader.stats,first_failure:reader.stats.first_failure&&{...reader.stats.first_failure,
      reason:String(reader.stats.first_failure.reason||'').replace(/postgres(?:ql)?:\/\/\S+/gi,'[database connection redacted]')},
      events:reader.stats.events.map(ev=>({...ev,...(ev.reason?{reason:String(ev.reason).replace(/postgres(?:ql)?:\/\/\S+/gi,'[database connection redacted]')}:{})}))}:null;
    if(e.pending){res.setHeader('Retry-After',Math.ceil((e.retry_after_ms||1000)/1000));return res.status(202).json({pending:true,retry_after_ms:e.retry_after_ms||1000,error:safe,transport});}
    return res.status(503).json({error:safe,transport});
  }finally{if(reader)releaseReader(reader);}
};

'use strict';
const {archiveReport}=require('../src/db/github-archive');
module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='POST')return res.status(405).json({status:'FAILED',error:'METHOD_NOT_ALLOWED'});
  if(req.headers.origin){
    let origin;try{origin=new URL(req.headers.origin).host;}catch(_){return res.status(403).json({status:'FAILED',error:'INVALID_ORIGIN'});}
    if(origin!==req.headers.host)return res.status(403).json({status:'FAILED',error:'CROSS_ORIGIN_WRITE_REFUSED'});
  }
  try{return res.json(await archiveReport(req.body));}
  catch(e){
    const code=e.code==='ARCHIVE_CONFLICT'?409:/INVALID_|NOT_ALLOWED|REQUIRED|TOO_LARGE|FIELD_NOT_ALLOWED|TARGET_REFUSED/.test(e.message)?400:503;
    return res.status(code).json({attempted:true,status:e.code==='ARCHIVE_CONFLICT'?'ARCHIVE_CONFLICT':'FAILED',
      report_id:req.body&&req.body.report_id||null,branch:'shadowwatch-report-archive',error:String(e.message||'GITHUB_ARCHIVE_FAILED').slice(0,300)});
  }
};

'use strict';
module.exports=async function(req,res){
 res.setHeader('Cache-Control','private, no-store, max-age=0');res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method!=='GET')return res.status(405).json({status:'UNAVAILABLE',error:'METHOD_NOT_ALLOWED'});
 try{return res.json(await require('../src/db/forensic-report').read());}
 catch(_){return res.status(503).json({status:'UNAVAILABLE',error:'FORENSIC_REPORT_UNAVAILABLE'});}
};

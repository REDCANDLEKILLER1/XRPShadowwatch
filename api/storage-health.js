'use strict';
const H=require('../src/db/storage-health');
module.exports=async function(req,res){
 res.setHeader('Cache-Control','private, no-store');res.setHeader('CDN-Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method!=='GET')return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
 try{return res.json(await H.health());}catch(e){return res.status(503).json({error:'STORAGE_HEALTH_UNAVAILABLE',storage_verified:false});}
};

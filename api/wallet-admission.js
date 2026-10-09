'use strict';
const Auto=require('../src/db/auto-roster');
module.exports=async function(req,res){
 res.setHeader('Cache-Control','private, no-store');res.setHeader('CDN-Cache-Control','no-store');
 if(req.method!=='GET')return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
 try{return res.json(await Auto.preview());}catch(e){return res.status(503).json({error:'QUALIFICATION_UNAVAILABLE',write_attempted:false});}
};

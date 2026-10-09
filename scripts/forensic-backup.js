#!/usr/bin/env node
'use strict';
// New work directory on every run. Original evidence and checkpoints are never
// modified. A compact report summary is published only after verified R2 export.
const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
const B=require('../src/db/master-backup'),R=require('./r2-master-backup'),E=require('./forensic-export');
async function run(root){
 const s3=R.client();fs.mkdirSync(root,{recursive:false});
 const source=path.join(root,'source'),downloaded=path.join(root,'downloaded'),restored=path.join(root,'restored'),out=path.join(root,'forensics');
 await B.backup(source,{onProgress:(n,total)=>{if(n%100===0||n===total)console.log('Source verified: '+n+'/'+total);}});
 const restore=await R.roundTrip(source,downloaded,restored,s3);
 const receipt=await require('./publish-restore-receipt').publish(restored,restore);
 const analysis=await E.exportForensics(restored,out,{restoreReceipt:restore});
 const market=await require('./market-history').appendMarket(out,s3);
 const archive=path.join(root,'shadowwatch-forensics.tar.gz');
 execFileSync('tar',['-czf',archive,'-C',out,'.']);
 const uploaded=await require('./forensic-archive').publish(archive,restore.source_commit,s3);
 const report=await require('../src/db/forensic-report').publish(analysis.report_summary);
 const result={source_commit:restore.source_commit,restore_verified:true,manifest_sha256:restore.manifest_sha256,receipt,
  ...uploaded,days:analysis.days.length,flags:analysis.days.reduce((n,d)=>n+d.flags,0),market,report,source_deletion:false};
 console.log(JSON.stringify(result,null,2));
 if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  'Verified private forensic export\n\nR2 object: `'+uploaded.key+'`\n\nSHA256: `'+uploaded.sha256+'`\n\nBytes: '+uploaded.bytes+'; projected bucket bytes: '+uploaded.projected_bucket_bytes+'\n\nSource: `'+restore.source_commit+'`; days: '+result.days+'; flags: '+result.flags+'\n\nNo source data deleted.\n');
 return result;
}
if(require.main===module){if(!process.argv[2])throw Error('Usage: node scripts/forensic-backup.js NEW_WORK_DIRECTORY');run(process.argv[2]).catch(e=>{console.error('Forensic backup failed:',String(e.message).replace(/https?:\/\/\S+/g,'[endpoint]'));process.exitCode=1;});}
module.exports={run};

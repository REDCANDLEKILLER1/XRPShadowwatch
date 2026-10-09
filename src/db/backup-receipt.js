'use strict';
function destination(uri){
 const u=new URL(uri);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||/(^|\.)github\.com$|(^|\.)githubusercontent\.com$/i.test(u.hostname))throw Error('BACKUP_DESTINATION_REFUSED');return u.href;
}
function status(receipt,now=Date.now()){
 let valid=false;try{destination(receipt.destination_uri);const automated=receipt.destination_verification==='R2_DOWNLOADED_AND_ISOLATED_RESTORE'&&receipt.independent_readback_verified===true&&/^[a-f0-9]{40}$/.test(receipt.source_tree)&&Number.isSafeInteger(receipt.files)&&receipt.files>0&&Number.isSafeInteger(receipt.bytes)&&receipt.bytes>=0;
 valid=receipt.schema==='shadowwatch-independent-restore/1'&&receipt.restore_verified===true&&(receipt.destination_verification==='OPERATOR_DOWNLOADED_AND_RESTORED'||automated)&&/^[a-f0-9]{40}$/.test(receipt.source_commit)&&/^[a-f0-9]{64}$/.test(receipt.manifest_sha256);}catch(_){}
 const anchorAge=valid?now-Date.parse(receipt.evidence_anchor_close):Infinity;
 valid=valid&&Number.isFinite(anchorAge)&&anchorAge>=0&&anchorAge<=24*3600000;
 const age=valid?now-Date.parse(receipt.verified_at):Infinity;
 return{status:valid&&Number.isFinite(age)&&age>=0&&age<=24*3600000?'VERIFIED_RECENT':valid?'STALE':'NOT_VERIFIED',independent_restore_verified:valid&&Number.isFinite(age)&&age>=0&&age<=24*3600000,age_hours:Number.isFinite(age)?age/3600000:null,verification_method:valid?(receipt.destination_verification==='R2_DOWNLOADED_AND_ISOLATED_RESTORE'?'R2-downloaded copy passed isolated restoration, canonical source-tree and hash checks':'Operator-downloaded copy passed isolated restoration and hash checks'):null};
}
module.exports={destination,status};

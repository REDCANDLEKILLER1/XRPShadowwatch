'use strict';
const crypto=require('crypto'),R=require('./roster'),Store=require('./github-store'),A=require('./github-archive');
const POLICY={version:1,window_hours:72,min_payment_xrp:1000000,min_transactions:2,min_ledgers:2,min_total_xrp:5000000,max_additions_per_run:5};
// Decode classic XRPL addresses and verify the double-SHA256 checksum. A
// regex alone admits typo addresses that can stall every collection forever.
const alphabet='rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
function validAddress(s){
 if(typeof s!=='string'||!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(s))return false;
 let n=0n;for(const c of s){const i=alphabet.indexOf(c);if(i<0)return false;n=n*58n+BigInt(i);}
 let hex=n.toString(16);if(hex.length%2)hex='0'+hex;let bytes=Buffer.from(hex,'hex');let zeros=0;for(const c of s){if(c!==alphabet[0])break;zeros++;}bytes=Buffer.concat([Buffer.alloc(zeros),bytes]);
 if(bytes.length!==25||bytes[0]!==0)return false;
 const payload=bytes.subarray(0,21),sum=crypto.createHash('sha256').update(crypto.createHash('sha256').update(payload).digest()).digest().subarray(0,4);
 return sum.equals(bytes.subarray(21));
}
function qualify(events,watched,anchor){
 const end=Date.parse(anchor.anchor_close),ceiling=Number(anchor.anchor_ledger),start=end-POLICY.window_hours*3600000;
 if(!Number.isFinite(end)||!Number.isInteger(ceiling)||ceiling<=0)throw Error('AUTO_ROSTER_ANCHOR_UNPROVEN');
 const known=new Set(watched),seen=new Map(),candidates=new Map();
 for(const e of events||[]){
  const time=Date.parse(e.close_time),ledger=Number(e.ledger_index);
  if(e.validated!==true||e.tx_result!=='tesSUCCESS'||e.tx_type!=='Payment'||e.currency!=='XRP'||e.issuer||!/^\d+$/.test(String(e.amount_drops||''))||!/^[a-fA-F0-9]{64}$/.test(e.hash||'')||!Number.isInteger(ledger)||ledger<=0||ledger>ceiling||!Number.isFinite(time)||time<start||time>end)continue;
  const amount=BigInt(e.amount_drops);if(amount<BigInt(POLICY.min_payment_xrp)*1000000n||amount>100000000000000000n)continue;
  const hash=e.hash.toUpperCase();const fingerprint=JSON.stringify([e.from_account,e.to_account,e.amount_drops,ledger,e.close_time]);
  if(seen.has(hash)){if(seen.get(hash)!==fingerprint)throw Error('AUTO_ROSTER_CONFLICTING_HASH');continue;}seen.set(hash,fingerprint);
  // Only a proved watched sender's observed payment nominates a recipient.
  // Incoming spam, dust, IOUs, offers and escrow submits do not qualify it.
  if(!known.has(e.from_account)||known.has(e.to_account)||e.from_account===e.to_account||!validAddress(e.to_account)||!Array.isArray(e.observed_via)||!e.observed_via.includes(e.from_account))continue;
  let c=candidates.get(e.to_account);if(!c){c={address:e.to_account,total:0n,hashes:[],ledgers:new Set(),senders:new Set()};candidates.set(e.to_account,c);}
  c.total+=amount;c.hashes.push(hash);c.ledgers.add(ledger);c.senders.add(e.from_account);
 }
 return [...candidates.values()].filter(c=>c.hashes.length>=POLICY.min_transactions&&c.ledgers.size>=POLICY.min_ledgers&&c.total>=BigInt(POLICY.min_total_xrp)*1000000n)
  .sort((a,b)=>a.total===b.total?a.address.localeCompare(b.address):a.total>b.total?-1:1)
  .map(c=>({address:c.address,label:'AUTO_'+c.address,cat:'discovered_receiver',ownership:'UNKNOWN',transaction_count:c.hashes.length,total_xrp:Number(c.total)/1000000,total_drops:c.total.toString(),qualifying_hashes:c.hashes.sort(),ledgers:[...c.ledgers].sort((a,b)=>a-b),watched_senders:[...c.senders].sort(),policy_version:POLICY.version}));
}
async function preview(deps={}){
 const read=deps.readReport||require('../../api/delta').storedReport;
 const now=deps.now?deps.now():Date.now();const report=await read({window_start_ms:now-72*3600000,window_end_ms:now},deps);
 if(!report.stored_checkpoint||report.failed_wallets!==0||report.complete_wallets!==report.target_wallets||report.window?.provenance!=='OBSERVED'||(report.window?.days_without_shards||[]).length||!report.window?.shards_verified)throw Error('AUTO_ROSTER_EVIDENCE_INCOMPLETE');
 const watched=(report.wallets||[]).map(w=>w.address);
 const candidates=qualify(report.events,watched,report);
 return{schema:'shadowwatch-auto-roster-preview/1',policy:{...POLICY},source_commit:report.evidence_ref||null,state_sha256:report.state_sha256,anchor_ledger:report.anchor_ledger,anchor_close:report.anchor_close,candidates,per_run_limit:POLICY.max_additions_per_run,apply_status:'Automatic admission requires an enabled production scheduler and a verified independent restore receipt.',write_attempted:false};
}
async function selection(deps={}){
 const env=deps.env||process.env;
 if(String(env.SHADOWWATCH_AUTOROSTER_ENABLED||'').toLowerCase()!=='true')return{...R.select(),auto_roster:{status:'DISABLED',candidates:[]}};
 // Preview cannot modify the shared evidence or admission roster.
 A.evidenceWriteTarget(env);
 const loaded=await Store.readPinnedState(deps);if(!loaded.state)throw Error('AUTO_ROSTER_STATE_MISSING');
 const current=[...new Set([...R.select().accounts,...loaded.state.wallets.map(w=>w.address)])];
 const raw=await Store.readFile(loaded.gh,A.EVIDENCE_BRANCH,'evidence/backup/latest.json',loaded.ref);
 let receipt=null;try{receipt=raw&&JSON.parse(raw);}catch(_){}
 if(!require('./backup-receipt').status(receipt).independent_restore_verified)return{accounts:current,hash:R.identity(current),auto_roster:{status:'BACKUP_NOT_VERIFIED',candidates:[]}};
 try {
  const capacity=await (deps.health||require('./storage-health').health)(deps);
  if(capacity.capacity_status==='CRITICAL')return{accounts:current,hash:R.identity(current),auto_roster:{status:'STORAGE_CRITICAL',candidates:[]}};
  const proposed=await preview({...deps,ref:loaded.ref});const fresh=proposed.candidates.filter(c=>!current.includes(c.address)).slice(0,POLICY.max_additions_per_run);
  const accounts=current.concat(fresh.map(c=>c.address));
  return{accounts,hash:R.identity(accounts),auto_roster:{status:'QUALIFIED',policy:{...POLICY},source_commit:loaded.ref,anchor_ledger:proposed.anchor_ledger,state_sha256:proposed.state_sha256,candidates:fresh,restore_receipt:receipt.manifest_sha256}};
 }catch(e){
  // Optional discovery may pause; existing proved wallets keep collecting.
  return{accounts:current,hash:R.identity(current),auto_roster:{status:'QUALIFICATION_PAUSED',candidates:[]}};
 }
}
module.exports={POLICY,validAddress,qualify,preview,selection};

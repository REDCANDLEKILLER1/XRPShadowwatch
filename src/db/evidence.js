'use strict';
const { randomUUID } = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const db = require('./connection');
const C = require('./coverage');
const T = require('./transactions');
const roster = require('./roster');
const { Reader } = require('./xrpl-reader');
const iso = ms => new Date(ms).toISOString();
const ms = value => new Date(value).getTime();
const query = (sql, values) => db.getExecutor()(sql, values);
const columns = ['hash','ledger_index','close_time','tx_type','tx_result','validated','from_account','to_account',
  'amount_drops','amount_value','currency','issuer','destination_tag','source_tag','sig_mode','signer_count',
  'escrow_owner','escrow_destination','escrow_amount_drops','fee_drops','sequence','tx_flags','transaction_index',
  'roster_version','raw_tx','raw_meta','evidence','first_seen_scan_id'];

async function begin(input, reader) {
  const selected = roster.select(input.accounts);
  const start = Number(input.start_ms), requestedEnd = Number(input.end_ms);
  if (!Number.isFinite(start) || !Number.isFinite(requestedEnd) || start <= 0 || start > requestedEnd) throw new Error('INVALID_REPORT_WINDOW');
  const anchor = await reader.ledger('validated');
  if (start > anchor.close_ms) throw new Error('WINDOW_AFTER_ANCHOR');
  const end = Math.min(requestedEnd, anchor.close_ms);
  // Reuse a real server-observed header before this window when available.
  // This is a time/ledger boundary only; it grants no wallet coverage.
  const known=(await query(`SELECT ledger,closed FROM (
    SELECT floor_ledger AS ledger,floor_close_time AS closed FROM scan_runs WHERE floor_ledger IS NOT NULL
    UNION SELECT anchor_ledger,anchor_close_time FROM scan_runs
    ) h WHERE closed<$1 ORDER BY closed DESC LIMIT 1`,[iso(start)])).rows[0];
  const floor=known?await reader.ledger(Number(known.ledger)):await reader.floor(start,anchor);
  if(known && floor.close_ms!==ms(known.closed))throw new Error('STORED_LEDGER_CLOSE_MISMATCH');
  const id = 'idx-' + randomUUID();
  await db.transaction(async q => {
    await q(`INSERT INTO scan_runs(scan_id,anchor_ledger,anchor_close_time,window_start,window_end,target_wallets,
      roster_hash,roster_accounts,floor_ledger,floor_close_time,transport)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id,anchor.ledger,iso(anchor.close_ms),iso(start),iso(end),selected.accounts.length,selected.hash,
      JSON.stringify(selected.accounts),floor.ledger,iso(floor.close_ms),JSON.stringify(reader.stats)]);
    await q(`INSERT INTO scan_wallets(scan_id,address) SELECT $1, unnest($2::text[])`, [id, selected.accounts]);
  });
  return { scan_id:id, anchor_ledger:anchor.ledger, anchor_close_ms:anchor.close_ms,
    floor_ledger:floor.ledger, floor_close_ms:floor.close_ms, start_ms:start, end_ms:end,
    roster_hash:selected.hash, accounts:selected.accounts, transport:reader.stats };
}
async function getRun(id) {
  const run = (await query('SELECT * FROM scan_runs WHERE scan_id=$1', [id])).rows[0];
  if (!run) throw new Error('UNKNOWN_SCAN');
  if (roster.identity(run.roster_accounts) !== run.roster_hash) throw new Error('STORED_ROSTER_IDENTITY_MISMATCH');
  return run;
}
function decision(run, coverage) {
  return C.windowServability({ coverage, windowStartMs:ms(run.window_start), windowEndMs:ms(run.window_end),
    anchorLedger:Number(run.anchor_ledger), anchorCloseMs:ms(run.anchor_close_time) });
}
function retainedProof(run, coverage, id) {
  const cov=C.normalizeCoverage(coverage);
  return {status:'COMPLETE',range_bound_proven:true,range_exhausted:true,covers_window_start:true,edge_fetch_complete:true,
    proven_reason:'SERVER_RETAINED_RANGE_PROVEN',from_ledger:cov.scan_coverage_from,through_ledger:Number(run.anchor_ledger),
    retained_from_ledger:cov.evidence_retained_from,retained_through_ledger:cov.evidence_retained_through,
    anchor_ledger:Number(run.anchor_ledger),run_id:id,request_bounded:true,transport_consistent:true,
    window_bounded_by_anchor:true,response_validated:true,source:'NEON_VERIFIED_INDEX',
    response_ledger_index_max:Number(run.anchor_ledger),response_ledger_index_min:cov.scan_coverage_from,pages_scanned:0};
}
async function persist(run, address, rows, proof, metrics) {
  assertConsistentRaw(rows);
  return db.transaction(async q => {
    // Serialize this address across runs, including its first-ever insertion.
    await q('SELECT pg_advisory_xact_lock(hashtextextended($1,9134))', [address]);
    const current = (await q('SELECT * FROM wallet_coverage WHERE address=$1 FOR UPDATE', [address])).rows[0];
    const c = C.normalizeCoverage(current);
    const advance = C.checkpointAdvance({ coverage:current, anchorLedger:Number(run.anchor_ledger), proof });
    if (!advance.advance && advance.reason !== 'NO_FORWARD_PROGRESS') throw new Error('CHECKPOINT_REFUSED: ' + advance.reason);
    for (let offset=0; offset<rows.length; offset+=200) {
      const chunk = rows.slice(offset,offset+200);
      for (const row of chunk) {
        db.assertNoSecretMaterial(row);
        if (!/^[A-Fa-f0-9]{64}$/.test(row.hash || '') || !Number.isInteger(row.ledger_index) ||
            row.ledger_index < proof.from_ledger || row.ledger_index > proof.through_ledger ||
            row.validated !== true || row.close_time_ms === null || !row.tx_result) throw new Error('INVALID_LEDGER_EVIDENCE');
      }
      const payload = chunk.map(r => ({ ...r, close_time:r.close_time_iso, first_seen_scan_id:run.scan_id }));
      // A conflicting response may not rewrite facts for an existing hash.
      const conflict = await q(`SELECT t.hash FROM transactions t JOIN jsonb_populate_recordset(NULL::transactions,$1::jsonb) r USING(hash)
        WHERE t.ledger_index<>r.ledger_index OR t.raw_tx<>r.raw_tx OR t.raw_meta<>r.raw_meta LIMIT 1`, [JSON.stringify(payload)]);
      if (conflict.rows.length) throw new Error('CONFLICTING_TRANSACTION_EVIDENCE: '+conflict.rows[0].hash);
      await q(`INSERT INTO transactions(${columns.join(',')}) SELECT ${columns.join(',')} FROM
        jsonb_populate_recordset(NULL::transactions,$1::jsonb) ON CONFLICT(hash) DO NOTHING`, [JSON.stringify(payload)]);
      await q(`INSERT INTO transaction_accounts(tx_hash,address,role)
        SELECT tx_hash,address,role FROM jsonb_to_recordset($1::jsonb) AS p(tx_hash text,address text,role text)
        ON CONFLICT DO NOTHING`, [JSON.stringify(chunk.flatMap(T.participantsOf))]);
    }
    // Extend proof monotonically. A wider cold rescan may restore pruned
    // evidence without increasing the high-water mark of the proof.
    const through = Math.max(c.scan_coverage_through || 0, proof.through_ledger);
    const from = Math.min(c.scan_coverage_from || proof.from_ledger, proof.from_ledger);
    const fromClose = from === c.scan_coverage_from ? c.scan_coverage_from_close_ms : proof.from_close_ms;
    const throughClose = through === c.scan_coverage_through ? c.scan_coverage_through_close_ms : proof.through_close_ms;
    const retainedAdjacent = c.evidence_retained_through !== null && c.evidence_retained_through >= proof.from_ledger-1 &&
      c.evidence_retained_from <= proof.through_ledger+1;
    const retainedFrom = retainedAdjacent ? Math.min(c.evidence_retained_from,proof.from_ledger) : proof.from_ledger;
    const retainedThrough = retainedAdjacent ? Math.max(c.evidence_retained_through,proof.through_ledger) : proof.through_ledger;
    const retainedClose = retainedFrom === c.evidence_retained_from ? c.evidence_retained_from_close_ms : proof.from_close_ms;
    await q(`INSERT INTO wallet_coverage(address,scan_coverage_from,scan_coverage_through,scan_coverage_from_close,scan_coverage_through_close,
      evidence_retained_from,evidence_retained_through,evidence_retained_from_close,last_observed_tx_ledger,last_status,last_scan_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'COMPLETE',$10) ON CONFLICT(address) DO UPDATE SET
      scan_coverage_from=excluded.scan_coverage_from,scan_coverage_through=excluded.scan_coverage_through,
      scan_coverage_from_close=excluded.scan_coverage_from_close,scan_coverage_through_close=excluded.scan_coverage_through_close,
      evidence_retained_from=excluded.evidence_retained_from,evidence_retained_through=excluded.evidence_retained_through,
      evidence_retained_from_close=excluded.evidence_retained_from_close,
      last_observed_tx_ledger=GREATEST(wallet_coverage.last_observed_tx_ledger,excluded.last_observed_tx_ledger),
      last_status='COMPLETE',last_scan_id=excluded.last_scan_id`,
    [address,from,through,iso(fromClose),iso(throughClose),retainedFrom,retainedThrough,iso(retainedClose),
      rows.length ? Math.max(...rows.map(r=>r.ledger_index)) : null,run.scan_id]);
    const floorExtended=c.scan_coverage_from!==null && from<c.scan_coverage_from;
    if (advance.advance || floorExtended) await q(`INSERT INTO coverage_advances(address,scan_id,from_through,to_through,proven_from,proven_through,rows_stored,reason,from_floor,to_floor)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [address,run.scan_id,c.scan_coverage_through,through,proof.from_ledger,proof.through_ledger,rows.length,
        advance.advance?advance.reason:'PROOF_FLOOR_EXTENDED',c.scan_coverage_from,from]);
    const after = (await q('SELECT * FROM wallet_coverage WHERE address=$1',[address])).rows[0];
    const complete=decision(run,after).complete_without_fetch;
    if (!complete && proof.partial !== true) throw new Error('STORED_WINDOW_NOT_SERVABLE');
    const previous=(await q('SELECT metrics FROM scan_wallets WHERE scan_id=$1 AND address=$2',[run.scan_id,address])).rows[0];
    const prior=previous&&previous.metrics||{};
    const combined={...metrics,requests:Number(prior.requests||0)+metrics.requests,rows_fetched:Number(prior.rows_fetched||0)+metrics.rows_fetched,
      segments:Number(prior.segments||0)+1,first_fetch_from_ledger:prior.first_fetch_from_ledger||metrics.fetch_from_ledger};
    await q(`UPDATE scan_wallets SET status=$5,proof=$3,metrics=$4,error=NULL,updated_at=now() WHERE scan_id=$1 AND address=$2`,
      [run.scan_id,address,JSON.stringify(proof),JSON.stringify(combined),complete?'COMPLETE':'PENDING']);
  });
}
// Validated account_tx pages carry full raw evidence. Unlike legacy enrichment
// sightings, duplicate hashes on this path must agree, even when node counts
// match. Check before deduplication and before either partial or final writes.
function assertConsistentRaw(rows) {
  const seen=new Map();
  for(const row of rows){
    const prior=seen.get(row.hash);
    if(prior && (!isDeepStrictEqual(prior.raw_tx,row.raw_tx) || !isDeepStrictEqual(prior.raw_meta,row.raw_meta)))
      throw new Error('CONFLICTING_TRANSACTION_SIGHTINGS');
    seen.set(row.hash,row);
  }
}
async function catchUp(id, address, reader) {
  const run = await getRun(id);
  if (!run.roster_accounts.includes(address)) throw new Error('ADDRESS_OUTSIDE_RUN_ROSTER');
  const cov = (await query('SELECT * FROM wallet_coverage WHERE address=$1',[address])).rows[0];
  const d = decision(run,cov), anchor = Number(run.anchor_ledger);
  const existing=(await query('SELECT status,proof,metrics FROM scan_wallets WHERE scan_id=$1 AND address=$2',[id,address])).rows[0];
  if(d.complete_without_fetch && existing && existing.status==='COMPLETE')return {scan_id:id,address,...existing.metrics,proof:existing.proof,resumed:true};
  const baseline = reader.stats.requests;
  const metrics = { mode:d.reason, fetch_from_ledger:d.fetch_from_ledger, fetch_to_ledger:anchor, requests:0, rows_fetched:0 };
  let proof;
  if (!d.complete_without_fetch) {
    const priorCoverage=C.normalizeCoverage(cov);
    const from = d.served_from_index ? d.fetch_from_ledger : Math.min(Number(run.floor_ledger),
      priorCoverage.scan_coverage_through===null?Number(run.floor_ledger):priorCoverage.scan_coverage_through+1);
    let rows;
    for (let restart=0; restart<4; restart++) {
      rows=[];
      const verifiedAnchor = {ledger:anchor,close_ms:ms(run.anchor_close_time)};
      if (verifiedAnchor.close_ms !== ms(run.anchor_close_time)) throw new Error('RUN_ANCHOR_MISMATCH');
      const verifiedFloor = from===Number(run.floor_ledger)?{ledger:from,close_ms:ms(run.floor_close_time)}:await reader.ledger(from);
      const range = await reader.retainedRange(anchor);
      const epoch = reader.epoch;
      if (!range || !range.some(r=>r[0]<=from && r[1]>=anchor)) throw new Error('REQUESTED_RANGE_NOT_RETAINED');
      let marker, pages=0;
      try {
        do {
          const cmd={command:'account_tx',account:address,ledger_index_min:from,ledger_index_max:anchor,limit:200,forward:true};
          if (marker) cmd.marker=marker;
          const result = await reader.request(cmd,epoch);
          if (result.validated !== true || Number(result.ledger_index_min)!==from || Number(result.ledger_index_max)!==anchor) throw new Error('ACCOUNT_TX_RESPONSE_RANGE_UNPROVEN');
          if (result.account !== address || !Array.isArray(result.transactions)) throw new Error('ACCOUNT_TX_RESPONSE_MALFORMED');
          for (const item of result.transactions) {
            const row=T.rowFromAccountTx(item,{observedVia:address,rosterVersion:run.roster_hash,scanId:id});
            if (row.ledger_index===null || row.ledger_index<from || row.ledger_index>anchor || row.validated!==true || row.close_time_ms===null) throw new Error('ROW_OUTSIDE_PROVEN_RANGE');
            if(rows.length && row.ledger_index<rows[rows.length-1].ledger_index)throw new Error('FORWARD_PAGE_ORDER_UNPROVEN');
            rows.push(row);
          }
          const next=result.marker;
          if (next && marker && JSON.stringify(next)===JSON.stringify(marker)) throw new Error('ACCOUNT_TX_MARKER_NOT_ADVANCING');
          marker=next; pages++;
          if (marker && Date.now()>reader.deadline-90000 && rows.length && rows[rows.length-1].ledger_index>from) {
            // Forward pagination has finished every ledger strictly before the
            // last row's ledger. Keep that proven prefix; replay the unfinished
            // ledger on the next invocation, without persisting a socket marker.
            const through=rows[rows.length-1].ledger_index-1;
            // A partial older backfill is a separate island until it touches
            // existing proof. Keep walking; never bridge the unread gap with
            // min/max bounds. If the read budget expires, the old checkpoint
            // remains unchanged and this wallet resumes with an honest gap.
            if(priorCoverage.scan_coverage_from!==null && through<priorCoverage.scan_coverage_from-1){
              if(Date.now()>reader.deadline){const e=new Error('XRPL_READ_PENDING: older prefix has not joined retained proof');e.pending=true;throw e;}
              continue;
            }
            const header=await reader.ledger(through);
            const prefix=T.mergeSightings(rows.filter(r=>r.ledger_index<=through));
            if(prefix.some(r=>r.conflicts.length))throw new Error('CONFLICTING_TRANSACTION_SIGHTINGS');
            const part={status:'COMPLETE',range_bound_proven:true,from_ledger:from,through_ledger:through,
              from_close_ms:verifiedFloor.close_ms,through_close_ms:header.close_ms,rows_stored:prefix.length,
              anchor_ledger:anchor,run_id:id,partial:true,terminal:'FORWARD_PAGE_CROSSED_LEDGER',
              transport_epoch:epoch,response_ledger_index_max:anchor,response_validated:true};
            metrics.requests=reader.stats.requests-baseline;metrics.rows_fetched=prefix.length;metrics.pages=pages;metrics.fetch_from_ledger=from;
            await persist(run,address,prefix,part,{...metrics,transport:reader.stats});
            return {scan_id:id,address,...metrics,pending:true,retry_after_ms:1000,proven_through:through,transport:reader.stats};
          }
          if (Date.now()>reader.deadline) { const e=new Error('XRPL_READ_PENDING');e.pending=true;throw e; }
        } while (marker);
        metrics.fetch_from_ledger=from;metrics.requests=reader.stats.requests-baseline;metrics.rows_fetched=rows.length;metrics.pages=pages;
        proof={status:'COMPLETE',range_bound_proven:true,from_ledger:from,through_ledger:anchor,
          from_close_ms:verifiedFloor.close_ms,through_close_ms:verifiedAnchor.close_ms,rows_stored:rows.length,
          request_bounded:true,transport_consistent:true,transport_epoch:epoch,actual_endpoint:reader.stats.actual_endpoint,
          anchor_ledger:anchor,run_id:id,window_bounded_by_anchor:true,response_validated:true,
          response_ledger_index_min:from,response_ledger_index_max:anchor,pages_scanned:pages,
          range_exhausted:true,edge_fetch_complete:true,covers_window_start:true,
          index_history_used:d.served_from_index,history_exhausted:false,boundary_reached:false};
        break;
      } catch(e) { if(e.message==='XRPL_TRANSPORT_CHANGED'&&restart<3) continue; throw e; }
    }
    assertConsistentRaw(rows);
    const merged=T.mergeSightings(rows);
    if (merged.some(r=>r.conflicts.length)) throw new Error('CONFLICTING_TRANSACTION_SIGHTINGS');
    await persist(run,address,merged,proof,{...metrics,transport:reader.stats});
  } else {
    proof=retainedProof(run,cov,id);
    await query(`UPDATE scan_wallets SET status='COMPLETE',proof=$3,metrics=$4,updated_at=now() WHERE scan_id=$1 AND address=$2`,
      [id,address,JSON.stringify(proof),JSON.stringify(metrics)]);
  }
  return { scan_id:id,address,...metrics,proof,transport:reader.stats };
}
async function readWindow(id,address,after) {
  const run=await getRun(id);
  if (!run.roster_accounts.includes(address)) throw new Error('ADDRESS_OUTSIDE_RUN_ROSTER');
  const cov=(await query('SELECT * FROM wallet_coverage WHERE address=$1',[address])).rows[0];
  const d=decision(run,cov);
  if (!d.complete_without_fetch) return {available:false,decision:d,transactions:[]};
  // Observation provenance selects the rows, never a many-to-many amount SUM.
  const rows=(await query(`SELECT t.* FROM transactions t WHERE t.ledger_index<=$1 AND t.close_time>=$2 AND t.close_time<=$3
    AND ($5::text IS NULL OR t.hash>$5) AND EXISTS(SELECT 1 FROM transaction_accounts a WHERE a.tx_hash=t.hash AND a.address=$4 AND a.role='observed_via')
    ORDER BY t.hash LIMIT 201`,[run.anchor_ledger,run.window_start,run.window_end,address,after||null])).rows;
  const more=rows.length>200;const selected=rows.slice(0,200);
  return {available:true,scan_id:id,roster_hash:run.roster_hash,decision:{...d,edge_fetch_complete:true},
    next:more?selected[selected.length-1].hash:null,
    proof:retainedProof(run,cov,id),
    transactions:selected.map(r=>({tx_json:{...r.raw_tx,hash:r.hash,ledger_index:Number(r.ledger_index)},meta:r.raw_meta,
      hash:r.hash,ledger_index:Number(r.ledger_index),validated:r.validated,close_time_iso:iso(ms(r.close_time))}))};
}
function reportFact(r, observedVia) {
  const amount = r.currency==='XRP'
    ? (r.amount_drops===null ? null : String(r.amount_drops))
    : (r.amount_value===null ? null : String(r.amount_value));
  const escrowAmount=r.escrow_amount_drops===null?null:String(r.escrow_amount_drops);
  return {hash:r.hash,ledger_index:Number(r.ledger_index),date:iso(ms(r.close_time)),type:r.tx_type,
    tx_result:r.tx_result,validated:r.validated===true,from:r.from_account||'',to:r.escrow_destination||r.to_account||'',
    amount:amount,currency:r.currency||'XRP',issuer:r.issuer||'',destination_tag:r.destination_tag,
    sig_mode:r.sig_mode||'unknown',signer_count:Number(r.signer_count)||0,escrow_owner:r.escrow_owner||'',
    escrow_amount_drops:escrowAmount,observed_via:Array.isArray(observedVia)?observedVia:[]};
}
// Once every wallet has proved its edge, serve one canonical hash stream for
// the run. The old browser path reread the same transaction once per observed
// wallet and downloaded full raw_tx/raw_meta on every report. Those complete
// payloads remain the evidence of record in Neon; this projection uses the
// intrinsic facts classified once at ingestion and removes cross-wallet copies.
async function readRunWindow(id,after) {
  const run=await getRun(id);
  const status=(await query(`SELECT count(*)::integer AS total,
    count(*) FILTER (WHERE status='COMPLETE')::integer AS complete,
    count(*) FILTER (WHERE status='FAILED')::integer AS failed
    FROM scan_wallets WHERE scan_id=$1`,[id])).rows[0];
  if(Number(status.total)!==Number(run.target_wallets)||Number(status.complete)!==Number(run.target_wallets)||Number(status.failed)!==0)
    return {available:false,scan_id:id,roster_hash:run.roster_hash,target_wallets:Number(run.target_wallets),
      complete_wallets:Number(status.complete),error:'RUN_WINDOW_NOT_FULLY_PROVEN',transactions:[]};
  const rosterJson=JSON.stringify(run.roster_accounts);
  const rows=(await query(`SELECT t.*,
    ARRAY(SELECT DISTINCT a.address FROM transaction_accounts a
      WHERE a.tx_hash=t.hash AND a.role='observed_via'
      AND a.address IN (SELECT jsonb_array_elements_text($5::jsonb)) ORDER BY a.address) AS observed_via
    FROM transactions t
    WHERE t.ledger_index<=$1 AND t.close_time>=$2 AND t.close_time<=$3
      AND ($4::text IS NULL OR t.hash>$4)
      AND EXISTS(SELECT 1 FROM transaction_accounts a WHERE a.tx_hash=t.hash AND a.role='observed_via'
        AND a.address IN (SELECT jsonb_array_elements_text($5::jsonb)))
    ORDER BY t.hash LIMIT 1001`,[run.anchor_ledger,run.window_start,run.window_end,after||null,rosterJson])).rows;
  const more=rows.length>1000,selected=rows.slice(0,1000);
  return {available:true,scan_id:id,roster_hash:run.roster_hash,anchor_ledger:Number(run.anchor_ledger),
    target_wallets:Number(run.target_wallets),complete_wallets:Number(status.complete),
    next:more?selected[selected.length-1].hash:null,
    transactions:selected.map(r=>reportFact(r,r.observed_via))};
}
async function summary(id) {
  const run=await getRun(id);
  const wallets=(await query('SELECT address,status,proof,metrics,error FROM scan_wallets WHERE scan_id=$1 ORDER BY address',[id])).rows;
  const complete=wallets.filter(w=>w.status==='COMPLETE').length;
  const status=complete===run.target_wallets?'COMPLETE':'PARTIAL';
  await query(`UPDATE scan_runs SET complete_wallets=$2,failed_wallets=$3,status=$4,finished_at=now() WHERE scan_id=$1`,[id,complete,wallets.filter(w=>w.status==='FAILED').length,status]);
  return {scan_id:id,anchor_ledger:Number(run.anchor_ledger),anchor_close_time:run.anchor_close_time,roster_hash:run.roster_hash,
    target_wallets:run.target_wallets,complete_wallets:complete,status,
    requests:wallets.reduce((n,w)=>n+Number(w.metrics.requests||0),0),rows_fetched:wallets.reduce((n,w)=>n+Number(w.metrics.rows_fetched||0),0),wallets};
}
async function archiveFacts(id) {
  const run=await getRun(id);
  const wallets=(await query('SELECT status,proof,metrics FROM scan_wallets WHERE scan_id=$1',[id])).rows;
  const tx=(await query(`SELECT count(DISTINCT t.hash)::integer AS count FROM transactions t
    WHERE t.ledger_index<=$1 AND t.close_time>=$2 AND t.close_time<=$3
    AND EXISTS(SELECT 1 FROM transaction_accounts a WHERE a.tx_hash=t.hash AND a.role='observed_via'
      AND a.address IN (SELECT jsonb_array_elements_text($4::jsonb)))`,
    [run.anchor_ledger,run.window_start,run.window_end,JSON.stringify(run.roster_accounts)])).rows[0];
  const count=status=>wallets.filter(w=>(((w.proof&&w.proof.status)||w.status)===status)).length;
  const complete=count('COMPLETE'),failed=count('FAILED'),truncated=count('TRUNCATED'),unproven=count('UNPROVEN');
  return {evidence_scan_id:id,generated_at:new Date(run.created_at||run.anchor_close_time).toISOString(),
    roster_hash:run.roster_hash,target_wallets:Number(run.target_wallets),transaction_windows_proved:complete,
    failed,truncated,unproven,validated_anchor_ledger:Number(run.anchor_ledger),
    transactions_in_window:Number(tx&&tx.count)||0,
    new_observations:wallets.reduce((n,w)=>n+Number(w.metrics&&w.metrics.rows_fetched||0),0),
    xrpl_requests:wallets.reduce((n,w)=>n+Number(w.metrics&&w.metrics.requests||0),0),
    stored_history_reused:wallets.some(w=>w.metrics&&w.metrics.mode==='EDGE_ONLY'),
    coverage_complete:complete===Number(run.target_wallets)&&failed===0&&truncated===0&&unproven===0};
}
module.exports={begin,getRun,decision,persist,catchUp,readWindow,readRunWindow,summary,archiveFacts,Reader};

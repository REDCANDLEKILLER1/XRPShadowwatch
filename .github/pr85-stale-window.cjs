'use strict';
const fs=require('fs'), assert=require('assert');
function replace(path, oldText, newText){
  const s=fs.readFileSync(path,'utf8');
  assert.strictEqual(s.split(oldText).length,2,'expected one match: '+path);
  fs.writeFileSync(path,s.replace(oldText,newText));
}
replace('api/delta.js',
"  const endMs = Math.min(requestedEnd, anchorCloseMs);\n",
"  const staleWindow = requestedEnd > anchorCloseMs;\n  const endMs = Math.min(requestedEnd, anchorCloseMs);\n");
replace('api/delta.js',
"    reason: 'PREVIEW_READ_ONLY_SNAPSHOT',\n",
"    reason: staleWindow ? 'STORED_WINDOW_STALE' : 'PREVIEW_READ_ONLY_SNAPSHOT',\n");
replace('api/delta.js',
"      capped_to_checkpoint: requestedEnd > anchorCloseMs,\n      claimed_beyond_checkpoint_ms",
"      capped_to_checkpoint: staleWindow,\n      full_window_complete: !staleWindow,\n      status: staleWindow ? 'STORED_WINDOW_STALE' : 'COMPLETE',\n      evidence_cutoff: new Date(endMs).toISOString(),\n      claimed_beyond_checkpoint_ms");
replace('api/delta.js',
"      capped_to_checkpoint: requestedEnd > anchorCloseMs,\n      days: assembled.days,",
"      capped_to_checkpoint: staleWindow,\n      full_window_complete: !staleWindow,\n      status: staleWindow ? 'STORED_WINDOW_STALE' : 'COMPLETE',\n      evidence_cutoff: new Date(endMs).toISOString(),\n      days: assembled.days,");
replace('src/brief/45-delta-evidence-index-20260911.js',
`            log('Evidence: anchor ' + result.anchor_ledger + ' · ' + result.complete_wallets + '/' +
              result.target_wallets + ' proved · ' + (result.transactions || 0) + ' transactions · ' +
              (result.xrpl_requests || 0) + ' XRPL reads' +
              (result.window && result.window.in_window !== undefined
                ? ' · window ' + result.window.in_window + ' events (' +
                  result.window.from_stored + ' stored + ' + result.window.from_this_run + ' this run)' : '') +
              (result.committed ? ' · checkpoint advanced'
                : ' · checkpoint NOT advanced (' + result.reason + ')'));`,
`            var staleStoredWindow = !!(result.freshness && result.freshness.status === 'STORED_WINDOW_STALE');
            log('Evidence: anchor ' + result.anchor_ledger + ' · ' + result.complete_wallets + '/' +
              result.target_wallets + (staleStoredWindow ? ' wallets proven through stored cutoff' : ' proved') +
              ' · new transactions acquired=' + (result.transactions || 0) +
              ' · ' + (result.xrpl_requests || 0) + ' watched-wallet XRPL reads' +
              (result.window && result.window.in_window !== undefined
                ? ' · stored transactions loaded=' + result.window.in_window + ' (' +
                  result.window.from_stored + ' stored + ' + result.window.from_this_run + ' this run)' : '') +
              (result.committed ? ' · checkpoint advanced'
                : ' · checkpoint NOT advanced (' + result.reason + ')'));
            if (staleStoredWindow) {
              log('Evidence: STORED_WINDOW_STALE — requested window is only proven through ' +
                (result.freshness.evidence_cutoff || result.anchor_close) + '; ' +
                Math.round((Number(result.freshness.claimed_beyond_checkpoint_ms) || 0) / 1000) +
                's of the requested tail is not covered. Preview remains read-only; direct watched-wallet account_tx is disabled.');
            }`);
replace('src/brief/17-report-scan-tuning-20260816.js',
"    var c = {\n      target_wallets: target,",
"    var storedWindowStale = false, evidenceCutoff = null;\n    try {\n      var ir = (typeof state !== 'undefined') && state.indexRun;\n      storedWindowStale = !!(ir && ir.freshness && ir.freshness.status === 'STORED_WINDOW_STALE');\n      evidenceCutoff = storedWindowStale ? (ir.freshness.evidence_cutoff || ir.anchor_close || null) : null;\n    } catch (_) {}\n\n    var c = {\n      target_wallets: target,");
replace('src/brief/17-report-scan-tuning-20260816.js',
"      anchor_ok: anchorOk,\n      // The identity",
"      anchor_ok: anchorOk,\n      stored_window_stale: storedWindowStale,\n      evidence_cutoff: evidenceCutoff,\n      coverage_status: storedWindowStale ? 'STORED_WINDOW_STALE' : 'COMPLETE_OR_MEASURED',\n      // The identity");
replace('src/brief/17-report-scan-tuning-20260816.js',
"      full_window_complete: anchorOk && target > 0 && complete === target &&\n                            failed === 0 && truncated === 0 && unproven === 0 && unknown === 0",
"      full_window_complete: !storedWindowStale && anchorOk && target > 0 && complete === target &&\n                            failed === 0 && truncated === 0 && unproven === 0 && unknown === 0");
replace('scripts/preview-no-direct-xrpl-fallback.test.js',
"  reason: 'PREVIEW_READ_ONLY_SNAPSHOT', preview_read_only: true, live_acquisition_disabled: true,\n  window:",
"  reason: 'STORED_WINDOW_STALE', preview_read_only: true, live_acquisition_disabled: true,\n  freshness: { status: 'STORED_WINDOW_STALE', evidence_cutoff: close, claimed_beyond_checkpoint_ms: 3600000, full_window_complete: false },\n  window:");
replace('scripts/preview-no-direct-xrpl-fallback.test.js',
"    assert.equal(r.s.SW_EVIDENCE_INDEX.metrics().checkpoint_advanced, false);\n    const proof",
"    assert.equal(r.s.SW_EVIDENCE_INDEX.metrics().checkpoint_advanced, false);\n    assert(r.logs.some(x => x.includes('new transactions acquired=0')));\n    assert(r.logs.some(x => x.includes('stored transactions loaded=0')));\n    const proof");
replace('scripts/preview-no-direct-xrpl-fallback.test.js',
"      assert.equal(done.complete_wallets, 1);",
"      assert.equal(done.complete_wallets, 1);\n      assert.equal(done.reason, 'STORED_WINDOW_STALE');\n      assert.equal(done.freshness.status, 'STORED_WINDOW_STALE');\n      assert.equal(done.freshness.full_window_complete, false);\n      assert.equal(done.freshness.evidence_cutoff, close);\n      assert.equal(done.window.status, 'STORED_WINDOW_STALE');\n      assert.equal(done.window.full_window_complete, false);");
console.log('stale-window follow-up applied');
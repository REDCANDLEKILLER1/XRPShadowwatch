'use strict';
const fs=require('fs'),assert=require('assert');
function rep(p,a,b){const s=fs.readFileSync(p,'utf8');assert.strictEqual(s.split(a).length,2,'match '+p);fs.writeFileSync(p,s.replace(a,b));}
rep('src/brief/17-report-scan-tuning-20260816.js',
"          var cov = aggregateCoverage();\n          if (state.indexRun",
"          var cov = aggregateCoverage();\n          if (cov.stored_window_stale) {\n            var cutoff = cov.evidence_cutoff || 'the stored checkpoint';\n            var err = new Error('STORED_WINDOW_STALE: Stored evidence is available only through ' + cutoff + '. The requested transaction window is not fully proven. No report created. Preview remains read-only; direct watched-wallet account_tx is disabled.');\n            err.code = 'STORED_WINDOW_STALE';\n            err.evidence_cutoff = cutoff;\n            err.tx_scan_coverage = cov;\n            throw err;\n          }\n          if (state.indexRun");
rep('src/brief/17-report-scan-tuning-20260816.js',
"    } else {\n      // Every cause named.",
"    } else if (c.stored_window_stale === true || c.coverage_status === 'STORED_WINDOW_STALE') {\n      line = 'STORED WINDOW STALE — all ' + complete + '/' + target + ' watched wallets are proven only through ' +\n             (c.evidence_cutoff || 'the stored checkpoint') + '; the requested tail is not covered. No report created.';\n    } else {\n      // Every cause named.");
rep('src/brief/17-report-scan-tuning-20260816.js',
"      anchor_ok: anchorOk,\n      measured: measured,",
"      anchor_ok: anchorOk,\n      stored_window_stale: c.stored_window_stale === true,\n      evidence_cutoff: c.evidence_cutoff || null,\n      coverage_status: c.coverage_status || null,\n      measured: measured,");
rep('src/brief/17-report-scan-tuning-20260816.js',
"          completed = true;\n\n          var proofs",
"          var _earlyIndexRun = (typeof state !== 'undefined') ? state.indexRun : null;\n          if (_earlyIndexRun && _earlyIndexRun.freshness && _earlyIndexRun.freshness.status === 'STORED_WINDOW_STALE') {\n            var _cutoff = _earlyIndexRun.freshness.evidence_cutoff || _earlyIndexRun.anchor_close || 'the stored checkpoint';\n            var _stale = new Error('STORED_WINDOW_STALE: Stored evidence is available only through ' + _cutoff + '. The requested transaction window is not fully proven. No report created. Preview remains read-only; direct watched-wallet account_tx is disabled.');\n            _stale.code = 'STORED_WINDOW_STALE';\n            _stale.evidence_cutoff = _cutoff;\n            throw _stale;\n          }\n          completed = true;\n\n          var proofs");
console.log('early stale stop applied');
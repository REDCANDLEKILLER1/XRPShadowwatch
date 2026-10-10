'use strict';
const assert=require('assert/strict'),W=require('../src/shared/market-watch');
const at='2026-10-10T20:23:40.000Z';
const envelope={status:'AVAILABLE',summary:{schema:'shadowwatch-forensic-report/1',window_start:'2026-10-09T10:19:32Z',window_end:'2026-10-10T10:19:32Z',
 exchange_transactions:2,classified_records:20,xrp_sold_for_rlusd:'0.177986',xrp_bought_with_rlusd:'0.448342',repeated_quote_wallets:0,repeated_cancel_wallets:0,regular_transfer_wallets:3,unclassified_records:0},
 collector:{status:'AVAILABLE',summary:{schema:'shadowwatch-market-coverage/1',generated_at:'2026-10-10T20:00:08.960Z',state:'RUNNING',
  coverage:{start:100,next:105,verified_ledgers:5,observed_tip:129,last_verified_close:'2026-10-10T19:58:21Z',collection_delay_ms:107960,schedule_delay_ms:0,missing_ranges:[{from:105,through:129,reason:'BACKLOG'}]},
  storage:{bucket_bytes:2483785310,bucket_limit:8000000000,daily_charged_bytes:357637,daily_limit:33554432,day_utc:'2026-10-10'},
  executions:{transactions:293,order_book_fills:1,partial_fills:1,order_book_xrp:'1.425213',order_book_rlusd:'2',amm_swaps:0,amm_xrp:'0',amm_rlusd:'0',unclassified_transactions:74,liquidity_operations:0}}}};
const before=JSON.stringify(envelope),text=W.render(envelope,{asOf:at});
assert.match(text,/24 minutes old/);assert.match(text,/26 minutes before that check/);
assert(!text.includes('Collection lag at snapshot'),'overview must not present the historic lag as current freshness');
assert.match(text,/0.177986 XRP was exchanged for RLUSD/);
assert.match(text,/matched amounts of 1.425213 XRP and 2 RLUSD/);
assert(!text.includes('exchanging 1.425213 XRP for'),'aggregate fills do not establish trade direction');
assert.match(text,/5 verified ledgers.*293 transactions/);assert.match(text,/74 transactions could not yet be classified/);
assert.match(text,/No verified XRP\/RLUSD AMM swaps in this collected sample/);
assert.match(text,/105–129 \(BACKLOG\)/);assert.match(text,/backlog may have grown/);
assert.match(text,/do not add their totals/);assert.match(text,/cannot keep up with XRPL/);
assert.match(text,/does not confirm scheduled runs/);
assert.equal(W.overview(envelope,{asOf:at}).label,'Saved sample · missing coverage');
assert(!W.overview(envelope,{asOf:at}).label.includes('RUNNING'));
const stale=W.render(envelope,{asOf:'2026-10-10T20:46:00Z'});
assert(!stale.includes('1.425213'));assert(!stale.includes('74 transactions'));assert.match(stale,/execution totals are withheld/);
assert.equal(W.collectorStatus(envelope.collector,'2026-10-10T20:45:08.960Z'),'AVAILABLE');
assert.equal(W.collectorStatus(envelope.collector,'2026-10-10T20:45:08.961Z'),'STALE');
assert.equal(W.collectorStatus({...envelope.collector,status:'STALE'},at),'STALE');
assert.equal(W.collectorStatus(envelope.collector,'2026-10-10T19:00:00Z'),'UNAVAILABLE');
assert(!W.render(envelope,{asOf:'2026-10-12T20:00:00Z'}).includes('0.177986'),'wallet summary also ages out');
const missing=W.render({...envelope,collector:{status:'UNAVAILABLE'}},{asOf:at});
assert.match(missing,/coverage is unavailable/);assert(!missing.includes('0 verified'));assert(missing.includes('0.177986'));
const noWallet=W.render({status:'UNAVAILABLE',collector:envelope.collector},{asOf:at});
assert(noWallet.includes('1.425213'));assert.match(noWallet,/Missing analysis does not mean zero/);
const noTime=W.render(envelope);assert(!noTime.includes('minutes old'),'do not invent a report reference time');
const frozen={market_watch:envelope,market_watch_as_of_utc:at},original='Story\n\nHow to Read It\nContext';
const saved=W.inject(original,frozen);assert(saved.includes(text));assert.equal(W.inject(saved,{...frozen,market_watch_as_of_utc:'2026-10-12T20:00:00Z'}),saved);
assert.equal(W.inject('Market activity watch\nOld sealed text',frozen),'Market activity watch\nOld sealed text');
assert.equal(JSON.stringify(envelope),before,'presentation never changes collected evidence');
const sandbox={window:{},URL};require('vm').runInNewContext(require('fs').readFileSync(require.resolve('../src/brief/31-public-morning-4k-20260817.js'),'utf8'),sandbox);
const longReport='Executive Summary\n'+('Observed movement in watched wallets. '.repeat(90))+'\n\n'+text+'\n\nVerdict\nNo price-control conclusion.\n\nLEDGER DIAGNOSTICS\n'+('Historical evidence only. '.repeat(20));
const compact=sandbox.window.SW_PUBLIC_MORNING_4K_20260817.publicText(longReport);
assert(compact.length<=4000);assert(compact.includes(text),'short copy preserves findings, time periods and limitations together');
assert(compact.includes('No price-control conclusion.'));
const withoutDiagnostics=sandbox.window.SW_PUBLIC_MORNING_4K_20260817.publicText(longReport.split('\nLEDGER DIAGNOSTICS\n')[0]);
assert(withoutDiagnostics.length<=4000);assert(withoutDiagnostics.includes(text));
const oversizeTail=sandbox.window.SW_PUBLIC_MORNING_4K_20260817.publicText(longReport+'Diagnostics only. '.repeat(300));
assert(oversizeTail.length<=4000);assert.match(oversizeTail,/findings are omitted/);assert(!oversizeTail.includes('1.425213'));
console.log('PASS shared overview: snapshot age, ledger age, separate periods/totals, bounded scope, stale/unknown withholding and frozen reports');

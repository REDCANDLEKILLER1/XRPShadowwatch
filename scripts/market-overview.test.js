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

// Public story excludes optional pilot diagnostics; technical overview is intact.
const story='Executive Summary\n221.90M XRP across 72 transfers.\n\nHow to Read It\nObserved movement.\n\nLEDGER DIAGNOSTICS\n• Watched-ledger evidence current through: 2026-10-12T10:19:31.000Z · CURRENT\n• Live order/offer sweep: not collected in this stored-evidence report.\n• Native XRPL DEX (24h): SOURCE UNAVAILABLE (no decision recorded)\n• Transaction coverage incomplete — do not treat as a complete window.\n• XRP price: ~$1.3882\n\n🙏 THE DAILY PRAYER\nPrayer text.\n\nSources\nSource text.';
const technical=W.inject(story,{market_watch:envelope,market_watch_as_of_utc:at});
const publicStory=W.publicReport(technical,{});
assert(!/What’s missing|BACKLOG|Private storage|Daily collection budget|market activity watch|SOURCE UNAVAILABLE|not collected/.test(publicStory));
assert.match(publicStory,/221.90M XRP across 72 transfers/);
assert.match(publicStory,/Watched-wallet data through: 2026-10-12T10:19:31.000Z/);
assert.match(publicStory,/Transaction coverage incomplete/,'material main-report limitations stay visible');
assert.match(publicStory,/Prayer text/);assert.match(publicStory,/Source text/);assert.match(publicStory,/XRP price/);
assert.equal(W.publicReport(publicStory,{}),publicStory);
assert.match(technical,/BACKLOG/);assert.match(technical,/Private storage/);
const core=require('fs').readFileSync(require('path').join(__dirname,'../src/brief/02-core.js'),'utf8');
assert.match(core,/structured\s*\? window.SW_MARKET_WATCH.inject\(out, pack\)\s*: window.SW_MARKET_WATCH.publicReport\(out, pack\)/);
console.log('PASS public/technical separation: pilot withheld, evidence timestamp and main coverage warnings retained');

#!/usr/bin/env node
/* ── A BROKEN FEED IS NOT A QUIET MARKET ──────────────────────────────────────
   On 2026-09-04 the Report told listeners, on air:

       • Native XRPL DEX (24h): $3K

   directly under "$3.26B" of exchange volume, which reads as "the XRPL's own
   DEX is dead". It is not. DefiLlama's dexs/xrpl adapter stopped reporting on
   2026-09-02:

       2026-09-01   $4,699,013     last day the adapter worked
       2026-09-02   $2,600
       2026-09-03   $3,010         the number that went on air
       2026-09-04   $3,532

   Everything needed to reject it arrived in the SAME response: total7d
   $25,308,259, total30d $229,849,904 (~$7.7M/day), and a protocol breakdown
   with the native order-book adapter returning null while Sologenic alone
   reported. fetchDefiDex read `total24h`, checked only `> 0`, and printed it.

   Measured from the ledger that morning: 7,661,930 XRP ~ $11.1M.

   Two properties, and the second is the one that keeps this from happening
   again with a different source:
     1. the figure is ledger-derived, not a third-party dollar aggregate
     2. no number is printed that its OWN source contradicts, and an
        unavailable source is SAID, never rendered as a zero and never
        silently dropped

   Run: node scripts/dex-volume-truth.test.js
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const path = require('path');
const DEX = require(path.join(__dirname, '..', 'src/brief/40-dex-volume-truth-20260904.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

// The real payload shape, with the real numbers from the morning it broke.
const BROKEN_PAYLOAD = {
  total24h: 3010,
  total48hto24h: 2600,
  total7d: 25308259,
  total30d: 229849904,
  protocols: [
    { name: 'XRPL DEX', module: 'xrpl-dex', total24h: null },
    { name: 'Sologenic', module: 'sologenic', total24h: 3532 }
  ]
};
// The same endpoint on a day it worked.
const HEALTHY_PAYLOAD = {
  total24h: 4699013,
  total7d: 25308259,
  total30d: 229849904,
  protocols: [
    { name: 'XRPL DEX', module: 'xrpl-dex', total24h: 4200000 },
    { name: 'Sologenic', module: 'sologenic', total24h: 499013 }
  ]
};
// Ledger-derived, as measured: the real top of the book.
const LEDGER_TOKENS = [
  { currency: '524C555344', meta: { token: { name: 'Ripple USD' } }, metrics: { volume_24h: '5686498' } },
  { currency: '55534443',   meta: { token: { name: 'Circle USDC' } }, metrics: { volume_24h: '700404' } },
  { currency: '46555A',     meta: { token: { name: 'Fuzzybear' } },   metrics: { volume_24h: '186168' } },
  { currency: '41524D59',   meta: { token: { name: 'ARMY' } },        metrics: { volume_24h: '147162' } },
  { currency: '564C54',     meta: { token: { name: 'Valtorum USD' } },metrics: { volume_24h: '117195' } },
  // The remainder of the measured top 200, so this fixture sums to the real
  // figure (7,661,930 XRP) rather than to a subset. A fixture that does not
  // reproduce the observed total cannot check the observed dollar amount.
  { currency: 'REST', meta: { token: { name: 'rest of top 200' } }, metrics: { volume_24h: '824503' } }
];
const XRP_PRICE = 1.4532;

// ════════════════════════════════════════════════════════════════════════════
console.log('\n1. the aggregator payload condemns its own number');
const broken = DEX.aggregatorHealth(BROKEN_PAYLOAD);
check('the broken day is refused', broken.plausible === false, broken);
check('and the reason names the silent adapter, which is the real cause',
      broken.reason === 'PARTIAL_ADAPTERS', broken.reason);
check('the silent adapter is identified by name',
      broken.silent_adapters.indexOf('XRPL DEX') >= 0, broken.silent_adapters);
check('the trailing average is computed from the SAME response',
      Math.round(broken.trailing_daily_usd) === Math.round(25308259 / 7),
      broken.trailing_daily_usd);
check('the ratio shows how far off it was',
      broken.ratio_to_trailing < 0.001, broken.ratio_to_trailing);

const healthy = DEX.aggregatorHealth(HEALTHY_PAYLOAD);
check('a working day is accepted', healthy.plausible === true && healthy.reason === 'OK');
check('and carries its value', healthy.value_usd === 4699013);

// A day that is merely QUIET must still pass — the gate is for broken feeds,
// not for low volume. Half the trailing average is a slow day, not a fault.
check('a genuinely quiet day is not mistaken for a broken feed',
      DEX.aggregatorHealth({ total24h: 1800000, total7d: 25308259,
        protocols: [{ name: 'XRPL DEX', total24h: 1500000 },
                    { name: 'Sologenic', total24h: 300000 }] }).plausible === true);
// But a collapse with no null adapter is still caught, by the ratio alone.
check('a collapse with every adapter reporting is still caught by the ratio',
      DEX.aggregatorHealth({ total24h: 3010, total7d: 25308259,
        protocols: [{ name: 'XRPL DEX', total24h: 10 },
                    { name: 'Sologenic', total24h: 3000 }] }).reason === 'BELOW_TRAILING_AVERAGE');
check('an all-null breakdown is refused for having no value at all',
      DEX.aggregatorHealth({ total24h: 0, total7d: 25308259, protocols: [] }).reason === 'NO_VALUE');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n2. the ledger-derived sum');
const led = DEX.sumLedgerVolume(LEDGER_TOKENS);
check('per-token volumes sum to the measured figure',
      led.xrp === 7661930, led.xrp);
check('the token count is reported, not assumed', led.tokens_counted === 6);
check('the leaders are carried for the diagnostics surface',
      led.top[0].name === 'Ripple USD' && led.top[0].xrp === 5686498);
check('a short list does NOT claim its tail is negligible',
      led.tail_negligible === false);
check('a full page does',
      DEX.sumLedgerVolume(new Array(200).fill({ metrics: { volume_24h: '1' } })).tail_negligible === true);
check('zero and malformed volumes are skipped, not coerced',
      DEX.sumLedgerVolume([{ metrics: { volume_24h: '0' } },
                           { metrics: { volume_24h: 'abc' } },
                           { metrics: {} }, {}]).xrp === 0);
check('an empty list yields zero, not a crash',
      DEX.sumLedgerVolume([]).xrp === 0 && DEX.sumLedgerVolume(null).xrp === 0);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n3. the decision — what may actually be printed');

// The morning that broke: ledger says $11.1M, aggregator says $3,010.
const both = DEX.reconcile({ ledger: led, aggregator: broken, xrpPriceUsd: XRP_PRICE });
check('the ledger figure wins', both.source === 'ledger' && both.printable === true);
check('and it is the measured number, not the aggregator\'s',
      Math.round(both.usd) === Math.round(led.xrp * XRP_PRICE), Math.round(both.usd));
check('it reproduces the measured 2026-09-04 figure',
      Math.round(both.usd) === Math.round(7661930 * XRP_PRICE) &&
      Math.round(both.usd) === 11134317, Math.round(both.usd));
check('which is three-and-a-half THOUSAND times what went on air',
      both.usd / 3010 > 3000, Math.round(both.usd / 3010));
check('the disagreement is recorded rather than hidden',
      both.cross_check.disagreement_ratio > 1000, both.cross_check);
check('and the note says the feed disagrees',
      /aggregator feed disagrees/.test(both.note), both.note);

// No ledger source, healthy aggregator: it may stand in.
const aggOnly = DEX.reconcile({ ledger: null, aggregator: healthy, xrpPriceUsd: XRP_PRICE });
check('a healthy aggregator may stand in when the ledger source is down',
      aggOnly.printable === true && aggOnly.source === 'aggregator' &&
      aggOnly.usd === 4699013);
check('and is marked as reported, not measured', aggOnly.confidence === 'reported');

// THE CASE THAT PUT $3K ON AIR. No ledger source, broken aggregator.
const neither = DEX.reconcile({ ledger: null, aggregator: broken, xrpPriceUsd: XRP_PRICE });
check('THE REGRESSION — a broken aggregator alone is NOT printable',
      neither.printable === false, neither);
check('no number is offered at all', neither.usd === null && neither.xrp === null);
check('and the reason survives to the surface',
      neither.reason === 'PARTIAL_ADAPTERS', neither.reason);
check('$3,010 appears nowhere in the decision',
      JSON.stringify(neither).indexOf('3010') < 0, neither);

// Nothing at all.
const nothing = DEX.reconcile({});
check('no sources at all is not printable', nothing.printable === false &&
      nothing.reason === 'NO_SOURCE');

// A ledger figure with no XRP price: the XRP number is still real.
const noPrice = DEX.reconcile({ ledger: led, aggregator: null, xrpPriceUsd: 0 });
check('a missing price does not discard the measured XRP volume',
      noPrice.printable === true && noPrice.xrp === led.xrp && noPrice.usd === null);
check('and says why the dollar figure is absent', noPrice.reason === 'NO_XRP_PRICE');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n4. what the Report actually says');
// A missing line reads as "we did not look". A zero reads as "the DEX is
// dead". Both are claims we have not earned, so the unavailable case is SAID.
const unavailableLine = DEX.line(neither);
check('an unavailable source is stated in words',
      /SOURCE UNAVAILABLE/.test(unavailableLine), unavailableLine);
check('the line is never dropped and never renders a zero',
      unavailableLine.length > 0 && !/\$0\b/.test(unavailableLine) &&
      !/\$3K|3,010|\$3010/.test(unavailableLine), unavailableLine);
check('and it names why', /silent|PARTIAL|unavailable/i.test(unavailableLine));

const goodLine = DEX.line(both);
check('a measured figure prints in millions, not as a bare integer',
      /\$11\.\d\dM/.test(goodLine), goodLine);
check('and shows the XRP volume behind it',
      /XRP, ledger-derived/.test(goodLine), goodLine);
check('the exact false figure from 2026-09-04 can never be produced here',
      !/\$3K/.test(goodLine) && !/\$3K/.test(unavailableLine));
check('a no-price decision prints XRP and says the price is missing',
      /XRP \(no USD price this run\)/.test(DEX.line(noPrice)), DEX.line(noPrice));

// The formatter must not round a real figure down into the false one.
check('11.13M formats as $11.13M, not $11M or $3K',
      DEX._fmtUsd(11134316) === '$11.13M', DEX._fmtUsd(11134316));
check('3010 would format as $3.0K — which is why it must never reach the line',
      DEX._fmtUsd(3010) === '$3.0K');

console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
process.exit(fail ? 1 : 0);

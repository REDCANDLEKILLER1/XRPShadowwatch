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
];
// The remainder of the measured top 200, as 195 separate rows rather than one
// aggregate. The fixture must reproduce the observed COUNT as well as the
// observed total (7,661,930 XRP): the scope label is built from the returned
// count, so a 6-row stand-in for 200 tokens would have made every label
// assertion test a number the real endpoint never produces.
for (let i = 0; i < 195; i++) {
  LEDGER_TOKENS.push({ currency: 'F' + i, meta: { token: { name: 'filler ' + i } },
                       metrics: { volume_24h: String(i === 194 ? 4271 : 4228) } });
}
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
const led = DEX.sumLedgerVolume(LEDGER_TOKENS, 165624);
check('per-token volumes sum to the measured figure',
      led.xrp === 7661930, led.xrp);
check('the token count is reported, not assumed', led.tokens_counted === 200, led.tokens_counted);
check('the leaders are carried for the diagnostics surface',
      led.top[0].name === 'Ripple USD' && led.top[0].xrp === 5686498);
// `tail_negligible: list.length >= 100` used to live here, asserted true for a
// full page. How many tokens came back says NOTHING about the volume of the
// ones that did not. Against ~165,000 XRPL tokens the honest bound —
// smallest returned x number omitted — exceeds the total, which is the proof
// that this endpoint cannot establish negligibility at all.
check('negligibility of the omitted tail is never claimed',
      led.tail_proven_negligible === false);
check('not even for a full page of 200',
      DEX.sumLedgerVolume(new Array(200).fill({ metrics: { volume_24h: '1' } }), 165624)
        .tail_proven_negligible === false);
check('the inputs a reader would need are reported instead',
      led.smallest_returned_xrp === 4228 && led.tokens_total === 165624 &&
      led.tokens_returned === 200, { s: led.smallest_returned_xrp, t: led.tokens_total });
check('an unknown total is null, not a guess',
      DEX.sumLedgerVolume(LEDGER_TOKENS).tokens_total === null);
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
// The method acknowledges token<->token double counting (over) and an
// unbounded omitted tail (under). "$11.13M" asserts a precision it does not
// have. The public correction given to the operator was "~$11M"; the Report
// must not claim more than that.
check('the figure is rendered as an APPROXIMATION, not a measurement',
      /~\$11M/.test(goodLine) && !/\$11\.\d\dM/.test(goodLine), goodLine);
check('and is labelled an estimate',
      /ledger-derived estimate/.test(goodLine), goodLine);
check('the XRP volume behind it is approximate too',
      /~7\.66M XRP/.test(goodLine), goodLine);
check('two significant figures at most — no false precision from the formatter',
      DEX.fmtUsdApprox(11134317) === '$11M' && DEX.fmtUsdApprox(3010) === '$3K');
check('the exact false figure from 2026-09-04 can never be produced here',
      !/\$3K/.test(goodLine) && !/\$3K/.test(unavailableLine));
check('a no-price decision prints approximate XRP and says the price is missing',
      /~7\.66M XRP \(no USD price this run\)/.test(DEX.line(noPrice)), DEX.line(noPrice));

// The formatter must not round a real figure down into the false one.
check('the exact formatter still exists for internal use',
      DEX._fmtUsd(11134316) === '$11.13M', DEX._fmtUsd(11134316));
check('but it is NOT what reaches the Report line',
      !/\$11\.13M/.test(DEX.line(both)), DEX.line(both));
check('3010 would format as $3.0K — which is why it must never reach the line',
      DEX._fmtUsd(3010) === '$3.0K');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n5. the stale-number bypass is closed at the call sites');
// The decision layer is only as good as the two places that use it. Before
// this, market() cleared inXrpldex ONLY on the success path, so a decision
// layer that failed to load — or a thrown fetch — left the PREVIOUS run's
// number sitting in the field, and 10-pipeline printed any bare value > 0.
// A stale figure walked straight past the gate. These are source assertions
// because the call sites are browser code the pure suite cannot execute; they
// are narrow enough to bite and are sabotage-verified.
const fs2 = require('fs');
const CORE = fs2.readFileSync(path.join(__dirname, '..', 'src/brief/02-core.js'), 'utf8');
const PIPE = fs2.readFileSync(path.join(__dirname, '..', 'src/brief/10-pipeline.js'), 'utf8');

const dexBlock = (CORE.split('// 7. Native XRPL DEX')[1] || '').split('// 8.')[0];
check('the DEX acquisition block exists to be checked', dexBlock.length > 400);
// This compared indexOf(clear) < indexOf(acquire). Deleting the clear entirely
// makes indexOf return -1, and -1 < anything is TRUE — so a MISSING clear read
// as "cleared very early" and the sabotage restoring the original bypass left
// the suite green. Assert the clear EXISTS first, then that it precedes
// acquisition.
const _clearAt   = dexBlock.indexOf("$('inXrpldex').value = ''");
const _acquireAt = dexBlock.indexOf('window.SW_DEX_VOLUME');
check('inXrpldex is cleared at all', _clearAt >= 0, _clearAt);
check('and the clear happens BEFORE acquisition, not only on success',
      _clearAt >= 0 && _acquireAt >= 0 && _clearAt < _acquireAt,
      { clear: _clearAt, acquire: _acquireAt });
check('the stored decision is cleared before acquisition too',
      /state\.dexVolumeDecision = null/.test(dexBlock));
check('a missing decision layer is reported as unavailable, not merely noted',
      /DECISION_LAYER_MISSING/.test(dexBlock) && !/Native DEX layer missing/.test(dexBlock));
check('a thrown acquisition is reported as unavailable too',
      /ACQUISITION_FAILED/.test(dexBlock));

// Strip line comments first. The previous form matched the phrase `if(nat>0)`
// inside the comment EXPLAINING why it was removed — a check that would have
// passed on prose while the code did anything at all. Same trap the SQL checks
// in db-foundation.test.js strip comments to avoid.
const stripJsComments = (t) => t.split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n');
const pipeBlock = stripJsComments(
  (PIPE.split('Native XRPL DEX. Rendered from the DECISION')[1] || '').slice(0, 1400));
check('the render block exists to be checked', pipeBlock.length > 200);
check('there is NO numeric fallback that could print an unvetted figure',
      !/xrpl_dex_volume_24h_usd\)[\s\S]{0,80}?_usdC\(/.test(pipeBlock), pipeBlock.slice(0, 300));
check('the fallback says SOURCE UNAVAILABLE instead',
      /SOURCE UNAVAILABLE \(no decision recorded\)/.test(pipeBlock));
check('and that is real code, not a comment about it',
      /L\.push\([^;]*SOURCE UNAVAILABLE/.test(pipeBlock));
check('and the line is never simply dropped',
      !/if\s*\(\s*nat\s*>\s*0\s*\)/.test(pipeBlock));

// ════════════════════════════════════════════════════════════════════════════
console.log('\n6. the LABEL is a claim too — scope, not just precision');
// Fixing "$11.13M" to "~$11M" fixed the PRECISION of the number and left the
// SCOPE of the sentence overstated: "Native XRPL DEX (24h): ~$11M" reads as
// the whole native DEX, when what was measured is the top slice of a token
// index against ~165,000 indexed tokens. The label must say what was looked at.
check('the scope is named, not implied',
      /Native XRPL DEX observed volume \(top 200-token index, 24h\)/.test(goodLine), goodLine);
check('THE REGRESSION — the unscoped label never fronts a ledger figure',
      !/^\u2022 Native XRPL DEX \(24h\): ~\$/.test(goodLine), goodLine);
check('and the count in the label is the count actually returned',
      DEX.reconcile({ ledger: led, aggregator: null, xrpPriceUsd: XRP_PRICE })
         .scope.tokens_returned === 200);

// A DEGRADED response is a second, different failure from the unbounded tail.
// The tail is a permanent limit of the method. A short sample is the index
// answering with less than we asked for, and the claim must shrink with it
// rather than keep the 200-token wording.
const SHORT_TOKENS = [];
for (let i = 0; i < 12; i++) {
  SHORT_TOKENS.push({ currency: 'S' + i, metrics: { volume_24h: '1000' } });
}
const shortLed = DEX.sumLedgerVolume(SHORT_TOKENS, 165624);
check('a short sample is detected against the requested count',
      shortLed.sample_short === true && shortLed.tokens_requested === 200, shortLed);
check('a full page against a large index is NOT flagged short',
      DEX.sumLedgerVolume(LEDGER_TOKENS, 165624).sample_short === false);
check('nor is a list that is short only because the index really is that small',
      DEX.sumLedgerVolume(SHORT_TOKENS, 12).sample_short === false);
check('an unreported total assumes the worse case rather than the flattering one',
      DEX.sumLedgerVolume(SHORT_TOKENS).sample_short === true);

const shortDec = DEX.reconcile({ ledger: shortLed, aggregator: null, xrpPriceUsd: XRP_PRICE });
const shortLine = DEX.line(shortDec);
check('a degraded response labels the SMALLER observed sample',
      /top 12-token index/.test(shortLine), shortLine);
check('and does NOT keep claiming the 200-token scope',
      !/200-token/.test(shortLine), shortLine);
check('and the shortfall is stated in words, with both numbers',
      /index returned 12 of 200 tokens requested/.test(shortLine), shortLine);

// Two things can be wrong with one figure. `out.note` was a single slot, so
// whichever was written second erased the first.
const shortAndWrong = DEX.reconcile({ ledger: shortLed, aggregator: broken, xrpPriceUsd: XRP_PRICE });
check('a short sample AND a disagreeing aggregator both survive to the note',
      /index returned 12 of 200/.test(shortAndWrong.note) &&
      /aggregator feed disagrees/.test(shortAndWrong.note), shortAndWrong.note);

// An aggregator dollar figure is not a ledger observation and must not borrow
// the wording of one.
const aggLine = DEX.line(aggOnly);
check('an aggregator figure is labelled reported, not observed',
      /reported volume \(third-party aggregator, 24h\)/.test(aggLine), aggLine);
check('and never claims a token index it did not read',
      !/observed volume/.test(aggLine) && !/token index/.test(aggLine), aggLine);
check('an aggregator decision carries no measurement scope at all',
      aggOnly.scope === null, aggOnly.scope);
check('and neither does an unprintable one', neither.scope === null);

check('the decision restates that the tail is unbounded, rather than inheriting it',
      both.scope.tail_proven_negligible === false && both.scope.tokens_total === 165624,
      both.scope);

// The short-sample test compares against the count in the URL. If the URL and
// the constant could drift apart, the test would compare against a number we
// never asked for.
check('the requested limit and the URL cannot drift apart',
      DEX.XRPLMETA_LIMIT === 200 &&
      DEX.XRPLMETA_URL.indexOf('limit=' + DEX.XRPLMETA_LIMIT) > 0, DEX.XRPLMETA_URL);

// The endpoint reports its own total as `count`. Without it every healthy run
// showed tokens_total=null and the short-sample test had to guess.
const lm = dexBlock.match(/sumLedgerVolume\(([^)]*)\)/);
check('the call site passes the endpoint total, not just the token list',
      !!lm && /lj\s*&&\s*lj\.count/.test(lm[1]), lm && lm[1]);

console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
process.exit(fail ? 1 : 0);

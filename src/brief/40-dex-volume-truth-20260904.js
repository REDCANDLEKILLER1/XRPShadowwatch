// XRPMAN Shadow Watch — native XRPL DEX volume, from the ledger.
//
// ── What went wrong ─────────────────────────────────────────────────────────
// On 2026-09-04 the Report told listeners:
//
//     • Native XRPL DEX (24h): $3K
//
// printed next to "$3.26B" of exchange volume, which reads as "the XRPL's own
// DEX is dead". It is not. DefiLlama's `dexs/xrpl` adapter stopped reporting on
// 2026-09-02 and the figure collapsed while the market did not:
//
//     2026-08-28   $8,875,069
//     2026-09-01   $4,699,013     <- last day the adapter worked
//     2026-09-02   $2,600
//     2026-09-03   $3,010         <- the number that went on air
//     2026-09-04   $3,532
//
// The same HTTP response carried `total7d = $25,308,259` and
// `total30d = $229,849,904` — about $7.7M a day — and a protocol breakdown
// showing the native order-book adapter returning NULL while only Sologenic
// reported. Every fact needed to reject the number arrived in the same
// payload, unread. fetchDefiDex took `total24h` and accepted anything > 0.
//
// Measured against the ledger the same morning: 7,661,930 XRP of DEX volume in
// 24h across the top 200 tokens, about $11.1M. The tail is irrelevant — ranks
// 101-200 contribute 0.66%.
//
// ── What this layer does ────────────────────────────────────────────────────
// Two changes, and the second matters more than the first:
//
//   1. The number now comes from LEDGER-DERIVED per-token DEX volume
//      (xrplmeta indexes the XRPL's own order book and AMM), not from a
//      third-party dollar aggregate.
//
//   2. No figure is printed that its OWN source contradicts. A 24h value far
//      below the same response's trailing average is a broken feed, not a
//      quiet market, and it is refused. When nothing trustworthy is available
//      the Report says the source is unavailable — it never prints a number,
//      and it never silently drops the line either. Silence and a false number
//      are both worse than saying we do not know.
//
// ── Honest scope ────────────────────────────────────────────────────────────
// xrplmeta derives its figures from the ledger, but it is still an index we do
// not run. Computing DEX volume first-party means walking every ledger in the
// window (~21,000 a day), which is a server-side job against the evidence
// database, not something a browser scan can do. That is the Neon track. This
// layer removes the silent-breakage failure mode and moves the source from a
// dollar aggregator to a ledger-derived one; it does not claim to be
// first-party evidence, and `source` on every result says which it is.
//
// Read-only. No signing, no submission, no wallet material.
(function () {
  'use strict';

  // Public, CORS-open (Access-Control-Allow-Origin: *), so the browser reaches
  // it directly and api/proxy.js — the security-sensitive allowlist — is not
  // touched by this change.
  var XRPLMETA_URL =
    'https://s1.xrplmeta.org/tokens?sort_by=volume_24h&limit=200';

  // Below this share of its own trailing daily average, a 24h aggregate is
  // treated as a broken feed rather than a quiet day. The observed break was
  // ~0.04% of trailing; a genuinely quiet day is not 20x below a week's mean.
  var PLAUSIBLE_MIN_RATIO = 0.20;

  // Two sources disagreeing by more than this are not measuring the same
  // thing. The observed break was ~3700x.
  var DISAGREE_MAX_RATIO = 5;

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  // ── Ledger-derived sum ────────────────────────────────────────────────────
  // Pure: takes the parsed token list, returns XRP volume. Per-token volume is
  // denominated in XRP, so token<->XRP trades count once. Token<->token trades
  // appear under both sides; that is stated rather than silently corrected,
  // because correcting it would require pair-level data this endpoint does not
  // give and guessing a discount would be inventing a number.
  function sumLedgerVolume(tokens) {
    var list = Array.isArray(tokens) ? tokens : [];
    var xrp = 0, counted = 0, top = [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i] || {};
      var m = t.metrics || {};
      var v = num(m.volume_24h);
      if (!(v > 0)) continue;
      xrp += v;
      counted++;
      if (top.length < 5) {
        var meta = (t.meta && t.meta.token) || {};
        top.push({ name: meta.name || String(t.currency || '').slice(0, 12), xrp: v });
      }
    }
    return {
      xrp: xrp,
      tokens_counted: counted,
      tokens_returned: list.length,
      top: top,
      // True when the list was long enough that the untruncated tail cannot
      // matter. Reported, not assumed.
      tail_negligible: list.length >= 100
    };
  }

  // ── Aggregator health ─────────────────────────────────────────────────────
  // Pure: takes the DefiLlama payload and says whether its own numbers support
  // the 24h figure it is offering. Everything needed is in the one response.
  function aggregatorHealth(payload) {
    var p = payload || {};
    var v24 = num(p.total24h);
    var d7 = num(p.total7d), d30 = num(p.total30d);
    var trailing = d7 > 0 ? d7 / 7 : (d30 > 0 ? d30 / 30 : 0);

    // A constituent reporting null while a sibling reports is the adapter
    // breaking, not the market stopping.
    var protos = Array.isArray(p.protocols) ? p.protocols : [];
    var nulls = [], reporting = 0;
    for (var i = 0; i < protos.length; i++) {
      var pr = protos[i] || {};
      if (pr.total24h === null || pr.total24h === undefined) nulls.push(pr.name || pr.module || '?');
      else if (num(pr.total24h) > 0) reporting++;
    }
    var partialAdapters = nulls.length > 0 && reporting > 0;

    var ratio = trailing > 0 ? (v24 / trailing) : null;
    var plausible = true, reason = 'OK';
    if (!(v24 > 0)) { plausible = false; reason = 'NO_VALUE'; }
    else if (partialAdapters) { plausible = false; reason = 'PARTIAL_ADAPTERS'; }
    else if (ratio !== null && ratio < PLAUSIBLE_MIN_RATIO) { plausible = false; reason = 'BELOW_TRAILING_AVERAGE'; }

    return {
      value_usd: v24 > 0 ? v24 : null,
      trailing_daily_usd: trailing > 0 ? trailing : null,
      ratio_to_trailing: ratio,
      silent_adapters: nulls,
      plausible: plausible,
      reason: reason
    };
  }

  // ── The decision ──────────────────────────────────────────────────────────
  // Pure. Ledger-derived wins when present. The aggregator is a cross-check,
  // never a silent fallback for a number it cannot support.
  //
  // `printable:false` is a real outcome and callers must render it as "source
  // unavailable" — not as a zero, and not by dropping the line. A missing line
  // reads as "we did not look"; a zero reads as "the DEX is dead". Both are
  // claims we have not earned.
  function reconcile(input) {
    var inp = input || {};
    var ledger = inp.ledger || null;
    var agg = inp.aggregator || null;
    var price = num(inp.xrpPriceUsd);

    var out = {
      usd: null, xrp: null,
      source: 'none',
      printable: false,
      confidence: 'none',
      reason: 'NO_SOURCE',
      note: '',
      cross_check: null
    };

    var ledgerXrp = ledger && num(ledger.xrp);
    var ledgerUsd = (ledgerXrp > 0 && price > 0) ? ledgerXrp * price : null;

    if (ledgerXrp > 0) {
      out.xrp = ledgerXrp;
      out.usd = ledgerUsd;              // null when no price — see below
      out.source = 'ledger';
      out.reason = ledgerUsd === null ? 'NO_XRP_PRICE' : 'LEDGER_DERIVED';
      // Without a price we still hold a real XRP figure; the dollar figure is
      // the thing we cannot state, so the XRP one stays printable.
      out.printable = true;
      out.confidence = 'measured';

      if (agg && agg.value_usd !== null && ledgerUsd !== null) {
        var hi = Math.max(agg.value_usd, ledgerUsd);
        var lo = Math.min(agg.value_usd, ledgerUsd);
        var disagree = lo > 0 ? (hi / lo) : Infinity;
        out.cross_check = {
          aggregator_usd: agg.value_usd,
          disagreement_ratio: disagree,
          aggregator_plausible: agg.plausible,
          aggregator_reason: agg.reason
        };
        if (!agg.plausible || disagree > DISAGREE_MAX_RATIO) {
          out.note = 'aggregator feed disagrees (' + agg.reason + ')';
        }
      }
      return out;
    }

    // No ledger figure. The aggregator may stand in ONLY if its own numbers
    // support it.
    if (agg && agg.plausible && agg.value_usd !== null) {
      out.usd = agg.value_usd;
      out.source = 'aggregator';
      out.printable = true;
      out.confidence = 'reported';
      out.reason = 'AGGREGATOR_PLAUSIBLE';
      return out;
    }

    out.reason = agg ? agg.reason : 'NO_SOURCE';
    out.note = agg && agg.silent_adapters && agg.silent_adapters.length
      ? 'source silent: ' + agg.silent_adapters.join(', ')
      : 'no trustworthy source this run';
    return out;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  // One place decides the words, so the diagnostics block and any other
  // surface cannot drift into printing different things about one fact.
  function line(decision) {
    var d = decision || {};
    if (!d.printable) {
      return '• Native XRPL DEX (24h): SOURCE UNAVAILABLE' +
             (d.note ? ' (' + d.note + ')' : '');
    }
    var body;
    if (d.usd === null) {
      body = fmtXrp(d.xrp) + ' XRP (no USD price this run)';
    } else {
      body = fmtUsd(d.usd);
      if (d.source === 'ledger') body += ' (' + fmtXrp(d.xrp) + ' XRP, ledger-derived)';
    }
    if (d.note) body += ' — ' + d.note;
    return '• Native XRPL DEX (24h): ' + body;
  }

  function fmtUsd(v) {
    var n = num(v);
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function fmtXrp(v) {
    var n = num(v);
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }

  var API = {
    XRPLMETA_URL: XRPLMETA_URL,
    PLAUSIBLE_MIN_RATIO: PLAUSIBLE_MIN_RATIO,
    DISAGREE_MAX_RATIO: DISAGREE_MAX_RATIO,
    sumLedgerVolume: sumLedgerVolume,
    aggregatorHealth: aggregatorHealth,
    reconcile: reconcile,
    line: line,
    _fmtUsd: fmtUsd,
    _fmtXrp: fmtXrp
  };

  if (typeof window !== 'undefined') window.SW_DEX_VOLUME = API;
  // Exported so the decision logic is testable in Node with no browser and no
  // network — the same discipline as src/db. A rule that can only be exercised
  // by running the whole app is a rule nobody checks.
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();

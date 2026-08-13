/* ── EXCHANGE PRESSURE & LEAD-LAG ────────────────────────────────────────────
   The app has always reported WHAT moved. It has never asked whether the moving
   predicts the price — which is the whole question behind "who is manipulating
   money and why."

   The evidence for that question was already on disk. saveBlackboxSnapshot()
   has been writing, on every scan since the store was introduced:

       { date, xrp_price, xrp_delta_24h_pct,
         wallets: [{ label, address, balance_xrp, delta_xrp }],   // all of them
         large_transfers: [...], offers: [...] }

   Thirty of those are retained. That is thirty days of every watched wallet's
   balance change joined to that day's price — and exactly one function read it.
   detectCoordination() walks the same snapshots for pair co-occurrence and
   touches neither snap.xrp_price nor snap.wallets[].delta_xrp. The join was
   sitting there unused.

   What this module does with it:

     · Buckets every wallet delta by category, using the SAME classifier the
       rest of the app uses (KNOWN[addr].cat / getWalletGroup) — never a second
       opinion about what a wallet is.
     · Nets the exchange bucket. XRP arriving at an exchange is supply arriving
       where it can be sold; XRP leaving is supply going to custody. That single
       number is the most-cited on-chain signal there is, and both halves of it
       were already being stored.
     · Correlates that flow against price at three lags. The middle one is the
       question; the third is the control that keeps us honest:

           flow[d] vs Δprice[d]     — moving together
           flow[d] vs Δprice[d+1]   — flow LEADS price: someone positioned first
           flow[d] vs Δprice[d-1]   — price leads flow: these wallets are
                                      reacting like everybody else

   The third row is what separates "informed" from "just another holder", and
   leaving it out would make this module a machine for confirming what we hoped.

   No model is involved in any of this, and that is the point rather than a
   limitation. Pearson correlation is arithmetic: it runs in the browser, for
   free, forever, and it can print its own working. For a report that might say
   "this money moved before the price did," being able to show n and r — and to
   say "no relationship" out loud — is the entire value.

   Limits, which the rendered section states every time it runs:
     · n is small. Thirty daily observations is suggestive, never conclusive.
     · Correlation is not causation and this cannot see intent.
     · Balance deltas are NET between scans. A wallet that sends and receives the
       same amount between two scans reads as flat. This measures positioning,
       not activity.
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var MIN_POINTS      = 6;     // below this, refuse to report a correlation at all
  var STRONG_R        = 0.55;  // |r| at or above this is worth a sentence
  var MODERATE_R      = 0.35;  // below this we say "no usable relationship"
  var CATS            = ['exchange', 'whale', 'escrow', 'next_hop_splitter',
                         'discovered_receiver', 'discovered_whale',
                         'discovered_unknown_highval'];

  function _n(x) { x = Number(x); return isFinite(x) ? x : 0; }

  // Category for a stored snapshot row. The snapshot carries the address, so the
  // live watch list is the authority even for a row written weeks ago — a wallet
  // reclassified since then is scored the way we understand it NOW.
  function _catOf(w) {
    try {
      if (w && w.address && typeof KNOWN !== 'undefined' && KNOWN[w.address] && KNOWN[w.address].cat)
        return KNOWN[w.address].cat;
    } catch (_) {}
    try {
      if (typeof getWalletGroup === 'function')
        return getWalletGroup((w && (w.address || w.label)) || '');
    } catch (_) {}
    return 'whale';
  }

  /* ── the series ──────────────────────────────────────────────────────────── */
  // One compact row per snapshot: the price, and the net XRP flow per category.
  function buildFlowSeries(history) {
    var h = Array.isArray(history) ? history
          : (typeof loadBlackboxHistory === 'function' ? loadBlackboxHistory() : []);
    if (!Array.isArray(h)) return [];
    var rows = h.map(function (snap) {
      var flows = {}, inOut = { exchange_in: 0, exchange_out: 0 };
      CATS.forEach(function (c) { flows[c] = 0; });
      (snap.wallets || []).forEach(function (w) {
        var d = _n(w.delta_xrp);
        if (!d) return;
        var c = _catOf(w);
        if (flows[c] === undefined) flows[c] = 0;
        flows[c] += d;
        if (c === 'exchange') { if (d > 0) inOut.exchange_in += d; else inOut.exchange_out += d; }
      });
      return {
        date: (snap.date || String(snap.data_as_of_utc || '')).slice(0, 10),
        price: _n(snap.xrp_price),
        price_delta_24h_pct: _n(snap.xrp_delta_24h_pct),
        flows: flows,
        exchange_in: inOut.exchange_in,
        exchange_out: inOut.exchange_out,
        net_exchange_flow: flows.exchange || 0,
        wallets_seen: (snap.wallets || []).length
      };
    }).filter(function (r) { return r.date && r.price > 0; });
    // Snapshots are appended in scan order, but a restored store can arrive out
    // of order and a lag analysis on shuffled rows is nonsense.
    rows.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    return rows;
  }

  /* ── arithmetic ──────────────────────────────────────────────────────────── */
  function pearson(xs, ys) {
    var n = Math.min(xs.length, ys.length);
    if (n < 3) return null;
    var sx = 0, sy = 0, i;
    for (i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
    var mx = sx / n, my = sy / n, num = 0, dx2 = 0, dy2 = 0;
    for (i = 0; i < n; i++) {
      var a = xs[i] - mx, b = ys[i] - my;
      num += a * b; dx2 += a * a; dy2 += b * b;
    }
    if (dx2 === 0 || dy2 === 0) return null;   // one side never moved
    return { r: num / Math.sqrt(dx2 * dy2), n: n };
  }

  // Day-over-day price change from the series itself. Using the stored
  // xrp_delta_24h_pct instead would mix two different clocks: that field is the
  // market's rolling 24h at scan time, not the change between OUR observations.
  function _priceChanges(series) {
    var out = [];
    for (var i = 1; i < series.length; i++) {
      var prev = series[i - 1].price, cur = series[i].price;
      out.push(prev > 0 ? ((cur - prev) / prev) * 100 : 0);
    }
    return out;   // out[i] is the change from series[i] to series[i+1]
  }

  // Three lags of one flow vector against price.
  //   lag  0 : flow on day d      vs the move INTO day d       (same window)
  //   lag +1 : flow on day d      vs the move into day d+1     (flow leads)
  //   lag -1 : flow on day d      vs the move into day d-1     (price leads)
  function laggedCorrelations(series, pick) {
    var chg = _priceChanges(series);          // length series.length - 1
    var flow = series.map(pick);
    var res = {};
    // same window: flow measured over the step ending at i+1, price change over
    // the same step
    res.same = pearson(flow.slice(1), chg);
    // flow leads: flow at step i, price change over the NEXT step
    res.leads = pearson(flow.slice(1, flow.length - 1), chg.slice(1));
    // price leads: price change over step i, flow measured on the step after
    res.lags  = pearson(flow.slice(2), chg.slice(0, chg.length - 1));
    return res;
  }

  function _strength(r) {
    var a = Math.abs(r);
    return a >= 0.75 ? 'strong' : a >= STRONG_R ? 'clear' : a >= MODERATE_R ? 'weak' : 'none';
  }

  function analyzeFlow(series) {
    series = series || buildFlowSeries();
    var out = {
      points: series.length,
      first: series.length ? series[0].date : null,
      last:  series.length ? series[series.length - 1].date : null,
      usable: series.length >= MIN_POINTS,
      totals: {}, exchange: null, verdict: null, series: series
    };
    if (!series.length) return out;

    CATS.forEach(function (c) {
      out.totals[c] = series.reduce(function (s, r) { return s + _n(r.flows[c]); }, 0);
    });
    out.exchange_in_total  = series.reduce(function (s, r) { return s + r.exchange_in; }, 0);
    out.exchange_out_total = series.reduce(function (s, r) { return s + r.exchange_out; }, 0);

    if (!out.usable) return out;

    out.exchange = laggedCorrelations(series, function (r) { return r.net_exchange_flow; });
    out.whale    = laggedCorrelations(series, function (r) { return _n(r.flows.whale); });

    // Pick the strongest of the three, then decide what it means. A "leads"
    // result only earns the word if it beats the same-window and price-leads
    // readings — otherwise we are reading a coincidence as a discovery.
    var e = out.exchange, best = null;
    ['leads', 'same', 'lags'].forEach(function (k) {
      if (e[k] && (!best || Math.abs(e[k].r) > Math.abs(e[best].r))) best = k;
    });
    if (best && Math.abs(e[best].r) >= MODERATE_R) {
      out.verdict = { which: best, r: e[best].r, n: e[best].n, strength: _strength(e[best].r) };
    } else {
      out.verdict = { which: 'none', r: best ? e[best].r : 0, n: best ? e[best].n : 0, strength: 'none' };
    }
    return out;
  }

  /* ── the section ─────────────────────────────────────────────────────────── */
  function _xrp(v) {
    v = _n(v); var a = Math.abs(v), s = v < 0 ? '−' : '+';
    if (a >= 1e9) return s + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return s + (a / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return s + (a / 1e3).toFixed(1) + 'K';
    return s + Math.round(a);
  }

  function flowAnalysisToText(a) {
    a = a || analyzeFlow();
    var L = [];
    if (!a.points) {
      return ['• No scan history stored yet — this reads the Black Box, which fills one row per scan.'];
    }
    L.push('• Window: ' + a.points + ' scans, ' + a.first + ' → ' + a.last + '.');
    L.push('• Exchange wallets took in ' + _xrp(a.exchange_in_total).replace('+', '') +
           ' XRP and released ' + _xrp(Math.abs(a.exchange_out_total)).replace('+', '') +
           ' XRP over that window — net ' + _xrp(a.totals.exchange) + ' XRP.');
    L.push('  ' + (a.totals.exchange > 0
      ? 'Net inflow. More XRP arrived where it can be sold than left for custody.'
      : a.totals.exchange < 0
        ? 'Net outflow. More XRP left the exchanges than arrived — supply moving into custody.'
        : 'Flat. Inflow and outflow cancelled.'));

    if (!a.usable) {
      L.push('• Not enough history to test whether that flow relates to price. ' +
             'Needs ' + MIN_POINTS + ' scans, has ' + a.points + '. Run the scan daily and this fills in.');
      return L;
    }

    var v = a.verdict, e = a.exchange;
    var pct = function (x) { return (x >= 0 ? '+' : '') + x.toFixed(2); };
    L.push('• Tested against price at three lags (r = correlation, n = observations):');
    if (e.same)  L.push('    same window     r ' + pct(e.same.r)  + '  n ' + e.same.n);
    if (e.leads) L.push('    flow → next day r ' + pct(e.leads.r) + '  n ' + e.leads.n);
    if (e.lags)  L.push('    price → flow    r ' + pct(e.lags.r)  + '  n ' + e.lags.n);

    if (v.which === 'none') {
      L.push('• Read: no usable relationship at this sample size. Exchange flow and price ' +
             'are not moving together in any direction strong enough to report. That is a ' +
             'result, not a failure — it says these wallets are not visibly front-running the tape.');
    } else if (v.which === 'leads') {
      L.push('• Read: exchange flow leads price (' + v.strength + ', r ' + pct(v.r) + ', n ' + v.n + '). ' +
             (v.r > 0
               ? 'Inflow to exchanges tends to be followed by a price rise in this window.'
               : 'Inflow to exchanges tends to be followed by a price fall in this window — ' +
                 'money arriving at the venue before the drop.') +
             ' Positioning ahead of the move is what this looks like. It is not proof of one.');
    } else if (v.which === 'lags') {
      L.push('• Read: price leads flow (' + v.strength + ', r ' + pct(v.r) + ', n ' + v.n + '). ' +
             'These wallets are moving AFTER the price does — reacting, like everybody else. ' +
             'On this window there is no sign of informed positioning.');
    } else {
      L.push('• Read: flow and price move in the same window (' + v.strength + ', r ' + pct(v.r) +
             ', n ' + v.n + '), with no lead either way. Consistent with the flow being part of ' +
             'the move rather than ahead of it.');
    }
    L.push('• n is small and correlation is not causation. Balance deltas are NET between scans, ' +
           'so a wallet that sent and received the same amount reads as flat — this measures ' +
           'positioning, not activity.');
    return L;
  }

  /* ── exports ─────────────────────────────────────────────────────────────── */
  if (typeof window !== 'undefined') {
    window.SW_FLOW_ANALYSIS = {
      VERSION: 'v1',
      MIN_POINTS: MIN_POINTS,
      buildFlowSeries: buildFlowSeries,
      pearson: pearson,
      laggedCorrelations: laggedCorrelations,
      analyzeFlow: analyzeFlow,
      toText: flowAnalysisToText
    };
    // Plain globals too, matching how the rest of the brief modules are reached
    // from the console and the harnesses.
    window.buildFlowSeries    = buildFlowSeries;
    window.analyzeFlow        = analyzeFlow;
    window.flowAnalysisToText = flowAnalysisToText;
  }
})();

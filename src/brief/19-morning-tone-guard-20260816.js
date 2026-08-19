/* Morning Report activity-tone + flow-context guard — 2026-08-16.
   Presentation-only. Does not change scan evidence, risk scoring, wallet logic,
   news collection, escrow classification, XRPL calls, concurrency or lookback. */
(function () {
  'use strict';

  var MID_MIN = 100000;
  var MID_MAX = 1000000;

  function activity(pack) {
    var p = pack || {};
    var transfers = Array.isArray(p.large_transfers)
      ? p.large_transfers.length
      : Number(p.large_transfer_count || p.largeTransferCount || 0);
    var volume = Number(p.shadow_volume_xrp || p.shadowVolumeXrp || 0);
    return {
      transfers: transfers,
      volume: volume,
      elevated: transfers >= 20 || volume >= 100000000
    };
  }

  function fmtXrp(v) {
    var x = Number(v || 0);
    if (x >= 1e9) return (x / 1e9).toFixed(2) + 'B';
    if (x >= 1e6) return (x / 1e6).toFixed(2) + 'M';
    if (x >= 1e3) return (x / 1e3).toFixed(2) + 'K';
    return x.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  // This duplicates only the lightweight presentation calculation so the public
  // Morning Report does not depend on the later debug/timing layer being loaded
  // before report construction. It uses transactions already fetched by the scan.
  function midSize(pack) {
    try {
      if (window.SW_SHADOW_FLOW_TIMING_20260816 &&
          typeof window.SW_SHADOW_FLOW_TIMING_20260816.metrics === 'function') {
        return window.SW_SHADOW_FLOW_TIMING_20260816.metrics();
      }
    } catch (_) {}

    var rows = [];
    try { rows = (typeof state !== 'undefined' && state && Array.isArray(state.txs)) ? state.txs : []; } catch (_) {}
    var seen = new Set();
    var mid = [];
    rows.forEach(function (t, idx) {
      if (!t || t.currency !== 'XRP' || String(t.type || '') !== 'Payment') return;
      var amount = Number(t.amount || 0);
      if (!(amount >= MID_MIN && amount < MID_MAX) || !t.from || !t.to) return;
      var key = String(t.hash || '').trim() || [t.date || '', t.from, t.to, amount, t.destination_tag || '', idx].join('|');
      if (seen.has(key)) return;
      seen.add(key);
      mid.push({ key: key, from: String(t.from), to: String(t.to), amount: amount });
    });

    function bucket(map, key) {
      if (!map.has(key)) map.set(key, { count: 0, total: 0, keys: [], cps: new Set() });
      return map.get(key);
    }
    var routes = new Map(), senders = new Map(), receivers = new Map();
    mid.forEach(function (t) {
      var r = bucket(routes, t.from + '>' + t.to); r.count++; r.total += t.amount; r.keys.push(t.key);
      var so = bucket(senders, t.from); so.count++; so.total += t.amount; so.keys.push(t.key); so.cps.add(t.to);
      var si = bucket(receivers, t.to); si.count++; si.total += t.amount; si.keys.push(t.key); si.cps.add(t.from);
    });

    var clustered = new Set();
    function qualify(v, multi) {
      return v.count >= 3 && v.total >= 1000000 && (!multi || v.cps.size >= 2);
    }
    routes.forEach(function (v) { if (qualify(v, false)) v.keys.forEach(function (k) { clustered.add(k); }); });
    senders.forEach(function (v) { if (qualify(v, true)) v.keys.forEach(function (k) { clustered.add(k); }); });
    receivers.forEach(function (v) { if (qualify(v, true)) v.keys.forEach(function (k) { clustered.add(k); }); });

    return {
      transfer_count: mid.length,
      total_xrp: mid.reduce(function (s, t) { return s + t.amount; }, 0),
      clustered_transfer_count: clustered.size,
      clustered_flow_xrp: mid.reduce(function (s, t) { return s + (clustered.has(t.key) ? t.amount : 0); }, 0)
    };
  }

  function addFlowContext(text, pack) {
    var out = String(text == null ? '' : text);
    out = out.replace(
      /• Shadow volume \(whale moves ≥1M\):/g,
      '• Shadow volume (≥1M XRP move spotlight):'
    );
    if (/• Mid-size flow \(100K–<1M\):/.test(out)) return out;

    var m = midSize(pack);
    if (!m || !m.transfer_count) return out;
    var midLine = '• Mid-size flow (100K–<1M): ' + fmtXrp(m.total_xrp) + ' XRP · ' + m.transfer_count + ' unique transfers';
    var clusterLine = m.clustered_transfer_count
      ? '• Sub-1M clustered flow: ' + fmtXrp(m.clustered_flow_xrp) + ' XRP · ' + m.clustered_transfer_count + ' transfers matched repeat/fan-in/fan-out patterns (signal only)'
      : '• Sub-1M clustered flow: none met the 3+ transfer / ≥1M aggregate pattern rule';

    var shadow = /(• Shadow volume \(≥1M XRP move spotlight\):[^\n]*\n?)/;
    if (shadow.test(out)) return out.replace(shadow, '$1' + midLine + '\n' + clusterLine + '\n');
    var watched = /(• Watched activity \(all sizes\):[^\n]*\n?)/;
    if (watched.test(out)) return out.replace(watched, '$1' + midLine + '\n' + clusterLine + '\n');
    return out;
  }

  function repair(text, pack) {
    var out = String(text == null ? '' : text);
    var a = activity(pack);

    if (a.elevated) {
      // Keep the risk score's own judgement intact. Correct only prose that calls
      // an objectively busy transfer window calm/quiet/steady.
      out = out.replace(
        /Mostly calm, a little chatter\. Nothing I[’']d wake you for\./g,
        'Transfer activity was elevated, even though the overall risk score stayed moderate. Worth watching, not a panic signal.'
      );
      out = out.replace(
        /The read, straight up: a steady night — nothing broke the pattern\./g,
        'The read, straight up: transfer activity was elevated, but the broader pattern did not break.'
      );
      out = out.replace(
        /Bottom line off the Ledger: a steady night — nothing broke the pattern\./g,
        'Bottom line off the Ledger: transfer activity was elevated, but the broader pattern did not break.'
      );
      out = out.replace(
        /Low hum on the board\. I logged it and moved on\./g,
        'Transfer activity was elevated on the board. I logged the movement and kept the broader risk read in context.'
      );
      out = out.replace(
        /Track whether today[’']s quiet is the calm before a repositioning\./g,
        'Track whether today’s elevated transfer activity develops into a clearer repositioning pattern.'
      );
      out = out.replace(
        /Slow night — but slow is when you catch the sloppy ones\./g,
        'Busy transfer window — the risk score stayed moderate, but the Ledger was not quiet.'
      );
      out = out.replace(
        /Today[’']s forensic read: ordinary motion, nothing that raised the hair on my neck\. \((\d+)\/100\)\./g,
        'Today’s forensic read: elevated transfer activity without a broader pattern break. ($1/100).'
      );
    }

    return addFlowContext(out, pack);
  }

  try {
    if (typeof buildMorningStoryText === 'function' && !buildMorningStoryText._sw20260816ToneGuard) {
      var original = buildMorningStoryText;
      var wrapped = function (pack) {
        return repair(original.apply(this, arguments), pack);
      };
      wrapped._sw20260816ToneGuard = true;
      wrapped._sw20260816ToneOriginal = original;
      buildMorningStoryText = wrapped;
      window.buildMorningStoryText = wrapped;
    }
  } catch (_) {}

  window.SW_MORNING_TONE_GUARD_20260816 = {
    version: '2026.08.16.3',
    large_transfer_floor: 20,
    shadow_volume_floor_xrp: 100000000,
    mid_size_min_xrp: MID_MIN,
    mid_size_max_exclusive_xrp: MID_MAX,
    public_flow_context: true,
    presentation_only: true,
    scanner_untouched: true,
    risk_score_untouched: true
  };
})();

// Scan-time visual throttling is isolated in its own reversible layer. It only
// coalesces wallet-table/dashboard redraws and records browser/webview stalls.
(function () {
  try {
    var s = document.createElement('script');
    s.src = '/src/brief/20-ui-responsiveness-20260816.js';
    s.async = false;
    s.setAttribute('data-sw-ui-responsiveness', '2026-08-16.2');
    document.body.appendChild(s);
  } catch (_) {}
})();

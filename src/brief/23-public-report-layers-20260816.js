/* Public Report layered narrative — 2026-08-16.
   Presentation-only. Uses evidence already collected by the Report.
   No XRPL requests, pagination, concurrency, lookback, wallet mutation,
   risk scoring, evidence scoring, signing, submit, or trading changes.

   Reader contract:
   - Story first: what happened and what deserves attention.
   - Learning bridge: explain Shadow / Mid-size / Clustered / Net flow plainly.
   - Expert lane: preserve exact thresholds, counts and forensic diagnostics.
*/
(function () {
  'use strict';

  var VERSION = '2026.08.16.1';
  var MID_MIN = 100000;
  var MID_MAX = 1000000;

  function st() {
    try { return (typeof state !== 'undefined' && state) ? state : null; } catch (_) { return null; }
  }
  function n(v) {
    var x = Number(v);
    return Number.isFinite(x) ? x : 0;
  }
  function fmt(v) {
    var x = n(v);
    if (x >= 1e9) return (x / 1e9).toFixed(2) + 'B';
    if (x >= 1e6) return (x / 1e6).toFixed(2) + 'M';
    if (x >= 1e3) return (x / 1e3).toFixed(2) + 'K';
    return x.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function fallbackFlowMetrics() {
    var s = st();
    var rows = s && Array.isArray(s.txs) ? s.txs : [];
    var seen = new Set();
    var mid = [];

    rows.forEach(function (t, idx) {
      if (!t || t.currency !== 'XRP' || String(t.type || '') !== 'Payment') return;
      var amount = n(t.amount);
      if (!(amount >= MID_MIN && amount < MID_MAX) || !t.from || !t.to) return;
      var key = String(t.hash || '').trim() || [t.date || '', t.from, t.to, amount, t.destination_tag || '', idx].join('|');
      if (seen.has(key)) return;
      seen.add(key);
      mid.push({ key: key, from: String(t.from), to: String(t.to), amount: amount });
    });

    function makeBucket(map, key) {
      if (!map.has(key)) map.set(key, { count: 0, total: 0, keys: [], cps: new Set() });
      return map.get(key);
    }
    var routes = new Map();
    var senders = new Map();
    var receivers = new Map();
    mid.forEach(function (t) {
      var r = makeBucket(routes, t.from + '>' + t.to); r.count++; r.total += t.amount; r.keys.push(t.key);
      var so = makeBucket(senders, t.from); so.count++; so.total += t.amount; so.keys.push(t.key); so.cps.add(t.to);
      var si = makeBucket(receivers, t.to); si.count++; si.total += t.amount; si.keys.push(t.key); si.cps.add(t.from);
    });

    var clustered = new Set();
    var patterns = 0;
    function qualify(v, multi) {
      return v.count >= 3 && v.total >= 1000000 && (!multi || v.cps.size >= 2);
    }
    routes.forEach(function (v) {
      if (!qualify(v, false)) return;
      patterns++;
      v.keys.forEach(function (k) { clustered.add(k); });
    });
    senders.forEach(function (v) {
      if (!qualify(v, true)) return;
      patterns++;
      v.keys.forEach(function (k) { clustered.add(k); });
    });
    receivers.forEach(function (v) {
      if (!qualify(v, true)) return;
      patterns++;
      v.keys.forEach(function (k) { clustered.add(k); });
    });

    return {
      transfer_count: mid.length,
      total_xrp: mid.reduce(function (sum, t) { return sum + t.amount; }, 0),
      clustered_transfer_count: clustered.size,
      clustered_flow_xrp: mid.reduce(function (sum, t) { return sum + (clustered.has(t.key) ? t.amount : 0); }, 0),
      cluster_pattern_count: patterns
    };
  }

  function flowMetrics() {
    try {
      var api = window.SW_SHADOW_FLOW_TIMING_20260816;
      if (api && typeof api.metrics === 'function') {
        var m = api.metrics();
        if (m && typeof m === 'object') return m;
      }
    } catch (_) {}
    return fallbackFlowMetrics();
  }

  function largeCount(pack) {
    var p = pack || {};
    if (Array.isArray(p.large_transfers)) return p.large_transfers.length;
    if (Array.isArray(p.large)) return p.large.length;
    try {
      var s = st();
      if (s && Array.isArray(s.large)) return s.large.length;
    } catch (_) {}
    return n(p.large_transfer_count || p.largeTransferCount);
  }

  function shadowVolume(pack) {
    var p = pack || {};
    var v = n(p.shadow_volume_xrp || p.shadowVolumeXrp);
    if (v) return v;
    try {
      var s = st();
      var rows = s && Array.isArray(s.large) ? s.large : [];
      return rows.reduce(function (sum, t) { return sum + (n(t && t.amount) >= 1000000 ? n(t.amount) : 0); }, 0);
    } catch (_) { return 0; }
  }

  function isElevated(pack) {
    return largeCount(pack) >= 20 || shadowVolume(pack) >= 100000000;
  }

  function storyFlowSection(pack) {
    var m = flowMetrics();
    if (!m || !m.transfer_count) return '';
    var shadow = shadowVolume(pack);
    var large = largeCount(pack);
    var patterns = n(m.cluster_pattern_count);

    var lines = [];
    lines.push('Under the Surface');
    lines.push('─────────────────');
    lines.push(
      'Here’s the part the ≥1M whale counter can miss. Shadow Volume is the big-move spotlight: ' +
      fmt(shadow) + ' XRP in ' + large + ' individual moves of at least 1M. Another ' +
      fmt(m.total_xrp) + ' XRP moved in ' + m.transfer_count + ' payments from 100K to under 1M. ' +
      (m.clustered_transfer_count
        ? fmt(m.clustered_flow_xrp) + ' XRP across ' + m.clustered_transfer_count + ' of those payments matched ' +
          (patterns ? patterns + ' ' : '') + 'repeat-route, fan-in, or fan-out patterns. '
        : 'None of those mid-size payments met the repeated-routing cluster rule. ') +
      'That is a signal to trace, not proof somebody was hiding funds.'
    );
    lines.push('');
    lines.push('How to Read It');
    lines.push('──────────────');
    lines.push(
      'New here? Shadow Volume shows the obvious ≥1M moves. Mid-size Flow catches 100K–<1M moves. ' +
      'Clustered Flow asks whether those smaller high-value payments keep using common routes. ' +
      'Net watched flow tells whether the tracked wallet board gained or lost XRP versus its prior snapshot.'
    );
    return lines.join('\n');
  }

  function enrichStory(text, pack) {
    var out = String(text == null ? '' : text);
    var m = flowMetrics();

    // Always make the public definition explicit.
    out = out.replace(/• Shadow volume \(whale moves ≥1M\):/g,
      '• Shadow volume (≥1M XRP move spotlight):');

    // The prior guard was exact-phrase based. Cover the current moderate-risk
    // vocabulary too, without changing the 43/100-type score itself.
    if (isElevated(pack)) {
      out = out.replace(
        /The read, straight up: a middling night — logged and watched\./g,
        'The read, straight up: a busy transfer window under a moderate overall risk score — logged and watched.'
      );
      out = out.replace(
        /Bottom line off the Ledger: a middling night — logged and watched\./g,
        'Bottom line off the Ledger: a busy transfer window under a moderate overall risk score — logged and watched.'
      );
      out = out.replace(
        /wallet board was relatively quiet/gi,
        'wallet board carried elevated transfer activity'
      );
    }

    // Add the learning/story bridge before the action list. This keeps the front
    // half conversational while the exact diagnostic lines remain available below.
    if (out.indexOf('Under the Surface\n') < 0) {
      var section = storyFlowSection(pack);
      if (section) {
        var anchor = '\nWhat To Watch Next\n';
        if (out.indexOf(anchor) >= 0) out = out.replace(anchor, '\n' + section + '\n\nWhat To Watch Next\n');
        else {
          var diagAnchor = '\nLEDGER DIAGNOSTICS\n';
          if (out.indexOf(diagAnchor) >= 0) out = out.replace(diagAnchor, '\n' + section + '\n\nLEDGER DIAGNOSTICS\n');
        }
      }
    }

    // Exact expert lane: keep the original Shadow number and append non-overlapping
    // mid-size diagnostics. Do not pretend this is proof of intent or total market flow.
    if (m && m.transfer_count && out.indexOf('• Mid-size flow (100K–<1M):') < 0) {
      var midLine = '• Mid-size flow (100K–<1M): ' + fmt(m.total_xrp) + ' XRP · ' + m.transfer_count + ' unique transfers';
      var clusterLine = '• Sub-1M clustered flow: ' + fmt(m.clustered_flow_xrp) + ' XRP · ' +
        m.clustered_transfer_count + ' unique transfers' +
        (n(m.cluster_pattern_count) ? ' · ' + n(m.cluster_pattern_count) + ' routing patterns' : '') +
        ' (signal only)';
      var shadowLine = /(• Shadow volume \(≥1M XRP move spotlight\):[^\n]*\n?)/;
      if (shadowLine.test(out)) out = out.replace(shadowLine, '$1' + midLine + '\n' + clusterLine + '\n');
    }

    return out;
  }

  function enrichStructured(text, pack) {
    var out = String(text == null ? '' : text);
    var m = flowMetrics();
    if (!m || !m.transfer_count) return out;

    out = out.replace(
      /• Shadow Volume:\s*([^\n]+)/g,
      '• Shadow Volume (≥1M XRP move spotlight): $1'
    );

    if (out.indexOf('• Mid-size Flow (100K–<1M):') < 0) {
      var insert = '• Mid-size Flow (100K–<1M): ' + fmt(m.total_xrp) + ' XRP across ' + m.transfer_count + ' unique transfers\n' +
        '• Sub-1M Clustered Flow: ' + fmt(m.clustered_flow_xrp) + ' XRP across ' + m.clustered_transfer_count + ' unique transfers' +
        (n(m.cluster_pattern_count) ? ' · ' + n(m.cluster_pattern_count) + ' routing patterns' : '') + ' (signal only)\n' +
        '• Reader note: Shadow Volume is the ≥1M spotlight; Mid-size and Clustered Flow expose smaller high-value routing without claiming intent.';
      var re = /(• Shadow Volume \(≥1M XRP move spotlight\):[^\n]*\n?)/;
      if (re.test(out)) out = out.replace(re, '$1' + insert + '\n');
    }

    if (isElevated(pack)) {
      out = out.replace(/the wallet board was relatively quiet/gi, 'the wallet board carried elevated transfer activity');
    }
    return out;
  }

  function installStoryWrapper() {
    try {
      if (typeof buildMorningStoryText !== 'function') return false;
      if (buildMorningStoryText._swPublicLayers20260816) return true;
      var original = buildMorningStoryText;
      var wrapped = function (pack) {
        return enrichStory(original.apply(this, arguments), pack);
      };
      wrapped._swPublicLayers20260816 = true;
      wrapped._swPublicLayersOriginal = original;
      wrapped._original = original._original || original;
      buildMorningStoryText = wrapped;
      window.buildMorningStoryText = wrapped;
      return true;
    } catch (_) { return false; }
  }

  function installStructuredWrapper() {
    try {
      if (typeof buildXRPMainReport !== 'function') return false;
      if (buildXRPMainReport._swPublicLayers20260816) return true;
      var original = buildXRPMainReport;
      var wrapped = function (pack) {
        return enrichStructured(original.apply(this, arguments), pack);
      };
      wrapped._swPublicLayers20260816 = true;
      wrapped._swPublicLayersOriginal = original;
      wrapped._original = original._original || original;
      buildXRPMainReport = wrapped;
      window.buildXRPMainReport = wrapped;
      return true;
    } catch (_) { return false; }
  }

  function install() {
    return { story: installStoryWrapper(), structured: installStructuredWrapper() };
  }

  var installed = install();
  try {
    var bus = window.SHADOW_EVENT_BUS;
    if (bus && typeof bus.on === 'function') {
      // Re-check at the last safe pre-build lifecycle point in case another late
      // presentation layer replaced a function after this file loaded.
      bus.on('shadow.report.building', function () { installed = install(); });
    }
  } catch (_) {}

  window.SW_PUBLIC_REPORT_LAYERS_20260816 = {
    version: VERSION,
    installed: installed,
    public_story_layered: true,
    reader_levels: ['NEW', 'LEARNING', 'EXPERT'],
    scanner_untouched: true,
    xrpl_calls_untouched: true,
    risk_score_untouched: true,
    evidence_untouched: true,
    enrichStory: enrichStory,
    enrichStructured: enrichStructured
  };
})();

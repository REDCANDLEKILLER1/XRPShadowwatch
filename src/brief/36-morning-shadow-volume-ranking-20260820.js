/* ═══════════════════════════════════════════════════════════════════════════
   MORNING STORY SHADOW-VOLUME RANKING — 2026-08-20

   Presentation-only wrapper for the existing Morning Story builder.
   Re-ranks the Executive Summary from existing runtime evidence:
     1) aggregate Shadow Volume scale,
     2) material absorber concentration,
     3) largest individual anomaly,
     4) that anomaly recipient's next-hop behavior.

   Scanner math, account_tx, thresholds, evidence/discovery scoring, news,
   escrow logic, exports and XRPL read-only behavior are untouched.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = '2026.08.20.1';

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function arr(v) { return Array.isArray(v) ? v : []; }

  function xrpFmt(v) {
    v = num(v);
    var a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2).replace(/\.00$/, '') + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2).replace(/\.00$/, '') + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(Math.round(v));
  }

  function pipelineHelpers() {
    try {
      var p = window.PUBLIC_REPORT_PIPELINE_V1;
      return p && p.helpers ? p.helpers : null;
    } catch (_) { return null; }
  }

  function largestTransfer(pack) {
    var txs = arr(pack && pack.large_transfers).slice();
    txs.sort(function (a, b) { return num(b && b.amount) - num(a && a.amount); });
    return txs[0] || null;
  }

  function largestMoveSentence(pack) {
    try {
      var h = pipelineHelpers();
      if (h && typeof h.summarizeLargeMoves === 'function') {
        var m = h.summarizeLargeMoves(pack);
        if (m && m.has_signal && (m.headline || m.summary)) {
          return String(m.headline || m.summary).replace(/\s+overnight(?=[.!?]?$)/i, '');
        }
      }
    } catch (_) {}

    var top = largestTransfer(pack);
    if (!top || !num(top.amount)) return '';
    return xrpFmt(top.amount) + ' XRP moved in the largest individual flagged transfer.';
  }

  function absorberSentence(pack) {
    try {
      var h = pipelineHelpers();
      if (h && typeof h.summarizeAbsorberActivity === 'function') {
        var a = h.summarizeAbsorberActivity(pack);
        if (a && a.has_signal && a.summary) return String(a.summary).trim();
      }
    } catch (_) {}
    return '';
  }

  function followthroughSentence(pack, top) {
    if (!top) return '';
    var to = top.to || top.receiver;
    if (!to) return '';
    var rows = arr(pack && pack.receiver_followthrough);
    var row = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].address === to) { row = rows[i]; break; }
    }
    if (!row) return '';

    var fwdCt = num(row.forwarded_large_count);
    var fwdAmt = num(row.forwarded_large_total_xrp);
    if (fwdCt > 0 && fwdAmt > 0) {
      return 'That recipient subsequently forwarded ' + xrpFmt(fwdAmt) +
        ' XRP onward in ' + fwdCt + ' large transaction' + (fwdCt === 1 ? '' : 's') +
        ' — routing behavior, not ownership or intent proof.';
    }

    if (String(row.classification || '') === 'RECEIVER_STILL_HOLDING_SIZE') {
      var bal = num(row.balance_xrp);
      return 'That recipient was still holding' + (bal > 0 ? ' about ' + xrpFmt(bal) + ' XRP' : ' size') +
        ' at the follow-through check — observable behavior, not proof of intent.';
    }
    return '';
  }

  function txCoverageSentence(pack) {
    var c = pack && pack.tx_scan_coverage;
    if (!c || c.full_window_complete !== false) return '';
    return '⚠️ TX WINDOW: INCOMPLETE — ' + num(c.complete_wallets) + '/' + num(c.target_wallets) +
      ' complete; ' + num(c.failed_wallets) + ' failed; ' + num(c.truncated_wallets) +
      ' truncated. Zero-result claims are not definitive.';
  }

  function buildRankedExecutive(pack) {
    var shadow = num(pack && pack.shadow_volume_xrp);
    var count = arr(pack && pack.large_transfers).length || num(pack && pack.large_transfers_count);

    if (shadow < 2000000 || count < 2) return '';

    var parts = [];
    parts.push(xrpFmt(shadow) + ' XRP moved across ' + count +
      ' large transfer' + (count === 1 ? '' : 's') + ' in the window.');

    var absorption = absorberSentence(pack);
    if (absorption) parts.push(absorption);

    var anomaly = largestMoveSentence(pack);
    if (anomaly) {
      parts.push('The standout individual anomaly was ' + anomaly.charAt(0).toLowerCase() + anomaly.slice(1));
      parts.push('Transfer classification is heuristic; movement does not prove intent.');
    }

    var follow = followthroughSentence(pack, largestTransfer(pack));
    if (follow) parts.push(follow);

    var coverage = txCoverageSentence(pack);
    if (coverage) parts.push(coverage);

    return parts.join(' ');
  }

  function replaceExecutive(text, replacement) {
    if (!replacement) return text;
    var rx = /(Executive Summary|EXECUTIVE SUMMARY)\s*\n[─-]+\s*\n[\s\S]*?(?=\n\s*(?:What Mattered Most|WHAT MATTERED MOST)\s*\n)/;
    if (!rx.test(text)) return text;
    return text.replace(rx, function (whole, header) {
      return header + '\n' + '─────────────────' + '\n' + replacement + '\n';
    });
  }

  function install() {
    var original = null;
    try { original = window.buildMorningStoryText; } catch (_) {}
    if (typeof original !== 'function') return false;
    if (original._swShadowVolumeRanking20260820) return true;

    var wrapped = function (pack) {
      var out = original.apply(this, arguments);
      try {
        var ranked = buildRankedExecutive(pack || (typeof state !== 'undefined' && state && state.pack) || {});
        if (ranked && typeof out === 'string') out = replaceExecutive(out, ranked);
      } catch (_) {}
      return out;
    };

    wrapped._swShadowVolumeRanking20260820 = true;
    wrapped._swOriginal = original;
    window.buildMorningStoryText = wrapped;
    try { buildMorningStoryText = wrapped; } catch (_) {}

    window.SW_MORNING_SHADOW_VOLUME_RANKING_20260820 = {
      version: VERSION,
      presentation_only: true,
      scanner_changed: false,
      evidence_changed: false,
      discovery_changed: false,
      escrow_changed: false,
      news_changed: false,
      read_only: true,
      buildRankedExecutive: buildRankedExecutive,
      install: install
    };
    return true;
  }

  if (!install()) {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (install() || tries >= 40) clearInterval(timer);
    }, 100);
  }
})();

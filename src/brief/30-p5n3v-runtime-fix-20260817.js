/* ═══════════════════════════════════════════════════════════════════════════
   P5N3V RUNTIME FIX — 2026-08-17

   Evidence-backed repairs from SW-20260817-P5N3V / SW-20260817-HVRRV.
   This layer is intentionally small and read-only.

   Fixes:
   1) Discovery totals do not add receiver balance/sample-count as new flow.
   2) GO2 + identity enrichment accept the real nested payload.seal event.
   3) Legacy GO2 callers using decisionTrace.record(type, details) are normalized.
   4) TOTAL DEBUG resolves the upgraded GO2 debug sections instead of GO1 text.

   Preserved:
   - scanner lookback, pagination and concurrency
   - the 2026-08-16 public flow layers (all-size total + >=1M spotlight +
     100K-<1M mid-size + clustered sub-1M context)
   - operator review requirement for watchlist additions
   - no signing, submit, trading, auto-add, or ledger mutation
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = '2026.08.17.2';

  try {
    if (typeof collectDiscoveryCandidates === 'function' &&
        !collectDiscoveryCandidates._swP5N3VAccountingFix) {
      var originalCollect = collectDiscoveryCandidates;
      var wrappedCollect = function (pack) {
        var source = pack || ((typeof state !== 'undefined' && state.pack) ? state.pack : {}) || {};
        var follow = Array.isArray(source.receiver_followthrough) ? source.receiver_followthrough : null;
        if (!follow || !follow.length) return originalCollect(source);
        var clean = Object.assign({}, source, {
          receiver_followthrough: follow.map(function (r) {
            return Object.assign({}, r || {}, { balance_xrp: 0, tx_count: 0 });
          })
        });
        return originalCollect(clean);
      };
      wrappedCollect._swP5N3VAccountingFix = true;
      wrappedCollect._swOriginal = originalCollect;
      collectDiscoveryCandidates = wrappedCollect;
      try { window.collectDiscoveryCandidates = wrappedCollect; } catch (_) {}
    }
  } catch (_) {}

  try {
    var DT = window.SHADOW_DECISION_TRACE;
    if (DT && typeof DT.record === 'function' && !DT.record._swP5N3VCompat) {
      var originalRecord = DT.record.bind(DT);
      var recordCompat = function (entry, details) {
        if (typeof entry === 'string') {
          var d = (details && typeof details === 'object') ? Object.assign({}, details) : {};
          if (!d.type) d.type = entry;
          return originalRecord(d);
        }
        return originalRecord(entry);
      };
      recordCompat._swP5N3VCompat = true;
      recordCompat._swOriginal = originalRecord;
      DT.record = recordCompat;
    }
  } catch (_) {}

  try {
    var bus = window.SHADOW_EVENT_BUS;
    if (bus && typeof bus.on === 'function') {
      var helperSealSeen = null;
      var identitySealSeen = null;

      bus.on('shadow.report.sealed', function (data) {
        try {
          var d = (data && data.payload) ? data.payload : data;
          var seal = d && d.seal ? d.seal : null;
          if (!seal || !(seal.scan_id || seal.report_id || seal.date)) return;
          var sealKey = seal.scan_id || seal.report_id || seal.date;

          if (helperSealSeen !== sealKey) {
            helperSealSeen = sealKey;
            var HP = window.SHADOW_HELPER_POOL;
            var FLAGS = window.SHADOW_SYSTEM_FLAGS;
            if (HP && FLAGS && FLAGS.helperPool && HP.enabled && typeof HP.assignJobs === 'function') {
              var activePack = (typeof state !== 'undefined' && state.pack) ? state.pack : d;
              setTimeout(function () {
                try { HP.assignJobs(activePack); } catch (_) {}
              }, 2000);
            }
          }

          if (identitySealSeen !== sealKey) {
            identitySealSeen = sealKey;
            var IL = window.SW_IDENTITY_LOOKUP;
            if (IL && typeof IL.run === 'function') {
              setTimeout(function () {
                try { IL.run({ limit: 40 }); } catch (_) {}
              }, 4000);
            }
          }
        } catch (_) {}
      });
    }
  } catch (_) {}

  try {
    if (typeof buildShadowWatchDebugFile === 'function' &&
        typeof _TOTAL_DEBUG_SECTIONS !== 'undefined' &&
        !buildShadowWatchDebugFile._swP5N3VDebugFix) {
      var fixedDebugBuilder = function () {
        var sections = _TOTAL_DEBUG_SECTIONS;
        var modeLabel = 'TOTAL DEBUG FILE';
        var divider = '============================================================';
        var reportId = (typeof state !== 'undefined' && state.pack && (state.pack.report_id || state.pack.scan_id)) ||
                       (typeof state !== 'undefined' && state.seal && state.seal.report_id) ||
                       (typeof state !== 'undefined' && state.lastReportId) || 'unknown';
        var generatedAt = new Date().toISOString();
        var lines = [];
        lines.push(divider);
        lines.push('XRPMAN // SHADOW WATCH — ' + modeLabel);
        lines.push('Powered by XMΣMΣ');
        lines.push(divider);
        lines.push('Report ID:    ' + reportId);
        lines.push('Generated:    ' + generatedAt);
        lines.push('App Version:  ' + (typeof APP_VERSION !== 'undefined' ? APP_VERSION : 'unknown'));
        lines.push('');
        lines.push('Shadow Watch needs two export modes: multi-file archive style for local');
        lines.push('records, and one total TXT handoff file for mobile/ChatGPT sharing.');
        lines.push('');
        lines.push('Sections (in order):');
        sections.forEach(function (s) { lines.push('  ' + s.num + ' — ' + s.label); });
        lines.push('');
        lines.push(divider);
        lines.push('');

        sections.forEach(function (s) {
          lines.push(divider);
          lines.push('SECTION ' + s.num + ' — ' + s.label);
          lines.push(divider);
          lines.push('');
          var text = '', ok = false;
          try {
            var resolver = (typeof window.buildDebugSectionContent === 'function')
              ? window.buildDebugSectionContent
              : ((typeof _resolveReportSource === 'function') ? _resolveReportSource : null);
            var src = resolver ? resolver(s.kind, (typeof state !== 'undefined' ? (state.pack || {}) : {})) : null;
            if (src && src.ok && src.text) {
              text = String(src.text).trim();
              ok = text.length > 0;
            }
          } catch (_) {}
          lines.push(ok ? text : '[EMPTY / NOT GENERATED THIS RUN]');
          lines.push('');
          lines.push('');
        });

        lines.push(divider);
        lines.push('END OF ' + modeLabel);
        lines.push('Report ID: ' + reportId);
        lines.push('Generated: ' + generatedAt);
        lines.push(divider);
        return lines.join('\n');
      };
      fixedDebugBuilder._swP5N3VDebugFix = true;
      buildShadowWatchDebugFile = fixedDebugBuilder;
      try { window.buildShadowWatchDebugFile = fixedDebugBuilder; } catch (_) {}
    }
  } catch (_) {}

  window.SW_P5N3V_RUNTIME_FIX_20260817 = {
    version: VERSION,
    read_only: true,
    discovery_accounting_fix: true,
    nested_seal_helper_fix: true,
    nested_seal_identity_fix: true,
    decision_trace_compat_fix: true,
    total_debug_go2_fix: true,
    scanner_untouched: true,
    concurrency_untouched: true,
    lookback_untouched: true,
    no_auto_add: true,
    no_signing: true,
    no_trading: true
  };
})();

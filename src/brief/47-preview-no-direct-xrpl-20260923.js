/* 47-preview-no-direct-xrpl-20260923.js
 * Preview-only fail-closed net for the stored evidence snapshot.
 * Does not edit 02-core.js and never acquires XRPL.
 */
(function shadowPreviewNoDirectXrplFence() {
  'use strict';

  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  if (window.SW_PREVIEW_NO_DIRECT_XRPL_FENCE) return;

  var nativeFetch = window.fetch.bind(window);

  function logFence(message) {
    try {
      if (typeof log === 'function') log(message);
      else if (window.console && console.warn) console.warn(message);
    } catch (_) {}
  }

  function parseRun(input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('/api/delta') < 0) return null;
      var body = init && init.body;
      if (!body && input && typeof input.body === 'string') body = input.body;
      if (!body) return null;
      var parsed = typeof body === 'string' ? JSON.parse(body) : body;
      return parsed && parsed.action === 'run' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function unavailableBody(run) {
    return {
      scan_id: null,
      report_id: run && run.report_id || null,
      target_wallets: 0,
      complete_wallets: 0,
      balance_contradictions: 0,
      balance_contradiction_addresses: [],
      transactions: 0,
      xrpl_requests: 0,
      failures: [],
      wallets: [],
      committed: false,
      reason: 'PREVIEW_READ_ONLY_SNAPSHOT_UNAVAILABLE',
      error: 'PREVIEW READ-ONLY SNAPSHOT UNAVAILABLE',
      preview_read_only: true,
      live_acquisition_disabled: true,
      checkpoint_advanced: false,
      events: [],
      window: { error: 'PREVIEW_READ_ONLY_SNAPSHOT_UNAVAILABLE' }
    };
  }

  window.fetch = async function previewFencedFetch(input, init) {
    var run = parseRun(input, init);
    var response = await nativeFetch(input, init);
    if (!run || response.ok) return response;

    var payload = null;
    try { payload = await response.clone().json(); } catch (_) {}
    var msg = String(payload && payload.error || '');
    if (!/PREVIEW_READ_ONLY_SNAPSHOT_UNAVAILABLE|EVIDENCE_WRITE_REFUSED_NON_PRODUCTION/.test(msg)) {
      return response;
    }

    logFence('Preview read-only snapshot unavailable — direct XRPL fallback remains disabled.');
    var body = unavailableBody(run);
    if (run.stream) {
      return new Response(JSON.stringify({ t: 'done', ...body }) + '\n', {
        status: 200,
        headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' }
      });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  };

  window.SW_PREVIEW_NO_DIRECT_XRPL_FENCE = {
    version: '2026.09.23.2',
    behavior: 'PREVIEW_READ_ONLY_FAIL_CLOSED'
  };
  logFence('[preview-fence] installed');
})();

/* Debug-only XRPSCAN source probe cleanup — 2026-08-16.
   Does not participate in the ledger scan or report evidence pipeline. */
(function () {
  'use strict';

  function one(id) { return document.getElementById(id); }

  async function runProbe() {
    var out = one('swDbgProbeBody');
    var copy = one('swDbgProbeCopy');
    if (copy) copy.disabled = true;
    if (out) out.textContent = 'probing documented XRPSCAN endpoints…';

    var targets = [
      { name: 'aggregate metrics', url: 'https://api.xrpscan.com/api/v1/metrics/metric' },
      { name: 'network server info', url: 'https://api.xrpscan.com/api/v1/network/server_info' }
    ];
    var lines = ['SOURCE PROBE @ ' + new Date().toISOString(), ''];

    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      try {
        var r = await fetch(t.url, { headers: { 'Accept': 'application/json' } });
        var body = await r.text();
        lines.push(t.name.toUpperCase());
        lines.push('GET ' + t.url + '  →  HTTP ' + r.status + '  (direct)');
        lines.push(body.slice(0, 1200));
      } catch (e) {
        lines.push(t.name.toUpperCase());
        lines.push('GET ' + t.url + '  →  direct FAILED (' + (e && e.message || e) + ')');
        try {
          var pu = '/api/proxy?url=' + encodeURIComponent(t.url);
          var pr = await fetch(pu);
          var pb = await pr.text();
          lines.push('   via proxy  →  HTTP ' + pr.status);
          lines.push(pb.slice(0, 1200));
        } catch (e2) {
          lines.push('   via proxy  →  FAILED (' + (e2 && e2.message || e2) + ')');
        }
      }
      lines.push('\n' + '─'.repeat(34) + '\n');
      if (out) out.textContent = lines.join('\n');
    }

    lines.push('PROBE COMPLETE');
    if (out) out.textContent = lines.join('\n');
    if (copy) copy.disabled = false;
  }

  // Capture before the legacy document-level click listener so the obsolete
  // seven-endpoint probe never runs. All other debug controls pass through.
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || t.id !== 'swDbgProbe') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    runProbe();
  }, true);

  window.SW_DEBUG_PROBE_20260816 = {
    version: '2026.08.16.1',
    endpoints: [
      'https://api.xrpscan.com/api/v1/metrics/metric',
      'https://api.xrpscan.com/api/v1/network/server_info'
    ],
    scanner_untouched: true
  };
})();

// Presentation-only guard for the Morning Report. Loaded after the debug probe
// cleanup so it remains the last wrapper around buildMorningStoryText.
(function () {
  try {
    var s = document.createElement('script');
    s.src = '/src/brief/19-morning-tone-guard-20260816.js';
    s.async = false;
    s.setAttribute('data-sw-morning-tone-guard', '2026-08-16.1');
    document.body.appendChild(s);
  } catch (_) {}
})();

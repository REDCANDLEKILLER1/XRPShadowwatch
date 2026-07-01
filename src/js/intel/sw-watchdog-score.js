/* ════════════════════════════════════════════════════════════════════
   SW.watchdog — read-only behavioural scores over a transaction sample.
   Behavioural scores: burst activity, counterparty concentration,
   unique takers, reversal/circular behaviour, token health tier. Pure
   functions; feed only "confidence / evidence / watch level" — never trades.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var SW = (window.SW = window.SW || {});

  // Burst: max share of activity falling in any 1-hour window (0..1).
  function burstScore(datesMs) {
    if (!datesMs || datesMs.length < 4) return 0;
    var HOUR = 3600000, best = 0, n = datesMs.length;
    var sorted = datesMs.slice().sort(function (a, b) { return a - b; });
    var j = 0;
    for (var i = 0; i < n; i++) {
      while (sorted[i] - sorted[j] > HOUR) j++;
      best = Math.max(best, i - j + 1);
    }
    return best / n;
  }

  // Concentration: share of interactions with the single busiest counterparty (0..1).
  function concentrationScore(counterparties) {
    if (!counterparties || !counterparties.length) return 0;
    var m = {}, top = 0;
    for (var i = 0; i < counterparties.length; i++) {
      var c = counterparties[i]; if (!c) continue;
      m[c] = (m[c] || 0) + 1; if (m[c] > top) top = m[c];
    }
    return top / counterparties.length;
  }

  function uniqueTakers(addrs) {
    var s = {}; var n = 0;
    (addrs || []).forEach(function (a) { if (a && !s[a]) { s[a] = 1; n++; } });
    return n;
  }

  // Reversal/circular flag: does A→B also appear as B→A within the sample?
  function reversalFlag(pairs) {
    if (!pairs || !pairs.length) return false;
    var seen = {};
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i]; if (!p || !p[0] || !p[1]) continue;
      if (seen[p[1] + '>' + p[0]]) return true;
      seen[p[0] + '>' + p[1]] = 1;
    }
    return false;
  }

  // Coarse token health tier from optional enrichment (holders/trustlines/liquidity).
  function tokenHealthTier(t) {
    t = t || {};
    var holders = Number(t.holders) || 0, tl = Number(t.trustlines) || 0, liq = Number(t.liquidity) || 0;
    if (holders >= 5000 || liq >= 250000) return 'healthy';
    if (holders >= 500 || tl >= 500 || liq >= 20000) return 'moderate';
    if (holders > 0 || tl > 0) return 'thin';
    return 'unknown';
  }

  SW.watchdog = { burstScore: burstScore, concentrationScore: concentrationScore, uniqueTakers: uniqueTakers, reversalFlag: reversalFlag, tokenHealthTier: tokenHealthTier };
})();

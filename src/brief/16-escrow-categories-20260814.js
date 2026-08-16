/* ═══════════════════════════════════════════════════════════════════════════
   ESCROW CATEGORY REPAIR — 2026-08-14

   Parent category: ESCROWS
     • RIPPLE ESCROW — escrow owned by sourced Ripple / Ripple-escrow accounts
     • OTHER XRPL ESCROWS — every other observed XRPL escrow event

   Classification changes presentation only. No event is discarded and no XRPL
   write/sign/submit path is introduced.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var RIPPLE_ESCROW_ACCOUNTS = {
    'r9NpyVfLfUG8hatuCCHKzosyDtKnBdsEN3': 1,
    'rMhkqz3DeU7GUUJKGZofusbrTwZe6bDyb1': 1,
    'rMQ98K56yXJbDGv49ZSmW51sLn94Xe1mu1': 1,
    'rKveEyR1SrkWbJX214xcfH43ZsoGMb3PEv': 1
  };

  function isRippleOwner(addr) {
    if (!addr) return false;
    if (RIPPLE_ESCROW_ACCOUNTS[addr]) return true;
    try {
      if (typeof KNOWN !== 'undefined' && KNOWN && KNOWN[addr]) {
        var k = KNOWN[addr] || {};
        if (k.cat === 'escrow' || k.type === 'RIPPLE' || /ripple/i.test(String(k.label || k.name || k.handle || ''))) return true;
      }
    } catch (_) {}
    try {
      var reg = window.SW_WALLET_IDENTITIES && window.SW_WALLET_IDENTITIES[addr];
      if (reg && (reg.type === 'RIPPLE' || /ripple/i.test(String(reg.name || reg.label || '')))) return true;
    } catch (_) {}
    return false;
  }

  function category(evt) { return evt && isRippleOwner(evt.owner) ? 'RIPPLE' : 'OTHER_XRPL'; }

  function escrowList() {
    try {
      if (typeof state !== 'undefined' && Array.isArray(state.escrow) && state.escrow.length) return state.escrow.slice();
    } catch (_) {}
    try {
      var byHash = {};
      if (typeof loadEscrowHistory === 'function') {
        loadEscrowHistory().forEach(function (e) { if (e && e.hash) byHash[e.hash] = e; });
      }
      if (typeof escrowFromTxs === 'function') escrowFromTxs(byHash);
      return Object.keys(byHash).map(function (h) { return byHash[h]; });
    } catch (_) { return []; }
  }

  function windowed() {
    var ms = (typeof escrowLookbackMs === 'function') ? escrowLookbackMs() : 36 * 3600000;
    var cut = Date.now() - ms;
    return {
      hrs: Math.round(ms / 3600000),
      rows: escrowList().filter(function (e) { return e && (e.ts || 0) >= cut; })
        .sort(function (a, b) { return (b.xrp || 0) - (a.xrp || 0); })
    };
  }

  function sum(rows) {
    var unlocks = rows.filter(function (e) { return e.type === 'UNLOCK'; });
    var locks = rows.filter(function (e) { return e.type === 'LOCK'; });
    return {
      unlocks: unlocks.length,
      locks: locks.length,
      totalUnlocked: unlocks.reduce(function (a, e) { return a + Number(e.xrp || 0); }, 0),
      totalLocked: locks.reduce(function (a, e) { return a + Number(e.xrp || 0); }, 0),
      largest: rows.length ? rows.slice().sort(function (a, b) { return Number(b.xrp || 0) - Number(a.xrp || 0); })[0] : null
    };
  }

  function f(n) {
    try { if (typeof fmt === 'function') return fmt(Number(n || 0), 0); } catch (_) {}
    return Math.floor(Number(n || 0)).toLocaleString();
  }

  function lane(lines, title, rows, hrs) {
    var s = sum(rows);
    lines.push('');
    lines.push(title);
    if (!rows.length) {
      lines.push('- No events detected in this scan window (' + hrs + 'h).');
      return;
    }
    lines.push('- Unlocks detected: ' + s.unlocks);
    lines.push('- Total unlocked: ' + f(s.totalUnlocked) + ' XRP');
    lines.push('- Locks detected: ' + s.locks);
    lines.push('- Total locked: ' + f(s.totalLocked) + ' XRP');
    if (s.largest) {
      lines.push('- Largest event: ' + f(s.largest.xrp) + ' XRP (' + s.largest.type + ')');
      lines.push('- Owner: ' + (s.largest.owner || '?'));
      if (s.largest.dest) lines.push('- Destination: ' + s.largest.dest);
      if (s.largest.hash) lines.push('- XRPSCAN: https://xrpscan.com/tx/' + s.largest.hash);
      try { if (typeof escrowFollowOn === 'function') lines.push('- Follow-on movement: ' + escrowFollowOn(s.largest.dest)); } catch (_) {}
    }
    lines.push('  Top events:');
    rows.slice(0, 5).forEach(function (e) {
      lines.push('   • ' + title + ' · ' + e.type + ' ' + f(e.xrp) + ' XRP → ' + String(e.dest || e.owner || '?').slice(0, 12) +
        (e.hash ? ' | https://xrpscan.com/tx/' + e.hash : ''));
    });
  }

  function buildSection() {
    var w = windowed();
    var ripple = w.rows.filter(function (e) { return category(e) === 'RIPPLE'; });
    var other = w.rows.filter(function (e) { return category(e) === 'OTHER_XRPL'; });
    var all = sum(w.rows);
    var L = ['ESCROWS — COFFEE & CRYPTO'];
    L.push('- Total escrow events: ' + w.rows.length + ' (' + w.hrs + 'h window)');
    L.push('- Total unlocked across all escrows: ' + f(all.totalUnlocked) + ' XRP');
    L.push('- Total locked across all escrows: ' + f(all.totalLocked) + ' XRP');
    lane(L, 'RIPPLE ESCROW', ripple, w.hrs);
    lane(L, 'OTHER XRPL ESCROWS', other, w.hrs);
    L.push('');
    L.push('Talking point:');
    L.push('Escrow activity is grouped by owner: Ripple treasury escrows are shown separately from other XRPL escrows. Escrow creation or release is on-ledger movement, not by itself a buy, sell, or trade signal. Watch destinations for follow-on routing, relocks, or large downstream transfers.');
    return L.join('\n');
  }

  function buildNarrative() {
    var w = windowed();
    var ripple = w.rows.filter(function (e) { return category(e) === 'RIPPLE'; });
    var other = w.rows.filter(function (e) { return category(e) === 'OTHER_XRPL'; });
    var rs = sum(ripple), os = sum(other);
    var parts = [];
    if (ripple.length) {
      parts.push('Ripple escrow was active in the last ' + w.hrs + 'h: ' + rs.unlocks + ' unlock' + (rs.unlocks === 1 ? '' : 's') +
        ' totaling ' + f(rs.totalUnlocked) + ' XRP and ' + rs.locks + ' lock' + (rs.locks === 1 ? '' : 's') + ' totaling ' + f(rs.totalLocked) + ' XRP.');
    } else {
      parts.push('No Ripple escrow events were detected in the last ' + w.hrs + 'h.');
    }
    if (other.length) {
      parts.push('Other XRPL escrows were also active: ' + os.unlocks + ' unlock' + (os.unlocks === 1 ? '' : 's') + ' totaling ' + f(os.totalUnlocked) +
        ' XRP and ' + os.locks + ' lock' + (os.locks === 1 ? '' : 's') + ' totaling ' + f(os.totalLocked) + ' XRP.');
      if (os.largest && os.largest.hash) {
        parts.push('The largest non-Ripple escrow event was ' + f(os.largest.xrp) + ' XRP (' + os.largest.type + ') — XRPSCAN: https://xrpscan.com/tx/' + os.largest.hash + '.');
      }
    } else {
      parts.push('No other XRPL escrow events were detected in that window.');
    }
    parts.push('Escrow movement is context, not proof of a buy, sell, or trade.');
    return parts.join(' ');
  }

  try {
    buildEscrowWatchSection = function () { return buildSection(); };
    buildEscrowNarrative = function () { return buildNarrative(); };
  } catch (_) {}

  window.SW_ESCROW_CATEGORIES_20260814 = {
    version: '2026.08.14.1',
    parent: 'ESCROWS',
    lanes: ['RIPPLE ESCROW', 'OTHER XRPL ESCROWS'],
    classify: category,
    read_only: true
  };
})();

// Load the small 2026-08-16 report-only promotion/performance layer after the
// escrow category repair. Kept separate so the scanner tuning is one-file
// reversible if field testing shows no benefit.
(function () {
  try {
    var s = document.createElement('script');
    s.src = '/src/brief/17-report-scan-tuning-20260816.js';
    s.async = false;
    s.setAttribute('data-sw-report-scan-tuning', '2026-08-16.2');
    document.body.appendChild(s);
  } catch (_) {}
})();

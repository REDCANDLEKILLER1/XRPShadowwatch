// ── SHARED HVT BALANCE HISTORY ───────────────────────────────────────────────
// One balance record per high-value target, written by BOTH apps and read by
// both. index.html (the live wall) and brief-console.html (the report engine)
// are separate documents with separate engines, but they are served from the
// SAME ORIGIN — which means they already share a localStorage. That shared key
// is the live datastore: whichever app reads a balance first, the other one
// benefits, and neither has to wait for the other to run.
//
// The committed file src/shared/hvt-balance-seed.js is the cold half of the
// same store: it survives a cleared cache, a new phone, a fresh browser, and it
// gives a freshly-installed app a peak to measure today's balance against
// instead of starting blind. exportSeed() emits the next version of that file.
//
// What the record is FOR: a wallet on this list is here because it held a lot of
// XRP. If it now holds almost none, that is the single most interesting thing
// the board can tell you, and it is invisible if you only ever look at today's
// number. peak is therefore never lowered — it is the high-water mark the drain
// is measured against.
(function () {
  'use strict';

  var KEY = 'SW_SHARED_HVT_HISTORY_V1';
  var FLOOR_XRP = 1e6;          // below this a "high value target" is not high value
  var DRAINED_RATIO  = 0.05;    // ≤5% of what it used to hold
  var BLEEDING_RATIO = 0.60;    // ≥40% of it gone

  var _mem = null;

  function _now() { return new Date().toISOString(); }

  function _seed() {
    try { return (typeof window !== 'undefined' && window.SW_HVT_BALANCE_SEED) || null; }
    catch (_) { return null; }
  }
  function _roster() {
    try { return (typeof window !== 'undefined' && window.SW_HVT_ROSTER) || null; }
    catch (_) { return null; }
  }

  // The roster's expected_xrp is a claim the LABEL makes ("20M Split 1"). It is a
  // starting point only — an observed peak always outranks it, because that is
  // something we actually saw on the ledger.
  function expectedFor(addr, rec) {
    var exp = 0;
    var r = _roster();
    if (r && r.targets) {
      for (var i = 0; i < r.targets.length; i++) {
        if (r.targets[i].address === addr) { exp = r.targets[i].expected_xrp || 0; break; }
      }
    }
    if (rec && rec.peak > exp) exp = rec.peak;
    return exp;
  }

  function load() {
    if (_mem) return _mem;
    var store = {};
    // cold seed first, live store on top — the live store is always fresher
    var seed = _seed();
    if (seed && seed.balances) {
      Object.keys(seed.balances).forEach(function (a) {
        var b = seed.balances[a];
        store[a] = { peak: +b.peak || 0, peakAt: b.peakAt || null,
                     last: +b.last || 0, lastAt: b.lastAt || null,
                     prev: null, prevAt: null, n: +b.n || 0, from: 'seed' };
      });
    }
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var live = JSON.parse(raw) || {};
        Object.keys(live).forEach(function (a) {
          var l = live[a], c = store[a];
          if (!c) { store[a] = l; return; }
          // merge: keep the higher peak and the newer observation
          store[a] = {
            peak:   Math.max(+c.peak || 0, +l.peak || 0),
            peakAt: ((+l.peak || 0) >= (+c.peak || 0)) ? (l.peakAt || c.peakAt) : c.peakAt,
            last:   (l.lastAt && (!c.lastAt || l.lastAt > c.lastAt)) ? l.last : c.last,
            lastAt: (l.lastAt && (!c.lastAt || l.lastAt > c.lastAt)) ? l.lastAt : c.lastAt,
            prev: l.prev != null ? l.prev : c.prev,
            prevAt: l.prevAt || c.prevAt,
            n: Math.max(+c.n || 0, +l.n || 0),
            from: 'merged'
          };
        });
      }
    } catch (_) {}
    _mem = store;
    return _mem;
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(_mem || {})); } catch (_) {}
  }

  // Record a balance reading. Called by the wall's HVT scanner and by the report
  // console's wallet pass — whichever runs, both apps see the result.
  // Returns the status of the wallet AFTER the reading.
  function record(addr, xrp, source) {
    if (!addr || typeof xrp !== 'number' || !isFinite(xrp) || xrp < 0) return null;
    var s = load();
    var r = s[addr];
    var t = _now();
    if (!r) {
      r = s[addr] = { peak: xrp, peakAt: t, last: xrp, lastAt: t, prev: null, prevAt: null, n: 0, from: source || 'live' };
    } else {
      // Only shift prev when this is a genuinely new reading, so a re-render
      // doesn't erase the previous value by copying today's over itself.
      if (r.lastAt !== t && r.last !== xrp) { r.prev = r.last; r.prevAt = r.lastAt; }
      r.last = xrp; r.lastAt = t;
      if (xrp > r.peak) { r.peak = xrp; r.peakAt = t; }
      r.from = source || r.from;
    }
    r.n = (+r.n || 0) + 1;
    save();
    return status(addr, xrp);
  }

  function get(addr) { return load()[addr] || null; }
  function all() { return load(); }

  // The judgement. Only ever fires when we know what the wallet USED to be worth
  // — with no peak and no size claim in the label there is nothing to drain from,
  // and calling that "drained" would be a guess.
  //   DRAINED  — ≤5% of its high-water mark left. Something happened here.
  //   BLEEDING — ≥40% gone. Worth opening.
  //   LIGHT    — under the 1M floor, but never seen holding more. Not high value.
  //   OK       — holding what a target this size should hold.
  function status(addr, xrpNow) {
    var rec = get(addr);
    if (xrpNow == null) xrpNow = rec ? rec.last : null;
    if (xrpNow == null) return { state: 'UNKNOWN', expected: 0, ratio: null, peak: rec ? rec.peak : 0, delta: null };

    var expected = expectedFor(addr, rec);
    var delta = (rec && rec.prev != null) ? (xrpNow - rec.prev) : null;

    if (expected < FLOOR_XRP) {
      return { state: xrpNow < FLOOR_XRP ? 'LIGHT' : 'OK',
               expected: expected, ratio: null, peak: rec ? rec.peak : 0, delta: delta, gone: 0 };
    }
    var ratio = expected > 0 ? (xrpNow / expected) : null;
    var state = ratio <= DRAINED_RATIO ? 'DRAINED'
              : ratio <= BLEEDING_RATIO ? 'BLEEDING'
              : 'OK';
    return { state: state, expected: expected, ratio: ratio,
             peak: rec ? rec.peak : 0, delta: delta, gone: expected - xrpNow };
  }

  // Everything currently worth investigating, worst first.
  function alerts() {
    var s = load(), out = [];
    Object.keys(s).forEach(function (a) {
      var st = status(a, s[a].last);
      if (st.state === 'DRAINED' || st.state === 'BLEEDING') {
        out.push({ address: a, balance: s[a].last, seenAt: s[a].lastAt,
                   state: st.state, expected: st.expected, ratio: st.ratio, gone: st.gone });
      }
    });
    out.sort(function (x, y) { return (x.ratio || 0) - (y.ratio || 0); });
    return out;
  }

  function stats() {
    var s = load(), n = 0, drained = 0, bleeding = 0;
    Object.keys(s).forEach(function (a) {
      n++;
      var st = status(a, s[a].last);
      if (st.state === 'DRAINED') drained++;
      else if (st.state === 'BLEEDING') bleeding++;
    });
    return { tracked: n, drained: drained, bleeding: bleeding };
  }

  // Emit the next version of src/shared/hvt-balance-seed.js. The browser has no
  // write access to the repo, so the loop closes through the operator: export,
  // commit, and every device starts from that baseline instead of blind.
  function exportSeed() {
    var s = load(), balances = {};
    Object.keys(s).sort().forEach(function (a) {
      var r = s[a];
      if (!r || !r.peak) return;
      balances[a] = { peak: Math.round(r.peak), peakAt: r.peakAt,
                      last: Math.round(r.last), lastAt: r.lastAt, n: r.n };
    });
    var st = stats();
    return '// ── HVT BALANCE SEED (generated — see src/shared/hvt-history.js) ────────────\n' +
      '// Cold baseline for the shared balance history: the high-water mark and last\n' +
      '// reading for every tracked target, so a fresh install can tell a drained\n' +
      '// wallet from a small one on its very first scan. Exported from the app, not\n' +
      '// hand-written. ' + st.tracked + ' targets · ' + st.drained + ' drained · ' + st.bleeding + ' bleeding.\n' +
      'window.SW_HVT_BALANCE_SEED = ' +
      JSON.stringify({ version: 1, exported: _now().slice(0, 10), balances: balances }, null, 1) + ';\n';
  }

  function downloadSeed() {
    try {
      var blob = new Blob([exportSeed()], { type: 'text/javascript' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'hvt-balance-seed.js';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      return true;
    } catch (_) { return false; }
  }

  function reset() { _mem = {}; save(); }

  window.SW_HVT_HISTORY = {
    record: record, get: get, all: all, status: status, alerts: alerts,
    stats: stats, exportSeed: exportSeed, downloadSeed: downloadSeed, reset: reset,
    FLOOR_XRP: FLOOR_XRP, DRAINED_RATIO: DRAINED_RATIO, BLEEDING_RATIO: BLEEDING_RATIO
  };
})();

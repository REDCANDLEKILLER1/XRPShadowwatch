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
  // Smallest peak worth judging a drain against. The Coreum bridge held ~200,410
  // XRP and ended at 493.5 — 99.75% gone in 97 minutes, unmistakably an event —
  // and the first version of this file called it LIGHT, because 200K is under the
  // 1M high-value floor and the floor short-circuited the drain check entirely.
  // Those are two different questions: "is this still a high-value target" is
  // absolute, "has this wallet been emptied" is relative and true at any size.
  // The floor now decides only the LIGHT label; MIN_JUDGE_XRP decides whether we
  // have enough to call a drain at all, and sits 100× lower so a five-figure
  // wallet collapsing still registers while dust stays quiet.
  var MIN_JUDGE_XRP  = 1e4;
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

  // ── HOW A WALLET SIGNS ──────────────────────────────────────────────────────
  // A bridge, a custody pool or a corporate treasury signs with a quorum. If an
  // account that has only ever multi-signed suddenly authorises a payment with a
  // single key, the interesting question is not where the money went — it is who
  // just became able to move it alone. The reverse (single → multisig) is the
  // ordinary shape of an account being secured, and is worth noting, not alarming.
  //
  // This lives in the shared store for the same reason balances do: the wall and
  // the report console both see transactions, and whichever sees one first should
  // teach the other. Counts are kept per mode so one malformed row cannot flip a
  // wallet's established habit.
  function recordSig(addr, mode, signerCount) {
    if (!addr || (mode !== 'multisig' && mode !== 'single')) return null;
    var s = load();
    var r = s[addr] || (s[addr] = { peak: 0, peakAt: null, last: 0, lastAt: null,
                                    prev: null, prevAt: null, n: 0, from: 'sig' });
    r.sig = r.sig || { multisig: 0, single: 0, mode: null, since: null, changedAt: null, from: null, quorum: 0 };
    r.sig[mode]++;
    if (mode === 'multisig' && n(signerCount) > r.sig.quorum) r.sig.quorum = n(signerCount);

    // An established habit needs more than one sighting; until then just record.
    var established = r.sig.mode;
    var total = r.sig.multisig + r.sig.single;
    var changed = null;
    if (!established) {
      if (total >= 2) { r.sig.mode = mode; r.sig.since = _now(); }
    } else if (established !== mode && r.sig[mode] >= 2) {
      // Two independent sightings of the new mode before we call it a change, so
      // a single odd row never raises this.
      changed = { address: addr, from: established, to: mode, at: _now(), quorum: r.sig.quorum };
      r.sig.from = established; r.sig.mode = mode;
      r.sig.changedAt = changed.at;
    }
    save();
    return changed;
  }
  function sigOf(addr) { var r = get(addr); return (r && r.sig) || null; }
  // Every wallet whose signing habit has changed — the report asks for this.
  function sigChanges() {
    var s = load(), out = [];
    Object.keys(s).forEach(function (a) {
      var g = s[a] && s[a].sig;
      if (g && g.changedAt && g.from && g.from !== g.mode)
        out.push({ address: a, from: g.from, to: g.mode, at: g.changedAt, quorum: g.quorum });
    });
    return out;
  }

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

    // Too small to say anything about — never seen holding enough for "drained"
    // to be a meaningful word.
    if (expected < MIN_JUDGE_XRP) {
      return { state: xrpNow < FLOOR_XRP ? 'LIGHT' : 'OK',
               expected: expected, ratio: null, peak: rec ? rec.peak : 0, delta: delta, gone: 0 };
    }
    var ratio = expected > 0 ? (xrpNow / expected) : null;
    var state = ratio <= DRAINED_RATIO ? 'DRAINED'
              : ratio <= BLEEDING_RATIO ? 'BLEEDING'
              // Holding its position, but never big enough to be a high-value
              // target in the first place — worth saying, not worth alerting on.
              : (xrpNow < FLOOR_XRP && expected < FLOOR_XRP) ? 'LIGHT'
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

  // n() lives in the report console but not on the wall; keep this file standalone.
  function n(v) { var x = Number(v); return isFinite(x) ? x : 0; }

  window.SW_HVT_HISTORY = {
    record: record, get: get, all: all, status: status, alerts: alerts,
    recordSig: recordSig, sigOf: sigOf, sigChanges: sigChanges,
    stats: stats, exportSeed: exportSeed, downloadSeed: downloadSeed, reset: reset,
    FLOOR_XRP: FLOOR_XRP, MIN_JUDGE_XRP: MIN_JUDGE_XRP,
    DRAINED_RATIO: DRAINED_RATIO, BLEEDING_RATIO: BLEEDING_RATIO
  };
})();

// ── 2026-08-14 REPORT-APPROVED ROSTER PROMOTIONS ────────────────────────────
// The report's own Auto Discovery promoted these four to ADD on
// SW-20260814-FCZVX. This file loads in BOTH applications after hvt-roster.js
// and before either engine, so injecting them here immediately keeps the live
// wall and Report on one roster without waiting for the next generated roster
// commit. scripts/build-hvt-roster.js carries the same promotion set so the next
// regeneration makes them ordinary generated targets rather than runtime-only.
(function () {
  'use strict';
  try {
    var R = window.SW_HVT_ROSTER;
    if (!R || !Array.isArray(R.targets)) return;
    var adds = [
      { address:'rpY7bZBkA98P8zds5LdBktAKj9ifekPdkE', label:'WHALE_RECV_rpY7bZ', handle:'WHALE_RECV_rpY7bZ', type:'HVT', identified:false, confidence:null, expected_xrp:null, expected_source:null, sources:['report'] },
      { address:'rU5NDVnQ6nHBvD33en6HjWipY67PJ7hcXG', label:'WHALE_RECV_rU5NDV', handle:'WHALE_RECV_rU5NDV', type:'HVT', identified:false, confidence:null, expected_xrp:null, expected_source:null, sources:['report'] },
      { address:'rsnXj9TDwt49XxCM64YrTEnSzwcY4awZnn', label:'EXOUT_RECV_rsnXj9', handle:'EXOUT_RECV_rsnXj9', type:'HVT', identified:false, confidence:null, expected_xrp:null, expected_source:null, sources:['report'] },
      { address:'rw1xqK3TvKCZcdTcHGp6b2Q8dELnCCGFvT', label:'LARGE_RECV_rw1xqK', handle:'LARGE_RECV_rw1xqK', type:'HVT', identified:false, confidence:null, expected_xrp:null, expected_source:null, sources:['report'] }
    ];
    var seen = Object.create(null);
    R.targets.forEach(function (t) { if (t && t.address) seen[t.address] = true; });
    var added = 0;
    adds.forEach(function (t) {
      if (!seen[t.address]) { R.targets.push(t); seen[t.address] = true; added++; }
    });
    if (added && R.stats) {
      R.stats.total = R.targets.length;
      if (typeof R.stats.from_report_only === 'number') R.stats.from_report_only += added;
    }
    R.runtime_promotions = R.runtime_promotions || {};
    R.runtime_promotions['2026-08-14'] = {
      added: added,
      addresses: adds.map(function (t) { return t.address; })
    };
  } catch (_) {}
})();

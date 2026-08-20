/* ShadowWatch discovery hot-path optimization — 2026-08-20.
   Preserves candidate evidence/scoring inputs while replacing the two quadratic
   transaction re-scan paths with precomputed linear counters. Read-only. */
(function () {
  'use strict';
  var VERSION = '2026.08.20.1';

  function install() {
    var original = null;
    try { original = window.collectDiscoveryCandidates; } catch (_) {}
    if (typeof original !== 'function') return false;
    if (original._swLinearDiscovery20260820) return true;

    var source = '';
    try { source = Function.prototype.toString.call(original); } catch (_) {}
    // Fail closed if upstream structure changed: do not guess around a new collector.
    if (source.indexOf('repeated mid-size') < 0 || source.indexOf('exchange_adjacent') < 0) return false;

    var optimized = function (pack) {
      pack = pack || state.pack || {};
      var txs = Array.isArray(state.txs) ? state.txs : [];
      if (!txs.length) return original(pack);

      // Precompute the evidence that the legacy collector previously derived by
      // re-filtering all txs once per recipient and re-scanning all global size
      // buckets once per recipient.
      var flow = {};
      txs.forEach(function (t) {
        if (!t || t.currency !== 'XRP' || !t.to) return;
        var amt = n(t.amount);
        if (amt <= 0) return;
        var f = flow[t.to];
        if (!f) f = flow[t.to] = { count:0, total:0, lastTs:null, mid:0, buckets:{} };
        f.count++;
        f.total += amt;
        if (amt >= 100000 && amt < 1000000) f.mid++;
        if (t.timestamp || t.ts) f.lastTs = t.timestamp || t.ts;
        var bucket = String(Math.round(amt));
        f.buckets[bucket] = (f.buckets[bucket] || 0) + 1;
      });

      // Let the canonical collector handle every non-tx source unchanged. With
      // txs temporarily empty, only its legacy repeated-flow + exchange-adjacent
      // passes are skipped; we add those exact contributions back below.
      var savedTxs = state.txs;
      var base;
      try {
        state.txs = [];
        base = original(pack) || [];
      } finally {
        state.txs = savedTxs;
      }

      var byAddr = new Map();
      (base || []).forEach(function (r) {
        if (!r || !r.address) return;
        var c = Object.assign({}, r);
        c.sources = new Set(r.sources || []);
        c.reasons = (r.reasons || []).slice();
        c.related_watched_wallets = new Set(r.related_watched_wallets || []);
        byAddr.set(c.address, c);
      });

      function ensure(addr) {
        if (!_isValidDiscoveryAddress(addr)) return null;
        var rec = byAddr.get(addr);
        if (!rec) {
          rec = {
            address: addr,
            sources: new Set(), reasons: [], related_watched_wallets: new Set(),
            total_value_xrp: 0, max_value_xrp: 0, tx_count: 0,
            last_seen: null, first_seen: null, active_last_24h: false,
            forwarded_large_count: 0, repeated_dest_tag: false,
            repeated_same_size: false, repeated_mid_size: false,
            exchange_adjacent: false, shared_counterparty_count: 0,
            is_blacklisted: false, is_dust_only: false, is_already_watched: false,
            fresh_account: false, age_hours: null
          };
          byAddr.set(addr, rec);
        }
        return rec;
      }

      function bump(addr, sourceName, fields) {
        var rec = ensure(addr);
        if (!rec) return;
        if (sourceName) rec.sources.add(sourceName);
        fields = fields || {};
        var val = fields.value_xrp != null ? n(fields.value_xrp) : null;
        var implausible = val != null && val >= 100000000000;
        if (fields.reason && !implausible) rec.reasons.push(fields.reason);
        (fields.related_watched || []).forEach(function (w) { rec.related_watched_wallets.add(w); });
        if (val != null && !implausible) {
          rec.total_value_xrp += val;
          if (val > rec.max_value_xrp) rec.max_value_xrp = val;
        }
        if (fields.tx_count != null) rec.tx_count += n(fields.tx_count);
        if (fields.last_seen) rec.last_seen = fields.last_seen;
        if (fields.active_last_24h) rec.active_last_24h = true;
        if (fields.repeated_same_size) rec.repeated_same_size = true;
        if (fields.repeated_mid_size) rec.repeated_mid_size = true;
        if (fields.exchange_adjacent) rec.exchange_adjacent = true;
      }

      Object.keys(flow).forEach(function (addr) {
        var f = flow[addr];
        if (f.mid >= 3) {
          bump(addr, 'repeated_mid_size', {
            reason: 'repeated mid-size flow (' + f.mid + ' transfers in 100K-1M range)',
            value_xrp: n(f.total), tx_count: n(f.count), last_seen: f.lastTs,
            active_last_24h: true, repeated_mid_size: true
          });
        }
        var same = Object.keys(f.buckets).reduce(function (count, bucket) {
          return count + (f.buckets[bucket] >= 3 ? 1 : 0);
        }, 0);
        if (same) {
          bump(addr, 'repeated_same_size', {
            reason: 'repeated same-size transfer pattern (' + same + ' bucket(s))',
            value_xrp: n(f.total), tx_count: n(f.count),
            repeated_same_size: true, active_last_24h: true
          });
        }
      });

      // Canonical exchange-adjacent contribution, still one linear pass.
      if (typeof KNOWN !== 'undefined') {
        txs.forEach(function (t) {
          if (!t) return;
          var fromIsExch = KNOWN[t.from] && KNOWN[t.from].cat === 'exchange';
          var toIsExch   = KNOWN[t.to]   && KNOWN[t.to].cat   === 'exchange';
          if (fromIsExch && t.to && !_isWatchedAddress(t.to)) {
            bump(t.to, 'exchange_adjacent', {
              reason: 'received funds from exchange ' + _swWho(t.from, KNOWN[t.from].label, { bare:true }),
              value_xrp: n(t.amount), tx_count: 1, exchange_adjacent: true,
              active_last_24h: true,
              related_watched: [_swWho(t.from, KNOWN[t.from].label, { bare:true })]
            });
          } else if (toIsExch && t.from && !_isWatchedAddress(t.from)) {
            bump(t.from, 'exchange_adjacent', {
              reason: 'sent funds to exchange ' + _swWho(t.to, KNOWN[t.to].label, { bare:true }),
              value_xrp: n(t.amount), tx_count: 1, exchange_adjacent: true,
              active_last_24h: true,
              related_watched: [_swWho(t.to, KNOWN[t.to].label, { bare:true })]
            });
          }
        });
      }

      var out = [];
      byAddr.forEach(function (rec) {
        rec.sources = Array.from(rec.sources);
        rec.related_watched_wallets = Array.from(rec.related_watched_wallets);
        rec.is_already_watched = _isWatchedAddress(rec.address);
        rec.is_dust_only = rec.total_value_xrp > 0 && rec.total_value_xrp < 1 && rec.tx_count > 0;
        out.push(rec);
      });
      return out;
    };

    optimized._swLinearDiscovery20260820 = true;
    optimized._swOriginal = original;
    try { window.collectDiscoveryCandidates = optimized; } catch (_) {}

    try {
      window.SW_DISCOVERY_PERF_20260820 = {
        version: VERSION,
        installed: true,
        algorithm: 'single-pass repeated-flow counters',
        read_only: true,
        scoring_changed: false,
        thresholds_changed: false
      };
    } catch (_) {}
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

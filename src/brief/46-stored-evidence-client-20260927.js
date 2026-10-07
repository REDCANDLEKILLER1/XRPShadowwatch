(function () {
  'use strict';

  // Stored-evidence device boundary.
  //
  // The report may still use small, targeted XRPL enrichments for addresses
  // outside the watched roster. What it may NOT do is silently turn a failed
  // stored-evidence read into another 423-wallet acquisition from this device.
  // This fence is deliberately installed after 02-core.js so it wraps the real
  // global xrpl() used by the scanner without editing the 1.9 MB core file.

  function watched(address) {
    if (!address) return false;
    try {
      if (typeof getActiveWatchlist === 'function') {
        var list = getActiveWatchlist() || [];
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].address === address) return true;
        }
      }
    } catch (_) {}
    return false;
  }

  function checkpointWallet(address) {
    try {
      var index = window.SW_EVIDENCE_INDEX;
      if (index && typeof index.checkpointWallet === 'function') {
        return index.checkpointWallet(address);
      }
    } catch (_) {}
    return null;
  }

  function storedActive() {
    try {
      var index = window.SW_EVIDENCE_INDEX;
      return !!(index && typeof index.storedActive === 'function' && index.storedActive());
    } catch (_) {
      return false;
    }
  }

  function installXrplFence() {
    try {
      if (typeof xrpl !== 'function' || xrpl.__swStoredEvidenceFence) return false;
      var original = xrpl;

      xrpl = async function (ws, request) {
        var req = request || {};
        var command = String(req.command || '');
        var address = req.account ? String(req.account) : '';

        if (storedActive() && address && watched(address) && command === 'account_info') {
          var cp = checkpointWallet(address);
          if (!cp || cp.balance_drops === null || cp.balance_drops === undefined ||
              !Number.isFinite(Number(cp.balance_ledger))) {
            var missing = new Error('STORED_EVIDENCE_BALANCE_UNAVAILABLE: ' + address);
            missing.storedEvidence = true;
            throw missing;
          }
          return {
            account_data: {
              Account: address,
              Balance: String(cp.balance_drops)
            },
            ledger_index: Number(cp.balance_ledger),
            validated: true,
            stored_evidence: true
          };
        }

        if (storedActive() && address && watched(address) && command === 'account_tx') {
          var fenced = new Error('WATCHED_ACCOUNT_TX_NETWORK_FENCED: stored evidence is authoritative for ' + address);
          fenced.storedEvidence = true;
          throw fenced;
        }

        // Enrichment is optional: no reconnect/quota retry chain and a shared
        // 20-second / 24-request ceiling. Watched evidence never enters here.
        if (storedActive() && typeof state !== 'undefined' && state._storedReportRun) {
          var budget = state._storedEnrichment;
          var socket = state._sock || ws;
          if (!budget || Date.now() >= budget.deadline || budget.requests >= 24 || !socket || socket.readyState !== 1) {
            if (budget) budget.unavailable++;
            throw new Error('OPTIONAL_LIVE_ENRICHMENT_UNAVAILABLE');
          }
          budget.requests++;
          var timer;
          try {
            return await Promise.race([
              _xrplRequest(socket, req),
              new Promise(function (_, reject) {
                timer = setTimeout(function () { reject(new Error('OPTIONAL_LIVE_ENRICHMENT_TIMEOUT')); },
                  Math.max(1, Math.min(4000, budget.deadline - Date.now())));
              })
            ]);
          } finally { if (timer) clearTimeout(timer); }
        }

        return original.apply(this, arguments);
      };

      xrpl.__swStoredEvidenceFence = true;
      xrpl.__swOriginal = original;
      return true;
    } catch (_) {
      return false;
    }
  }

  function installFailClosedPreflight() {
    try {
      if (typeof scanWallets !== 'function' || scanWallets.__swStoredPreflight) return;
      var originalScanWallets = scanWallets;
      scanWallets = async function () {
        // The real RUN owns identity/window initialization and fails closed at
        // its acquisition boundary. Prefetching before that initialization
        // causes a second GET (or a window mismatch) on subsequent RUNs.
        if (typeof state !== 'undefined' && state && state._storedReportRun) {
          return originalScanWallets.apply(this, arguments);
        }
        // Direct diagnostic calls to scanWallets (the XRPL resilience suites)
        // are not report RUNs. The report path always mints state.reportId first.
        try {
          if (typeof state === 'undefined' || !state || !state.reportId) {
            return originalScanWallets.apply(this, arguments);
          }
        } catch (_) {
          return originalScanWallets.apply(this, arguments);
        }
        var index = window.SW_EVIDENCE_INDEX;
        if (!index || typeof index.prefetch !== 'function') {
          throw new Error('STORED_EVIDENCE_READER_UNAVAILABLE');
        }
        var range = (typeof getTxWindow === 'function') ? getTxWindow() : null;
        var accounts = [];
        try {
          accounts = (typeof getActiveWatchlist === 'function' ? getActiveWatchlist() : [])
            .map(function (w) { return w && w.address; }).filter(Boolean);
        } catch (_) {}
        try {
          await index.prefetch(range, accounts);
        } catch (e) {
          try {
            if (typeof log === 'function') {
              log('STORED EVIDENCE UNAVAILABLE — report stopped before watched-wallet acquisition: ' +
                String(e && e.message || e));
            }
          } catch (_) {}
          throw e;
        }
        return originalScanWallets.apply(this, arguments);
      };
      scanWallets.__swStoredPreflight = true;
      scanWallets.__swOriginal = originalScanWallets;
    } catch (_) {}
  }

  function installHeavyEnrichmentFence() {
    try {
      if (typeof renderReceiverFollowthrough === 'function' && !renderReceiverFollowthrough.__swUnknownRetention) {
        var originalFollowthrough = renderReceiverFollowthrough;
        renderReceiverFollowthrough = function () {
          var lines = originalFollowthrough.apply(this, arguments);
          lines = lines.map(function (line) {
            return line.replace('held — no large forward', 'no large forward observed; retention unproved')
              .replace(/receiver followthrough unproven|RECEIVER_FOLLOWTHROUGH_UNPROVEN/g, 'follow-through unknown');
          });
          if (lines.length && (arguments[0] || []).some(function (r) { return r && r.evidence_source === 'STORED_VERIFIED_EVIDENCE'; })) {
            lines.push('• Stored receiver tracing uses observed watched-wallet payments only; receiver history is incomplete.');
          }
          return lines;
        };
        renderReceiverFollowthrough.__swUnknownRetention = true;
      }
    } catch (_) {}
    // Follow observed outgoing payments without relying on the optional live
    // socket. A watched-window archive is not complete history for an unknown
    // receiver: it proves observed transfers, never an absence or retention.
    try {
      if (typeof scanReceivers === 'function' && !scanReceivers.__swStoredReceiverTrace) {
        var originalReceivers = scanReceivers;
        scanReceivers = async function () {
          if (!storedActive()) return originalReceivers.apply(this, arguments);
          var range = typeof getTxWindow === 'function' ? getTxWindow() : {};
          var anchor = state.indexRun || {};
          var start = Number(range && range.startMs), end = Number(anchor.anchor_close_ms || (range && range.endMs));
          var ceiling = Number(anchor.anchor_ledger);
          function bounded(t) {
            var time = Date.parse(t && t.date), ledger = Number(t && t.ledger_index);
            return t && t.proves_coverage === true && t.hash && Number.isFinite(time) &&
              Number.isFinite(start) && Number.isFinite(end) && time >= start && time <= end &&
              Number.isInteger(ledger) && ledger > 0 && Number.isInteger(ceiling) && ledger <= ceiling &&
              t.tx_result === 'tesSUCCESS';
          }
          var outgoing = new Map();
          var hashes = new Set();
          (state.txs || []).forEach(function (t) {
            if (!bounded(t) || t.type !== 'Payment' || t.currency !== 'XRP' ||
                !t.from || !t.to || t.to === t.from || !Number.isFinite(Number(t.amount)) ||
                Number(t.amount) <= 0 || Number(t.amount) >= 1e11) return;
            var key = String(t.hash).toUpperCase();
            if (hashes.has(key)) return;
            hashes.add(key);
            if (!outgoing.has(t.from)) outgoing.set(t.from, []);
            outgoing.get(t.from).push(t);
          });
          var recipients = new Map();
          _deliveredToReceiver(null).forEach(function (t) {
            if (!bounded(t) || !t.to || KNOWN[t.to] || !BASE58_RE.test(t.to) || t.currency !== 'XRP' ||
                !Number.isFinite(Number(t.amount)) || Number(t.amount) <= 0 || Number(t.amount) >= 1e11 ||
                (t.type !== 'Payment' && t.type !== 'EscrowFinish')) return;
            var prior = recipients.get(t.to);
            if (!prior || Number(t.amount) > Number(prior.amount) ||
                (Number(t.amount) === Number(prior.amount) && Number(t.ledger_index) < Number(prior.ledger_index))) recipients.set(t.to, t);
          });
          state.receivers = [];
          recipients.forEach(function (src, address) {
            var rec = {address: address, source_label: src.sender_label, source_amount_xrp: src.amount,
              balance_xrp: null, tx_count: 0, forwarded_large_count: 0, forwarded_large_total_xrp: 0,
              classification: 'RECEIVER_FOLLOWTHROUGH_UNPROVEN', confidence: 'LOW', error: '',
              evidence_source: 'STORED_VERIFIED_EVIDENCE', history_complete: false,
              evidence_through: new Date(end).toISOString(), anchor_ledger: ceiling,
              observed_forward_hashes: [], source_hash: src.hash};
            var cp = checkpointWallet(address);
            if (cp && cp.balance_drops != null && Number.isFinite(Number(cp.balance_drops)) &&
                Number.isInteger(Number(cp.balance_ledger)) && Number(cp.balance_ledger) === ceiling) {
              rec.balance_xrp = Number(cp.balance_drops) / 1e6;
              rec.balance_as_of_ledger = ceiling;
            }
            (outgoing.get(address) || []).forEach(function (t) {
              // Same-ledger transaction order is not retained in the compact
              // archive, so only later ledgers prove an onward move.
              if (Number(t.ledger_index) <= Number(src.ledger_index) || Date.parse(t.date) < Date.parse(src.date)) return;
              rec.tx_count++;
              if (Number(t.amount) >= 1e6) {
                rec.forwarded_large_count++;
                rec.forwarded_large_total_xrp += Number(t.amount);
                rec.observed_forward_hashes.push(t.hash);
              }
            });
            if (rec.forwarded_large_count > 0) {
              rec.classification = 'NEXT_HOP_FORWARDING_DETECTED';
              rec.confidence = 'HIGH';
            }
            rec.coverage_note = 'Observed payments after the largest receipt, within watched-wallet evidence only; receiver history is not complete. No observed large forward does not prove funds were held.';
            state.receivers.push(rec);
            if (typeof log === 'function') log('NEXT_HOP: ' + address + ' ' + rec.classification + ' · stored observed payments; receiver history not complete');
          });
          if (typeof setText === 'function') {
            setText('hudReceiverCount', state.receivers.length);
            setText('hudReceiverMode', state.receivers.length + ' receiver(s) · stored observed routes');
          }
          return state.receivers;
        };
        scanReceivers.__swStoredReceiverTrace = true;
        scanReceivers.__swOriginal = originalReceivers;
      }
    } catch (_) {}
    try {
      if (typeof scanOffers === 'function' && !scanOffers.__swStoredEvidenceFence) {
        var originalOffers = scanOffers;
        scanOffers = async function () {
          if (!storedActive()) return originalOffers.apply(this, arguments);
          try { if (typeof state !== 'undefined') state.offers = []; } catch (_) {}
          try { if (typeof log === 'function') log('OFFERS: watched-wallet sweep skipped — stored RUN coverage does not depend on live offers.'); } catch (_) {}
          return 0;
        };
        scanOffers.__swStoredEvidenceFence = true;
        scanOffers.__swOriginal = originalOffers;
      }
    } catch (_) {}

    try {
      if (typeof runRelatedOfferScan === 'function' && !runRelatedOfferScan.__swStoredEvidenceFence) {
        var originalRelatedOffers = runRelatedOfferScan;
        runRelatedOfferScan = async function () {
          if (!storedActive()) return originalRelatedOffers.apply(this, arguments);
          try { if (typeof state !== 'undefined') state.relatedOffers = []; } catch (_) {}
          try { if (typeof log === 'function') log('RELATED OFFERS: phone sweep skipped — optional live enrichment is outside stored coverage.'); } catch (_) {}
          return [];
        };
        runRelatedOfferScan.__swStoredEvidenceFence = true;
        runRelatedOfferScan.__swOriginal = originalRelatedOffers;
      }
    } catch (_) {}
  }

  function formatTime(value) {
    if (!value) return 'unknown';
    var d = new Date(value);
    if (!Number.isFinite(d.getTime())) return String(value);
    try {
      return d.toLocaleString([], {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        timeZoneName: 'short'
      });
    } catch (_) {
      return d.toISOString();
    }
  }

  function freshnessText() {
    var f = null;
    try {
      var index = window.SW_EVIDENCE_INDEX;
      f = index && typeof index.freshness === 'function' ? index.freshness() : null;
    } catch (_) {}
    if (!f) return '';
    return 'EVIDENCE FRESHNESS\n' +
      'Evidence current through: ' + formatTime(f.evidence_time) +
      ' · ledger ' + String(f.anchor_ledger == null ? 'unknown' : f.anchor_ledger) +
      ' · state v' + String(f.state_version == null ? 'unknown' : f.state_version) + '\n' +
      'Next collection window: ' + formatTime(f.next_slot_start) + '–' +
      formatTime(f.next_slot_end) + ' (' + String(f.schedule_precision || 'HOUR_BUCKET').replace(/_/g, ' ') + ')\n' +
      'Status: ' + String(f.status || 'UNKNOWN').replace(/_/g, ' ');
  }

  function addFreshnessToText(text) {
    var block = freshnessText();
    if (!block || String(text || '').indexOf('EVIDENCE FRESHNESS') >= 0) return text;
    var out = String(text == null ? '' : text);
    var lines = out.split('\n');
    var insertAt = 0;
    for (var i = 0; i < Math.min(lines.length, 20); i++) {
      if (/^(DATE:|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4})/.test(lines[i].trim())) {
        insertAt = i + 1; break;
      }
    }
    lines.splice(insertAt, 0, '', block, '');
    return lines.join('\n');
  }

  function installReportFreshness() {
    try {
      if (typeof buildMorningStoryText === 'function' && !buildMorningStoryText.__swFreshness) {
        var originalMorning = buildMorningStoryText;
        buildMorningStoryText = function () {
          var text = originalMorning.apply(this, arguments);
          return storedActive() ? addFreshnessToText(text) : text;
        };
        buildMorningStoryText.__swFreshness = true;
      }
    } catch (_) {}
    try {
      if (typeof buildPublicReport === 'function' && !buildPublicReport.__swFreshness) {
        var originalStructured = buildPublicReport;
        buildPublicReport = function () {
          var text = originalStructured.apply(this, arguments);
          return storedActive() ? addFreshnessToText(text) : text;
        };
        buildPublicReport.__swFreshness = true;
      }
    } catch (_) {}
  }

  function renderFreshness(f) {
    if (!f) return;
    var bar = document.getElementById('swEvidenceFreshness');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'swEvidenceFreshness';
      bar.setAttribute('role', 'status');
      bar.setAttribute('aria-live', 'polite');
      bar.style.cssText =
        'box-sizing:border-box;width:100%;padding:5px 10px;border-bottom:1px solid rgba(0,255,0,.25);' +
        'background:rgba(0,8,4,.92);color:#aaffaa;font:600 9px/1.35 Rajdhani,Arial,sans-serif;' +
        'letter-spacing:.05em;text-transform:uppercase;overflow-wrap:anywhere;z-index:12;';
      var stage = document.getElementById('screenStage');
      var app = stage && stage.parentNode;
      if (app && stage) app.insertBefore(bar, stage);
      else document.body.insertBefore(bar, document.body.firstChild);
    }

    var status = String(f.status || 'UNKNOWN').replace(/_/g, ' ');
    var prefix = (f.last_good_after_fail || f.stale) ? 'LAST GOOD · ' : '';
    bar.textContent =
      prefix + status +
      ' · Evidence through ' + formatTime(f.evidence_time) +
      ' · Ledger ' + String(f.anchor_ledger == null ? 'unknown' : f.anchor_ledger) +
      ' · State v' + String(f.state_version == null ? 'unknown' : f.state_version) +
      ' · Next collection window ' + formatTime(f.next_slot_start) +
      '–' + formatTime(f.next_slot_end);
    bar.dataset.status = String(f.status || 'UNKNOWN');
  }

  try {
    window.addEventListener('shadowwatch:evidence-freshness', function (event) {
      renderFreshness(event && event.detail);
    });
  } catch (_) {}

  installXrplFence();
  installFailClosedPreflight();
  installHeavyEnrichmentFence();
  installReportFreshness();

  window.SW_STORED_EVIDENCE_CLIENT_20260927 = {
    installXrplFence: installXrplFence,
    installFailClosedPreflight: installFailClosedPreflight,
    installHeavyEnrichmentFence: installHeavyEnrichmentFence,
    installReportFreshness: installReportFreshness,
    freshnessText: freshnessText,
    addFreshnessToText: addFreshnessToText,
    checkpointWallet: checkpointWallet,
    storedActive: storedActive,
    watched: watched,
    renderFreshness: renderFreshness
  };
})();

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

        return original.apply(this, arguments);
      };

      xrpl.__swStoredEvidenceFence = true;
      xrpl.__swOriginal = original;
      return true;
    } catch (_) {
      return false;
    }
  }

  function installHeavyEnrichmentFence() {
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
  installHeavyEnrichmentFence();

  window.SW_STORED_EVIDENCE_CLIENT_20260927 = {
    installXrplFence: installXrplFence,
    installHeavyEnrichmentFence: installHeavyEnrichmentFence,
    checkpointWallet: checkpointWallet,
    storedActive: storedActive,
    watched: watched,
    renderFreshness: renderFreshness
  };
})();

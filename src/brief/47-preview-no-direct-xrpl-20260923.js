/* 47-preview-no-direct-xrpl-20260923.js
 * Preview fence on audit/memory-contract-guard. Does not edit 02-core.js.
 *
 * Preview may READ the shared evidence store. It must not WRITE the
 * production checkpoint. If the stored snapshot cannot be served, the
 * scan stops incomplete. It must not start account_tx on all 418 wallets.
 *
 * Server half lives in api/delta.js (buildPreviewReadOnlyRun).
 * This file is the client fail-closed net around scanWallets' catch.
 */
(function previewNoDirectXrpl() {
  'use strict';

  var BLOCK_RE = /PREVIEW_READ_ONLY_SNAPSHOT_UNAVAILABLE|EVIDENCE_WRITE_REFUSED_NON_PRODUCTION/;

  function previewUnavailableError() {
    var _previewErr = new Error('PREVIEW READ-ONLY SNAPSHOT UNAVAILABLE: stored evidence could not satisfy this test window. Production was not modified and no direct 418-wallet crawl was started.');
    _previewErr.scanIncomplete = true;
    _previewErr.previewReadOnly = true;
    return _previewErr;
  }

  if (typeof beginEvidenceIndexResilient === 'function') {
    var origBegin = beginEvidenceIndexResilient;
    beginEvidenceIndexResilient = async function () {
      try {
        return await origBegin.apply(this, arguments);
      } catch (e) {
        var _evidenceMsg = String(e && e.message || e || '');
        var _previewReadOnlyUnavailable = BLOCK_RE.test(_evidenceMsg);
        if (_previewReadOnlyUnavailable) {
          try {
            if (typeof log === 'function') {
              log('Preview read-only snapshot unavailable — direct XRPL fallback remains disabled.');
            }
          } catch (_) {}
          throw previewUnavailableError();
        }
        throw e;
      }
    };
    if (typeof window !== 'undefined') window.beginEvidenceIndexResilient = beginEvidenceIndexResilient;
  }

  if (typeof log === 'function') {
    var origLog = log;
    log = function (msg) {
      origLog(msg);
      var text = String(msg || '');
      if (/Evidence index unavailable — direct XRPL acquisition:/.test(text) && BLOCK_RE.test(text)) {
        throw previewUnavailableError();
      }
    };
  }

  if (typeof xrpl === 'function') {
    var origXrpl = xrpl;
    xrpl = async function (ws, req) {
      if (req && req.command === 'account_tx') {
        try {
          if (typeof state === 'object' && state && state._previewBlockDirectXrpl) {
            throw previewUnavailableError();
          }
        } catch (e) {
          if (e && e.previewReadOnly) throw e;
        }
      }
      return origXrpl.apply(this, arguments);
    };
  }

  try {
    if (typeof log === 'function') log('[preview-fence] installed');
  } catch (_) {}
})();

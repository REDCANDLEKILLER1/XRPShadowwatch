/* Morning Report activity-tone guard — 2026-08-16.
   Presentation-only. Does not change scan evidence, risk scoring, wallet logic,
   news collection, escrow classification, or XRPL calls. */
(function () {
  'use strict';

  function activity(pack) {
    var p = pack || {};
    var transfers = Array.isArray(p.large_transfers)
      ? p.large_transfers.length
      : Number(p.large_transfer_count || p.largeTransferCount || 0);
    var volume = Number(p.shadow_volume_xrp || p.shadowVolumeXrp || 0);
    return {
      transfers: transfers,
      volume: volume,
      elevated: transfers >= 20 || volume >= 100000000
    };
  }

  function repair(text, pack) {
    var out = String(text == null ? '' : text);
    var a = activity(pack);
    if (!a.elevated) return out;

    // Keep the risk score's own judgement intact. This guard corrects only the
    // contradictory prose that called an objectively busy transfer window calm.
    out = out.replace(
      /Mostly calm, a little chatter\. Nothing I[’']d wake you for\./g,
      'Transfer activity was elevated, even though the overall risk score stayed moderate. Worth watching, not a panic signal.'
    );
    out = out.replace(
      /The read, straight up: a steady night — nothing broke the pattern\./g,
      'The read, straight up: transfer activity was elevated, but the broader pattern did not break.'
    );
    out = out.replace(
      /Track whether today[’']s quiet is the calm before a repositioning\./g,
      'Track whether today’s elevated transfer activity develops into a clearer repositioning pattern.'
    );

    return out;
  }

  try {
    if (typeof buildMorningStoryText === 'function' && !buildMorningStoryText._sw20260816ToneGuard) {
      var original = buildMorningStoryText;
      buildMorningStoryText = function (pack) {
        return repair(original.apply(this, arguments), pack);
      };
      buildMorningStoryText._sw20260816ToneGuard = true;
    }
  } catch (_) {}

  window.SW_MORNING_TONE_GUARD_20260816 = {
    version: '2026.08.16.1',
    large_transfer_floor: 20,
    shadow_volume_floor_xrp: 100000000,
    presentation_only: true,
    scanner_untouched: true,
    risk_score_untouched: true
  };
})();

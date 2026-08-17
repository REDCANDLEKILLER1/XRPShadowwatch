/* Live App — keep Ripple escrow OFF the HOME mission-control surface.
   The escrow engine remains read-only and accessible through Escrow Watch/Menu.
   This layer only preserves the owner-only current-position filter and removes
   any legacy/home escrow presentation so the original ShadowWatch Report card
   remains completely untouched. */
(function () {
  'use strict';

  // XRPL account_objects can include Escrow objects linked to an account merely
  // because it is the destination. CURRENT RIPPLE ESCROW must count only objects
  // actually owned by the queried Ripple account (Escrow.Account === result.account).
  try {
    var escrowApi = window.SW_ESCROW;
    if (escrowApi && typeof escrowApi.handleResp === 'function' && !escrowApi._ownerOnlyObjectFilter) {
      var originalEscrowResp = escrowApi.handleResp;
      escrowApi.handleResp = function (d) {
        try {
          var id = String(d && d.id || '');
          var res = d && d.result;
          if (id.indexOf('esc_obj_') === 0 && res && res.account && Array.isArray(res.account_objects)) {
            res.account_objects = res.account_objects.filter(function (o) {
              return !!(o && o.Account && String(o.Account) === String(res.account));
            });
          }
        } catch (_) {}
        return originalEscrowResp.call(escrowApi, d);
      };
      escrowApi._ownerOnlyObjectFilter = true;
    }
  } catch (_) {}

  function removeHomeEscrow() {
    try {
      var node = document.getElementById('sw-ripple-escrow-home');
      if (node) node.remove();
    } catch (_) {}
    try {
      var style = document.getElementById('sw-ripple-escrow-home-style');
      if (style) style.remove();
    } catch (_) {}
  }

  // escrow-watch.js predates the current Mission Control and may still attempt
  // to mount its old dedicated HOME line during position refreshes. Suppress
  // presentation only; do not alter escrow scanning, history, or the Escrow
  // Watch panel itself.
  removeHomeEscrow();

  try {
    var observer = new MutationObserver(function (mutations) {
      var shouldClean = false;
      for (var i = 0; i < mutations.length && !shouldClean; i++) {
        var added = mutations[i].addedNodes || [];
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (!n || n.nodeType !== 1) continue;
          if (n.id === 'sw-ripple-escrow-home' || n.id === 'sw-ripple-escrow-home-style' ||
              (n.querySelector && n.querySelector('#sw-ripple-escrow-home, #sw-ripple-escrow-home-style'))) {
            shouldClean = true;
            break;
          }
        }
      }
      if (shouldClean) removeHomeEscrow();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.SW_RIPPLE_ESCROW_HOME_SUPPRESSOR = {
      installed: true,
      presentation_only: true,
      menu_only: true,
      disconnect: function () { try { observer.disconnect(); } catch (_) {} }
    };
  } catch (_) {}
})();

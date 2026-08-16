/* Live App Mission Control — embedded Ripple escrow status.
   Presentation only. Reads SW_ESCROW's read-only validated-ledger state.
   Keeps Ripple escrow first-class without adding another Mission Control card. */
(function () {
  'use strict';

  // account_objects may include Escrow objects where the queried account is only
  // the destination. CURRENT RIPPLE ESCROW counts owner-only objects.
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

  // Remove the previous standalone card if an older cached script mounted it.
  try {
    var old = document.getElementById('sw-ripple-escrow-home');
    if (old) old.remove();
  } catch (_) {}

  var hero = document.querySelector('#mc-grid .mc-card-featured');
  if (!hero) return;
  var copy = hero.querySelector('.mc-card-copy') || hero;

  var strip = document.createElement('div');
  strip.id = 'sw-ripple-escrow-home';
  strip.className = 'sw-ripple-escrow-home sw-ripple-escrow-inline';
  strip.setAttribute('role', 'button');
  strip.setAttribute('tabindex', '0');
  strip.setAttribute('aria-label', 'Open Ripple Escrow Watch');
  strip.innerHTML = '<span class="sw-re-k">RIPPLE ESCROW</span>' +
    '<span class="sw-re-v" id="homeRippleEscrowLocked">SYNCING…</span>' +
    '<span class="sw-re-m" id="homeRippleEscrowMeta">0/20</span>' +
    '<span class="sw-re-r" id="homeRippleEscrowRecent">96H CHECK…</span>';

  function openEscrow(ev) {
    try { if (ev) { ev.preventDefault(); ev.stopPropagation(); } } catch (_) {}
    try { if (typeof window.openEscrowWatch === 'function') window.openEscrowWatch(); } catch (_) {}
  }
  strip.addEventListener('click', openEscrow);
  strip.addEventListener('keydown', function (ev) {
    if (ev && (ev.key === 'Enter' || ev.key === ' ')) openEscrow(ev);
  });
  copy.appendChild(strip);

  if (!document.getElementById('sw-ripple-escrow-home-style')) {
    var st = document.createElement('style');
    st.id = 'sw-ripple-escrow-home-style';
    st.textContent = [
      '#sw-ripple-escrow-home.sw-ripple-escrow-inline{margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,200,61,.32);display:flex;align-items:center;gap:7px;min-width:0;width:100%;box-sizing:border-box;cursor:pointer;line-height:1.05}',
      '#sw-ripple-escrow-home.sw-ripple-escrow-inline:hover{border-top-color:rgba(255,200,61,.7)}',
      '.sw-ripple-escrow-inline .sw-re-k{font:800 7.5px Orbitron,sans-serif;letter-spacing:.08em;color:#ffc83d;white-space:nowrap}',
      '.sw-ripple-escrow-inline .sw-re-v{font:900 9.5px Orbitron,sans-serif;color:#00ff66;white-space:nowrap}',
      '.sw-ripple-escrow-inline .sw-re-m{font:700 7px "Share Tech Mono",monospace;color:#8ca996;white-space:nowrap}',
      '.sw-ripple-escrow-inline .sw-re-r{font:600 6.8px "Share Tech Mono",monospace;color:#75847c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '@media(max-width:620px){#sw-ripple-escrow-home.sw-ripple-escrow-inline{gap:5px;margin-top:4px;padding-top:4px}.sw-ripple-escrow-inline .sw-re-k{font-size:7px}.sw-ripple-escrow-inline .sw-re-v{font-size:9px}.sw-ripple-escrow-inline .sw-re-m{font-size:6.6px}.sw-ripple-escrow-inline .sw-re-r{display:none}}',
      '@media(max-width:380px){.sw-ripple-escrow-inline .sw-re-k{font-size:6.5px}.sw-ripple-escrow-inline .sw-re-v{font-size:8.4px}.sw-ripple-escrow-inline .sw-re-m{font-size:6.2px}}'
    ].join('');
    document.head.appendChild(st);
  }

  function short(n) {
    n = Number(n || 0);
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    return Math.floor(n).toLocaleString();
  }

  function render() {
    var api = window.SW_ESCROW;
    if (!api) return;
    var p = typeof api.currentRipplePosition === 'function' ? api.currentRipplePosition() : null;
    var s = typeof api.computeSummary === 'function' ? api.computeSummary() : null;
    var v = document.getElementById('homeRippleEscrowLocked');
    var m = document.getElementById('homeRippleEscrowMeta');
    var r = document.getElementById('homeRippleEscrowRecent');
    if (!v || !m || !r) return;

    if (p && p.complete) v.textContent = short(p.locked_xrp) + ' XRP';
    else if (p && p.status === 'PARTIAL') v.textContent = 'SYNC ' + p.answered_owners + '/' + p.expected_owners;
    else v.textContent = 'SYNCING…';

    if (p) {
      m.textContent = p.complete
        ? (p.answered_owners + '/' + p.expected_owners + ' · ' + p.active_objects + ' OBJ')
        : (p.answered_owners + '/' + p.expected_owners);
    }
    if (s) r.textContent = s.lookbackH + 'H · ' + s.ripple.unlocks + ' REL · ' + s.ripple.locks + ' LOCK';
  }

  window.addEventListener('shadowwatch:ripple-escrow-position', render);
  render();
})();

/* ═══════════════════════════════════════════════════════════════════════════
   ESCROW CATEGORY + RIPPLE POSITION — 2026-08-16

   Parent category: ESCROWS
     • RIPPLE ESCROW — CURRENT POSITION (validated ledger objects, 20 published owners)
     • RIPPLE ESCROW — RECENT ACTIVITY (create/finish events)
     • OTHER XRPL ESCROWS — every other observed XRPL escrow event

   Read-only. No event is discarded and no XRPL write/sign/submit path exists.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function isRippleOwner(addr) {
    if (!addr) return false;
    try {
      var r = window.SW_RIPPLE_ESCROW_REGISTRY;
      return !!(r && r.by_address && r.by_address[addr]);
    } catch (_) { return false; }
  }
  function category(evt) { return evt && isRippleOwner(evt.owner) ? 'RIPPLE' : 'OTHER_XRPL'; }

  function escrowList() {
    try { if (typeof state !== 'undefined' && Array.isArray(state.escrow) && state.escrow.length) return state.escrow.slice(); } catch (_) {}
    try {
      var byHash = {};
      if (typeof loadEscrowHistory === 'function') loadEscrowHistory().forEach(function (e) { if (e && e.hash) byHash[e.hash] = e; });
      if (typeof escrowFromTxs === 'function') escrowFromTxs(byHash);
      return Object.keys(byHash).map(function (h) { return byHash[h]; });
    } catch (_) { return []; }
  }

  function currentPosition() {
    try {
      if (typeof state !== 'undefined' && state && state.rippleEscrowPosition) return state.rippleEscrowPosition;
      if (window.SW_RIPPLE_ESCROW_POSITION_20260816 && typeof window.SW_RIPPLE_ESCROW_POSITION_20260816.get === 'function') return window.SW_RIPPLE_ESCROW_POSITION_20260816.get();
    } catch (_) {}
    return null;
  }

  function windowed() {
    var ms = (typeof escrowLookbackMs === 'function') ? escrowLookbackMs() : 36 * 3600000;
    var cut = Date.now() - ms;
    return { hrs: Math.round(ms / 3600000), rows: escrowList().filter(function (e) { return e && (e.ts || 0) >= cut; }).sort(function (a,b) { return (b.xrp||0)-(a.xrp||0); }) };
  }

  function sum(rows) {
    var unlocks = rows.filter(function (e) { return e.type === 'UNLOCK'; });
    var locks = rows.filter(function (e) { return e.type === 'LOCK'; });
    return { unlocks:unlocks.length, locks:locks.length,
      totalUnlocked:unlocks.reduce(function(a,e){return a+Number(e.xrp||0);},0),
      totalLocked:locks.reduce(function(a,e){return a+Number(e.xrp||0);},0),
      largest:rows.length ? rows.slice().sort(function(a,b){return Number(b.xrp||0)-Number(a.xrp||0);})[0] : null };
  }

  function f(n) { try { if (typeof fmt === 'function') return fmt(Number(n||0),0); } catch (_) {} return Math.floor(Number(n||0)).toLocaleString(); }
  function fb(n) { n=Number(n||0); if (n>=1e9) return (n/1e9).toFixed(2)+'B'; if(n>=1e6) return (n/1e6).toFixed(2)+'M'; return f(n); }

  function lane(lines, title, rows, hrs) {
    var s=sum(rows); lines.push(''); lines.push(title);
    if (!rows.length) { lines.push('- No create/finish events detected in this scan window ('+hrs+'h).'); return; }
    lines.push('- Releases detected: '+s.unlocks);
    lines.push('- Total released: '+f(s.totalUnlocked)+' XRP');
    lines.push('- New locks detected: '+s.locks);
    lines.push('- Total newly locked: '+f(s.totalLocked)+' XRP');
    if (s.largest) {
      lines.push('- Largest event: '+f(s.largest.xrp)+' XRP ('+s.largest.type+')');
      lines.push('- Owner: '+(s.largest.owner||'?'));
      if (s.largest.dest) lines.push('- Destination: '+s.largest.dest);
      if (s.largest.hash) lines.push('- XRPSCAN: https://xrpscan.com/tx/'+s.largest.hash);
      try { if (typeof escrowFollowOn === 'function') lines.push('- Follow-on movement: '+escrowFollowOn(s.largest.dest)); } catch (_) {}
    }
    lines.push('  Top events:');
    rows.slice(0,5).forEach(function(e){ lines.push('   • '+title+' · '+e.type+' '+f(e.xrp)+' XRP → '+String(e.dest||e.owner||'?').slice(0,12)+(e.hash?' | https://xrpscan.com/tx/'+e.hash:'')); });
  }

  function positionLines(L, pos) {
    L.push('');
    L.push('RIPPLE ESCROW — CURRENT POSITION');
    if (pos && pos.complete && Number.isFinite(Number(pos.locked_xrp))) {
      L.push('- XRP locked now: '+f(pos.locked_xrp)+' XRP ('+fb(pos.locked_xrp)+')');
      L.push('- Active escrow objects: '+Number(pos.active_objects||0));
      L.push('- Coverage: '+Number(pos.answered_owners||0)+'/'+Number(pos.expected_owners||20)+' published Ripple escrow owners');
      if (pos.ledger_index) L.push('- Validated ledger: '+pos.ledger_index);
      L.push('- Status: COMPLETE — this is current locked inventory, not the recent-event total below.');
    } else if (pos) {
      L.push('- Current locked inventory: PARTIAL / NOT FINAL');
      L.push('- Coverage: '+Number(pos.answered_owners||0)+'/'+Number(pos.expected_owners||20)+' published Ripple escrow owners'+(pos.failed_owners?' · '+pos.failed_owners+' failed':'')+'.');
      L.push('- Shadow Watch will not present an incomplete escrow total as final.');
    } else {
      L.push('- Current locked inventory: NOT AVAILABLE THIS RUN');
      L.push('- Recent activity below remains separate and must not be read as current inventory.');
    }
  }

  function buildSection() {
    var w=windowed(), ripple=w.rows.filter(function(e){return category(e)==='RIPPLE';}), other=w.rows.filter(function(e){return category(e)==='OTHER_XRPL';}), all=sum(w.rows), pos=currentPosition();
    var L=['ESCROWS — COFFEE & CRYPTO'];
    positionLines(L,pos);
    L.push(''); L.push('ESCROW ACTIVITY — LAST '+w.hrs+'H');
    L.push('- Total create/finish events: '+w.rows.length);
    L.push('- Total released across all escrows: '+f(all.totalUnlocked)+' XRP');
    L.push('- Total newly locked across all escrows: '+f(all.totalLocked)+' XRP');
    lane(L,'RIPPLE ESCROW — RECENT ACTIVITY',ripple,w.hrs);
    lane(L,'OTHER XRPL ESCROWS — RECENT ACTIVITY',other,w.hrs);
    L.push(''); L.push('Talking point:');
    L.push('Ripple current escrow inventory and recent escrow activity are separate measurements. A quiet '+w.hrs+'h event window does not mean Ripple escrow is empty. Other XRPL escrows remain separate. Escrow creation or release is on-ledger movement, not by itself a buy, sell, or trade signal.');
    return L.join('\n');
  }

  function buildNarrative() {
    var w=windowed(), ripple=w.rows.filter(function(e){return category(e)==='RIPPLE';}), other=w.rows.filter(function(e){return category(e)==='OTHER_XRPL';}), rs=sum(ripple), os=sum(other), pos=currentPosition(), parts=[];
    if (pos && pos.complete && Number.isFinite(Number(pos.locked_xrp))) parts.push('Ripple currently has '+fb(pos.locked_xrp)+' XRP locked across '+Number(pos.active_objects||0)+' validated-ledger escrow objects, with '+Number(pos.answered_owners||0)+'/'+Number(pos.expected_owners||20)+' published escrow owners checked.');
    else if (pos) parts.push('Ripple current escrow inventory was only partially verified this run ('+Number(pos.answered_owners||0)+'/'+Number(pos.expected_owners||20)+' owners), so Shadow Watch is withholding a final locked-XRP total.');
    if (ripple.length) parts.push('Recent Ripple escrow activity in the last '+w.hrs+'h: '+rs.unlocks+' release'+(rs.unlocks===1?'':'s')+' totaling '+f(rs.totalUnlocked)+' XRP and '+rs.locks+' new lock'+(rs.locks===1?'':'s')+' totaling '+f(rs.totalLocked)+' XRP.');
    else parts.push('No Ripple escrow create/finish events were detected in the last '+w.hrs+'h; that is activity status, not an empty-escrow claim.');
    if (other.length) parts.push('Other XRPL escrows were active: '+os.unlocks+' release'+(os.unlocks===1?'':'s')+' totaling '+f(os.totalUnlocked)+' XRP and '+os.locks+' lock'+(os.locks===1?'':'s')+' totaling '+f(os.totalLocked)+' XRP.');
    else parts.push('No other XRPL escrow events were detected in that window.');
    parts.push('Escrow movement is context, not proof of a buy, sell, or trade.');
    return parts.join(' ');
  }

  try { buildEscrowWatchSection=function(){return buildSection();}; buildEscrowNarrative=function(){return buildNarrative();}; } catch (_) {}
  window.SW_ESCROW_CATEGORIES_20260814={ version:'2026.08.16.2', parent:'ESCROWS', lanes:['RIPPLE ESCROW — CURRENT POSITION','RIPPLE ESCROW — RECENT ACTIVITY','OTHER XRPL ESCROWS'], classify:category, read_only:true };
})();

// Load the canonical registry, then the validated-ledger Ripple position layer,
// then continue the existing report tuning chain. Ordered, read-only startup.
(function () {
  try {
    function load17() {
      if (window.SW_REPORT_SCAN_TUNING_20260816) return;
      var s=document.createElement('script'); s.src='/src/brief/17-report-scan-tuning-20260816.js'; s.async=false; s.setAttribute('data-sw-report-scan-tuning','2026-08-19.1'); document.body.appendChild(s);
    }
    function load25() {
      var p=document.createElement('script'); p.src='/src/brief/25-ripple-escrow-position-20260816.js?v=20260816.1'; p.async=false; p.setAttribute('data-sw-ripple-escrow-position','2026-08-16.1'); p.onload=load17; document.body.appendChild(p);
    }
    if (window.SW_RIPPLE_ESCROW_REGISTRY) load25();
    else {
      var r=document.createElement('script'); r.src='/src/shared/ripple-escrow-registry.js?v=20260816.1'; r.async=false; r.setAttribute('data-sw-ripple-escrow-registry','2026-08-16.1'); r.onload=load25; document.body.appendChild(r);
    }
  } catch (_) {}
})();

/* Live App Mission Control — first-class Ripple escrow line.
   Presentation only. Reads SW_ESCROW's read-only validated-ledger state. */
(function () {
  'use strict';
  if (document.getElementById('sw-ripple-escrow-home')) return;
  var grid = document.getElementById('mc-grid');
  if (!grid) return;

  var b = document.createElement('button');
  b.type = 'button';
  b.id = 'sw-ripple-escrow-home';
  b.className = 'sw-ripple-escrow-home';
  b.setAttribute('aria-label', 'Open Ripple Escrow Watch');
  b.innerHTML = '<span class="sw-re-k">RIPPLE ESCROW LOCKED</span>' +
    '<span class="sw-re-v" id="homeRippleEscrowLocked">CHECKING XRPL…</span>' +
    '<span class="sw-re-m" id="homeRippleEscrowMeta">ESCROW WATCH · 0/20 PUBLIC OWNERS</span>' +
    '<span class="sw-re-r" id="homeRippleEscrowRecent">RECENT ACTIVITY · CHECKING…</span>' +
    '<span class="sw-re-arrow">›</span>';
  b.addEventListener('click', function () { try { if (typeof window.openEscrowWatch === 'function') window.openEscrowWatch(); } catch (_) {} });

  var hero = grid.querySelector('.mc-card-featured');
  if (hero && hero.nextSibling) grid.insertBefore(b, hero.nextSibling);
  else if (hero) grid.appendChild(b);
  else grid.insertBefore(b, grid.firstChild);

  if (!document.getElementById('sw-ripple-escrow-home-style')) {
    var st = document.createElement('style');
    st.id = 'sw-ripple-escrow-home-style';
    st.textContent = '#sw-ripple-escrow-home{grid-column:1/-1;width:100%;display:grid;grid-template-columns:minmax(145px,.75fr) minmax(155px,.95fr) minmax(220px,1.35fr) 22px;grid-template-areas:"k v m a" "k v r a";gap:3px 14px;align-items:center;text-align:left;padding:12px 14px;border:1px solid rgba(255,200,61,.52);border-left:4px solid #ffc83d;border-radius:10px;background:linear-gradient(90deg,rgba(255,200,61,.10),rgba(0,255,0,.035));color:#e6f1ea;cursor:pointer;box-sizing:border-box;font-family:Rajdhani,sans-serif;box-shadow:inset 0 0 18px rgba(255,200,61,.025)}#sw-ripple-escrow-home:hover{border-color:rgba(255,200,61,.82);background:linear-gradient(90deg,rgba(255,200,61,.14),rgba(0,255,0,.05))}.sw-re-k{grid-area:k;font:900 11px Orbitron,sans-serif;letter-spacing:.12em;color:#ffc83d}.sw-re-v{grid-area:v;font:900 24px Orbitron,sans-serif;color:#00ff00;white-space:nowrap}.sw-re-m{grid-area:m;font:700 10px Rajdhani,sans-serif;letter-spacing:.08em;color:#9fc7aa}.sw-re-r{grid-area:r;font:600 9.5px "Share Tech Mono",monospace;color:#7c8c86}.sw-re-arrow{grid-area:a;font:300 30px/1 sans-serif;color:#ffc83d;text-align:right}@media(max-width:620px){#sw-ripple-escrow-home{grid-template-columns:1fr 18px;grid-template-areas:"k a" "v a" "m a" "r a";gap:5px 8px;padding:11px 12px}.sw-re-v{font-size:20px}.sw-re-arrow{align-self:center}}';
    document.head.appendChild(st);
  }

  function short(n) { n=Number(n||0); if(n>=1e9)return(n/1e9).toFixed(2)+'B'; if(n>=1e6)return(n/1e6).toFixed(2)+'M'; return Math.floor(n).toLocaleString(); }
  function render() {
    var api=window.SW_ESCROW; if(!api)return;
    var p=typeof api.currentRipplePosition==='function'?api.currentRipplePosition():null;
    var s=typeof api.computeSummary==='function'?api.computeSummary():null;
    var v=document.getElementById('homeRippleEscrowLocked'),m=document.getElementById('homeRippleEscrowMeta'),r=document.getElementById('homeRippleEscrowRecent');
    if(p&&p.complete)v.textContent=short(p.locked_xrp)+' XRP';
    else if(p&&p.status==='PARTIAL')v.textContent='PARTIAL — RETRY';
    else v.textContent='CHECKING XRPL…';
    if(p)m.textContent='ESCROW WATCH · '+p.answered_owners+'/'+p.expected_owners+' PUBLIC OWNERS'+(p.complete?' · '+p.active_objects+' ACTIVE OBJECTS':(p.failed_owners?' · '+p.failed_owners+' FAILED':''));
    if(s)r.textContent='LAST '+s.lookbackH+'H · '+s.ripple.unlocks+' RELEASE'+(s.ripple.unlocks===1?'':'S')+' · '+s.ripple.locks+' NEW LOCK'+(s.ripple.locks===1?'':'S');
  }
  window.addEventListener('shadowwatch:ripple-escrow-position', render);
  render();
})();

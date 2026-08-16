/* Live App Mission Control — compact first-class Ripple escrow status strip.
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
  b.innerHTML = '<span class="sw-re-k">RIPPLE ESCROW</span>' +
    '<span class="sw-re-v" id="homeRippleEscrowLocked">SYNCING…</span>' +
    '<span class="sw-re-m" id="homeRippleEscrowMeta">LOCKED · 0/20 OWNERS</span>' +
    '<span class="sw-re-r" id="homeRippleEscrowRecent">96H · CHECKING ACTIVITY…</span>' +
    '<span class="sw-re-arrow">›</span>';
  b.addEventListener('click', function () { try { if (typeof window.openEscrowWatch === 'function') window.openEscrowWatch(); } catch (_) {} });

  var hero = grid.querySelector('.mc-card-featured');
  if (hero && hero.nextSibling) grid.insertBefore(b, hero.nextSibling);
  else if (hero) grid.appendChild(b);
  else grid.insertBefore(b, grid.firstChild);

  if (!document.getElementById('sw-ripple-escrow-home-style')) {
    var st = document.createElement('style');
    st.id = 'sw-ripple-escrow-home-style';
    st.textContent = [
      '#sw-ripple-escrow-home{grid-column:1/-1;width:100%;min-height:58px;display:grid;grid-template-columns:minmax(125px,.68fr) minmax(150px,.85fr) minmax(190px,1.1fr) minmax(170px,1fr) 16px;grid-template-areas:"k v m r a";gap:10px;align-items:center;text-align:left;padding:8px 12px;border:1px solid rgba(255,200,61,.48);border-left:3px solid #ffc83d;border-radius:8px;background:linear-gradient(90deg,rgba(255,200,61,.075),rgba(0,255,0,.025));color:#e6f1ea;cursor:pointer;box-sizing:border-box;font-family:Rajdhani,sans-serif;box-shadow:none}',
      '#sw-ripple-escrow-home:hover{border-color:rgba(255,200,61,.76);background:linear-gradient(90deg,rgba(255,200,61,.11),rgba(0,255,0,.04))}',
      '.sw-re-k{grid-area:k;font:900 10px Orbitron,sans-serif;letter-spacing:.11em;color:#ffc83d;white-space:nowrap}',
      '.sw-re-v{grid-area:v;font:900 17px Orbitron,sans-serif;color:#00ff66;white-space:nowrap}',
      '.sw-re-m{grid-area:m;font:700 9px Rajdhani,sans-serif;letter-spacing:.055em;color:#91b89c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.sw-re-r{grid-area:r;font:600 8.5px "Share Tech Mono",monospace;color:#74847e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.sw-re-arrow{grid-area:a;font:300 23px/1 sans-serif;color:#ffc83d;text-align:right}',
      '@media(max-width:620px){#sw-ripple-escrow-home{min-height:68px;grid-template-columns:minmax(0,1fr) auto 13px;grid-template-areas:"k v a" "m r a";column-gap:8px;row-gap:3px;padding:8px 10px}.sw-re-k{font-size:9.5px}.sw-re-v{font-size:16px;text-align:right}.sw-re-m{font-size:8.5px}.sw-re-r{font-size:8px;text-align:right}.sw-re-arrow{font-size:22px;align-self:center}}',
      '@media(max-width:390px){#sw-ripple-escrow-home{grid-template-columns:minmax(0,1fr) auto 12px}.sw-re-k{font-size:9px}.sw-re-v{font-size:14px}.sw-re-m,.sw-re-r{font-size:7.6px}}'
    ].join('');
    document.head.appendChild(st);
  }

  function short(n) { n=Number(n||0); if(n>=1e9)return(n/1e9).toFixed(2)+'B'; if(n>=1e6)return(n/1e6).toFixed(2)+'M'; return Math.floor(n).toLocaleString(); }
  function render() {
    var api=window.SW_ESCROW; if(!api)return;
    var p=typeof api.currentRipplePosition==='function'?api.currentRipplePosition():null;
    var s=typeof api.computeSummary==='function'?api.computeSummary():null;
    var v=document.getElementById('homeRippleEscrowLocked'),m=document.getElementById('homeRippleEscrowMeta'),r=document.getElementById('homeRippleEscrowRecent');
    if(p&&p.complete) v.textContent=short(p.locked_xrp)+' XRP';
    else if(p&&p.status==='PARTIAL') v.textContent='SYNCING '+p.answered_owners+'/'+p.expected_owners;
    else v.textContent='SYNCING…';

    if(p) {
      if(p.complete) m.textContent='LOCKED · '+p.answered_owners+'/'+p.expected_owners+' OWNERS · '+p.active_objects+' OBJECTS';
      else m.textContent='LOCKED · '+p.answered_owners+'/'+p.expected_owners+' OWNERS'+(p.failed_owners?' · RETRYING '+p.failed_owners:'');
    }
    if(s) r.textContent=s.lookbackH+'H · '+s.ripple.unlocks+' RELEASE'+(s.ripple.unlocks===1?'':'S')+' · '+s.ripple.locks+' NEW LOCK'+(s.ripple.locks===1?'':'S');
  }
  window.addEventListener('shadowwatch:ripple-escrow-position', render);
  render();
})();

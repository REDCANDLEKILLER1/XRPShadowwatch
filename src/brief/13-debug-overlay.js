(function(){
  function $one(id){ return document.getElementById(id); }
  function txtOf(id){ var el=$one(id); return el ? (el.textContent||'').trim() : ''; }
  function valOf(id){ var el=$one(id); return el ? String(el.value!=null&&el.value!=='' ? el.value : (el.textContent||'')).trim() : ''; }
  function marketBlock(){
    var out='';
    try {
      out+='report mode: '+(window._SW_REPORT_MODE||'— (run a scan)')+'\n';
      out+='wallets scanned: '+(txtOf('hudChecked')||'—')+' / '+(txtOf('hudTotal')||'—')+
           '   risk: '+(txtOf('hudRiskBadge')||'—')+'\n';
      out+='price: '+(valOf('inPrice')||'—')+'   24h vol: '+(valOf('inVolume')||'—')+'\n';
      out+='native DEX: '+(valOf('inXrpldex')||'—')+'   EVM DEX: '+(valOf('inDexvol')||'—')+
           '   EVM TVL: '+(valOf('inTvl')||'—');
      // RLUSD supply — show both sources + whether they agree.
      var src=(window.state&&window.state.rlusdSupplySources)||null;
      if(src){
        var g=src.gateway, c=src.coingecko;
        var fm=function(v){ return (v==null||v===0)?'—':(v>=1e9?(v/1e9).toFixed(2)+'B':(v/1e6).toFixed(2)+'M'); };
        var agree=(g&&c)?(Math.abs(g-c)/Math.max(g,c)<0.02?'agree':'DIVERGE'):(g||c?'single-source':'both failed');
        out+='\nRLUSD supply: gateway='+fm(g)+'  gecko='+fm(c)+'  ('+agree+')';
      }
      // New funded XRPL accounts per day (XRPScan daily metrics).
      var xd=(window.state&&window.state.xrplDaily)||null;
      if(xd) out+='\nnew XRPL accounts: +'+Number(xd.accounts_created||0).toLocaleString('en-US')+' on '+(xd.date||'—')+'  (xrpscan daily metrics, '+Number(xd.transaction_count||0).toLocaleString('en-US')+' tx that day)';
      else   out+='\nnew XRPL accounts: — (source empty this scan)';
    } catch(e){}
    return out||'No scan yet.';
  }
  function newsBlock(){
    var out='';
    try {
      var badge=txtOf('hudNewsBadge'), cnt=txtOf('hudNewsCount');
      out='headlines: '+(cnt||'0')+'  ·  badge: '+(badge||'—')+'\n';
      var ni=(window.state&&window.state.newsIntel)||null;
      if(ni&&ni.source_status) out+=JSON.stringify(ni.source_status,null,2);
    } catch(e){}
    return out||'No news status yet.';
  }
  function gateBlock(){
    try {
      if(!window.SW_DAILY_GATE) return 'gate not installed yet.';
      var s=window.SW_DAILY_GATE.status();
      return '24h daily block: '+(s.gate_enabled?'ON':'OFF (unlimited reports)')+'\n'+
             'dev unlock: '+(s.unlocked_dev?'ON (multiple reports)':'off')+'\n'+
             'locked: '+(s.locked?'YES':'no')+'   next fresh brief in: '+s.next_unlock_in+'\n'+
             'reports delivered (lifetime): '+s.delivered_count+'\n'+
             'last delivered: '+(s.last_delivered||'never')+'\n'+
             'logged brief size: '+s.stored_report_chars+' chars\n'+
             'archive: '+s.archive_days+' day(s)  ['+s.archive_range+']  ·  on this day: '+s.on_this_day;
    } catch(e){ return 'gate status error: '+e.message; }
  }
  function ymdToday(){ try { return new Date().toISOString().slice(0,10); } catch(_){ return ''; } }
  function fillArch(){
    var list=$one('swArchList'), meta=$one('swArchMeta'), view=$one('swDbgArch');
    if(!list||!window.SW_DAILY_GATE) return;
    var items=[]; try { items=window.SW_DAILY_GATE.archiveList()||[]; } catch(_){}
    var otd=[]; try { otd=window.SW_DAILY_GATE.onThisDay()||[]; } catch(_){}
    if(meta) meta.textContent='· '+items.length+' day(s)'+(otd.length?' · '+otd.length+' on this day in past years':'');
    list.innerHTML='';
    if(!items.length){ if(view) view.textContent='No briefs archived yet. The first clean brief each day is saved here automatically.'; return; }
    var today=ymdToday();
    items.forEach(function(it){
      var chip=document.createElement('span');
      chip.className='arch-chip'+(it.date===today?' today':'');
      chip.setAttribute('data-arch', it.date);
      chip.textContent=it.date+(it.risk!=null?(' · r'+it.risk):'');
      list.appendChild(chip);
    });
    if(view){
      var head='📅 ON THIS DAY\n';
      if(otd.length){ otd.forEach(function(e){ head+='• '+e.date+' (risk '+(e.risk!=null?e.risk:'—')+')\n'; }); }
      else head+='(nothing yet — this fills in as the year comes around)\n';
      view.textContent=head+'\nTap a date above to re-read that day’s brief.';
    }
  }
  function showArchDay(date){
    var view=$one('swDbgArch'); if(!view||!window.SW_DAILY_GATE) return;
    var e=null; try { e=window.SW_DAILY_GATE.archiveGet(date); } catch(_){}
    view._archDate=date;
    view.textContent = e && e.text ? ('📅 '+date+'  ·  '+(e.text.length)+' chars\n'+'─'.repeat(30)+'\n'+e.text) : ('No brief stored for '+date+'.');
  }
  function updateUnlockBtn(){
    var b=$one('swDbgUnlock'); if(!b||!window.SW_DAILY_GATE) return;
    var on=false; try { on=window.SW_DAILY_GATE.status().unlocked_dev; } catch(_){}
    b.textContent = on ? '🔒 RE-LOCK' : '🔓 UNLOCK';
    b.style.color = on ? '#ffcc00' : '';
  }
  function updateGateBtn(){
    var b=$one('swDbgGateToggle'); if(!b||!window.SW_DAILY_GATE) return;
    var on=false; try { on=window.SW_DAILY_GATE.status().gate_enabled; } catch(_){}
    b.textContent = on ? '⏳ BLOCK: ON' : '⏳ BLOCK: OFF';
    b.style.color = on ? '#ffcc00' : '';
  }
  function fill(){
    updateUnlockBtn(); updateGateBtn();
    if($one('swDbgGate')) $one('swDbgGate').textContent = gateBlock();
    if($one('swDbgErr'))  $one('swDbgErr').textContent  = txtOf('errorLog')||'No errors logged.';
    if($one('swDbgFeed')) $one('swDbgFeed').textContent = txtOf('statusFeed')||'No scan feed yet.';
    if($one('swDbgMkt'))  $one('swDbgMkt').textContent  = marketBlock();
    if($one('swDbgNews')) $one('swDbgNews').textContent = newsBlock();
    fillArch();
  }
  function combined(){
    return 'SHADOW WATCH DEBUG LOG\n\n[DAILY BRIEF GATE]\n'+gateBlock()+
           '\n\n[REPORT & MARKET]\n'+marketBlock()+
           '\n\n[ERROR LOG]\n'+(txtOf('errorLog')||'—')+
           '\n\n[SCAN FEED]\n'+(txtOf('statusFeed')||'—')+
           '\n\n[NEWS]\n'+newsBlock();
  }
  // Fetch the candidate funded-account endpoints (direct, then via our own
  // same-origin proxy which can reach allowlisted hosts server-side) and dump
  // the raw responses into a copyable box — so the exact JSON shape can be seen.
  async function probeSources(){
    var out=$one('swDbgProbeBody'); if(out) out.textContent='probing… (this can take a few seconds)';
    // XRPScan is open (no key). /metrics 404s — its metrics are date-based and/or
    // under different paths. Probe the likely candidates so we find the account-count one.
    // /api/v1/metrics/:x returns plain "Not found" (route exists) vs "Cannot GET"
    // (no route) — so metrics takes a NAME, not a date. Probe metric-name candidates.
    var targets=[
      'https://api.xrpscan.com/api/v1/metrics/accounts',
      'https://api.xrpscan.com/api/v1/metrics/account',
      'https://api.xrpscan.com/api/v1/metrics/summary',
      'https://api.xrpscan.com/api/v1/metrics/network',
      'https://api.xrpscan.com/api/v1/metrics/latest',
      'https://api.xrpscan.com/api/v1/server_info',
      'https://api.xrpscan.com/api/v1/network/server_info'
    ];
    var lines=['SOURCE PROBE @ '+new Date().toISOString(), ''];
    for(var i=0;i<targets.length;i++){
      var url=targets[i];
      var got=false;
      try{
        var r=await fetch(url, {headers:{'Accept':'application/json'}});
        var body=await r.text();
        lines.push('GET '+url+'  →  HTTP '+r.status+'  (direct)');
        lines.push(body.slice(0,900));
        got=true;
      }catch(e){
        lines.push('GET '+url+'  →  direct FAILED ('+(e&&e.message||e)+')');
      }
      if(!got){
        try{
          var pu='/api/proxy?url='+encodeURIComponent(url);
          var pr=await fetch(pu);
          var pb=await pr.text();
          lines.push('   via proxy  →  HTTP '+pr.status);
          lines.push(pb.slice(0,900));
        }catch(e2){
          lines.push('   via proxy  →  FAILED ('+(e2&&e2.message||e2)+')');
        }
      }
      lines.push('\n'+'─'.repeat(34)+'\n');
      if(out) out.textContent=lines.join('\n'); // progressive
    }
    if(out) out.textContent=lines.join('\n');
  }

  document.addEventListener('click', function(e){
    var t=e.target; if(!t) return;
    // Archive date chip (no id, carries data-arch).
    var ad = t.getAttribute && t.getAttribute('data-arch');
    if(ad){ showArchDay(ad); return; }
    if(!t.id) return;
    if(t.id==='swDebugFab'){ fill(); var o=$one('swDebugOverlay'); if(o)o.classList.add('open'); }
    else if(t.id==='swDbgClose'){ var o=$one('swDebugOverlay'); if(o)o.classList.remove('open'); }
    else if(t.id==='swDbgRefresh'){ fill(); }
    else if(t.id==='swDbgGateToggle'){
      // Turn the 24h daily block ON/OFF. OFF = unlimited reports (archive still builds).
      try {
        if(window.SW_DAILY_GATE){
          if(window.SW_DAILY_GATE.status().gate_enabled){ window.SW_DAILY_GATE.disable(); }
          else { window.SW_DAILY_GATE.enable(); window.SW_DAILY_GATE.reset(); } // fresh 24h window starts on next brief
        }
      } catch(_){}
      updateGateBtn(); fill();
    }
    else if(t.id==='swDbgUnlock'){
      // One-tap dev unlock/relock from the debug panel — no hidden 9s hold needed.
      try {
        if(window.SW_DAILY_GATE){
          var on=window.SW_DAILY_GATE.status().unlocked_dev;
          if(on){ window.SW_DAILY_GATE.relock(); }
          else  { window.SW_DAILY_GATE.unlock(); window.SW_DAILY_GATE.reset(); } // clear today's lock so a re-scan regenerates fresh
        }
      } catch(_){}
      updateUnlockBtn(); fill();
    }
    else if(t.id==='swDbgArchBtn'){ fillArch(); }
    else if(t.id==='swDbgProbe'){ probeSources(); }
    else if(t.id==='swDbgProbeCopy'){ try{ var pt=(($one('swDbgProbeBody')||{}).textContent)||''; if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(pt); }catch(_){}}
    else if(t.id==='swDbgCopy'){ try{ if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(combined()); }catch(_){}}
    else if(t.id==='swDbgDownload'){
      try{
        if(typeof downloadShadowWatchDebugFile==='function') downloadShadowWatchDebugFile();
        else { var b=new Blob([combined()],{type:'text/plain'}), a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download='shadowwatch_debug.txt'; a.click(); URL.revokeObjectURL(a.href); }
      }catch(_){}
    }
  });
})();

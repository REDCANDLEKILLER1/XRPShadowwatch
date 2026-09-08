(function(){
  'use strict';
  var DAY_MS     = 24*60*60*1000;
  var KEY        = 'SW_DAILY_BRIEF_GATE_V1';   // today's lock
  var ARCH       = 'SW_BRIEF_ARCHIVE_V1';      // all-time archive, keyed by YYYY-MM-DD
  var UNLOCK     = 'SW_DEV_UNLOCK';            // sessionStorage, {until:<ts>}
  var HOLD_MS    = 9000;                        // press-and-hold for dev unlock
  var UNLOCK_TTL = 2*60*60*1000;                // dev unlock auto-expires (can't silently stay on)
  var ARCH_MAX   = 500;                         // cap archived days (~16 months)

  function _now(){ return (new Date()).getTime(); }
  function _ymd(ts){ return new Date(ts).toISOString().slice(0,10); }
  function _log(msg){ try { if(typeof window.log === 'function') window.log('[daily-gate] '+msg); } catch(_){} }

  function loadGate(){ try { return JSON.parse(localStorage.getItem(KEY)||'{}')||{}; } catch(_){ return {}; } }
  function saveGate(g){ try { localStorage.setItem(KEY, JSON.stringify(g)); } catch(_){} }
  function loadArch(){ try { return JSON.parse(localStorage.getItem(ARCH)||'{}')||{}; } catch(_){ return {}; } }
  function saveArch(a){ try { localStorage.setItem(ARCH, JSON.stringify(a)); } catch(_){} }

  // ── Dev unlock (auto-expiring) ─────────────────────────────────
  function devUnlocked(){
    try {
      var raw = sessionStorage.getItem(UNLOCK); if(!raw) return false;
      var u = JSON.parse(raw);
      if (u && u.until && u.until > _now()) return true;
      sessionStorage.removeItem(UNLOCK); refreshBadge(); return false;
    } catch(_){ return false; }
  }
  function setUnlocked(on){
    try {
      if (on) sessionStorage.setItem(UNLOCK, JSON.stringify({ until: _now()+UNLOCK_TTL }));
      else    sessionStorage.removeItem(UNLOCK);
    } catch(_){}
    refreshBadge();
  }
  function refreshBadge(){
    var b = document.getElementById('swDevBadge'); if(!b) return;
    var on=false, left=0;
    try { var u=JSON.parse(sessionStorage.getItem(UNLOCK)||'null'); if(u&&u.until>_now()){ on=true; left=u.until-_now(); } } catch(_){}
    if (on){ b.style.display='block'; b.textContent='🔓 DEV UNLOCK · '+fmtCountdown(left)+' left · tap to lock'; }
    else   { b.style.display='none'; }
  }

  // ── Self-healing helper ────────────────────────────────────────
  function healReport(text){
    var t = String(text || ''), repaired = false, before = t;
    t = t.replace(/\b(?:undefined|NaN)\b/g, '—')
         .replace(/\[object [A-Za-z]+\]/g, '—')
         .replace(/[ \t]+\n/g, '\n')
         .replace(/\n{4,}/g, '\n\n\n');
    if (t !== before) repaired = true;
    if (t.trim().length < 300) return {ok:false, text:t, reason:'empty / too short', repaired:repaired};
    if (/is not defined|ReferenceError|TypeError|SyntaxError/.test(t))
      return {ok:false, text:t, reason:'script error in report', repaired:repaired};
    if (/failed to fetch|fetch failed|upstream fetch failed|proxy error|network error/i.test(t))
      return {ok:false, text:t, reason:'connection dropped', repaired:repaired};
    return {ok:true, text:t, reason:'', repaired:repaired};
  }

  function fmtCountdown(ms){
    if (ms < 0) ms = 0;
    var h = Math.floor(ms/3600000), m = Math.floor((ms%3600000)/60000);
    if (h > 0) return h+'h '+m+'m';
    if (m > 0) return m+'m';
    return 'less than a minute';
  }
  function lockedBanner(g, now){
    var left = fmtCountdown((g.lastDeliveredAt||0)+DAY_MS - now);
    return '⏳ TODAY’S BRIEF IS IN THE BOOKS.\n'+
           'Next fresh Coffee & Crypto brief unlocks in '+left+'.\n'+
           'This is the report XRPMan filed this morning — re-read it anytime.\n'+
           '─'.repeat(44)+'\n';
  }
  function _packFacts(pack){
    var f = {};
    try {
      if (pack){
        var rs = pack.risk_score || {};
        f.risk  = (rs.score!=null ? rs.score : pack.score);
        f.price = pack.price!=null ? pack.price : pack.xrp_price;
      }
    } catch(_){}
    return f;
  }
  function lockState(){
    var g = loadGate(), now = _now();
    return { g:g, now:now, locked: !!(g.report && (now-(g.lastDeliveredAt||0) < DAY_MS)) };
  }

  // ── Master switch ──────────────────────────────────────────────
  // The 24h block can be turned OFF while building (default OFF for now).
  // When OFF, reports are unlimited (no lock) but the daily archive still
  // accumulates, so the "on this day" history keeps building either way.
  var ENABLED_KEY = 'SW_GATE_ENABLED';
  function gateEnabled(){ try { var v=localStorage.getItem(ENABLED_KEY); return v===null ? false : v==='1'; } catch(_){ return false; } }
  function setGateEnabled(on){ try { localStorage.setItem(ENABLED_KEY, on?'1':'0'); } catch(_){} }

  // Archive the FIRST good brief of each date (canonical), independent of the lock.
  function _writeArchive(text, sources, pack){
    try {
      var now=_now(), date=_ymd(now), a=loadArch();
      if (a[date]) return;
      var f=_packFacts(pack);
      a[date]={ date:date, savedAt:now, text:text,
                sources:Array.isArray(sources)?sources.slice(0,20):[], risk:f.risk, price:f.price };
      var keys=Object.keys(a).sort(); while(keys.length>ARCH_MAX){ delete a[keys.shift()]; }
      saveArch(a);
      _log('archived brief for '+date+' (archive holds '+Object.keys(a).length+' days)');
    } catch(_){}
  }

  // ── COMMIT: heal → lock today → write archive. Shared by every
  //    delivery surface so a brief is committed exactly once per day. ──
  function commit(freshText, sources, pack){
    var h = healReport(freshText);
    if (!h.ok){ _log('withheld daily lock — unfit ('+h.reason+')'); return null; }
    var now = _now(), date = _ymd(now), g = loadGate();
    saveGate({ lastDeliveredAt:now, deliveredDate:date, report:h.text,
               sources: Array.isArray(sources)?sources.slice(0,40):[], count:(g.count||0)+1 });
    _writeArchive(h.text, sources, pack);
    _log('brief locked for 24h (delivery #'+((g.count||0)+1)+')');
    return h.text;
  }

  // ── SOURCE GATE — called at the live finalize where the real report
  //    is set on state. Governs BOTH the popup and the full-screen view. ──
  function gateDelivery(freshText, pack){
    try {
      if (devUnlocked()) return healReport(freshText).text;
      // Block OFF: unlimited reports, but keep the daily archive building.
      if (!gateEnabled()) {
        var hd = healReport(freshText);
        if (hd.ok) _writeArchive(hd.text, (pack && pack.report_sources) || null, pack);
        return hd.text;
      }
      var ls = lockState();
      if (ls.locked){ _log('source-gate: locked — using today’s logged brief'); return ls.g.report; }
      var committed = commit(freshText, (pack && pack.report_sources) || null, pack);
      if (committed) return committed;
      if (ls.g.report) return ls.g.report;      // unfit fresh → keep last good
      return healReport(freshText).text;         // nothing better; slot NOT consumed
    } catch(_){ return freshText; }
  }

  // ── Archive access ─────────────────────────────────────────────
  function archList(){
    var a = loadArch();
    return Object.keys(a).sort().reverse().map(function(d){
      var e=a[d]; return { date:d, savedAt:e.savedAt, chars:(e.text||'').length, risk:e.risk, price:e.price };
    });
  }
  function archGet(date){ var a=loadArch(); return a[date]||null; }
  function onThisDay(refTs){
    var now = refTs||_now(), md = _ymd(now).slice(5), today = _ymd(now);
    var a = loadArch(), out = [];
    Object.keys(a).forEach(function(d){ if (d.slice(5)===md && d!==today) out.push(a[d]); });
    return out.sort(function(x,y){ return y.savedAt-x.savedAt; });
  }

  // ── VIEW GATE — read-only. Display surfaces that re-render the brief
  //    (e.g. the full-screen HTML view) call this to get the governed text
  //    WITHOUT committing/locking. Commit happens once, at gateDelivery. ──
  function viewBrief(freshText, pack){
    try {
      if (devUnlocked() || !gateEnabled()) return healReport(freshText).text;
      var ls = lockState();
      if (ls.locked) return ls.g.report;
      return healReport(freshText).text;
    } catch(_){ return freshText; }
  }

  // ── Public API ─────────────────────────────────────────────────
  window.SW_DAILY_GATE = {
    gateDelivery: gateDelivery,
    viewBrief: viewBrief,
    status: function(){
      var ls = lockState(), a = loadArch(), dates = Object.keys(a).sort();
      var enabled = gateEnabled();
      return {
        gate_enabled: enabled,
        unlocked_dev: devUnlocked(),
        locked: enabled && ls.locked && !devUnlocked(),
        delivered_count: ls.g.count || 0,
        last_delivered: ls.g.lastDeliveredAt ? new Date(ls.g.lastDeliveredAt).toISOString() : null,
        next_unlock_in: (enabled && ls.locked) ? fmtCountdown((ls.g.lastDeliveredAt||0)+DAY_MS-ls.now) : 'now',
        stored_report_chars: (ls.g.report||'').length,
        archive_days: dates.length,
        archive_range: dates.length ? (dates[0]+' … '+dates[dates.length-1]) : 'none',
        on_this_day: onThisDay().length
      };
    },
    archiveList: archList,
    archiveGet:  archGet,
    onThisDay:   onThisDay,
    enable:  function(){ setGateEnabled(true);  _log('24h daily block ENABLED'); },
    disable: function(){ setGateEnabled(false); _log('24h daily block DISABLED'); },
    isEnabled: gateEnabled,
    reset:        function(){ try { localStorage.removeItem(KEY); } catch(_){} _log('today’s lock reset'); },
    clearArchive: function(){ try { localStorage.removeItem(ARCH); } catch(_){} _log('archive cleared'); },
    unlock: function(){ setUnlocked(true);  _log('dev unlock ON'); },
    relock: function(){ setUnlocked(false); _log('dev unlock OFF'); }
  };

  // ── Install: wrap the popup surface (secondary gate) ───────────
  function install(){
    var MRF = window.MORNING_REPORT_FLOAT;
    if (!MRF || typeof MRF.show !== 'function') { setTimeout(install, 400); return; }
    if (MRF._dailyGateWrapped) return;
    var _origShow = MRF.show;
    MRF.show = function(reportText, sources, pack){
      try {
        if (devUnlocked() || !gateEnabled()) return _origShow.call(MRF, healReport(reportText).text, sources, pack);
        var ls = lockState();
        if (ls.locked)
          return _origShow.call(MRF, lockedBanner(ls.g, ls.now)+'\n'+ls.g.report, ls.g.sources||sources, pack);
        var committed = commit(reportText, sources, pack);
        if (committed) return _origShow.call(MRF, committed, sources, pack);
        if (ls.g.report)
          return _origShow.call(MRF, lockedBanner(ls.g, ls.now)+'\n'+ls.g.report, ls.g.sources||sources, pack);
        return _origShow.call(MRF, healReport(reportText).text, sources, pack);
      } catch(e){
        try { return _origShow.call(MRF, reportText, sources, pack); } catch(_){}
      }
    };
    MRF._dailyGateWrapped = true;
    _log('installed');
  }
  install();
  try { refreshBadge(); setInterval(refreshBadge, 60000); } catch(_){}

  // ── Hidden dev-unlock hotspot: press-and-hold 9s (bottom-left) ─
  (function(){
    var dot = document.getElementById('swDailyUnlockDot');
    if (!dot) return;
    var timer = null;
    function cancel(){ if (timer){ clearTimeout(timer); timer = null; } dot.classList.remove('holding'); }
    function fire(){
      cancel();
      var on = !devUnlocked();
      setUnlocked(on);
      if (on) { try { window.SW_DAILY_GATE.reset(); } catch(_){} }
      var msg = on ? 'DEV UNLOCK ON — multiple reports for 2h' : 'DEV UNLOCK OFF — daily limit restored';
      try { if (typeof window.showToast === 'function') window.showToast(msg); } catch(_){}
      try { if (typeof window.speakXaiLine === 'function') window.speakXaiLine(msg, {priority:'CMD'}); } catch(_){}
      _log(on ? 'dev unlock engaged via hold' : 'dev unlock released via hold');
    }
    function start(){ cancel(); dot.classList.add('holding'); timer = setTimeout(fire, HOLD_MS); }
    dot.addEventListener('pointerdown', start);
    dot.addEventListener('pointerup', cancel);
    dot.addEventListener('pointerleave', cancel);
    dot.addEventListener('pointercancel', cancel);
    dot.addEventListener('touchstart', function(e){ e.preventDefault(); start(); }, {passive:false});
    dot.addEventListener('touchend', cancel);
    dot.addEventListener('touchcancel', cancel);
  })();

  // Visible dev-unlock badge doubles as a one-tap re-lock.
  (function(){
    var b = document.getElementById('swDevBadge');
    if (b) b.addEventListener('click', function(){ setUnlocked(false);
      try { if (typeof window.showToast === 'function') window.showToast('DEV UNLOCK OFF — daily limit restored'); } catch(_){} });
  })();
})();

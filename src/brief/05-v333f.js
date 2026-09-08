(function() {
  'use strict';
  var V333F_VERSION = 'v3.33f-x-share-fix1';
  var STATE = { lastSummary:null, reportReady:false, modalBuilt:false };

  function _q(sel){ try { return document.querySelector(sel); } catch(_) { return null; } }
  function _byId(id){ return document.getElementById(id); }
  function _clean(s){ return s ? String(s).replace(/\s+/g,' ').replace(/^\s+|\s+$/g,'') : ''; }
  function _today(){
    var d=new Date();
    var m=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return m[d.getMonth()]+' '+d.getDate()+', '+d.getFullYear();
  }
  function _roundRect(ctx,x,y,w,h,r){
    ctx.beginPath();
    ctx.moveTo(x+r,y);
    ctx.arcTo(x+w,y,x+w,y+h,r);
    ctx.arcTo(x+w,y+h,x,y+h,r);
    ctx.arcTo(x,y+h,x,y,r);
    ctx.arcTo(x,y,x+w,y,r);
    ctx.closePath();
  }
  function _wrap(ctx, text, maxWidth){
    var words=String(text).split(/\s+/), lines=[], cur='';
    for(var i=0;i<words.length;i++){
      var test=cur?cur+' '+words[i]:words[i];
      if(ctx.measureText(test).width>maxWidth && cur){ lines.push(cur); cur=words[i]; }
      else { cur=test; }
    }
    if(cur) lines.push(cur);
    return lines;
  }

  function extractReportSummary(){
    var summary={ title:'SHADOWWATCH MORNING BRIEF',
                  date:_today(), bullets:[], headline:null, flagged:null, raw:null };
    var sels=['#morningStoryText','.morning-story','#shadowReport',
              '.shadow-report-body','#reportSummary','[data-shadow-report]',
              '#scanReportBody','.report-body','#publicReport','.public-report'];
    var reportEl=null;
    for(var i=0;i<sels.length;i++){
      var el=_q(sels[i]);
      if(el && _clean(el.textContent).length>20){ reportEl=el; break; }
    }
    if(reportEl){
      summary.raw=_clean(reportEl.textContent).slice(0,2000);
      var liNodes=reportEl.querySelectorAll('li, .report-bullet, [data-bullet]');
      for(var j=0;j<liNodes.length && summary.bullets.length<4;j++){
        var t=_clean(liNodes[j].textContent);
        if(t.length>=10) summary.bullets.push(t.slice(0,140));
      }
    }
    var hdr=_q('#topHeadline')||_q('.top-headline')||_q('[data-top-headline]');
    if(hdr) summary.headline=_clean(hdr.textContent).slice(0,140);
    var flg=_q('#topFlaggedWallet')||_q('.flagged-wallet-line')||_q('[data-flagged-wallet]');
    if(flg) summary.flagged=_clean(flg.textContent).slice(0,140);

    if(!summary.bullets.length && summary.raw){
      var sentences=summary.raw.split(/(?<=[.!?])\s+/).filter(function(s){
        return s.length>20 && s.length<180;
      });
      summary.bullets=sentences.slice(0,3);
    }
    if(!summary.bullets.length){
      summary.bullets=[
        'Run a scan to populate this with today\u2019s evidence.',
        'Wallet activity + news context will fill in here.',
        'Hit SHARE again after the report seals.'
      ];
    }
    STATE.lastSummary=summary;
    return summary;
  }

  function buildXText(summary, opts){
    summary=summary||extractReportSummary();
    opts=opts||{};
    var mode=opts.mode||'long';
    var lines=[];
    lines.push('\uD83D\uDFE2 SHADOWWATCH \u25B8 MORNING BRIEF');
    lines.push(summary.date);
    lines.push('');
    if(summary.headline) lines.push('\u25B8 '+summary.headline);
    if(summary.flagged)  lines.push('\u25B8 '+summary.flagged);
    var added=0;
    for(var i=0;i<summary.bullets.length && added<3;i++){
      var b=summary.bullets[i];
      if(summary.headline && b===summary.headline) continue;
      if(summary.flagged && b===summary.flagged) continue;
      lines.push('\u25B8 '+b); added++;
    }
    lines.push('');
    lines.push('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
    lines.push('@xrpman  \u00B7  #XRPL  #XMEME  #SHADOWWATCH');
    var text=lines.join('\n');
    if(mode==='short' && text.length>280){
      var first=(summary.headline||summary.flagged||summary.bullets[0]||'').slice(0,160);
      var compact='\uD83D\uDFE2 SHADOWWATCH \u25B8 '+summary.date+'\n\n\u25B8 '+first+'\n\n#XRPL #XMEME #SHADOWWATCH';
      if(compact.length>280) compact=compact.slice(0,277)+'\u2026';
      return compact;
    }
    return text;
  }

  function shareToX(text){
    var t=text||buildXText();
    var url='https://twitter.com/intent/tweet?text='+encodeURIComponent(t);
    var w=window.open(url,'_blank','noopener,noreferrer');
    if(!w){
      copyToClipboard(t);
      _toast('POPUP BLOCKED \u2014 TEXT COPIED');
      return false;
    }
    return true;
  }

  function copyToClipboard(text){
    var t=text||buildXText();
    var done=function(ok){ _toast(ok?'COPIED \u2014 PASTE TO X':'COPY FAILED'); };
    if(navigator.clipboard && window.isSecureContext){
      return navigator.clipboard.writeText(t).then(function(){ done(true); })
        .catch(function(){ _fallbackCopy(t,done); });
    }
    return _fallbackCopy(t,done);
  }
  function _fallbackCopy(text,cb){
    try {
      var ta=document.createElement('textarea');
      ta.value=text;
      ta.style.position='fixed'; ta.style.left='-9999px';
      document.body.appendChild(ta); ta.select();
      var ok=document.execCommand('copy');
      document.body.removeChild(ta);
      cb && cb(ok); return ok;
    } catch(e){ cb && cb(false); return false; }
  }

  function generateImageCard(summary){
    summary=summary||extractReportSummary();
    var W=1200, H=675;
    var canvas=_byId('swShareCanvas');
    if(!canvas){
      canvas=document.createElement('canvas');
      canvas.id='swShareCanvas';
      document.body.appendChild(canvas);
    }
    canvas.width=W; canvas.height=H;
    var ctx=canvas.getContext('2d');

    ctx.fillStyle='#01030a';
    ctx.fillRect(0,0,W,H);
    var topGlow=ctx.createRadialGradient(W/2,-60,40,W/2,-60,620);
    topGlow.addColorStop(0,'rgba(0,255,0,0.22)');
    topGlow.addColorStop(0.6,'rgba(0,255,0,0.05)');
    topGlow.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=topGlow; ctx.fillRect(0,0,W,H);
    var goldGlow=ctx.createRadialGradient(W*0.5,H+80,40,W*0.5,H+80,540);
    goldGlow.addColorStop(0,'rgba(255,180,40,0.18)');
    goldGlow.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=goldGlow; ctx.fillRect(0,0,W,H);

    ctx.globalAlpha=0.06;
    ctx.fillStyle='#00ff00';
    for(var y=0;y<H;y+=4){ ctx.fillRect(0,y,W,1); }
    ctx.globalAlpha=1;

    ctx.strokeStyle='rgba(0,255,0,0.45)'; ctx.lineWidth=2;
    _roundRect(ctx,20,20,W-40,H-40,14); ctx.stroke();
    ctx.strokeStyle='rgba(255,180,40,0.30)'; ctx.lineWidth=1;
    _roundRect(ctx,28,28,W-56,H-56,10); ctx.stroke();

    ctx.shadowColor='#ff4040'; ctx.shadowBlur=12;
    ctx.fillStyle='#ff4040';
    ctx.beginPath(); ctx.arc(64,70,6,0,Math.PI*2); ctx.fill();
    ctx.shadowBlur=0;
    ctx.fillStyle='rgba(0,255,0,0.85)';
    ctx.font='700 13px "Courier New", monospace';
    ctx.textBaseline='middle'; ctx.textAlign='left';
    ctx.fillText('XRPMAN AI INTELLIGENCE SYSTEM', 80, 70);

    ctx.textAlign='right';
    ctx.fillStyle='rgba(255,180,40,0.85)';
    ctx.font='700 13px "Courier New", monospace';
    ctx.fillText(summary.date.toUpperCase(), W-60, 70);
    ctx.font='700 11px "Courier New", monospace';
    ctx.fillStyle='rgba(255,180,40,0.65)';
    ctx.fillText('FEED // LIVE', W-60, 92);

    ctx.textAlign='center';
    ctx.shadowColor='#00ff00'; ctx.shadowBlur=14;
    ctx.fillStyle='#00FF00';
    ctx.font='800 22px Inter, "Segoe UI", system-ui, sans-serif';
    ctx.fillText('XRPMAN  PRESENTS', W/2, 142);
    ctx.shadowBlur=0;

    ctx.shadowColor='#ff2a2a'; ctx.shadowBlur=16;
    ctx.fillStyle='#ff2a2a';
    ctx.font='900 italic 36px Inter, "Segoe UI", system-ui, sans-serif';
    ctx.fillText('REDCANDLEKILLER', W/2, 186);
    ctx.shadowBlur=0;

    ctx.shadowColor='#00ff00'; ctx.shadowBlur=22;
    ctx.fillStyle='#00FF00';
    ctx.font='900 76px Inter, "Segoe UI", system-ui, sans-serif';
    ctx.fillText('SHADOWWATCH', W/2, 262);
    ctx.shadowBlur=0;

    var divGrad=ctx.createLinearGradient(140,295,W-140,295);
    divGrad.addColorStop(0,'rgba(0,0,0,0)');
    divGrad.addColorStop(0.25,'rgba(255,180,40,0.6)');
    divGrad.addColorStop(0.5,'rgba(0,255,0,0.85)');
    divGrad.addColorStop(0.75,'rgba(255,180,40,0.6)');
    divGrad.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=divGrad;
    ctx.fillRect(80,300,W-160,2);

    ctx.textAlign='left'; ctx.textBaseline='top';
    ctx.shadowColor='#00ff00'; ctx.shadowBlur=4;
    var bulletY=330;
    var bulletList=[];
    if(summary.headline) bulletList.push(summary.headline);
    if(summary.flagged)  bulletList.push(summary.flagged);
    for(var bi=0;bi<summary.bullets.length;bi++){
      var bb=summary.bullets[bi];
      if(bb!==summary.headline && bb!==summary.flagged) bulletList.push(bb);
      if(bulletList.length>=4) break;
    }
    bulletList=bulletList.slice(0,4);
    var leftPad=90, maxW=W-leftPad-90-30;
    for(var k=0;k<bulletList.length;k++){
      ctx.fillStyle='#00FF00';
      ctx.font='900 22px "Courier New", monospace';
      ctx.fillText('\u25B8', leftPad, bulletY);
      ctx.fillStyle='#cffacd';
      ctx.font='600 21px "Courier New", monospace';
      var wrapped=_wrap(ctx, bulletList[k], maxW);
      var lineY=bulletY;
      for(var w2=0; w2<wrapped.length && w2<2; w2++){
        ctx.fillText(wrapped[w2], leftPad+34, lineY);
        lineY+=30;
      }
      bulletY=lineY+10;
      if(bulletY>560) break;
    }
    ctx.shadowBlur=0;

    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillStyle='rgba(255,180,40,0.85)';
    ctx.font='700 14px "Courier New", monospace';
    ctx.shadowColor='#ffcc44'; ctx.shadowBlur=6;
    ctx.fillText('@xrpman  \u00B7  #XRPL  \u00B7  #XMEME  \u00B7  #SHADOWWATCH', W/2, H-58);
    ctx.shadowBlur=0;
    ctx.fillStyle='rgba(0,255,0,0.5)';
    ctx.font='700 10px "Courier New", monospace';
    ctx.fillText('POWERED BY XM\u03A3M\u03A3', W/2, H-36);

    return canvas;
  }

  function saveImageCard(){
    var canvas=generateImageCard();
    canvas.toBlob(function(blob){
      if(!blob){ _toast('IMAGE BUILD FAILED'); return; }
      var url=URL.createObjectURL(blob);
      var a=document.createElement('a');
      a.href=url;
      var stamp=new Date().toISOString().slice(0,10);
      a.download='shadowwatch_'+stamp+'.png';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function(){ URL.revokeObjectURL(url); }, 6000);
      _toast('IMAGE SAVED \u2014 ATTACH ON X');
    }, 'image/png');
  }

  var _toastTimer=null;
  function _toast(msg){
    var t=_byId('swShareToast');
    if(!t){
      t=document.createElement('div');
      t.id='swShareToast';
      document.body.appendChild(t);
    }
    t.textContent=msg;
    t.classList.add('show');
    if(_toastTimer) clearTimeout(_toastTimer);
    _toastTimer=setTimeout(function(){ t.classList.remove('show'); }, 2400);
  }

  function buildShareModal(){
    if(STATE.modalBuilt) return;
    var modal=document.createElement('div');
    modal.id='swShareModal';
    modal.innerHTML=
      '<div class="swsm-card">' +
        '<div class="swsm-head">' +
          '<div class="swsm-head-left">' +
            '<div class="swsm-head-title">SHARE TO <span style="color:#fff;">X</span></div>' +
            '<div class="swsm-head-sub">SHADOWWATCH \u00B7 BROADCAST READY</div>' +
          '</div>' +
          '<button type="button" class="swsm-close" id="swsmClose" aria-label="Close">\u2715</button>' +
        '</div>' +
        '<div class="swsm-body">' +
          '<div>' +
            '<div class="swsm-section-label">POST PREVIEW \u00B7 EDIT BEFORE SHARING</div>' +
            '<textarea id="swsmText" class="swsm-textarea" spellcheck="false"></textarea>' +
            '<div class="swsm-meta-row">' +
              '<span id="swsmCount">0 chars</span>' +
              '<div class="swsm-tools">' +
                '<button type="button" class="swsm-tool-btn" id="swsmRefresh">\u21BB AUTO-FILL</button>' +
                '<button type="button" class="swsm-tool-btn" id="swsmShort">\u21F2 280-MODE</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="swsm-row">' +
            '<button type="button" class="swsm-btn primary" id="swsmShareBtn">' +
              '<span class="swsm-btn-x">\uD835\uDD4F</span> SHARE TO X' +
            '</button>' +
            '<button type="button" class="swsm-btn" id="swsmCopyBtn">\u270E COPY</button>' +
            '<button type="button" class="swsm-btn" id="swsmImageBtn">\uD83D\uDCF7 SAVE IMAGE</button>' +
          '</div>' +
        '</div>' +
        '<div class="swsm-foot">' +
          'Tip: SAVE IMAGE for a visual post \u00B7 attach the PNG on X manually' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    if(!_byId('swShareCanvas')){
      var c=document.createElement('canvas');
      c.id='swShareCanvas';
      document.body.appendChild(c);
    }

    modal.addEventListener('click', function(e){
      if(e.target===modal) hideShareModal();
    });
    _byId('swsmClose').addEventListener('click', hideShareModal);

    var ta=_byId('swsmText');
    var cnt=_byId('swsmCount');
    function updateCount(){
      var len=ta.value.length;
      cnt.textContent=len+' chars';
      if(len>280) cnt.classList.add('over');
      else cnt.classList.remove('over');
    }
    ta.addEventListener('input', updateCount);

    _byId('swsmRefresh').addEventListener('click', function(){
      ta.value=buildXText(extractReportSummary(),{mode:'long'});
      updateCount();
    });
    _byId('swsmShort').addEventListener('click', function(){
      ta.value=buildXText(STATE.lastSummary||extractReportSummary(),{mode:'short'});
      updateCount();
    });
    _byId('swsmShareBtn').addEventListener('click', function(){
      shareToX(ta.value);
    });
    _byId('swsmCopyBtn').addEventListener('click', function(){
      copyToClipboard(ta.value);
    });
    _byId('swsmImageBtn').addEventListener('click', function(){
      saveImageCard();
    });

    document.addEventListener('keydown', function(e){
      if(e.key==='Escape' && modal.classList.contains('show')) hideShareModal();
    });

    STATE.modalBuilt=true;
  }

  function showShareModal(){
    if(!STATE.modalBuilt) buildShareModal();
    var ta=_byId('swsmText');
    ta.value=buildXText(extractReportSummary(),{mode:'long'});
    var cnt=_byId('swsmCount');
    if(cnt){
      cnt.textContent=ta.value.length+' chars';
      cnt.classList.toggle('over', ta.value.length>280);
    }
    _byId('swShareModal').classList.add('show');
    var pill=_byId('swSharePill');
    if(pill) pill.removeAttribute('data-ready');
    STATE.reportReady=false;
  }
  function hideShareModal(){
    var m=_byId('swShareModal');
    if(m) m.classList.remove('show');
  }

  function buildSharePill(){
    if(_byId('swSharePill')) return;
    var pill=document.createElement('button');
    pill.id='swSharePill';
    pill.type='button';
    pill.setAttribute('aria-label','Share Shadow Watch report to X');
    pill.innerHTML=
      '<span class="swsp-dot"></span>' +
      '<span>SHARE</span>' +
      '<span class="swsp-x">\uD835\uDD4F</span>';
    pill.addEventListener('click', showShareModal);
    document.body.appendChild(pill);
  }

  function bindLifecycle(){
    if(window._v333fBound) return;
    var bus=window.SHADOW_EVENT_BUS;
    if(!bus || typeof bus.on!=='function') return;
    function onReady(){
      STATE.reportReady=true;
      extractReportSummary();
      var pill=_byId('swSharePill');
      if(pill) pill.setAttribute('data-ready','true');
    }
    bus.on('shadow.report.sealed', onReady);
    bus.on('shadow.scan.completed', onReady);
    window._v333fBound=true;
    try { console.log('[SW-v333f] Share lifecycle bound'); } catch(_){}
  }

  function boot(){
    buildSharePill();
    buildShareModal();
    bindLifecycle();
    try { console.log('[SW-v333f] '+V333F_VERSION+' loaded'); } catch(_){}
  }

  function start(){
    var tries=0;
    var iv=setInterval(function(){
      tries++;
      if(document.body){
        boot();
        clearInterval(iv);
      } else if(tries>=20){
        clearInterval(iv);
      }
    }, 200);
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded', function(){
      setTimeout(start, 400);
    });
  } else {
    setTimeout(start, 400);
  }

  window.SW_SHARE={
    version:V333F_VERSION,
    show:showShareModal,
    hide:hideShareModal,
    shareToX:shareToX,
    copy:copyToClipboard,
    saveImage:saveImageCard,
    extract:extractReportSummary,
    buildText:buildXText,
    generateCard:generateImageCard
  };
})();

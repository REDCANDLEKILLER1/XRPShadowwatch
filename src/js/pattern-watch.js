/* Verified daily findings on the live workbench. This does not classify the
   current stream or infer ownership. Only observed transfer routes get edges. */
(function () {
  'use strict';
  var envelope={status:'UNAVAILABLE'}, busy=false, selected='', hosts=[];
  var labels={REPEATED_LIMIT_PRICE:'Repeated price',REPEATED_CONFIRMED_CANCEL:'Order cancellations',REGULAR_TRANSFER_INTERVAL:'Regular transfers'};
  var address=/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
  function el(tag,text,cls){var n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;}
  function details(){var s=envelope.summary;return envelope.status==='AVAILABLE'&&s&&Array.isArray(s.pattern_details)?s.pattern_details.filter(function(d){return labels[d.kind]&&address.test(d.account);}):[];}
  function flagged(a){return !!a&&details().some(function(d){return d.account===a;});}
  function decorate(row,from,to){
    row.dataset.patternFrom=from||'';row.dataset.patternTo=to||'';
    var badge=row.querySelector('.sw-pattern-badge');
    if(flagged(from)||flagged(to)){if(!badge){badge=el('span','PATTERN · earlier analysis','sw-pattern-badge');row.prepend(badge);}}
    else if(badge)badge.remove();
  }
  function link(text,url){var a=el('a',text);a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;}
  function wallet(a){return link(a,'https://livenet.xrpl.org/accounts/'+encodeURIComponent(a));}
  function short(a){return a.slice(0,7)+'…'+a.slice(-4);}
  function graph(rows){
    var routes=rows.filter(function(d){return d.kind==='REGULAR_TRANSFER_INTERVAL'&&address.test(d.to);}).slice(0,6);
    if(!routes.length)return el('p','No observed transfer routes in the displayed findings. Quote and cancellation patterns do not establish wallet connections.');
    var ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
    svg.setAttribute('viewBox','0 0 480 '+(routes.length*55));svg.setAttribute('role','img');svg.setAttribute('aria-label','Observed directed transfer routes; no ownership inference');
    routes.forEach(function(d,i){var y=25+i*55;
      var line=document.createElementNS(ns,'path');line.setAttribute('d','M 110 '+y+' H 365 l -8 -5 m 8 5 l -8 5');line.setAttribute('stroke','#63d4d9');line.setAttribute('fill','none');svg.appendChild(line);
      [[90,d.account],[390,d.to]].forEach(function(pair){var c=document.createElementNS(ns,'circle');c.setAttribute('cx',pair[0]);c.setAttribute('cy',y);c.setAttribute('r','6');c.setAttribute('fill',pair[0]===90?'#ffd76a':'#63d4d9');svg.appendChild(c);
        var t=document.createElementNS(ns,'text');t.setAttribute('x',pair[0]);t.setAttribute('y',y+20);t.setAttribute('text-anchor','middle');t.textContent=short(pair[1]);svg.appendChild(t);});
      var t=document.createElementNS(ns,'text');t.setAttribute('x','240');t.setAttribute('y',y-5);t.setAttribute('text-anchor','middle');t.textContent=d.count+' transfers · ~'+d.interval_seconds+'s';svg.appendChild(t);
    });return svg;
  }
  function render(){
    document.querySelectorAll('#feed [data-pattern-from]').forEach(function(row){decorate(row,row.dataset.patternFrom,row.dataset.patternTo);});
    hosts.forEach(function(h){var body=h.body,s=envelope.summary;body.replaceChildren();
      h.status.textContent=busy?'Checking…':envelope.status==='AVAILABLE'?'Daily evidence':envelope.status==='STALE'?'Older evidence':'Unavailable';
      h.refresh.disabled=busy;
      if(envelope.status!=='AVAILABLE'||!s){body.appendChild(el('p',window.SW_MARKET_WATCH.render(envelope),'sw-pattern-summary'));return;}
      var stamp=function(t){return new Date(t).toLocaleString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});};
      body.appendChild(el('p',stamp(s.window_start)+' – '+stamp(s.window_end),'sw-pattern-note'));
      var totals=el('div',null,'sw-pattern-totals');
      totals.appendChild(el('div','XRP → RLUSD: '+s.xrp_sold_for_rlusd+' XRP'));
      totals.appendChild(el('div','RLUSD → XRP: '+s.xrp_bought_with_rlusd+' XRP'));
      if(s.classified_records>0)body.appendChild(totals);else body.appendChild(el('p','No classified records in this window; trading activity is unknown.'));
      if(s.unclassified_records>0)body.appendChild(el('p',s.unclassified_records+' records could not be classified.','sw-pattern-note'));
      body.appendChild(el('p','Observed wallet flows, not total market volume. Daily analysis; separate from the live stream.','sw-pattern-note'));
      body.appendChild(el('p',s.regular_transfer_wallets+' regular-transfer wallets · '+s.repeated_quote_wallets+' repeated-price wallets · '+s.repeated_cancel_wallets+' cancellation wallets'));
      body.appendChild(el('p','Flags are leads, not proof of bots or price control.','sw-pattern-note'));
      var rows=details();
      if(!Array.isArray(s.pattern_details)){body.appendChild(el('p','Wallet details are awaiting the next forensic analysis. The verified totals above remain available.'));return;}
      var select=el('select');select.setAttribute('aria-label','Filter '+h.mode+' patterns');
      [['','All patterns']].concat(Object.keys(labels).map(function(k){return[k,labels[k]];})).forEach(function(p){var o=el('option',p[1]);o.value=p[0];select.appendChild(o);});
      select.value=selected;select.onchange=function(){selected=select.value;render();};body.appendChild(select);
      var shown=rows.filter(function(d){return !selected||d.kind===selected;});
      body.appendChild(el('p',rows.length+' of '+s.pattern_details_total+' findings shown; up to 3 sample transactions per finding.'));
      if(!shown.length)body.appendChild(el('p','No findings for this filter in the displayed sample.'));
      if(h.mode==='graph'){body.appendChild(graph(shown));if(shown.filter(function(d){return d.kind==='REGULAR_TRANSFER_INTERVAL';}).length>6)body.appendChild(el('p','Diagram shows the first six transfer findings; the list below contains the displayed sample.'));}
      var list=el('div',null,h.mode==='map'?'sw-pattern-wallets':'sw-pattern-list');
      shown.forEach(function(d){var card=el('article',null,'sw-pattern-card');card.appendChild(el('strong',labels[d.kind]+' · '+d.count+' events'));card.appendChild(wallet(d.account));
        if(d.to&&address.test(d.to)){card.appendChild(el('span','Observed recipient · approximately '+d.interval_seconds+' seconds between transfers'));card.appendChild(wallet(d.to));}
        if(d.price_key){var ratio=d.price_key.match(/:(\d+)\/(\d+)$/);if(ratio&&Number(ratio[2])>0){var price=Number(ratio[1])/Number(ratio[2]);if(Number.isFinite(price))card.appendChild(el('span',(d.price_key.indexOf('SELL_XRP:')===0?'Sell':'Buy')+' limit quote: approximately '+price.toPrecision(6)+' RLUSD per XRP. An order quote is not a confirmed fill.'));}}
        var refs=el('div',null,'sw-pattern-refs');(d.hashes||[]).filter(function(hash){return /^[a-fA-F0-9]{64}$/.test(hash);}).forEach(function(hash,i){refs.appendChild(link('Transaction '+(i+1),'https://livenet.xrpl.org/transactions/'+hash));});card.appendChild(refs);
        var trace=el('button','Trace wallet in GRAPH');trace.type='button';trace.onclick=function(){if(typeof traceWallet==='function')traceWallet(d.account);};card.appendChild(trace);list.appendChild(card);
      });body.appendChild(list);
      body.appendChild(el('p',h.mode==='map'?'Wallet cards group observed findings, not geographic locations. Gold rings on live bubbles identify wallets with earlier findings.':h.mode==='graph'?'Arrows above are observed transfer routes only. Gold rings in the main graph mark wallets with earlier findings.':'Gold PATTERN badges mark live transactions involving a wallet flagged in this analysis.'));
      var provenance=el('details');provenance.appendChild(el('summary','Evidence reference'));provenance.appendChild(el('p','Summary SHA-256: '+s.sha256));body.appendChild(provenance);
    });
  }
  async function refresh(){if(busy||!window.SW_MARKET_WATCH)return;busy=true;render();envelope=await window.SW_MARKET_WATCH.load();busy=false;render();}
  ['live','map','graph'].forEach(function(mode){var panel=document.getElementById('view-'+mode);if(!panel)return;
    var box=el('details',null,'sw-pattern-watch sw-pattern-'+mode);box.id='pattern-watch-'+mode;
    var heading=el('summary','Pattern watch · '),status=el('span','Loading');heading.appendChild(status);box.appendChild(heading);
    var refreshButton=el('button','Refresh analysis');refreshButton.type='button';refreshButton.onclick=refresh;
    var body=el('div',null,'sw-pattern-body');box.appendChild(refreshButton);box.appendChild(body);
    if(mode==='live')panel.insertBefore(box,document.getElementById('filter-zone'));else panel.appendChild(box);
    hosts.push({mode:mode,body:body,status:status,refresh:refreshButton});
  });
  window.SW_PATTERN_WATCH={refresh:refresh,hasWallet:flagged,decorateTransaction:decorate};
  document.addEventListener('visibilitychange',function(){if(!document.hidden)refresh();});
  setInterval(function(){if(!document.hidden)refresh();},300000);refresh();
})();

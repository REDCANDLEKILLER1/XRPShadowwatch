(function(){
'use strict';
var PIPE_VERSION = 'PUBLIC_REPORT_PIPELINE_V1';

/* ─────────────────────────────────────────────────────────────────────
   KILL SWITCH
   Set window.SW_PIPELINE_V1_KILL = true before load to disable V1
   and route through legacy chain. Default: V1 enabled.
   ───────────────────────────────────────────────────────────────────── */
function _isEnabled(){ return window.SW_PIPELINE_V1_KILL !== true; }

/* ─────────────────────────────────────────────────────────────────────
   UTILITIES
   ───────────────────────────────────────────────────────────────────── */
function _safe(fn, fallback){
  try{ return fn(); } catch(e){ return fallback; }
}
function _str(v){ return (v == null) ? '' : String(v); }
function _num(v){ var n=parseFloat(v); return isNaN(n)?0:n; }
function _arr(v){ return Array.isArray(v)?v:[]; }
function _xrpFmt(n){
  var a=Math.abs(n);
  if(a>=1e9) return (n/1e9).toFixed(2).replace(/\.00$/,'')+'B';
  if(a>=1e6) return (n/1e6).toFixed(2).replace(/\.00$/,'')+'M';
  if(a>=1e3) return (n/1e3).toFixed(1).replace(/\.0$/,'')+'K';
  return String(Math.round(n));
}
function _trunc(addr){
  if(!addr||addr.length<12) return addr||'unknown';
  return addr.slice(0,6)+'\u2026'+addr.slice(-4);
}
function _today(){
  var d=new Date();
  return d.toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
}

/* ─────────────────────────────────────────────────────────────────────
   LABEL REGISTRY — provenance-checked wallet naming
   Source of truth: richlist seed + operator-reviewed labels in pack
   ───────────────────────────────────────────────────────────────────── */
var _labelCache = {};
function _getLabel(address, pack){
  if(!address) return null;
  if(_labelCache[address]) return _labelCache[address];
  // Check operator-reviewed labels first
  var opLabels = _safe(function(){
    return pack && (pack.operator_labels || pack.label_registry || pack.knownWallets || []);
  }, []);
  if(Array.isArray(opLabels)){
    for(var i=0;i<opLabels.length;i++){
      var e=opLabels[i];
      var a=e&&(e.address||e.addr||e.a||'');
      if(a===address && (e.label||e.name)){
        var entry={
          name: e.label||e.name,
          provenance: 'operator_reviewed',
          id: e.id||e.address||address
        };
        _labelCache[address]=entry;
        return entry;
      }
    }
  }
  // ── SHARED IDENTITY REGISTRY — a real-world name, where one is established ──
  // This is the only source that may NAME an entity. Everything else stays
  // behavioural.
  var ident = _safe(function(){
    var R = (typeof window!=='undefined') && window.SW_WALLET_IDENTITIES;
    return (R && R[address]) || null;
  }, null);
  if(ident && ident.name){
    var ie={
      name: ident.name,
      // The registry is operator-curated and committed to source, so it is
      // legitimate provenance for assertLabelProvenance. Confidence is carried
      // through rather than flattened, so a CONFIRMED and a PUBLIC_SOURCE claim
      // remain distinguishable downstream.
      provenance: 'operator_reviewed',
      confidence: ident.confidence || 'PUBLIC_SOURCE',
      entityType: ident.type || null,
      identified: true,
      id: address
    };
    _labelCache[address]=ie;
    return ie;
  }

  // ── WATCHED-BUT-NOT-IDENTIFIED — a behavioural handle, never a name ──
  // The previous code looked for window.KNOWN, which does not exist: KNOWN is
  // declared `const` at classic-script top level (02-core.js), which creates a
  // LEXICAL global, not a window property. It then ran Array.isArray() against
  // it, and KNOWN is an object keyed by address, not an array. Two independent
  // reasons this branch could never return anything — which is why every report
  // ever published said "an unidentified wallet" for wallets the app had
  // labelled, and why allRefs in assertLabelProvenance was always empty.
  var watched = _safe(function(){
    if(typeof KNOWN!=='undefined' && KNOWN && KNOWN[address]) return KNOWN[address];
    if(typeof window!=='undefined' && window.KNOWN && window.KNOWN[address]) return window.KNOWN[address];
    return null;
  }, null);
  if(watched && (watched.label||watched.cat)){
    var we={
      // Deliberately NOT the raw handle: "SPLITTER_rDsbeo" is an internal
      // identifier, not something a reader should see, and printing it would
      // imply an identity we do not have.
      name: null,
      handle: watched.label || null,
      cat: watched.cat || null,
      provenance: 'behavioral_watchlist',
      identified: false,
      id: address
    };
    _labelCache[address]=we;
    return we;
  }
  return null;
}
// How a wallet should be DESCRIBED when we have no identity for it. Being on the
// watch list is itself information — "a watched routing wallet" is both honest
// and more use to a reader than "an unidentified wallet".
var _CAT_PHRASE = {
  exchange:                   'an exchange wallet',
  escrow:                     'a Ripple escrow wallet',
  whale:                      'a watched whale wallet',
  next_hop_splitter:          'a watched routing wallet',
  discovered_whale:           'a tracked whale wallet',
  discovered_receiver:        'a tracked receiving wallet',
  discovered_unknown_highval: 'a tracked high-value wallet'
};
function _entityName(address, pack, fallback){
  var lbl=_getLabel(address,pack);
  // 1. a real, sourced identity — name it
  if(lbl && lbl.name) return { name: lbl.name, provenance: lbl.provenance,
                               confidence: lbl.confidence, identified: true, id: lbl.id };
  // 2. watched but not identified — describe what it is, do not name it
  if(lbl && lbl.identified === false){
    var phrase = _CAT_PHRASE[lbl.cat];
    if(phrase) return { name: phrase, provenance: 'behavioral_watchlist',
                        identified: false, id: lbl.id };
  }
  // 3. genuinely unknown
  return { name: fallback||'an unidentified wallet', provenance: null, identified: false, id: null };
}
function _plain(name, provenance){
  // Convert internal labels to plain English where provenance allows
  if(!name) return 'an unidentified wallet';
  var n=name.toLowerCase();
  if(n.includes('bithumb'))   return 'Bithumb';
  if(n.includes('binance'))   return 'Binance';
  if(n.includes('coinbase'))  return 'Coinbase';
  if(n.includes('kraken'))    return 'Kraken';
  if(n.includes('upbit'))     return 'Upbit';
  if(n.includes('crypto.com')||n.includes('crypto_com')) return 'Crypto.com';
  if(n.includes('bitstamp'))  return 'Bitstamp';
  if(n.includes('bitso'))     return 'Bitso';
  if(n.includes('sbi'))       return 'SBI VC Trade';
  // v16.17: this used to return 'Ripple Labs'. That is an UPGRADE, not a
  // normalisation — the registry sources the name "Ripple", and rewriting it as
  // the company asserts corporate ownership nobody sourced. It also broke the
  // report outright: assertLabelProvenance then went looking for provenance for
  // "Ripple Labs", the source ref said "Ripple", the two could never match, and
  // the whole public narrative was discarded in favour of the KGMT fallback
  // (SW-20260813-FVZAO). Two registry wallets named "Ripple" went onto the scan
  // list the day before; the first time one of them moved 50M XRP, the report
  // blanked itself.
  //
  // A sourced name passes through as it was sourced. An internal handle
  // (RIPPLE_1.3B, RIPPLE_ESCROW_*) is a description of what the wallet does and
  // must never become a company either — it gets the neutral phrase.
  if(n.includes('ripple')&&!n.includes('xrpl')){
    return /^ripple$/i.test(String(name).trim()) ? 'Ripple' : 'a Ripple escrow wallet';
  }
  if(n.includes('exchange')||n.includes('hot')) return 'an exchange wallet';
  if(n.includes('whale'))     return 'a large XRP holder';
  if(n.includes('escrow'))    return 'an escrow wallet';
  if(n.includes('bridge')||n.includes('peg')) return 'a bridge reserve';
  return name; // fallback: use label as given if no mapping
}

/* ─────────────────────────────────────────────────────────────────────
   BLANK INTERPRETATION CONTRACT — returned when has_signal = false
   ───────────────────────────────────────────────────────────────────── */
function _blank(){
  return{
    headline:'',summary:'',significance:'NOISE',confidence:'LOW',
    evidence_level:'NONE',source_refs:[],uncertainty:'',
    narrative_weight:0,has_signal:false
  };
}
function _contract(fields){
  var b=_blank();
  var out={};
  var keys=['headline','summary','significance','confidence','evidence_level',
            'source_refs','uncertainty','narrative_weight','has_signal'];
  for(var i=0;i<keys.length;i++){
    var k=keys[i];
    out[k]=(fields[k]!==undefined)?fields[k]:b[k];
  }
  out.has_signal=!!(out.headline && out.summary);
  return out;
}

/* ─────────────────────────────────────────────────────────────────────
   XRP NEWS FILTER (from v333h — XRP-only allowlist/denylist)
   ───────────────────────────────────────────────────────────────────── */
var _XRP_ALLOW=['xrp','ripple','xrpl','rlusd','clarity act','ripple labs',
  'xrp ledger','brad garlinghouse','david schwartz','flare network',
  'songbird','sologenic','xahau'];
var _XRP_DENY=['bitcoin','ethereum','solana','zcash','cardano','dogecoin',
  'shiba','avalanche','polkadot','litecoin','monero','chainlink','tron',
  'polygon','arbitrum','cosmos','saylor','irgc',' btc ',' eth ',' sol ',
  'bnb chain','matic'];
function _isXrpNews(title,url){
  var h=(title||'').toLowerCase()+' '+(url||'').toLowerCase();
  var allow=_XRP_ALLOW.some(function(k){return h.indexOf(k)>-1;});
  if(!allow) return false;
  var deny=_XRP_DENY.some(function(k){return h.indexOf(k)>-1;});
  return !deny;
}

/* ═════════════════════════════════════════════════════════════════════
   L2 INTERPRETATION HELPERS — SIX LOCKED
   Each returns the Interpretation Contract (§2.1).
   ═════════════════════════════════════════════════════════════════════ */

/* Helper 1 — summarizeLargeMoves */
function summarizeLargeMoves(pack){
  return _safe(function(){
    var txs=_arr(pack&&pack.large_transfers);
    if(!txs.length) return _blank();
    // Sort by amount descending, take top 3
    var sorted=txs.slice().sort(function(a,b){
      return _num(b.amount)-_num(a.amount);
    }).slice(0,3);
    var top=sorted[0];
    if(!top||!_num(top.amount)) return _blank();
    var amt=_xrpFmt(_num(top.amount));
    var senderInfo=_entityName(top.from||top.sender,pack,'a large private holder');
    var recvInfo=_entityName(top.to||top.receiver,pack,'an unidentified wallet');
    var senderName=_plain(senderInfo.name, senderInfo.provenance);
    var recvName=_plain(recvInfo.name, recvInfo.provenance);
    var headline=amt+' XRP moved from '+senderName+' to '+recvName+' overnight.';
    var parts=[headline];
    if(sorted.length>1){
      var t2=sorted[1];
      var a2=_xrpFmt(_num(t2.amount));
      var r2Info=_entityName(t2.to||t2.receiver,pack,'an unidentified wallet');
      parts.push('A second transfer of '+a2+' XRP reached '+_plain(r2Info.name,r2Info.provenance)+'.');
    }
    var refs=[];
    sorted.forEach(function(tx){
      var hash=tx.hash||tx.tx_hash||tx.id;
      if(hash) refs.push({
        kind:'ledger_tx',id:hash,url:null,
        label:_xrpFmt(_num(tx.amount))+' XRP transfer',
        provenance:'ledger_native'
      });
      // Add label registry refs for named wallets
      [tx.from||tx.sender, tx.to||tx.receiver].forEach(function(addr){
        var lbl=_getLabel(addr,pack);
        // Only an IDENTITY counts as a label reference. A behavioural watchlist
        // entry has name:null and must not inflate evidence_level, nor appear as
        // provenance for naming an entity.
        if(lbl && lbl.name) refs.push({
          kind:'label_registry',id:lbl.id,url:null,
          label:lbl.name,provenance:lbl.provenance
        });
      });
    });
    var evLevel=refs.length>=2?'HIGH':refs.length===1?'MEDIUM':'LOW';
    return _contract({
      headline:headline,
      summary:parts.join(' '),
      significance:_num(top.amount)>=5e6?'CRITICAL':_num(top.amount)>=1e6?'HIGH':'MEDIUM',
      confidence:'HIGH',
      evidence_level:evLevel,
      source_refs:refs,
      uncertainty:'Behavioral evidence only — not ownership proof. Transfer routing, not intent, is observable.',
      narrative_weight:0.90
    });
  }, _blank());
}

/* Helper 2 — summarizeDominanceShift */
function summarizeDominanceShift(pack){
  return _safe(function(){
    var dom=pack&&(pack.holder_dominance||pack.dominance);
    var cluster=pack&&pack.cluster_intel;
    var delta=pack&&pack.balance_delta;
    if(delta==null && !dom && !cluster) return _blank();
    var parts=[];
    var weight=0.4;
    if(delta!=null && Math.abs(_num(delta))>0){
      var d=_num(delta);
      var dir=d>0?'added':'shed';
      parts.push('Watched wallets '+dir+' '+_xrpFmt(Math.abs(d))+' XRP net across this scan.');
      weight=0.6;
    }
    if(dom&&_num(dom.top10_pct)>0){
      parts.push('Top-tier wallets hold an estimated '+_num(dom.top10_pct).toFixed(1)+'% of tracked supply.');
      weight=Math.max(weight,0.55);
    }
    if(cluster&&cluster.coordinated_count>0){
      parts.push('A cluster of '+cluster.coordinated_count+' wallets showed coordinated timing behavior — movement consistent with managed routing.');
      weight=Math.max(weight,0.65);
    }
    if(!parts.length) return _blank();
    return _contract({
      headline:parts[0],
      summary:parts.join(' '),
      significance:weight>=0.65?'HIGH':'MEDIUM',
      confidence:'MEDIUM',
      evidence_level:'MEDIUM',
      source_refs:[],
      uncertainty:'Supply positioning is observable. Intent is not. Coordinated timing is a behavioral pattern, not confirmed coordination.',
      narrative_weight:weight
    });
  }, _blank());
}

/* Helper 3 — summarizeNewsImpact */
function summarizeNewsImpact(pack){
  return _safe(function(){
    var items=[];
    var ni=pack&&pack.news_intel;
    if(ni){
      [ni.items,ni.top_headlines,ni.matched_articles].forEach(function(a){
        if(Array.isArray(a)) items=items.concat(a);
      });
    }
    var eln=pack&&pack.evidence_led_news;
    if(eln){
      [eln.ranked_context,eln.matched,eln.items].forEach(function(a){
        if(Array.isArray(a)) items=items.concat(a);
      });
    }
    // XRP-only filter, dedup, top 3
    var seen={};
    var xrp=[];
    items.forEach(function(it){
      if(!it||!it.title) return;
      var key=it.title.toLowerCase().slice(0,70);
      if(seen[key]) return;
      seen[key]=true;
      if(_isXrpNews(it.title,it.url||'')) xrp.push(it);
    });
    xrp=xrp.slice(0,3);
    if(!xrp.length) return _blank();
    var lead=xrp[0];
    var refs=xrp.map(function(it){
      return{kind:'news_article',id:it.id||it.url||it.title.slice(0,40),
             url:it.url||it.link||null,label:it.title.slice(0,80),
             provenance:'news_router'};
    });
    var titles=xrp.map(function(it){return it.title;});
    var summary='Ledger-matched context: '+titles.join(' \u00B7 ')+'.';
    if(titles.length===1) summary='Relevant headline: '+titles[0]+'.';
    return _contract({
      headline:lead.title.slice(0,110),
      summary:summary,
      significance:'MEDIUM',
      confidence:'MEDIUM',
      evidence_level:'MEDIUM',
      source_refs:refs,
      uncertainty:'Headlines provide context only. News corroborates ledger evidence — it does not cause or prove ledger movement.',
      narrative_weight:0.50
    });
  }, _blank());
}

/* Helper 4 — summarizeReceiverFollowthrough */
function summarizeReceiverFollowthrough(pack){
  return _safe(function(){
    var rf=pack&&pack.receiver_followthrough;
    if(!rf) return _blank();
    var parts=[];
    var weight=0.45;
    var held=rf.holding_receiver||rf.holdingReceiver;
    var fwd=rf.forwarding_receiver||rf.forwardingReceiver;
    var split=rf.split_receiver||rf.splitReceiver;
    if(fwd){
      var fwdInfo=_entityName(fwd.address,pack,'a wallet');
      parts.push('The largest receiver forwarded funds onward — behavior consistent with routing, not holding.');
      weight=0.70;
    } else if(held){
      var heldInfo=_entityName(held.address,pack,'a wallet');
      parts.push('The primary receiving wallet held position after the inflow. No large outward transfer detected yet.');
      weight=0.65;
    } else if(split){
      parts.push('Received funds were split across multiple wallets after arrival — consistent with distribution or custody management.');
      weight=0.60;
    }
    if(!parts.length && rf.total_followthrough_count>0){
      parts.push(rf.total_followthrough_count+' receiving wallets showed detectable follow-through behavior after inflows.');
      weight=0.50;
    }
    if(!parts.length) return _blank();
    var refs=[];
    [held,fwd,split].forEach(function(r){
      if(!r||!r.address) return;
      var lbl=_getLabel(r.address,pack);
      if(lbl && lbl.name) refs.push({kind:'label_registry',id:lbl.id,url:null,
                          label:lbl.name,provenance:lbl.provenance});
    });
    return _contract({
      headline:parts[0],
      summary:parts.join(' '),
      significance:weight>=0.65?'HIGH':'MEDIUM',
      confidence:'MEDIUM',
      evidence_level:refs.length?'MEDIUM':'LOW',
      source_refs:refs,
      uncertainty:'Receiver behavior is observable on-ledger. Intent — whether this is accumulation, custody, or routing — is not confirmed.',
      narrative_weight:weight
    });
  }, _blank());
}

/* Helper 5 — summarizeBandBehavior */
function summarizeBandBehavior(pack){
  return _safe(function(){
    var market=pack&&pack.market;
    var mem=pack&&(pack.forensic_memory||pack.pattern_memory);
    if(!market) return _blank();
    var price=_num(market.price||market.xrp_price);
    var pct=_num(market.pct24h||market.change_24h||0);
    if(!price) return _blank();
    var LOW_BAND=1.28, HIGH_BAND=1.55;
    var inBand=(price>=LOW_BAND && price<=HIGH_BAND);
    var bandDays=_safe(function(){
      return mem&&(mem.band_hold_days||mem.corridor_days)||null;
    },null);
    var parts=[];
    var weight=0.55;
    var dir=pct>1?'up':pct<-1?'down':'flat';
    parts.push('XRP is '+dir+' near $'+price.toFixed(4)+
               (pct!==0?' ('+( pct>=0?'+':'')+pct.toFixed(2)+'% in 24 hours)':'')+
               '.');
    if(inBand){
      var bandNote='The price has held inside a tight corridor — between roughly $'+
                   LOW_BAND+' and $'+HIGH_BAND+' — for';
      if(bandDays&&bandDays>7){
        bandNote+=' approximately '+bandDays+' days.';
        weight=0.80;
      } else {
        bandNote+=' an extended period.';
        weight=0.70;
      }
      parts.push(bandNote);
      parts.push('That kind of price stability in a speculative asset is not normal without external pressure or managed absorption.');
    }
    return _contract({
      headline:'XRP $'+price.toFixed(4)+' — '+(inBand?'holding the corridor.':'outside recent band.'),
      summary:parts.join(' '),
      significance:inBand&&weight>=0.75?'HIGH':'MEDIUM',
      confidence:inBand?'HIGH':'MEDIUM',
      evidence_level:'MEDIUM',
      source_refs:[],
      uncertainty:'Price behavior is observable. Causation — whether the corridor is managed or organic — is behavioral inference, not confirmed.',
      narrative_weight:weight
    });
  }, _blank());
}

/* Helper 6 — summarizeAbsorberActivity */
function summarizeAbsorberActivity(pack){
  return _safe(function(){
    var txs=_arr(pack&&pack.large_transfers);
    var rf=pack&&pack.receiver_followthrough;
    var pm=pack&&(pack.pattern_memory||pack.forensic_memory);
    // Find exchange-adjacent absorbers: received large and held
    var absorbers=[];
    txs.forEach(function(tx){
      var addr=tx.to||tx.receiver;
      if(!addr) return;
      var lbl=_getLabel(addr,pack);
      var cat=lbl&&lbl.name?lbl.name.toLowerCase():'';
      var isExchange=cat.includes('exchange')||cat.includes('hot')||
                     cat.includes('bithumb')||cat.includes('coinbase')||
                     cat.includes('binance')||cat.includes('kraken')||
                     cat.includes('upbit')||cat.includes('bitstamp')||
                     cat.includes('bitso')||cat.includes('crypto');
      if(isExchange){
        absorbers.push({
          address:addr,
          amount:_num(tx.amount),
          label:lbl,
          name:_plain(lbl&&lbl.name||'an exchange wallet',lbl&&lbl.provenance||null)
        });
      }
    });
    // Also check repeat absorbers from pattern memory
    var repeatNote='';
    if(pm&&pm.repeat_absorbers&&pm.repeat_absorbers.length){
      var ra=pm.repeat_absorbers[0];
      var raInfo=_entityName(ra.address,pack,'an exchange');
      repeatNote=' '+_plain(raInfo.name,raInfo.provenance)+' has appeared as an absorber in multiple recent scans.';
    }
    if(!absorbers.length && !repeatNote) return _blank();
    var refs=[];
    absorbers.forEach(function(ab){
      if(ab.label) refs.push({
        kind:'label_registry',id:ab.label.id||ab.address,url:null,
        label:ab.name,provenance:ab.label.provenance||'richlist_seed'
      });
    });
    var totalAmt=absorbers.reduce(function(s,a){return s+a.amount;},0);
    // v16.18: this was a bare slice(0,2).join(' and '), so two Binance wallets
    // absorbing supply printed "Binance and Binance absorbed 20.99M XRP this
    // scan." — which reads as a mistake and hides the actual finding, that ONE
    // exchange took it across two wallets. 02-core already solves this:
    // _swWhoList collapses repeats into "Binance ×2" and caps the list. Reuse it
    // rather than keeping a second, worse version here.
    var names;
    if(typeof _swWhoList==='function'){
      names=_safe(function(){ return _swWhoList(absorbers.map(function(a){return a.address;}),{max:2}); }, null);
    }
    if(!names||!names.length){
      // fallback: collapse by name the same way, without the address lookup
      var seen={},ord=[];
      absorbers.forEach(function(a){ if(seen[a.name]==null){seen[a.name]=0;ord.push(a.name);} seen[a.name]++; });
      names=ord.slice(0,2).map(function(nm){ return seen[nm]>1?nm+' ×'+seen[nm]:nm; });
    }
    var headline=absorbers.length?
      names.join(' and ')+' absorbed '+_xrpFmt(totalAmt)+' XRP this scan.' :
      'Repeat exchange absorber activity detected across scans.';
    var summary=headline+(repeatNote||'');
    return _contract({
      headline:headline,
      summary:summary,
      significance:totalAmt>=5e6?'CRITICAL':totalAmt>=1e6?'HIGH':'MEDIUM',
      confidence:refs.length?'HIGH':'MEDIUM',
      evidence_level:refs.length>=1?'HIGH':'LOW',
      source_refs:refs,
      uncertainty:'Exchange-adjacent wallets absorbed supply. Whether this is proprietary accumulation, custody movement, or user deposits is not confirmed from ledger data alone.',
      narrative_weight:absorbers.length>=2?0.85:0.65
    });
  }, _blank());
}

/* ═════════════════════════════════════════════════════════════════════
   L3 PUBLIC NARRATIVE ENGINE
   Single entry: assemblePublicReport(pack) → { text, interpretations }
   ═════════════════════════════════════════════════════════════════════ */

var LOCKED_SECTIONS=[
  'EXECUTIVE SUMMARY','WHAT MATTERED MOST','EVIDENCE',
  'WHAT TO WATCH NEXT','VERDICT',
  '\uD83D\uDE4F THE DAILY PRAYER','\uD83D\uDCD6 THE DAILY SCRIPTURE','SOURCES'
];

function _sectionHeader(name){
  return '\n\n'+name+'\n'+'─'.repeat(Math.min(name.length,40))+'\n';
}

function _firstSentence(s){
  s=String(s||'').trim(); if(!s) return '';
  var m=s.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (m?m[0]:s).trim();
}
function _topInterp(interps){
  var best=null, bw=-1;
  interps.forEach(function(i){ if(i && i.has_signal && i.narrative_weight>bw){ bw=i.narrative_weight; best=i; } });
  return best;
}

// v3.34: EXEC / WHAT MATTERED / EVIDENCE used to return the SAME sentence,
// which read as a data dump. Now each has a distinct job:
//   Exec  = the one-line topline (the single biggest fact)
//   WMM   = why it mattered / the context BEYOND the headline move
//   Evid  = the itemized receipts (built separately, below)
// ── v16.9: LOCAL NARRATOR ("small LM") ──────────────────────────────
// Turns the ledger facts into a warm Coffee & Crypto morning read instead of a
// robotic data dump. No external AI — deterministic per scan (seeded by scan id)
// so the phrasing varies day to day but stays stable within a single report.
// v16.15: the seed fell back to TODAY'S DATE whenever the pack had no scan id —
// and the pack normally has none, because the scan id lives on state.seal. So
// every report run on the same day drew the identical opener, the identical
// posture line and the identical closing beat; the three 2026-08-13 reports all
// begin "I never blinked. Here's what crossed the wire:" and end on "Watch the
// hands, not the mouth." Only the numbers moved.
function _nvSeed(pack){
  if(typeof swRunSeed==='function'){ try{ return swRunSeed(pack); }catch(_){} }
  var s=String((pack&&(pack.scan_id||pack.report_id||pack.data_as_of_utc))||('run-'+Date.now()));
  var h=0; for(var i=0;i<s.length;i++){ h=(h*31 + s.charCodeAt(i))|0; }
  return Math.abs(h);
}
// ...and `(seed + salt) % len` made every same-length pool move in lockstep, so
// changing the seed shifted the opener and the beat by exactly the same amount.
// swVoicePick hashes the bucket separately AND refuses to reuse a line until the
// rest of its pool has been spent, which is the guarantee that was actually
// being asked for. The old arithmetic stays as the fallback so this file still
// renders on its own if 02-core has not loaded.
function _nvPick(arr, seed, salt){
  if(!arr||!arr.length) return '';
  if(typeof swVoicePick==='function'){
    try{ return swVoicePick(arr, 'nv'+(salt||0), seed); }catch(_){}
  }
  return arr[(seed+(salt||0))%arr.length];
}
function _lc1(s){
  s=String(s||''); if(!s) return s;
  // Don't de-capitalize acronyms / brand names when the first word already
  // carries a second capital (CLARITY, ETF, JPMorgan, XRP, SEC, DEX...).
  if(/^[A-Z][A-Z0-9]/.test(s)) return s;
  // ...nor a PROPER NOUN. This rule only caught SHOUTED words, so once wallets
  // started being named the 2026-08-10 brief read "bitstamp and Bitso absorbed
  // 11.45M XRP" and "ripple Price Prediction: ...". A sentence that opens with a
  // real entity or a headline must keep its capital.
  // Split on whitespace only — a dot can be INSIDE a name ("Crypto.com"), so
  // splitting on it would test "Crypto" and miss. Trailing punctuation is
  // stripped by the normaliser in _isProperNoun.
  var first = s.split(/\s+/)[0];
  if(first && _isProperNoun(first)) return s;
  return s.charAt(0).toLowerCase()+s.slice(1);
}
// A first word is a proper noun if the shared identity registry knows it as an
// entity — that registry IS the list of names this report is allowed to use, so
// it is exactly the right authority — or if it is a well-known name the registry
// has no wallet for.
var _PROPER_EXTRA = ['ripple','xrpl','coinbase','binance','kraken','bitstamp','bitso','bithumb',
                     'upbit','bybit','okx','huobi','gemini','uphold','coincheck','bitbank',
                     'coinone','mexc','gate','kucoin','bitfinex','bitget','revolut','evernorth'];
var _properCache = null;
function _isProperNoun(word){
  var w = String(word||'').toLowerCase().replace(/[^a-z0-9.]/g,'');
  if(!w) return false;
  if(_properCache === null){
    _properCache = {};
    _PROPER_EXTRA.forEach(function(n){ _properCache[n] = true; });
    try {
      var R = (typeof window!=='undefined') && window.SW_WALLET_IDENTITIES;
      if(R) Object.keys(R).forEach(function(a){
        var nm = R[a] && R[a].name; if(!nm) return;
        // index each word of a multi-word entity ("BTC Markets", "SBI VC Trade")
        String(nm).toLowerCase().split(/\s+/).forEach(function(p){
          p = p.replace(/[^a-z0-9.]/g,''); if(p.length>2) _properCache[p] = true;
        });
      });
    } catch(_){}
  }
  return !!_properCache[w];
}
// XRPMan's in-character asides — his ethos from the theme (receipts, tracing,
// telling on the banks). Used to give the morning read personality and room.
var _NV_BEATS=[
  'Somebody wanted this one quiet. That’s exactly why I say it loud.',
  'The banks count on nobody watching. I count on catching them.',
  'Every coin leaves a trail on the Ledger — and I follow the trail.',
  'Receipts over rumors. That’s the whole job, every single morning.',
  'They move in the dark. I brought the light.',
  'No badges, no guesses — just what the Ledger actually did.',
  'This is why I keep watch: so you never have to wonder who moved what.',
  'The chart is the story they tell you. The Ledger is the one that’s true.',
  'I don’t trade the news. I trade the truth on the Ledger.',
  'When the money whispers, I turn up the volume.',
  'They bury it in the ledger and hope nobody reads. I read.',
  'Follow the money and you find the motive — every single time.',
  'I don’t need their permission to watch. The Ledger is public.',
  'A whale can hide its name, but never its footprints.',
  'The truth doesn’t need a press release. It’s already on-chain.',
  'I work the night shift so the community can sleep.',
  'Big money hates a witness. I’m the witness.',
  'Numbers don’t lie, and neither do I.',
  'Every transfer is a confession, if you know how to read it.',
  'I’m not here to hype. I’m here to hold the line.',
  'Watch the hands, not the mouth. Hands move the money.',
  'They call it noise. I call it evidence.',
  'The banks write the headlines. The Ledger writes the record.',
  'Trust the receipts. Question everything else.',
  // ── v16.9: doubled. 24 beats over a daily report meant the same aside came
  // round roughly every three weeks, which a regular reader hears. Same ethos —
  // receipts, patience, no badges, tell on the banks.
  'They\u2019ve got lawyers. I\u2019ve got timestamps.',
  'Nobody subpoenas the Ledger. It just answers.',
  'A quiet night is still a night on watch.',
  'The money left a receipt. I just read it out loud.',
  'They rehearse the statement. The Ledger doesn\u2019t rehearse anything.',
  'I\u2019d rather report nothing than report a guess.',
  'The ones who move quietly are the ones worth watching closely.',
  'You can move a fortune in silence. You cannot move it in secret.',
  'Every address is a witness that never changes its story.',
  'I don\u2019t chase the pump. I chase the paperwork.',
  'What looks like nothing tonight is usually the first page of something.',
  'The Ledger has no press office and no reason to lie.',
  'They count on you being tired. I count for you instead.',
  'Big money leaves small tracks. That\u2019s the whole trick.',
  'I\u2019m not calling anyone guilty. I\u2019m calling the transfer what it was.',
  'Flagged is not convicted. I keep that line bright.',
  'The tape forgets by lunchtime. The Ledger never does.',
  'If it moved, it\u2019s written down. If it\u2019s written down, I found it.',
  'They can decline to comment. The chain already commented.',
  'Patience is a forensic tool. Most people skip it.',
  'I watch the wallets that stopped moving too. Silence is data.',
  'No thesis first. Evidence first, every morning, no exceptions.',
  'The story that survives the receipts is the only one I\u2019ll tell you.',
  'Somebody always knows before the rest of us. Tonight I\u2019m somebody.',
  'I don\u2019t predict. I document. It ages better.',
  'The whales are careful. The Ledger is more careful.'
];
// Routed through _nvPick so the signature beats rotate and de-repeat on the same
// terms as everything else — this was its own additive index, which is why
// "Watch the hands, not the mouth" closed all three reports on 2026-08-13.
function _nvBeat(seed, salt){ return _nvPick(_NV_BEATS, seed, 900+(salt||0)); }

// v16.10: coverage gate for every narrative path that can say "quiet".
// SW-20260813-VAGPU read 35 of 197 wallets while the device had no network at
// all, and opened with "not one wallet did anything it had not done before."
// XRPMan does not get to sound certain about a board he could not read.
function _cov(pack){
  if(typeof scanCoverage==='function'){ try{ return scanCoverage(pack); }catch(_){} }
  return { checked:0, failed:0, total:0, pct:1, percent:100,
           degraded:false, severe:false, line:'', caveat:'' };
}
// The blunt version, for the top of the story.
function _covLead(cov, seed){
  return _nvPick([
    'I have to open with a problem instead of a finding: ',
    'Before anything else — this scan did not finish. ',
    'Straight up, because burying it would be worse: ',
    'This one comes with a warning label on the front. ',
    'I would rather hand you a short report than a confident wrong one. ',
    'Read this part first, because it changes how you read the rest: '
  ], seed, 9) +
  'only ' + cov.checked + ' of ' + cov.total + ' watched wallets answered tonight (' +
  cov.percent + '%). ' + cov.failed + ' never came back. ' +
  _nvPick([
    'The link to the Ledger went down mid-scan and most of the board went dark with it.',
    'Most of the board was unreachable when I ran it — that is a connection problem, not a market one.',
    'The servers stopped answering partway through and took the rest of the list with them.',
    'I lost the wire before I got through the list.'
  ], seed, 10) +
  ' So I am not calling this a quiet night. I could not see most of it, and an unread wallet is not a still one. ' +
  'Re-run the scan before you trust a single total below.';
}

function _buildExecutiveSummary(interps, pack){
  var seed=_nvSeed(pack), best=_topInterp(interps), moves=interps[0];
  var cov=_cov(pack);
  // A scan that lost most of the board reports the outage, not the calm.
  if(cov.severe) return _covLead(cov, seed)+' '+_nvBeat(seed,0);
  var covNote=cov.degraded
    ? ' Coverage note: '+cov.checked+' of '+cov.total+' wallets answered — the numbers below are of what was reachable, not the whole list.'
    : '';
  var openers=[
    'I kept watch over the Ledger while you slept. ',
    'Another night on patrol, and the Ledger tipped its hand: ',
    'The city sleeps; the Ledger never does. Overnight, ',
    'XRPMan on the wire — while you were out cold, ',
    'While the world slept, I worked the Ledger. ',
    'Morning. Here’s what moved in the dark: ',
    'I ran the whole board overnight, and here’s the read: ',
    'Coffee’s hot and the Ledger’s open — overnight, ',
    'You were sleeping. The whales weren’t. ',
    'Fresh off the night shift on the Ledger: ',
    'I never blinked. Here’s what crossed the wire: ',
    'The Ledger doesn’t clock out, and neither do I. Overnight, ',
    'Let’s open the books on last night: ',
    'Straight from the night watch: ',
    'Kettle on, board up — here’s the overnight: ',
    'Nothing got past me. Here’s the tape: ',
    'Sat with the Ledger till the sun came up. Overnight, ',
    'The wires ran all night. What they carried: ',
    'Back from the watch, notebook full. Overnight, ',
    'You slept. I counted. Here’s the count: ',
    'Same seat, same screens, new night. Overnight, ',
    'Doors were locked, money still moved. Here it is: ',
    'I stayed up so this line could be short: ',
    'Everything below crossed the Ledger while you were out: ',
    'Long night on the board. Here’s what it gave up: ',
    'Fresh receipts, still warm. Overnight, ',
    'No one announced any of this. Overnight, ',
    'Here’s the honest read from the night shift: ',
    'Ledger’s open, coffee’s poured — overnight, ',
    'Quiet hours, loud wallets. Overnight, '
  ];
  var quietOpen=[
    'the Ledger stayed quiet under my watch. No whale broke cover — and a still night on patrol is a good night.',
    'the rails ran quiet and honest. Nobody big blinked, and that’s worth saying out loud.',
    'it was a calm shift. No heavy hands, no cover blown — I still counted every ripple.',
    'the board sat still. A quiet night isn’t a wasted one; it’s the baseline I measure the loud ones against.',
    'nothing crossed that was worth waking you for. I checked anyway, wallet by wallet.',
    'the whales stayed under. No cover blown, no cover needed — I logged the quiet and kept the seat warm.',
    'the wires carried ordinary traffic and nothing else. That is a finding too, and I am reporting it as one.',
    'not one wallet did anything it had not done before. Boring is a result, and tonight it is the result.',
    'the money stayed where it went to sleep. I watched it not move for hours, which is the job.',
    'no heavy hands on the board. I would rather tell you that plainly than dress up a slow night.'
  ];
  var factRaw=(moves&&moves.has_signal)?(moves.headline||moves.summary):(best?best.summary:'');
  if(!factRaw) return _nvPick(openers,seed,0)+_nvPick(quietOpen,seed,7)+covNote+' '+_nvBeat(seed,0);
  // v16.23: several openers end in "Overnight, " and the large-move headline
  // ends in "overnight." — so the summary read "Fresh receipts, still warm.
  // Overnight, 50M XRP moved from Ripple to a large XRP holder overnight."
  // Fine on the page, a stumble when it is read out. Drop the fact's trailing
  // "overnight" when the opener already established the window.
  var _open = _nvPick(openers,seed,0);
  var _fact = _lc1(_firstSentence(factRaw));
  // Anywhere in the opener counts, not just the end: "I ran the whole board
  // overnight, and here's the read: …moved from Binance to Coinbase overnight."
  if(/overnight/i.test(_open)) _fact = _fact.replace(/\s+overnight(?=[.!?]?$)/i, '');
  var line=_open+_fact;
  var score=_num(pack&&pack.risk_score&&pack.risk_score.score);
  var posture=score>=75?_nvPick(['The signal flared red — this is a full-alert night on the Ledger.','Every alarm I’ve got lit up. Top of the dial.','This is a loud one — the board’s screaming and I’m all eyes.','Red across the board. When it’s this hot, somebody’s making a move.','Full alert. The heavy hands came out to play tonight.','I have not seen the board light like this in a while. Eyes up.','This is the kind of night the receipts get printed for.','Everything I watch moved at once. That is not coincidence, that is coordination.','Loud, fast, and deliberate. Somebody wanted this done before morning.','If you read one report this week, make it this one.'],seed,1)
             :score>=50?_nvPick(['My instincts are up — something’s moving out there.','The Ledger’s running warm tonight, and I’m watching close.','Not a siren yet, but the needle’s twitching. I’m leaning in.','Enough motion to keep me honest — I’m tracking it.','Warm, not hot. But warm is how the big ones start.','A few wallets stretched their legs. Worth a second look tomorrow.','Nothing alarming, but the shape of it has my attention.','More motion than usual and no obvious reason for it yet.','Middle of the dial. I am staying in the chair.'],seed,1)
             :score>=25?_nvPick(['Nothing villainous, but I kept one eye open.','A quiet patrol — steady, nothing extreme.','Low hum on the board. I logged it and moved on.','Mostly calm, a little chatter. Nothing I’d wake you for.','Slow night — but slow is when you catch the sloppy ones.','Routine traffic, logged and filed. No drama to sell you.','A working night. Nothing that changes the picture.','Ordinary motion on an ordinary board. I still read every line.','Gentle night. The interesting ones usually follow these.'],seed,1)
             :_nvPick(['Otherwise the Ledger behaved itself.','The rest of the board stayed in line.','A still night — the rails were quiet and honest.','Nothing else tried to slip past. Good.','Calm water tonight — I still counted every ripple.','Flat board, honest hours. Nothing to report is a report.','Everything sat exactly where it was left.','No movement worth your time — and I checked all of it.','Dead quiet, start to finish. I will take it.'],seed,1);
  // Close the open on one of XRPMan's signature beats — keeps the voice front
  // and center before we get into the facts.
  return line+(posture?' '+posture:'')+covNote+' '+_nvBeat(seed,0);
}

function _buildWhatMatteredMost(interps, pack){
  var seed=_nvSeed(pack), band=interps[4], absorber=interps[5];
  var tails=[
    ' Down here the Ledger leads and the chart just follows along.',
    ' The chart plays catch-up; the Ledger already knew.',
    ' That’s the move under the move — the part the ticker never shows you.',
    ' Watch that thread; it usually unspools into something bigger.',
    ' Small on the surface, loud if you know where the money sleeps.',
    ' Keep that name in your head; it tends to come back.',
    ' On its own it is nothing. Alongside the rest of the board it is something.',
    ' That is the sort of move that only reads as odd in hindsight.',
    ' The ticker will not mention it. That is rather the point.',
    ' File it. Two weeks from now it may be the first line of a bigger story.'
  ];
  if(band&&band.has_signal&&absorber&&absorber.has_signal){
    var alertLead=_nvPick(['Here’s the part that put me on alert.','This is the piece I circled twice.','Here’s where the night turned interesting.','This is the tell that earned a hard look.','Here is the line I kept coming back to.','This is the one that made me re-run the numbers.','Out of everything on the board, this is what stuck.','Here is where I stopped scrolling.'],seed,2);
    var closer=_nvPick(['The chart played dead; the Ledger told the truth.','The price sat still while the money quietly rearranged itself.','No fireworks on the ticker — all the action was underneath.','The price told you nothing. The transfers told you plenty.','Flat candles, busy wallets. That gap is the whole story.','Nobody announced any of it, and it all happened anyway.'],seed,6);
    return alertLead+' '+band.summary+' '+absorber.summary+' '+closer;
  }
  var best=_topInterp(interps);
  var others=interps.filter(function(i){ return i && i.has_signal && i!==best; })
    .sort(function(a,b){ return b.narrative_weight-a.narrative_weight; });
  var leads=[
    'What really caught my eye out there: ',
    'Beyond the headline, here’s what I flagged: ',
    'The part I couldn’t look away from: ',
    'Here’s what actually mattered under the surface: ',
    'The tell of the night: ',
    'If you read one thing, read this: ',
    'What the chart won’t tell you: ',
    'The move that earned a second look: ',
    'Cut through the noise, here’s the signal: '
  ];
  if(others.length){
    // v16.18: the clauses were joined raw, but a headline already ends in a full
    // stop — so the section read "…absorbed 20.99M XRP this scan., and XRP Price
    // Outlook…" with the period stranded mid-sentence. Strip the terminator off
    // each clause before joining, and let the join supply the punctuation.
    var clauses=others.slice(0,2).map(function(i){
      return _lc1(String(i.headline||_firstSentence(i.summary)||'').replace(/\s*[.;,]+\s*$/,''));
    }).filter(Boolean);
    return _nvPick(leads,seed,2)+clauses.join(', and ')+'.'+_nvPick(tails,seed,6);
  }
  if(best) return _nvPick([
    'One move carried the whole night — a single, deliberate transfer, not a busy board. When it’s that concentrated, the quiet around it is the tell, and I noticed.',
    'It came down to one move. One deliberate transfer, no crowd around it — and concentration like that is its own kind of loud.',
    'The whole night hinged on a single hand. Not a busy board, just one purposeful move — the sort I don’t let slide.',
    'One transfer did the talking tonight. Clean, deliberate, alone on the board — exactly the kind that rewards a closer look.'
  ],seed,2);
  // "Nothing forced my hand" is a claim about the board. It is only true if the
  // board was read. With most of the list dark, the honest answer is that we do
  // not know — say that instead of dressing an outage up as a calm night.
  var cov=_cov(pack);
  if(cov.severe) return _nvPick([
    'What mattered most is what I could not see. '+cov.failed+' of '+cov.total+' wallets never reported in, so anything I tell you about "no moves" tonight is about the '+cov.checked+' that answered, and nothing else.',
    'The thing that mattered tonight was the blackout, not the board. Only '+cov.checked+' wallets came back. I will not dress that up as a quiet shift.',
    'I cannot tell you what mattered most, because '+cov.failed+' of the '+cov.total+' wallets I watch never answered. That is the finding: the read failed, not the market went still.',
    'The headline tonight is the gap in my own coverage. '+cov.percent+'% of the board reported in. The rest is unknown, and unknown is not the same as quiet.'
  ],seed,2);
  return _nvPick([
    'A steady patrol tonight. The rails stayed calm and nothing tried to slip past me.',
    'Quiet on the board. No single move stood up and asked to be watched — so I watched everything instead.',
    'Nothing forced my hand tonight. Calm rails, honest flow, and me still reading every line.',
    'The night kept its secrets, if it had any. I found no move worth circling — which is its own clean answer.'
  ],seed,2);
}

function _buildEvidence(interps, pack){
  var seed=_nvSeed(pack);
  var moves=interps[0], domShift=interps[1], news=interps[2],
      recv=interps[3];
  var parts=[];
  var receiptsLead=_nvPick(['Here are the receipts, straight off the Ledger.','Let’s go to the tape.','The evidence, plain and on-chain:','Here’s exactly what the Ledger logged:','Receipts first, opinions never:'],seed,8);
  var tracedLead=_nvPick(['I traced it —','I followed the money —','I ran it down —','I chased the hops —','I walked it forward —'],seed,9);
  var domLead=_nvPick(['Across the whole board,','Zooming out,','On the wider board,','Stepping back for the big picture,'],seed,10);
  var newsLead=_nvPick(['And out in the daylight world,','Up in the headlines,','And where the news lives,','Above ground, in the daylight world,'],seed,11);
  if(moves&&moves.has_signal) parts.push(receiptsLead+' '+moves.summary);
  if(recv&&recv.has_signal)   parts.push(tracedLead+' '+_lc1(recv.summary));
  if(domShift&&domShift.has_signal) parts.push(domLead+' '+_lc1(domShift.summary));
  // v16.8: surface newly-discovered related wallets so the report says more.
  try {
    var inbox=(typeof state!=='undefined' && _arr(state.discoveryInbox)) ||
              _arr(pack&&pack.discovery_candidates);
    var fresh=inbox.filter(function(c){ return c && c.review_status!=='REJECTED' && c.review_status!=='SUPPRESSED'; });
    if(fresh.length){
      // fresh is the CUMULATIVE discovery queue (not new-this-scan). The report
      // also prints "Watched wallets: N" in LEDGER DIAGNOSTICS, so two different
      // wallet counts land in one document — 172 here against 130 there on
      // 2026-08-05. Both were right and the pairing still read as a
      // contradiction. Name what each number IS, and put them in one sentence so
      // the relationship is explicit instead of left to the reader.
      var watched=0;
      try{
        watched=_num(pack&&(pack.watchlist_total||pack.wallets_total))||0;
        if(!watched&&typeof KNOWN!=='undefined') watched=Object.keys(KNOWN).length;
      }catch(_){}
      // Every variant names the discovery queue on purpose. The rotation used to
      // include phrasings with no such word ("I've got ", "Flagged on the net
      // right now: "), so whether the report even mentioned discovery came down
      // to which variant the day's seed picked — and the smoke assertion that
      // looks for /DISCOVERY/i passed or failed with it.
      var netLead=_nvPick(['The discovery queue is holding ','On the discovery pile I have ','The discovery queue is carrying ','In the discovery queue right now: '],seed,12);
      // Every variant here must carry the ownership disclaimer, not just the
      // first one. Two of the old three said only "nobody gets a badge for free"
      // and "suspects, not the convicted" — good voice, no disclaimer — so which
      // report carried the required line came down to the day's pick. Now that
      // the picker rotates per RUN that would have been a coin flip on every
      // scan, so the rule is: vary the wording, never vary the claim.
      var netTail=_nvPick([
        ' — flagged, not trusted; behavioral evidence only, nobody gets a badge automatically.',
        ' — every one flagged on behavior, not identity; behavioral evidence only, and nobody gets a badge for free.',
        ' — suspects, not the convicted; behavioral evidence only, the Ledger earns the flag and I don’t hand it out.',
        ' — behavioral evidence only, not ownership proof; a wallet gets on that pile by what it did, never by whose name is on it.',
        ' — queued on behavior alone. Behavioral evidence only, so not one of them is named until the receipts say so.',
        ' — all of them flagged, none of them accused; behavioral evidence only, and not ownership proof.',
        ' — that pile is behavioral evidence only. It says what moved, never who owns it, and I keep that line hard.',
        ' — behavior put them there and behavior alone. Not ownership proof, and I won’t dress it up as any.'
      ],seed,13);
      var watchedClause=watched?(', separate from the '+watched+' wallets on the permanent watch list'):'';
      parts.push(netLead+fresh.length+' flagged candidate'+(fresh.length===1?'':'s')+
                 watchedClause+netTail);
    }
  } catch(_){}
  if(news&&news.has_signal)   parts.push(newsLead+' '+_lc1(news.summary));
  // Same rule as WHAT MATTERED MOST: "no move crossed the line" is a finding
  // about a board that was read. With the list mostly dark it is not available.
  var covE=_cov(pack);
  if(!parts.length && covE.severe)
    return _nvPick([
      'The evidence tonight is the read itself: '+covE.checked+' of '+covE.total+' wallets answered, '+covE.failed+' did not.',
      'There is no tape to hand you. '+covE.failed+' of '+covE.total+' wallets never responded, so there is nothing to put on the record.',
      'What I have is a partial ledger — '+covE.checked+' wallets out of '+covE.total+'. I am not going to build a case on that.'
    ],seed,4)+' Nothing crossed my threshold in the part I could read, and I am reporting that as a limit, not a result. '+_nvBeat(seed,3);
  if(!parts.length) return _nvPick(['No move crossed the line big enough to book tonight. I stayed on watch anyway.','Nothing hit the threshold worth booking — but a clean night is still a logged night.','The board gave me nothing to charge tonight. I kept the watch regardless.'],seed,4)+' '+_nvBeat(seed,3);
  parts.push(_nvBeat(seed,3));
  return parts.join(' ');
}

function _buildWatchNext(interps, pack){
  var seed=_nvSeed(pack), bullets=[];
  var recv=interps[3], band=interps[4], absorber=interps[5], moves=interps[0];
  // The first thing to do about an unread board is read it. Nothing else on this
  // list matters until that happens, so it goes at the top.
  var cov=_cov(pack);
  if(cov.degraded)
    bullets.push('Re-run the scan — '+cov.failed+' of '+cov.total+' wallets never answered this pass'+
                 (cov.severe?', and nothing below is settled until they do.':'.'));
  if(recv&&recv.has_signal){
    if(recv.summary.indexOf('forwarded')>-1)
      bullets.push('Follow the forwarded funds — where they land tells me who’s really behind it.');
    else if(recv.summary.indexOf('held')>-1)
      bullets.push('Keep eyes on that holding wallet for any move out in the next day.');
  }
  if(band&&band.has_signal&&band.summary.indexOf('corridor')>-1)
    bullets.push('See whether the price corridor holds through the next session.');
  if(absorber&&absorber.has_signal)
    bullets.push('Watch the absorbing wallets — are they stacking it, or handing it back out?');
  if(moves&&moves.has_signal)
    bullets.push('Check whether last night’s big recipient makes a move today.');
  // Standing watch \u2014 always-true forensic to-dos. Fill out the list (especially
  // on a quiet night) so the section stays substantive instead of a lone line.
  var standing=[
    'Keep the watchlist warm and wait for the next whale to break cover.',
    'Watch the exchanges around the open \u2014 that\u2019s when the banks like to move.',
    'If a dormant giant wakes up, I\u2019ll flag it before the chart does.',
    'Eyes on the escrow calendar \u2014 a big unlock reshapes the whole board.',
    'Track whether today\u2019s quiet is the calm before a repositioning.',
    'Keep tracing the chains we\u2019ve already opened; they tend to extend another hop.',
    'Watch the same-hour clusters \u2014 coordination hides in the timing, not the size.'
  ];
  var need=Math.max(0, 3-bullets.length);
  for(var s=0; s<standing.length && need>0; s++){
    var pick=_nvPick(standing, seed, 24+s);
    if(bullets.indexOf(pick)===-1){ bullets.push(pick); need--; }
  }
  return bullets.slice(0,4).map(function(b){return '\u2022 '+b;}).join('\n');
}

function _buildVerdict(interps, pack){
  // v16.8: risk_score is an OBJECT {score,label,drivers} — read .score (the object
  // coerced to NaN, so every verdict wrongly read "quiet" even at BLACK/100).
  var _rs=(pack&&pack.risk_score)||{};
  var risk=_num(_rs.score!=null?_rs.score:(pack&&pack.score));
  var _drivers=_arr(_rs.drivers).slice(0,3).filter(Boolean);
  var seed=_nvSeed(pack);
  // v16.10: a low score off an unread board is not a verdict. Say what the
  // number actually measures before anyone reads it on air as an all-clear.
  var cov=_cov(pack);
  if(cov.severe){
    return _nvPick(['Today’s forensic read: ','The read, straight up: ','Bottom line off the Ledger: ','My call this morning: '],seed,32)+
      _nvPick([
        'no verdict tonight — I could not read the board',
        'I am withholding the call; the scan came back mostly blind',
        'no call from me on this one — most of the list never answered',
        'the honest verdict is that there is no verdict yet'
      ],seed,30)+
      '. The score reads '+risk+'/100, but it was calculated across only '+cov.checked+' of '+
      cov.total+' wallets ('+cov.percent+'%). '+
      'A low number off '+cov.percent+'% coverage means unread, not clear — do not report it as a quiet night. '+
      'Re-run the scan when the connection is back and take that read instead. '+_nvBeat(seed,5)+
      ' Not financial advice. XRP-only forensic watch.\n\n'+
      'I’m XRPMan, and I tell on the banks.';
  }
  var verbal=risk>=75?_nvPick(['the Ledger is on high alert — heavy hands moving all night','this was a loud night — big money didn’t even try to hide','the board ran hot; the whales were busy','full-alert night — the heavy hands showed themselves'],seed,30):
             risk>=50?_nvPick(['the Ledger is restless, and I’m watching close','a stirring night — motion working under the surface','the board’s warm; something’s in play','an unsettled night — I’m leaning in on it'],seed,30):
             risk>=25?_nvPick(['a moderate night — routine patrol holds','a steady night — nothing broke the pattern','ordinary motion, nothing that raised the hair on my neck','a middling night — logged and watched'],seed,30):
             _nvPick(['a quiet night — no villain broke cover','a still night — the rails stayed honest','calm water — nobody made a move worth booking','a silent shift — and silence gets logged too'],seed,30);
  var dir=' ('+risk+'/100).';
  if(_drivers.length) dir+=' '+_nvPick(['What tipped me off: ','What put me here: ','The flags that lit up: ','What earned the score: '],seed,31)+_drivers.join(', ')+'.';
  var delta=_num(pack&&(pack.total_balance_delta_xrp!=null?pack.total_balance_delta_xrp:pack.balance_delta));
  if(delta>500000) dir+=' Watched wallets are net accumulating — about '+_xrpFmt(delta)+' XRP moved inward.';
  else if(delta<-500000) dir+=' Watched wallets are net distributing — about '+_xrpFmt(Math.abs(delta))+' XRP moved outward.';
  if(cov.degraded) dir+=' Scored across '+cov.checked+' of '+cov.total+' wallets ('+cov.percent+'%) — '+
                        cov.failed+' failed to read, so treat this as a partial read.';
  return _nvPick(['Today\u2019s forensic read: ','The read, straight up: ','Bottom line off the Ledger: ','My call this morning: '],seed,32)+verbal+'.'+dir+' '+_nvBeat(seed,5)+
         ' Not financial advice. XRP-only forensic watch.\n\n'+
         'I\u2019m XRPMan, and I tell on the banks.';
}

// Compact USD formatter for the diagnostics readout.
function _usdC(v){
  v=_num(v); if(!v) return '$0';
  var a=Math.abs(v);
  if(a>=1e9) return '$'+(v/1e9).toFixed(2).replace(/\.00$/,'')+'B';
  if(a>=1e6) return '$'+(v/1e6).toFixed(2).replace(/\.00$/,'')+'M';
  if(a>=1e3) return '$'+(v/1e3).toFixed(1).replace(/\.0$/,'')+'K';
  return '$'+Math.round(v);
}

// LEDGER DIAGNOSTICS \u2014 the factual readout the desk loves: price/volume, the
// XRPL DEX + EVM layer, RLUSD stablecoin supply, wallet coverage and the
// night's on-chain activity. Only prints lines that actually have data.
function _buildLedgerDiagnostics(pack){
  var p=pack||{}, L=[];
  var price=_num(p.xrp_price!=null?p.xrp_price:p.price), d24=_num(p.xrp_delta_24h_pct);
  if(price>0){
    var q=(d24>1.5?' (24h firm)':d24<-1.5?' (24h soft)':d24?' (24h flat)':'');
    L.push('\u2022 XRP price: ~$'+price.toFixed(4)+q);
  }
  // Market volume = exchange trading (external, in USD). Labeled so it is never
  // confused with the on-Ledger movement figures below (which are in XRP).
  var vol=_num(p.xrp_volume_24h);            if(vol>0) L.push('\u2022 Market volume (exchanges, 24h): '+_usdC(vol));
  var nat=_num(p.xrpl_dex_volume_24h_usd);   if(nat>0) L.push('\u2022 Native XRPL DEX (24h): '+_usdC(nat));
  var evm=_num(p.xrpl_evm_dex_volume_24h_usd), tvl=_num(p.xrpl_evm_tvl_usd);
  if(evm>0||tvl>0){
    var parts=[]; if(evm>0) parts.push(_usdC(evm)+' DEX'); if(tvl>0) parts.push(_usdC(tvl)+' TVL');
    L.push('\u2022 XRPL EVM: '+parts.join(' \u00b7 '));
  }
  var rlusd=_num(p.rlusd_supply);            if(rlusd>0) L.push('\u2022 RLUSD supply: '+_xrpFmt(rlusd)+' tokens');
  // New funded XRPL accounts created network-wide on the most recent day
  // (XRPScan daily metrics). Unfunded/vanity keypairs never hit the Ledger.
  var accts=_num(p.xrpl_accounts_created);
  if(accts>0){
    var adt=String(p.xrpl_metrics_date||'').slice(0,10);
    L.push('\u2022 New funded XRPL accounts'+(adt?(' ('+adt+')'):'')+': +'+accts.toLocaleString('en-US'));
  }
  var watched=_num(p.watchlist_total)||_num(p.wallets_total)||(typeof WATCHLIST!=='undefined'?WATCHLIST.length:0);
  var scanned=_num(p.wallets_checked);
  if(watched>0||scanned>0){
    var wc='\u2022 Watched wallets: '+(watched||scanned);
    if(scanned>0&&watched>0&&scanned!==watched){
      // "(35 scanned this pass)" read like a sampling choice. It was a failure.
      var _c=_cov(p);
      wc+=_c.degraded
        ? ' \u2014 only '+scanned+' answered this pass ('+_c.percent+'%); '+_c.failed+' failed to read'
        : ' ('+scanned+' scanned this pass)';
    }
    L.push(wc);
  }
  // Wide shot: ALL on-Ledger activity across the watched wallets, every size.
  var txn=_num(p.tx_24h_count), moved=_num(p.total_tx_xrp), act=_num(p.active_wallets);
  if(txn>0||moved>0){
    var ap=[];
    if(txn>0)   ap.push(txn+' transaction'+(txn===1?'':'s'));
    if(moved>0) ap.push(_xrpFmt(moved)+' XRP moved');
    if(act>0)   ap.push(act+' wallet'+(act===1?'':'s')+' active');
    L.push('\u2022 Watched activity (all sizes): '+ap.join(' \u00b7 '));
  }
  // Spotlight: the big whale moves only \u2014 a SUBSET of the activity line above.
  var sv=_num(p.shadow_volume_xrp), lt=_arr(p.large_transfers).length||_num(p.large_transfers_count);
  if(sv>0) L.push('\u2022 Shadow volume (whale moves \u22651M): '+_xrpFmt(sv)+' XRP'+(lt>0?(' \u00b7 '+lt+' transfer'+(lt===1?'':'s')):''));
  var nd=_num(p.total_balance_delta_xrp!=null?p.total_balance_delta_xrp:p.balance_delta);
  if(Math.abs(nd)>=100000) L.push('\u2022 Net watched flow: '+(nd>0?'+':'\u2212')+_xrpFmt(Math.abs(nd))+' XRP '+(nd>0?'inward':'outward'));
  if(!L.length) return 'The rails were quiet \u2014 no market or ledger metrics crossed the wire this scan.';
  return L.join('\n');
}

function _buildPrayer(pack){
  // Call existing prayer engine if available
  if(typeof window.getDailyPrayer==='function')
    return _safe(function(){return window.getDailyPrayer(pack);}, '');
  if(typeof window.buildDailyPrayer==='function')
    return _safe(function(){return window.buildDailyPrayer(pack);}, '');
  // Search for the prayer in existing morning story text as fallback
  var prev=window._pipelineLegacyText||'';
  var m=prev.match(/\uD83D\uDE4F\s*THE DAILY PRAYER[\s\S]*?(?=\uD83D\uDCD6\s*THE DAILY SCRIPTURE|SOURCES|$)/);
  if(m) return m[0].replace(/^\uD83D\uDE4F\s*THE DAILY PRAYER\s*/,'').trim();
  return '[Today\u2019s prayer \u2014 see dev panel]';
}

function _buildScripture(pack){
  if(typeof window.getDailyScripture==='function')
    return _safe(function(){return window.getDailyScripture(pack);}, '');
  if(typeof window.buildDailyScripture==='function')
    return _safe(function(){return window.buildDailyScripture(pack);}, '');
  var prev=window._pipelineLegacyText||'';
  var m=prev.match(/\uD83D\uDCD6\s*THE DAILY SCRIPTURE[\s\S]*?(?=SOURCES|$)/);
  if(m) return m[0].replace(/^\uD83D\uDCD6\s*THE DAILY SCRIPTURE\s*/,'').trim();
  return '[Today\u2019s scripture \u2014 see dev panel]';
}

function _buildSources(interpretations, pack){
  // Collect all source_refs URLs from L2 helpers
  var seen={};
  var sources=[];
  interpretations.forEach(function(interp){
    _arr(interp.source_refs).forEach(function(ref){
      if(!ref||!ref.url) return;
      if(seen[ref.url]) return;
      seen[ref.url]=true;
      sources.push(ref);
    });
  });
  // Also call legacy renderClickableSources for GDELT/news URLs
  var legacySources='';
  if(typeof window.renderClickableSources==='function'){
    legacySources=_safe(function(){
      return window.renderClickableSources(pack)||'';
    },'');
  }
  if(!sources.length && !legacySources) return '[No external sources for today\u2019s scan.]';
  var lines=sources.map(function(ref,i){
    return '['+(i+1)+'] '+ref.label+' \u2014 '+ref.url;
  });
  return (lines.length?lines.join('\n')+'\n':'')+legacySources;
}

function assemblePublicReport(pack){
  var interps=[
    _safe(function(){return summarizeLargeMoves(pack);}, _blank()),
    _safe(function(){return summarizeDominanceShift(pack);}, _blank()),
    _safe(function(){return summarizeNewsImpact(pack);}, _blank()),
    _safe(function(){return summarizeReceiverFollowthrough(pack);}, _blank()),
    _safe(function(){return summarizeBandBehavior(pack);}, _blank()),
    _safe(function(){return summarizeAbsorberActivity(pack);}, _blank())
  ];

  // v16.8: use the canonical branded header (RedCandleKiller / Lady K's / COFFEE
  // & CRYPTO with STONE) instead of the old hand-typed banner whose Unicode was
  // garbled ("\u211C\u1D07\u1D05\u1D04\u1D00\u1D21\u1D05\u029C\u1D0F\u029C\u1D1B\u1D07\u0280", "with \uD835\uDCC2\uD835\uDD3B\uD835\uDD46\uFF2E\uD835\uDCC2").
  var BANNER=((typeof buildBrandedHeader==='function')
                ? buildBrandedHeader()
                : '\uD83E\uDE78 \u211C\u1D07\u1D05\u1D04\u1D00\u1D0D\u1D05\u029C\u1D0F\u029C\u1D1B\u1D07\u0280 \uD83E\uDE78\n\uFF33\uFF28\uFF21\uFF24\uFF2F\uFF37 \uFF37\uFF21\uFF34\uFF23\uFF28')
             + '\n' + _today();

  var exec  = _buildExecutiveSummary(interps, pack);
  var wmm   = _buildWhatMatteredMost(interps, pack);
  var evid  = _buildEvidence(interps, pack);
  var watch = _buildWatchNext(interps, pack);
  var verd  = _buildVerdict(interps, pack);
  var diag  = _buildLedgerDiagnostics(pack);

  // Build public body (capped at 4K)
  var body=
    _sectionHeader('EXECUTIVE SUMMARY')+exec+
    _sectionHeader('WHAT MATTERED MOST')+wmm+
    _sectionHeader('EVIDENCE')+evid+
    _sectionHeader('WHAT TO WATCH NEXT')+watch+
    _sectionHeader('VERDICT')+verd+
    _sectionHeader('LEDGER DIAGNOSTICS')+diag;

  // Trim to 4K if needed — EVIDENCE first, then WHAT MATTERED MOST
  if(body.length>4000){
    // Shorten EVIDENCE
    if(evid.length>400){
      var shortEvid=evid.slice(0,400)+'\u2026 [full evidence in dev panel]';
      body=_sectionHeader('EXECUTIVE SUMMARY')+exec+
           _sectionHeader('WHAT MATTERED MOST')+wmm+
           _sectionHeader('EVIDENCE')+shortEvid+
           _sectionHeader('WHAT TO WATCH NEXT')+watch+
           _sectionHeader('VERDICT')+verd+
           _sectionHeader('LEDGER DIAGNOSTICS')+diag;
    }
    // Still over? Shorten WHAT MATTERED MOST
    if(body.length>4000 && wmm.length>200){
      var shortWmm=wmm.slice(0,200)+'\u2026';
      body=_sectionHeader('EXECUTIVE SUMMARY')+exec+
           _sectionHeader('WHAT MATTERED MOST')+shortWmm+
           _sectionHeader('EVIDENCE')+evid.slice(0,300)+'\u2026 [dev panel]'+
           _sectionHeader('WHAT TO WATCH NEXT')+watch+
           _sectionHeader('VERDICT')+verd+
           _sectionHeader('LEDGER DIAGNOSTICS')+diag;
    }
    if(body.length>4000) body=body.slice(0,3960)+'\n\u2026[4K LIMIT]';
  }

  // Append-only: prayer, scripture, sources (outside cap)
  var prayer   = _buildPrayer(pack);
  var scripture= _buildScripture(pack);
  var sources  = _buildSources(interps, pack);

  var full=BANNER+body+
    _sectionHeader('\uD83D\uDE4F THE DAILY PRAYER')+prayer+
    _sectionHeader('\uD83D\uDCD6 THE DAILY SCRIPTURE')+scripture+
    _sectionHeader('SOURCES')+sources;

  // v3.34: collapse any doubled rule lines \u2014 a section builder can return content
  // that already starts with a \u2500\u2500\u2500 rule, producing a double under the header.
  full = full.replace(/(\u2500{3,})\n(?:[ \t]*\1\n)+/g, '$1\n');

  return { text: full, interpretations: interps };
}

/* ═════════════════════════════════════════════════════════════════════
   sanitizePublicNarrative — §5.1 categories 1-17
   ═════════════════════════════════════════════════════════════════════ */
var _FORBIDDEN=[
  // Cat 1 — classification tags in brackets
  {cat:1,sev:'BLOCK',re:/\[(HIGH|MEDIUM|LOW|CRITICAL|STRONG|WEAK)\]/g},
  // Cat 2 — internal classification names
  {cat:2,sev:'BLOCK',re:/\b(UNKNOWN_FLOW|EXCHANGE_INFLOW|EXCHANGE_OUTFLOW|RECEIVER_STILL_HOLDING_SIZE|NEXT_HOP_FORWARDING_DETECTED|RECEIVER_BALANCE_LOW_OR_SPLIT|DUST_TAG_CLUSTER|LARGE_EXCHANGE_OUTFLOW|WHALE_TO_UNKNOWN|REPEATED_COUNTERPARTY|AMM_LIQUIDITY_CHANGE|COORDINATION_MEMORY_ACTIVE|NEWS_SOURCE_DEGRADED|DISCOVERY_CANDIDATE)\b/g},
  // Cat 3 — provider status
  {cat:3,sev:'BLOCK',re:/GDELT failed|CryptoCompare empty|Google News empty|RSS[^.]*failed/gi},
  // Cat 4 — internal label tokens (ALL_CAPS_UNDERSCORE tokens > 6 chars)
  {cat:4,sev:'BLOCK',re:/\b[A-Z]{2,}(?:_[A-Z0-9]+){1,}\b/g},
  // Cat 5 — score notation
  {cat:5,sev:'BLOCK',re:/\d+\/\d+\s*(risk|score|confidence)/gi},
  // Cat 6 — JSON-like artifacts
  {cat:6,sev:'BLOCK',re:/\{[^}]{0,80}\}|\[[^\]]{0,80}\]/g},
  // Cat 7 — forbidden section headers (WARN)
  {cat:7,sev:'WARN',re:/^(PATTERN MEMORY|DISCOVERY|MARKET SNAPSHOT|LEDGER STORY|CONFIDENCE FRAME|COORDINATION MEMORY|HOLDER DOMINANCE|RECEIVER FOLLOWTHROUGH|AUTO DISCOVERY)\s*$/gim},
  // Cat 8 — developer warnings (WARN)
  {cat:8,sev:'WARN',re:/source degradation|partial coverage|narrative_usable|public_sources_usable|degraded feed/gi},
  // Cat 10 — inline bare URLs (WARN in body, outside sources section)
  // Handled separately in assertSourceBinding
  // Cat 11 — helper/function names
  {cat:11,sev:'BLOCK',re:/\b(summarize[A-Z]\w+|build[A-Z]\w+Paragraph|assemblePublicReport|MORNING_NEWS_GOVERNOR|XAI_PROGRESS_NARRATOR|CLUSTER_ENGINE|LABEL_REGISTRY)\b/g},
  // Cat 12 — threshold/heuristic mentions
  {cat:12,sev:'BLOCK',re:/\b(threshold|heuristic|confidence score|signal score|match strength|keyword match)\b/gi},
  // Cat 13 — non-XRP chains/assets
  {cat:13,sev:'BLOCK',re:/\b(bitcoin|solana|ethereum|zcash|cardano|dogecoin|shiba inu|avalanche|polkadot|litecoin|monero|chainlink|tron|polygon|arbitrum|cosmos|saylor|irgc)\b/gi},
  // Cat 14 — legacy ownership claims
  {cat:14,sev:'BLOCK',re:/proves ownership|confirmed identity|verified entity/gi},
  // Cat 15 — coordinated-action assertions
  {cat:15,sev:'BLOCK',re:/coordinated suppression|price control confirmed|bank accumulation confirmed|institutional absorption confirmed|confirmed manipulation|proven suppression|proven price control|institutional buyout proven/gi},
  // Cat 16 — price prediction certainty
  {cat:16,sev:'BLOCK',re:/guaranteed (breakout|dump|move)|will (pump|crash)|definitely going to/gi},
  // Cat 17 — identity/causal overreach
  {cat:17,sev:'BLOCK',re:/wallet owner identified|entity identity confirmed|confirmed owner|news proves ledger movement|article caused the transfer|headline confirms the flow|proves the rails are/gi}
];

function sanitizePublicNarrative(reportText, interpretations){
  var text=reportText||'';
  var violations=[];
  // Split into body (before PRAYER) and append sections
  var prayerIdx=text.indexOf('\uD83D\uDE4F THE DAILY PRAYER');
  var body=prayerIdx>-1?text.slice(0,prayerIdx):text;
  var tail=prayerIdx>-1?text.slice(prayerIdx):'';

  _FORBIDDEN.forEach(function(rule){
    rule.re.lastIndex=0;
    var m;
    while((m=rule.re.exec(body))!==null){
      violations.push({
        rule:'CAT_'+rule.cat,
        match:m[0],
        severity:rule.sev,
        section:'BODY',
        category:rule.cat
      });
    }
    // Strip from body
    body=body.replace(new RegExp(rule.re.source,'gi'),'');
    rule.re.lastIndex=0;
  });
  return { text: body+tail, violations: violations };
}

/* ═════════════════════════════════════════════════════════════════════
   PUBLIC REPORT AUDIT SUITE — 13 assertions (§6.1)
   ═════════════════════════════════════════════════════════════════════ */
function _fail(assertion, detail, excerpt){
  return{assertion:assertion, detail:detail, severity:'BLOCK',
         excerpt:(excerpt||'').slice(0,120)};
}

function assertNoTelemetryLeak(report, violations){
  // v3.34: cat 12 ("threshold", "heuristic"…) and cat 13 (other-chain names) are
  // common English/news words that legitimately appear in headlines. The sanitizer
  // already strips them from the body, so they are NOT telemetry leaks — they must
  // not nuke the whole report into the audit-blocked fallback. Only genuine
  // telemetry/JSON/classification leaks (the other categories) hard-block.
  var CONTENT_COLLISION={ 12:true, 13:true };
  var blocks=violations.filter(function(v){ return v.severity==='BLOCK' && !CONTENT_COLLISION[v.category]; });
  if(blocks.length)
    return _fail('assertNoTelemetryLeak',
      blocks.length+' BLOCK-severity violation(s). First: '+blocks[0].match,
      blocks[0].match);
  return null;
}

function assertSectionOrderLocked(report){
  var order=['EXECUTIVE SUMMARY','WHAT MATTERED MOST','EVIDENCE',
             'WHAT TO WATCH NEXT','VERDICT',
             'THE DAILY PRAYER','THE DAILY SCRIPTURE','SOURCES'];
  var positions=order.map(function(s){
    var idx=report.indexOf(s);
    return{name:s,idx:idx};
  });
  for(var i=1;i<positions.length;i++){
    if(positions[i].idx<positions[i-1].idx){
      return _fail('assertSectionOrderLocked',
        '"'+positions[i].name+'" appears before "'+positions[i-1].name+'".',
        positions[i].name);
    }
    if(positions[i-1].idx===-1&&i<6){ // Sections 1-5 required
      return _fail('assertSectionOrderLocked',
        'Required section "'+positions[i-1].name+'" not found.',
        positions[i-1].name);
    }
  }
  return null;
}

function assertCharacterLimit(report){
  var verdictEnd=report.indexOf('\uD83D\uDE4F THE DAILY PRAYER');
  var bodyText=verdictEnd>-1?report.slice(0,verdictEnd):report;
  // Remove banner (before EXECUTIVE SUMMARY)
  var execStart=bodyText.indexOf('EXECUTIVE SUMMARY');
  if(execStart>0) bodyText=bodyText.slice(execStart);
  if(bodyText.length>4000)
    return _fail('assertCharacterLimit',
      'Public body is '+bodyText.length+' characters (limit 4000).',
      bodyText.slice(3990));
  return null;
}

function assertNoInternalHelpersVisible(report){
  var forbidden=['summarizeLargeMoves','summarizeDominanceShift',
    'summarizeNewsImpact','summarizeReceiverFollowthrough',
    'summarizeBandBehavior','summarizeAbsorberActivity',
    'assemblePublicReport','MORNING_NEWS_GOVERNOR',
    'XAI_PROGRESS_NARRATOR','CLUSTER_ENGINE','buildMorningStory'];
  for(var i=0;i<forbidden.length;i++){
    if(report.indexOf(forbidden[i])>-1)
      return _fail('assertNoInternalHelpersVisible',
        'Helper name "'+forbidden[i]+'" visible in public report.',
        forbidden[i]);
  }
  return null;
}

function assertNarrativeFlow(report){
  var sentences=report.split(/(?<=[.!?])\s+/);
  for(var i=1;i<sentences.length;i++){
    if(sentences[i].trim()===sentences[i-1].trim()&&sentences[i].trim().length>10)
      return _fail('assertNarrativeFlow','Duplicate consecutive sentence.',sentences[i]);
  }
  var longSent=sentences.find(function(s){
    return s.length>280 && !/\uD83D\uDE4F|\uD83D\uDCD6|SOURCES/.test(s);
  });
  if(longSent)
    return _fail('assertNarrativeFlow',
      'Sentence exceeds 280 chars (telemetry signature).',longSent.slice(0,120));
  return null;
}

function assertHumanReadable(report){
  // Check for full wallet addresses (hex > 16 chars in context)
  var hexRe=/\br[a-zA-Z0-9]{29,34}\b/;
  if(hexRe.test(report))
    return _fail('assertHumanReadable',
      'Full wallet address visible in public report.',
      (report.match(hexRe)||[''])[0]);
  // More than 5 all-caps multi-letter tokens in report body
  var bodyEnd=report.indexOf('\uD83D\uDE4F THE DAILY PRAYER');
  var body=bodyEnd>-1?report.slice(0,bodyEnd):report;
  // v3.34: the mandated section headers are REQUIRED in ALL-CAPS by
  // assertSectionOrderLocked, so counting them made this assert impossible.
  // Exclude those header words and brand/ticker tokens from the count.
  var _CAPS_WL=/^(EXECUTIVE|SUMMARY|WHAT|MATTERED|MOST|EVIDENCE|WATCH|NEXT|VERDICT|SOURCES|LEDGER|DIAGNOSTICS|XRP|XRPL|EVM|COFFEE|CRYPTO|XCELLENT|GPT|RLUSD|USD|TVL|DEX|AMM|NFT)$/;
  var capsMatches=(body.match(/\b[A-Z]{3,}\b/g)||[]).filter(function(t){return !_CAPS_WL.test(t);}).length;
  if(capsMatches>5)
    return _fail('assertHumanReadable',
      capsMatches+' ALL-CAPS tokens found in body (limit 5).',
      body.slice(0,80));
  return null;
}

function assertNoDuplicateSections(report){
  var headers=['EXECUTIVE SUMMARY','WHAT MATTERED MOST','EVIDENCE',
               'WHAT TO WATCH NEXT','VERDICT','SOURCES'];
  for(var i=0;i<headers.length;i++){
    var h=headers[i];
    var first=report.indexOf(h);
    var second=report.indexOf(h,first+h.length);
    if(second>-1)
      return _fail('assertNoDuplicateSections',
        'Section "'+h+'" appears more than once.',h);
  }
  return null;
}

function assertNoJSONArtifacts(report){
  var bodyEnd=report.indexOf('SOURCES');
  var body=bodyEnd>-1?report.slice(0,bodyEnd):report;
  if(/\{[^}]{2,}\}/.test(body)||/^\s*"[\w_]+"\s*:/m.test(body))
    return _fail('assertNoJSONArtifacts',
      'JSON-like artifact detected in public body.',
      (body.match(/\{[^}]{2,}\}/)||[''])[0]);
  return null;
}

function assertNoDeveloperLanguage(report){
  var devTerms=['threshold','heuristic','narrative_usable','evidence_level',
    'source_refs','has_signal','pipeline','boot','null','undefined',
    'NaN','degraded','governor','validation','schema'];
  var bodyEnd=report.indexOf('\uD83D\uDE4F THE DAILY PRAYER');
  var body=bodyEnd>-1?report.slice(0,bodyEnd):report;
  for(var i=0;i<devTerms.length;i++){
    var term=devTerms[i];
    // v3.34: word-boundary match. The old substring check false-flagged real
    // words — e.g. "Binance" contains "nan", so every report mentioning Binance
    // was rejected as the developer term "NaN" and fell back to legacy.
    var re=new RegExp('\\b'+term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','i');
    if(re.test(body))
      return _fail('assertNoDeveloperLanguage',
        'Developer term "'+term+'" found in public body.', term);
  }
  return null;
}

function assertSourceBinding(report, interpretations){
  // All URLs rendered in body must trace to source_refs
  var bodyEnd=report.indexOf('SOURCES');
  var body=bodyEnd>-1?report.slice(0,bodyEnd):report;
  var urlRe=/https?:\/\/[^\s<>"'\]\)]+/g;
  var m;
  var allRefs=[];
  _arr(interpretations).forEach(function(i){
    _arr(i.source_refs).forEach(function(r){if(r&&r.url) allRefs.push(r.url);});
  });
  while((m=urlRe.exec(body))!==null){
    if(allRefs.indexOf(m[0])===-1)
      return _fail('assertSourceBinding',
        'URL in body not found in any source_refs: '+m[0],m[0]);
  }
  return null;
}

// Remove text that is QUOTED JOURNALISM rather than a Shadow Watch claim:
// the cited headlines and the citation/sources block. An exchange named inside
// a headline we are quoting is the publisher's assertion, not ours.
//
// 2026-08-05: this is why the daily report went out empty. Three cited headlines
// named Binance ("XRP's Realized Volatility Drops to 3-Month Low on Binance" and
// two others). assertLabelProvenance scanned the whole report, found the string,
// found no wallet-label provenance for it — because there was no wallet claim to
// back, only a news title — and hard-blocked the entire public narrative. The
// ledger evidence that day was intact. It is a landmine: it fires whenever the
// news router happens to cite a headline naming a major exchange, so the report
// survived 08-04 only because that day's Binance headline was never selected.
function _stripQuotedJournalism(report, interpretations){
  var out=String(report||'');
  // citations are never identity claims — cut the trailing blocks wholesale
  ['\nSources','\nSOURCES','\nNEWS USED'].forEach(function(marker){
    var at=out.indexOf(marker);
    if(at>-1) out=out.slice(0,at);
  });
  _arr(interpretations).forEach(function(i){
    _arr(i.source_refs).forEach(function(r){
      if(!r||r.kind!=='news_article') return;
      var t=String(r.label||'');
      if(t.length<8) return;                 // too short to be a headline; skip
      var guard=0;
      for(var at=out.indexOf(t); at>-1 && guard<200; at=out.indexOf(t), guard++){
        var end=at+t.length;
        // ref.label is title.slice(0,80), so a longer headline leaves a tail —
        // extend the cut to the end of that headline segment (they are joined
        // with ' · ' and terminated by a period or newline).
        var stop=out.slice(end).search(/\s·\s|\n|\.\s|\.$/);
        if(stop>-1&&stop<160) end+=stop;
        out=out.slice(0,at)+' '+out.slice(end);
      }
    });
  });
  out=out.replace(/^\s*\[\d+\][^\n]*$/gm,'');  // any leftover "[2] u.today — ..." lines
  return out;
}

function assertLabelProvenance(report, interpretations){
  // Named entities CLAIMED BY US must have operator_reviewed or richlist_seed
  // provenance. Quoted headlines are excluded — see _stripQuotedJournalism.
  var exchanges=['Bithumb','Binance','Coinbase','Kraken','Upbit',
    'Crypto.com','Bitstamp','Bitso','SBI VC Trade','Ripple'];
  var scanned=_stripQuotedJournalism(report, interpretations);
  var allRefs=[];
  _arr(interpretations).forEach(function(i){
    _arr(i.source_refs).forEach(function(r){
      if(r&&(r.provenance==='operator_reviewed'||r.provenance==='richlist_seed'))
        allRefs.push(r.label);
    });
  });
  for(var i=0;i<exchanges.length;i++){
    var ex=exchanges[i];
    if(scanned.indexOf(ex)>-1){
      // v16.17: the match was one-directional — the REF had to contain the
      // entity. A ref sourced as "Ripple" therefore failed to satisfy a mention
      // of "Ripple Labs", and a ref sourced as "Binance Hot 3" would fail
      // "Binance" the moment anything shortened it. Either string containing the
      // other is the same claim about the same entity, and the consequence of
      // getting this wrong is the entire report being thrown away.
      var found=allRefs.some(function(l){
        if(!l) return false;
        var a=String(l).toLowerCase(), b=ex.toLowerCase();
        return a.indexOf(b)>-1 || b.indexOf(a)>-1;
      });
      if(!found)
        return _fail('assertLabelProvenance',
          '"'+ex+'" named in report but no operator_reviewed/richlist_seed provenance found.',ex);
    }
  }
  return null;
}

// Replace an entity we cannot prove provenance for with the neutral description
// of what it is. Keeps every finding, every number and every sentence — drops
// only the identity claim we could not stand behind, which is the one thing that
// actually had to go.
var _NEUTRAL_FOR={
  'Ripple':'a Ripple escrow wallet', 'Ripple Labs':'a Ripple escrow wallet',
  'SBI VC Trade':'an exchange wallet'
};
function _repairProvenance(text, failures){
  var out=String(text||''), count=0, notes=[];
  _arr(failures).forEach(function(f){
    if(!f || f.assertion!=='assertLabelProvenance') return;
    var ent=String(f.excerpt||'').trim();
    if(!ent) return;
    var neutral=_NEUTRAL_FOR[ent]||'an exchange wallet';
    // Whole-word only: "Bitso" must not eat the "Bitso" inside a longer name,
    // and a replacement must never run two words together.
    var re=new RegExp('(^|[^A-Za-z0-9.])'+ent.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![A-Za-z0-9])','g');
    var before=out;
    out=out.replace(re, function(m,p1){ return p1+neutral; });
    if(out!==before){ count++; notes.push('"'+ent+'" → "'+neutral+'"'); }
  });
  return { text:out, changed:count>0, count:count, notes:notes };
}

function assertNoArrayDumps(report){
  var bodyEnd=report.indexOf('\uD83D\uDE4F THE DAILY PRAYER');
  var body=bodyEnd>-1?report.slice(0,bodyEnd):report;
  // Check for >4 consecutive bullet lines outside WATCH NEXT
  var watchIdx=body.indexOf('WHAT TO WATCH NEXT');
  var preWatch=watchIdx>-1?body.slice(0,watchIdx):body;
  var bulletRuns=(preWatch.match(/(?:\n\u2022[^\n]+){5,}/g)||[]);
  if(bulletRuns.length)
    return _fail('assertNoArrayDumps',
      'More than 4 consecutive bullet lines outside WHAT TO WATCH NEXT section.',
      bulletRuns[0].slice(0,100));
  return null;
}

function assertFallbackContentRequirements(report){
  var checks=[
    [/COFFEE & CRYPTO/i,'Coffee & Crypto banner missing from fallback.'],
    [/THE DAILY PRAYER/i,'Prayer block missing from fallback.'],
    [/THE DAILY SCRIPTURE/i,'Scripture block missing from fallback.'],
    [/not financial advice/i,'No financial-advice disclaimer in fallback.'],
    [/I.m XRPMan, and I tell on the banks\./i,'XRPMan closing line missing from fallback.'],
  ];
  for(var i=0;i<checks.length;i++){
    if(!checks[i][0].test(report))
      return _fail('assertFallbackContentRequirements',checks[i][1],'');
  }
  return null;
}

function auditPublicReport(reportText, violations, interpretations, isFallback){
  var failures=[], advisories=[];
  // v3.34: COSMETIC assertions are advisory — they get logged but do NOT nuke the
  // whole report into the fallback. Real news headlines kept tripping sentence-length
  // and readability rules and blocking an otherwise-good report. Genuine leaks
  // (telemetry, JSON, helpers, structure, section order) still hard-block.
  var ADVISORY={ assertNarrativeFlow:true, assertHumanReadable:true };
  function run(r){ if(!r) return; if(ADVISORY[r.assertion]) advisories.push(r); else failures.push(r); }

  run(assertNoTelemetryLeak(reportText, violations));
  run(assertSectionOrderLocked(reportText));
  run(assertCharacterLimit(reportText));
  run(assertNoInternalHelpersVisible(reportText));
  run(assertNarrativeFlow(reportText));
  run(assertHumanReadable(reportText));
  run(assertNoDuplicateSections(reportText));
  run(assertNoJSONArtifacts(reportText));
  run(assertNoDeveloperLanguage(reportText));
  run(assertSourceBinding(reportText, interpretations||[]));
  run(assertLabelProvenance(reportText, interpretations||[]));
  run(assertNoArrayDumps(reportText));
  if(isFallback) run(assertFallbackContentRequirements(reportText));

  // Filter nulls
  failures=failures.filter(Boolean);
  return{pass:failures.length===0, failures:failures, advisories:advisories};
}

/* ═════════════════════════════════════════════════════════════════════
   KNOWN-GOOD MINIMAL TEMPLATE (KGMT) — §7.1
   ═════════════════════════════════════════════════════════════════════ */
// v16.17: the fallback's banner was hand-typed Unicode and both names were
// wrong \u2014 it rendered "\u211C\u1D07\u1D05\u1D04\u1D00\u1D21\u1D05\u029C\u1D0F\u029C\u1D1B\u1D07\u0280" instead of RedCandleKiller, and
// "\uD835\uDCC2\uD835\uDD3B\uD835\uDD46\uFF2E\uD835\uDCC2" instead of STONE. The one template that only ever appears on the
// app's worst day was misspelling the operator's own name and his co-host's,
// which is exactly when it is least affordable. Use the real branded header
// (02-core.js buildBrandedHeader) and keep the garbled literal only as the
// last-ditch value if that function has not loaded.
var _KGMT_BANNER=(function(){
  try{ if(typeof buildBrandedHeader==='function') return buildBrandedHeader()+'\n\n'; }catch(_){}
  return '\uD83E\uDE78 RedCandleKiller \uD83E\uDE78\nSHADOW WATCH\n\u2615 COFFEE & CRYPTO with STONE\n\n';
})();
var KGMT_TEXT=
_KGMT_BANNER+
'EXECUTIVE SUMMARY\n'+'\u2500'.repeat(17)+'\n'+
'Today\'s scan completed. The public narrative engine could not assemble a publishable report from the available evidence. Raw evidence is intact in the dev panel and the GPT/Agent package.\n\n'+
'WHAT MATTERED MOST\n'+'\u2500'.repeat(18)+'\n'+
'The watch continues. Operator review recommended for today\'s evidence.\n\n'+
'EVIDENCE\n'+'\u2500'.repeat(8)+'\n'+
'Full forensic evidence is available in the dev panel.\n\n'+
'WHAT TO WATCH NEXT\n'+'\u2500'.repeat(18)+'\n'+
'\u2022 Operator review of today\'s scan in the dev panel.\n'+
'\u2022 Next scheduled scan will retry the public narrative.\n\n'+
'VERDICT\n'+'\u2500'.repeat(7)+'\n'+
'Audit blocked today\'s public report. Evidence is intact. Patrol holds.\n'+
'Not financial advice. XRP-only forensic watch.\n\n'+
'I\'m XRPMan, and I tell on the banks.\n\n'+
'\uD83D\uDE4F THE DAILY PRAYER\n[auto-rendered]\n\n'+
'\uD83D\uDCD6 THE DAILY SCRIPTURE\n[auto-rendered]\n\n'+
'SOURCES\n[No public sources available for today\'s fallback.]';

/* ═════════════════════════════════════════════════════════════════════
   MAIN RENDER ENTRY POINT
   renderPublicReport(pack) → string
   ═════════════════════════════════════════════════════════════════════ */
var _fallbackCount=0;
var _buildFailCount=0;
var _lastAudit=null;

function _logToDevPanel(msg){
  _safe(function(){
    if(window.SW_ERROR_LOG&&typeof window.SW_ERROR_LOG.push==='function')
      window.SW_ERROR_LOG.push('[PIPELINE-V1 '+new Date().toISOString()+'] '+msg);
    var log=document.getElementById('errorLog')||document.getElementById('swErrorLog');
    if(log) log.textContent=(log.textContent||'')+'\n[PIPELINE-V1] '+msg;
  });
}

function _setFallbackBanner(n){
  _safe(function(){
    var banner=document.getElementById('swPipelineBanner');
    if(!banner){
      banner=document.createElement('div');
      banner.id='swPipelineBanner';
      banner.style.cssText='background:#330000;color:#ff6666;padding:6px 12px;'+
        'font:11px monospace;border-bottom:1px solid #660000;display:none;';
      var pane=document.getElementById('cmdReportPane');
      if(pane) pane.insertBefore(banner,pane.firstChild);
    }
    if(n>0){
      banner.textContent='[PIPELINE-V1] Last report rendered via fallback. Audit failures: '+n+'. See error log.';
      banner.style.display='block';
    } else {
      banner.style.display='none';
    }
  });
}

function renderPublicReport(pack){
  if(!_isEnabled()) return null;

  try{
    // L3 assemble
    var assembled=assemblePublicReport(pack);
    var rawText=assembled.text;
    var interps=assembled.interpretations;

    // Store for prayer/scripture extraction by later builds
    window._pipelineLegacyText=rawText;

    // Sanitize
    var sanitized=sanitizePublicNarrative(rawText, interps);

    // Audit
    var audit=auditPublicReport(sanitized.text, sanitized.violations, interps, false);
    _lastAudit=audit;

    if(audit.pass){
      _setFallbackBanner(0);
      try{ window._SW_REPORT_MODE='CLEAN report (V1 pipeline)'; }catch(_){}
      if(audit.advisories && audit.advisories.length){
        try{ _logToDevPanel('Advisories (non-blocking): '+audit.advisories.map(function(a){return a.assertion;}).join(', ')); }catch(_){}
      }
      try{ console.log('[PIPELINE-V1] Report passed audit. '+
                       sanitized.text.length+' chars.'); }catch(_){}
      return sanitized.text;
    }

    // v16.17: audit failure used to go straight to KGMT — the whole night's
    // narrative thrown away and replaced with "the public narrative engine could
    // not assemble a publishable report". On SW-20260813-FVZAO that happened
    // because one wallet was called "Ripple Labs" instead of "Ripple". A naming
    // nit cost the entire report, on a scan that had found 3 new candidates, a
    // 50M XRP escrow move and live news.
    //
    // A name we cannot source is a name we should not print — but the fix for
    // that is to stop printing THE NAME, not to stop printing the report. Try the
    // proportionate repair first, re-audit it honestly, and only fall back if the
    // report still cannot pass.
    var repair=_repairProvenance(sanitized.text, audit.failures);
    if(repair.changed){
      var reAudit=auditPublicReport(repair.text, sanitized.violations, interps, false);
      if(reAudit.pass){
        _lastAudit=reAudit;
        _setFallbackBanner(0);
        try{ window._SW_REPORT_MODE='CLEAN report (V1 pipeline, '+repair.count+' unsourced name(s) neutralised)'; }catch(_){}
        _logToDevPanel('Audit repaired: '+repair.notes.join('; ')+'. Report published with the name(s) removed rather than the report.');
        return repair.text;
      }
      _logToDevPanel('Audit repair attempted but still failing: '+
        (reAudit.failures||[]).map(function(f){return f.assertion;}).join(', '));
    }

    // Repair impossible or insufficient — fallback
    _fallbackCount++;
    var failDetail=audit.failures.map(function(f){
      return f.assertion+': '+f.detail;
    }).join(' | ');
    _logToDevPanel('Audit FAILED ('+audit.failures.length+' failures). '+failDetail);
    _setFallbackBanner(audit.failures.length);
    try{ console.warn('[PIPELINE-V1] Audit failed. Rendering KGMT fallback.',audit.failures); }catch(_){}

    // Verify KGMT itself
    var kgmtAudit=auditPublicReport(KGMT_TEXT,[],[],true);
    if(!kgmtAudit.pass){
      _logToDevPanel('KGMT self-audit failed ('+(kgmtAudit.failures||[]).map(function(f){return f.assertion;}).join(', ')+') — returning legacy.');
      return null; // let the routing hook fall back to the (humanized) legacy report
    }
    try{ window._SW_REPORT_MODE='audit-blocked fallback (KGMT) — see error log'; }catch(_){}
    return KGMT_TEXT;

  }catch(err){
    _buildFailCount++;
    _logToDevPanel('BUILD FAILURE: '+(err&&err.message||String(err)));
    try{ console.error('[PIPELINE-V1] Build error:',err); }catch(_){}
    return null; // Signal caller to use legacy chain
  }
}

/* ═════════════════════════════════════════════════════════════════════
   ROUTING HOOK
   Wraps buildMorningStoryText as the final outer wrapper.
   V1 output wins if enabled + returns > 100 chars.
   Legacy chain remains as fallback if V1 returns null.
   ═════════════════════════════════════════════════════════════════════ */
function _installHook(){
  if(typeof window.buildMorningStoryText!=='function') return false;
  if(window.buildMorningStoryText._pipelineV1Hooked) return true;
  var legacy=window.buildMorningStoryText;
  var _hz=function(t){ return (typeof window._humanizePublicText==='function') ? window._humanizePublicText(t) : t; };
  var _mode=function(m){ try{ window._SW_REPORT_MODE=m; }catch(_){} };
  var hooked=function(pack){
    if(!_isEnabled()){ _mode('legacy (pipeline OFF)'); return _hz(legacy(pack)); }
    // Store legacy output for prayer/scripture extraction
    var legacyOut=_safe(function(){return legacy(pack);},'');
    window._pipelineLegacyText=legacyOut;
    var v1=renderPublicReport(pack||window._lastPack);
    // v3.34: humanize the winning report (title-case the mandated ALL-CAPS
    // headers for display — the audit ran on the raw version already).
    // renderPublicReport already set _SW_REPORT_MODE accurately (clean vs KGMT).
    if(v1&&v1.length>100){ return _hz(v1); }
    _mode('legacy fallback (V1 audit failed — see error log)');
    return _hz(legacyOut);
  };
  hooked._pipelineV1Hooked=true;
  hooked._legacyChain=legacy;
  window.buildMorningStoryText=hooked;
  try{ console.log('[PIPELINE-V1] Routing hook installed on buildMorningStoryText'); }catch(_){}
  return true;
}

// Track the last pack for reference
_safe(function(){
  var bus=window.SHADOW_EVENT_BUS;
  if(bus&&typeof bus.on==='function'){
    bus.on('shadow.scan.completed',function(data){
      if(data&&data.pack) window._lastPack=data.pack;
    });
    bus.on('shadow.report.sealed',function(data){
      if(data&&data.pack) window._lastPack=data.pack;
    });
  }
});

function _boot(){
  _installHook();
  setTimeout(function(){
    if(!window.buildMorningStoryText||!window.buildMorningStoryText._pipelineV1Hooked)
      _installHook();
  },2000);
}

function _bootWithRetry(){
  var tries=0;
  var iv=setInterval(function(){
    tries++;
    if(typeof window.buildMorningStoryText==='function'){
      _boot();
      clearInterval(iv);
      try{ console.log('[PIPELINE-V1] '+PIPE_VERSION+' ready. Kill switch: window.SW_PIPELINE_V1_KILL=true'); }catch(_){}
    } else if(tries>=40){
      clearInterval(iv);
      try{ console.warn('[PIPELINE-V1] buildMorningStoryText not found after 40 tries'); }catch(_){}
    }
  },400);
}

if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',_bootWithRetry);
} else {
  _bootWithRetry();
}

/* ═════════════════════════════════════════════════════════════════════
   PUBLIC API
   ═════════════════════════════════════════════════════════════════════ */
window.PUBLIC_REPORT_PIPELINE_V1={
  version:          PIPE_VERSION,
  specVersion:      'PUBLIC_REPORT_PIPELINE_v2.md · 2026-05-19',
  enabled:          _isEnabled,
  render:           renderPublicReport,
  assemble:         assemblePublicReport,
  sanitize:         sanitizePublicNarrative,
  audit:            auditPublicReport,
  kgmt:             KGMT_TEXT,
  helpers:{
    summarizeLargeMoves:         summarizeLargeMoves,
    summarizeDominanceShift:     summarizeDominanceShift,
    summarizeNewsImpact:         summarizeNewsImpact,
    summarizeReceiverFollowthrough: summarizeReceiverFollowthrough,
    summarizeBandBehavior:       summarizeBandBehavior,
    summarizeAbsorberActivity:   summarizeAbsorberActivity
  },
  assertions:{
    assertNoTelemetryLeak:        assertNoTelemetryLeak,
    assertSectionOrderLocked:     assertSectionOrderLocked,
    assertCharacterLimit:         assertCharacterLimit,
    assertNoInternalHelpersVisible: assertNoInternalHelpersVisible,
    assertNarrativeFlow:          assertNarrativeFlow,
    assertHumanReadable:          assertHumanReadable,
    assertNoDuplicateSections:    assertNoDuplicateSections,
    assertNoJSONArtifacts:        assertNoJSONArtifacts,
    assertNoDeveloperLanguage:    assertNoDeveloperLanguage,
    assertSourceBinding:          assertSourceBinding,
    assertLabelProvenance:        assertLabelProvenance,
    assertNoArrayDumps:           assertNoArrayDumps,
    assertFallbackContentRequirements: assertFallbackContentRequirements
  },
  // exposed for the regression harness — same reason the assertions are
  internals: { lc1: _lc1, isProperNoun: _isProperNoun, plain: _plain },
  stats:{ get fallbackCount(){ return _fallbackCount; },
          get buildFailCount(){ return _buildFailCount; } },
  lastAudit:        function(){ return _lastAudit; },
  runOnLastReport:  function(){
    var t=document.getElementById('cmdReportBody');
    var text=t?t.textContent||'':'';
    if(!text) return{pass:false,failures:[{assertion:'runOnLastReport',detail:'No report found in DOM'}]};
    var s=sanitizePublicNarrative(text,[]);
    return auditPublicReport(s.text,s.violations,[],false);
  },
  reinstall:        function(){
    if(window.buildMorningStoryText&&window.buildMorningStoryText._pipelineV1Hooked){
      window.buildMorningStoryText=window.buildMorningStoryText._legacyChain;
    }
    _installHook();
  }
};

})();

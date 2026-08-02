(function() {
  'use strict';
  var V333H_VERSION = 'v3.33h-xrp-only-fix1';

  /* ──────────────────────────────────────────────────────────────────
     PART 1 — Wallet candidate adds (BACK-END / DEV PANEL ONLY)
     Exposed but NEVER touches the public report.
     ────────────────────────────────────────────────────────────────── */
  window.SW_WALLET_ADDS = [
    {
      label: 'BITHUMB_HOT_WALLET',
      address: 'rw3fRcmn5PJyPKuvtAwHDSpEqoW2JKmKbu',
      cat: 'exchange_hot',
      source: 'v333h_auto_add',
      reviewed: true,
      confidence: 'HIGH',
      note: 'Operator-reviewed. Score 200/200. Seen 6 scans.'
    },
    {
      label: 'BINANCE_PEG_BRIDGE_RESERVE',
      address: 'r3bqvUfF9weyxZqwo6qumBV2Q5k8LzepjJ',
      cat: 'bridge_reserve',
      source: 'v333h_auto_add',
      reviewed: true,
      confidence: 'HIGH',
      note: 'Operator-reviewed. Score 175/200. BSC/BEP20 collateral.'
    },
    {
      label: 'WHALE_RECV_r4Dymt_C6c5',
      address: 'r4DymtkgUAh2wqRxVfdd3Xtswzim6eC6c5',
      cat: 'discovered_whale',
      source: 'v333h_auto_add',
      reviewed: false,
      confidence: 'HIGH',
      note: 'Score 190/200. Receiver from CRYPTO_COM, fed COINBASE_HOT.'
    }
  ];

  function _softMergeIntoWatchlist() {
    if (window._v333hMerged) return false;
    var targets = [
      window.KNOWN,
      window.WATCHED_WALLETS,
      window.state && window.state.watched,
      window.state && window.state.knownWallets
    ].filter(function(t) { return Array.isArray(t); });
    if (!targets.length) return false;
    var added = 0;
    window.SW_WALLET_ADDS.forEach(function(w) {
      targets.forEach(function(arr) {
        var dup = arr.some(function(x) {
          var a = x && (x.address || x.a || x.addr);
          return a === w.address;
        });
        if (!dup) {
          arr.push({ label: w.label, address: w.address, cat: w.cat,
                     source: w.source, reviewed: w.reviewed });
          added++;
        }
      });
    });
    window._v333hMerged = true;
    try { console.log('[SW-v333h] wallet candidates merged: '+added); } catch(_){}
    return added > 0;
  }

  /* ──────────────────────────────────────────────────────────────────
     PART 2 — XRP-only news filter + expansion to 3-5 items
     Only touches the REAL NEWS section. Everything else passes through
     untouched. Prayer, scripture, voice, structure — all preserved.
     ────────────────────────────────────────────────────────────────── */

  // Must mention at least one of these (case-insensitive)
  var XRP_ALLOW = [
    'xrp', 'ripple', 'xrpl', 'rlusd', 'clarity act', 'ripple labs',
    'xrp ledger', 'ripple ceo', 'brad garlinghouse', 'david schwartz',
    'flare network', 'songbird', 'sologenic', 'xahau'
  ];
  // Reject if ANY of these appear (unless paired with allow term in same title)
  var XRP_DENY_HARD = [
    'bitcoin', 'btc-', 'ethereum', 'eth-', 'solana', ' sol ',
    'zcash', 'zec ', 'cardano', ' ada ', 'dogecoin', 'doge',
    ' shib ', 'shiba', 'avalanche', 'avax', 'polkadot', ' dot ',
    'litecoin', 'ltc', 'monero', 'xmr', 'chainlink', ' link ',
    'binance coin', 'bnb chain', 'tron', ' trx ', 'polygon',
    'matic', 'arbitrum', 'optimism', 'cosmos',
    'saylor', 'irgc', 'iran'
  ];
  // Soft deny — drops unless title also clearly XRP/Ripple
  var XRP_DENY_SOFT = [
    'phishing', 'meme coin', 'memecoin', 'rug pull', 'hack',
    'airdrop', 'nft floor', 'gaming token'
  ];

  function _isXrpRelevant(title, url) {
    var t = (title || '').toLowerCase();
    var u = (url || '').toLowerCase();
    var hay = t + ' ' + u;
    // Must contain an allow term
    var hasAllow = XRP_ALLOW.some(function(k) { return hay.indexOf(k) > -1; });
    if (!hasAllow) return false;
    // Hard deny — reject outright
    var hardBad = XRP_DENY_HARD.some(function(k) { return hay.indexOf(k) > -1; });
    if (hardBad) return false;
    // Soft deny — only allow if "xrp" or "ripple" is clearly in the title (not just URL)
    var hasCoreXrp = (t.indexOf('xrp') > -1 || t.indexOf('ripple') > -1 ||
                      t.indexOf('xrpl') > -1 || t.indexOf('rlusd') > -1);
    var softBad = XRP_DENY_SOFT.some(function(k) { return t.indexOf(k) > -1; });
    if (softBad && !hasCoreXrp) return false;
    return true;
  }

  function _collectNewsItems(pack) {
    var items = [];
    var seen = {};
    function push(arr) {
      if (!Array.isArray(arr)) return;
      arr.forEach(function(it) {
        if (!it) return;
        var title = it.title || it.headline || '';
        var url   = it.url || it.link || '';
        var src   = it.source || it.publisher || it.domain || '';
        if (!title) return;
        var key = title.toLowerCase().slice(0, 80);
        if (seen[key]) return;
        seen[key] = true;
        items.push({ title: title, url: url, src: src });
      });
    }
    var ni = pack && pack.news_intel;
    if (ni) {
      push(ni.items);
      push(ni.top_headlines);
      push(ni.matched_articles);
      push(ni.ranked);
    }
    var eln = pack && pack.evidence_led_news;
    if (eln) {
      push(eln.ranked_context);
      push(eln.matched);
      push(eln.items);
    }
    return items;
  }

  function _buildXrpOnlyNewsSection(pack) {
    var all = _collectNewsItems(pack);
    var xrp = all.filter(function(it) { return _isXrpRelevant(it.title, it.url); });
    if (!xrp.length) return null;
    xrp = xrp.slice(0, 5);
    var lines = ['REAL NEWS'];
    xrp.forEach(function(n) {
      var frame = ' — XRP / Ripple context.';
      var t = n.title.toLowerCase();
      if (t.indexOf('rlusd') > -1)            frame = ' — RLUSD / Ripple stablecoin angle.';
      else if (t.indexOf('clarity act') > -1) frame = ' — regulatory framing for XRP positioning.';
      else if (t.indexOf('rwa') > -1)         frame = ' — XRPL real-world-asset activity.';
      else if (t.indexOf('xrpl') > -1)        frame = ' — XRP Ledger development.';
      else if (t.indexOf('whale') > -1)       frame = ' — XRP whale activity context.';
      var bullet = '• ' + n.title + frame;
      if (n.url) bullet += '\n  ' + n.url;
      lines.push(bullet);
    });
    return lines.join('\n');
  }

  /* ──────────────────────────────────────────────────────────────────
     PART 3 — Wrap buildMorningStoryText
     ONLY replaces the REAL NEWS block. Leaves voice, prayer, scripture,
     verdict, all other sections untouched.
     ────────────────────────────────────────────────────────────────── */
  function _replaceNewsBlockOnly(pack, original) {
    if (!original) return original;
    var newsBlock = _buildXrpOnlyNewsSection(pack);
    if (!newsBlock) return original; // Leave original news intact if filter found nothing

    // Match the existing REAL NEWS block — from "REAL NEWS" up to the next
    // ALL-CAPS section header or end of body
    var newsRe = /REAL NEWS\b[\s\S]*?(?=\n\n[A-Z][A-Z\s\/]{2,}\n|$)/;
    if (newsRe.test(original)) {
      return original.replace(newsRe, newsBlock);
    }
    return original;
  }

  function _wrapBuildMorningText() {
    if (typeof window.buildMorningStoryText !== 'function') return false;
    if (window.buildMorningStoryText._v333hWrapped) return true;
    var prev = window.buildMorningStoryText;
    var wrapped = function(pack) {
      var raw;
      try { raw = prev(pack); } catch (e) { return prev(pack); }
      try { return _replaceNewsBlockOnly(pack || (window.state && window.state.pack) || {}, raw); }
      catch (e) {
        try { console.warn('[SW-v333h] news swap failed, returning raw:', e.message); } catch(_){}
        return raw;
      }
    };
    wrapped._v333hWrapped = true;
    wrapped._original = prev._original || prev;
    window.buildMorningStoryText = wrapped;
    try { console.log('[SW-v333h] buildMorningStoryText wrapped (XRP-only news)'); } catch(_){}
    return true;
  }

  /* ──────────────────────────────────────────────────────────────────
     PART 4 — Clickable links in the HTML rendering
     The real bug: buildMorningStoryHtml runs body through escapeHTML
     which kills anchors. Wrap output and re-linkify <pre> contents.
     ────────────────────────────────────────────────────────────────── */
  var URL_RE = /\bhttps?:\/\/[^\s<>"'\]\)]+/g;

  function _linkifyHtml(html) {
    if (!html || typeof html !== 'string') return html;
    return html.replace(/<pre([^>]*)>([\s\S]*?)<\/pre>/g, function(_, attrs, inner) {
      var linked = inner.replace(URL_RE, function(url) {
        return '<a href="' + url + '" target="_blank" rel="noopener noreferrer" class="sw-report-link">' +
               url + '</a>';
      });
      return '<pre' + attrs + '>' + linked + '</pre>';
    });
  }

  function _wrapBuildMorningHtml() {
    if (typeof window.buildMorningStoryHtml !== 'function') return false;
    if (window.buildMorningStoryHtml._v333hWrapped) return true;
    var prev = window.buildMorningStoryHtml;
    var wrapped = function(pack) {
      var html;
      try { html = prev(pack); } catch (e) { return prev(pack); }
      if (!html) return html;
      try { return _linkifyHtml(html); }
      catch (e) {
        try { console.warn('[SW-v333h] linkify failed:', e.message); } catch(_){}
        return html;
      }
    };
    wrapped._v333hWrapped = true;
    wrapped._original = prev._original || prev;
    window.buildMorningStoryHtml = wrapped;
    try { console.log('[SW-v333h] buildMorningStoryHtml linkified'); } catch(_){}
    return true;
  }

  /* ──────────────────────────────────────────────────────────────────
     PART 5 — DOM fallback for innerHTML writes
     ────────────────────────────────────────────────────────────────── */
  function _linkifyReportDom() {
    var body = document.getElementById('cmdReportBody');
    if (!body) return;
    var preNodes = body.querySelectorAll('pre');
    var nodes = preNodes.length ? preNodes : [body];
    nodes.forEach(function(node) {
      if (node.querySelector && node.querySelector('a.sw-report-link')) return;
      var html = node.innerHTML;
      if (!URL_RE.test(html)) return;
      URL_RE.lastIndex = 0;
      node.innerHTML = html.replace(URL_RE, function(url) {
        return '<a href="' + url + '" target="_blank" rel="noopener noreferrer" class="sw-report-link">' +
               url + '</a>';
      });
    });
  }

  function _watchReportDom() {
    var body = document.getElementById('cmdReportBody');
    if (!body || window._v333hObserver) return;
    var obs = new MutationObserver(function() {
      if (window._v333hLinkTimer) return;
      window._v333hLinkTimer = requestAnimationFrame(function() {
        window._v333hLinkTimer = null;
        try { _linkifyReportDom(); } catch (e) {}
      });
    });
    obs.observe(body, { childList: true, subtree: true, characterData: true });
    window._v333hObserver = obs;
  }

  /* ──────────────────────────────────────────────────────────────────
     Boot — retry until functions exist, re-wrap after late wrappers
     ────────────────────────────────────────────────────────────────── */
  function boot() {
    var txt = _wrapBuildMorningText();
    var html = _wrapBuildMorningHtml();
    _softMergeIntoWatchlist();
    _watchReportDom();
    try { console.log('[SW-v333h] '+V333H_VERSION+' loaded · text:'+(txt?1:0)+' html:'+(html?1:0)); } catch(_){}
  }

  function bootWithRetry() {
    var tries = 0;
    var iv = setInterval(function() {
      tries++;
      if (typeof window.buildMorningStoryText === 'function') {
        boot();
        clearInterval(iv);
        setTimeout(function() {
          if (!window.buildMorningStoryText._v333hWrapped) _wrapBuildMorningText();
          if (window.buildMorningStoryHtml && !window.buildMorningStoryHtml._v333hWrapped) _wrapBuildMorningHtml();
        }, 1500);
      } else if (tries >= 30) {
        clearInterval(iv);
        try { console.warn('[SW-v333h] buildMorningStoryText not found'); } catch(_){}
      }
    }, 400);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootWithRetry);
  } else {
    bootWithRetry();
  }

  window.SW_V333H = {
    version: V333H_VERSION,
    walletAdds: window.SW_WALLET_ADDS,
    isXrpRelevant: _isXrpRelevant,
    linkifyHtml: _linkifyHtml,
    linkifyDom: _linkifyReportDom,
    rewrap: function() { _wrapBuildMorningText(); _wrapBuildMorningHtml(); }
  };
})();

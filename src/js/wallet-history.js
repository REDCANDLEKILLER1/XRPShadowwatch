/* ═══════════════════════════════════════════════════════════════════════════
   WALLET HISTORY — click a wallet, see what it actually did

   Primary ledger data only. Every row here is a real transaction returned by
   account_tx over the app's own live XRPL socket. Nothing is inferred, nothing
   is fetched from a search engine, and a counterparty is NAMED only when it is
   in the shared identity registry — otherwise it is described by role or shown
   as its address. Same rule the report follows.

   Routing note: app.js's socket handler sends ANY response carrying
   result.transactions to processTrace(), which would dump these rows into the
   wallet graph. "hist_" is excluded there so a history request stays a history
   request.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var PANEL = 'wallet-history';
  var _addr = null, _pending = false, _timer = null;

  function $(id) { return document.getElementById(id); }
  function short(a) { a = String(a || ''); return a.length > 14 ? a.slice(0, 6) + '…' + a.slice(-4) : a; }

  /* Name a counterparty the same way the report does:
     1. shared identity registry  -> the real entity
     2. watched wallet            -> its role, never the internal handle
     3. otherwise                 -> the address, which is a fact           */
  // NOTE ON SCOPE: app.js declares KNOWN_WALLETS, PRELOADED_HVTS and customHvts
  // with const/let at classic-script top level, which creates LEXICAL globals —
  // they are NOT properties of window. Reading window.PRELOADED_HVTS returns
  // undefined and the lookup silently never fires. That exact mistake is why the
  // report said "an unidentified wallet" for a year. This file is a classic
  // script loaded after app.js, so it shares that lexical scope: read the bare
  // names, guarded with typeof.
  function _reg()  { try { return (typeof window !== 'undefined' && window.SW_WALLET_IDENTITIES) || null; } catch (_) { return null; } }
  function _known(){ try { return (typeof KNOWN_WALLETS !== 'undefined') ? KNOWN_WALLETS : null; } catch (_) { return null; } }
  function _hvts() {
    var out = [];
    try { if (typeof PRELOADED_HVTS !== 'undefined' && PRELOADED_HVTS) out = out.concat(PRELOADED_HVTS); } catch (_) {}
    try { if (typeof customHvts    !== 'undefined' && customHvts)    out = out.concat(customHvts); } catch (_) {}
    return out;
  }

  function describe(addr) {
    if (!addr) return { text: 'unknown', cls: 'wh-unknown' };
    var R = _reg();
    if (R && R[addr] && R[addr].name)
      return { text: R[addr].name, cls: 'wh-named', title: addr + ' — ' + (R[addr].confidence || '') };
    var K = _known();
    if (K && K[addr] && K[addr].name)
      return { text: K[addr].name, cls: 'wh-named', title: addr };
    var H = _hvts();
    for (var i = 0; i < H.length; i++) {
      if (H[i] && H[i].address === addr) {
        var l = String(H[i].label || '');
        // an internal handle is not an identity — say what it is instead
        if (/^(SPLITTER|LARGE_RECV|WHALE_RECV|HIGHVAL|EXOUT_RECV)_/.test(l))
          return { text: 'watched wallet ' + short(addr), cls: 'wh-watched', title: addr };
        return { text: l, cls: 'wh-watched', title: addr };
      }
    }
    return { text: short(addr), cls: 'wh-unknown', title: addr };
  }

  function drops(v) {
    if (v == null) return null;
    if (typeof v === 'string' || typeof v === 'number') { var n = Number(v); return isFinite(n) ? n / 1000000 : null; }
    return null;   // issued currency, not XRP — handled by the caller
  }
  function fmtXrp(n) {
    if (n == null) return '—';
    if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.00$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return n.toFixed(n < 1 ? 4 : 2).replace(/\.?0+$/, '');
  }
  // XRPL epoch is 2000-01-01, not 1970.
  function when(rippleTime) {
    if (!rippleTime && rippleTime !== 0) return '';
    try {
      var d = new Date((rippleTime + 946684800) * 1000);
      if (isNaN(d.getTime())) return '';
      var days = Math.floor((Date.now() - d.getTime()) / 86400000);
      if (days === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (days === 1) return 'yesterday';
      if (days < 30) return days + 'd ago';
      return d.toLocaleDateString();
    } catch (_) { return ''; }
  }

  function open(addr) {
    if (!addr) return;
    _addr = addr;
    var p = $(PANEL); if (!p) return;
    p.classList.add('wh-open');
    var who = describe(addr);
    $('wh-title').textContent = who.cls === 'wh-named' ? who.text : 'Wallet history';
    $('wh-addr').textContent = addr;
    $('wh-sub').textContent = who.cls === 'wh-named'
      ? 'Identified · last 25 ledger transactions'
      : 'No published identity · last 25 ledger transactions';
    $('wh-rows').innerHTML = '<div class="wh-msg">Reading the ledger…</div>';
    _pending = true;
    clearTimeout(_timer);
    _timer = setTimeout(function () {
      if (_pending) { _pending = false;
        $('wh-rows').innerHTML = '<div class="wh-msg">No response from the ledger. The connection may be down — try again.</div>'; }
    }, 12000);
    try {
      var s = window.socket || (typeof socket !== 'undefined' ? socket : null);
      if (s && s.readyState === 1) {
        s.send(JSON.stringify({ id: 'hist_' + addr, command: 'account_tx', account: addr, limit: 25, ledger_index_min: -1, ledger_index_max: -1, forward: false }));
      } else {
        _pending = false;
        $('wh-rows').innerHTML = '<div class="wh-msg">Not connected to the XRP Ledger right now.</div>';
      }
    } catch (e) {
      _pending = false;
      $('wh-rows').innerHTML = '<div class="wh-msg">Could not reach the ledger.</div>';
    }
  }
  function close() { var p = $(PANEL); if (p) p.classList.remove('wh-open'); _pending = false; clearTimeout(_timer); }

  function handleResp(d) {
    if (!d || !d.id || d.id.indexOf('hist_') !== 0) return false;
    var addr = d.id.slice(5);
    if (addr !== _addr) return true;          // a stale response for a panel we've moved on from
    _pending = false; clearTimeout(_timer);
    var host = $('wh-rows'); if (!host) return true;

    if (d.error || !d.result || !Array.isArray(d.result.transactions)) {
      host.innerHTML = '<div class="wh-msg">' +
        (d.error === 'actNotFound' ? 'This account is not funded on the ledger.' : 'The ledger returned no history for this account.') +
        '</div>';
      return true;
    }
    var txs = d.result.transactions;
    if (!txs.length) { host.innerHTML = '<div class="wh-msg">No transactions found for this account.</div>'; return true; }

    var frag = document.createDocumentFragment();
    var shown = 0, inSum = 0, outSum = 0;
    txs.forEach(function (t) {
      var tx = t && (t.tx || t.tx_json); if (!tx) return;
      if (tx.TransactionType !== 'Payment') return;              // only value movement
      var amt = drops(tx.Amount);
      var issued = (amt == null && tx.Amount && typeof tx.Amount === 'object') ? tx.Amount : null;
      var out = tx.Account === addr;
      var other = out ? tx.Destination : tx.Account;
      if (amt != null) { if (out) outSum += amt; else inSum += amt; }

      var who = describe(other);
      var row = document.createElement('div');
      row.className = 'wh-row';
      var dir = document.createElement('span');
      dir.className = 'wh-dir ' + (out ? 'wh-out' : 'wh-in');
      dir.textContent = out ? 'OUT' : 'IN';
      var val = document.createElement('span');
      val.className = 'wh-amt';
      val.textContent = issued
        ? (Number(issued.value).toLocaleString() + ' ' + String(issued.currency).slice(0, 8))
        : fmtXrp(amt) + ' XRP';
      var arrow = document.createElement('span'); arrow.className = 'wh-arrow'; arrow.textContent = out ? '→' : '←';
      var party = document.createElement('span');
      party.className = 'wh-party ' + who.cls;
      party.textContent = who.text;
      if (who.title) party.setAttribute('title', who.title);
      var time = document.createElement('span'); time.className = 'wh-time'; time.textContent = when(tx.date);
      row.appendChild(dir); row.appendChild(val); row.appendChild(arrow); row.appendChild(party); row.appendChild(time);
      if (tx.hash) {
        row.style.cursor = 'pointer';
        row.setAttribute('title', 'Open this transaction on XRPSCAN');
        row.addEventListener('click', function () { try { window.open('https://xrpscan.com/tx/' + tx.hash, '_blank'); } catch (_) {} });
      }
      frag.appendChild(row); shown++;
    });

    host.innerHTML = '';
    if (!shown) { host.innerHTML = '<div class="wh-msg">No XRP payments in the last 25 ledger entries (offers or trust lines only).</div>'; return true; }
    var sum = document.createElement('div');
    sum.className = 'wh-summary';
    sum.textContent = shown + ' payment' + (shown === 1 ? '' : 's') + ' · in ' + fmtXrp(inSum) + ' · out ' + fmtXrp(outSum) +
                      ' · net ' + (inSum - outSum >= 0 ? '+' : '−') + fmtXrp(Math.abs(inSum - outSum)) + ' XRP';
    host.appendChild(sum);
    host.appendChild(frag);
    return true;
  }

  window.openWalletHistory = open;
  window.closeWalletHistory = close;
  window.SW_WALLET_HISTORY = { open: open, close: close, handleResp: handleResp, describe: describe };
})();

/* ════════════════════════════════════════════════════════════════════
   ESCROW WATCH  (main app — read-only)
   Persistent dashboard of XRPL escrow LOCK/UNLOCK events (Ripple's monthly
   treasury movements). Live events come from handleTx; recent history is
   backfilled read-only via account_tx for known Ripple/escrow wallets.
   Storage: localStorage XRPMAN_ESCROW_HISTORY_V1 (dedupe by hash, 30-day).
   Watchdog only — never trades/signs/submits. Entry: window.openEscrowWatch()
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var KEY = 'XRPMAN_ESCROW_HISTORY_V1';
  var HOUR = 3600000, DAY = 86400000, KEEP_MS = 30 * DAY;
  var history = load();
  var _bfRetries = 0, _bfDone = false;

  function socketReady() { return typeof socket !== 'undefined' && socket && socket.readyState === WebSocket.OPEN; }
  function esc(s) { return (window.SW && SW.escapeHtml) ? SW.escapeHtml(s) : String(s == null ? '' : s); }
  function xshort(n) { n = Number(n) || 0; if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return Math.floor(n).toLocaleString(); }
  function xrpscanTx(h) { return 'https://xrpscan.com/tx/' + encodeURIComponent(h); }

  function load() { try { var a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function persist() { try { localStorage.setItem(KEY, JSON.stringify(history)); } catch (e) {} }
  function prune() { var cut = Date.now() - KEEP_MS; history = history.filter(function (e) { return (e.ts || 0) >= cut; }); }

  // Lookback: 96h on Sat/Sun/Mon (weekend/Monday catch-up), else 36h.
  function lookbackMs() { var d = new Date().getUTCDay(); return (d === 6 || d === 0 || d === 1) ? 96 * HOUR : 36 * HOUR; }
  function inWindow(e) { return (e.ts || 0) >= (Date.now() - lookbackMs()); }

  // Parse an escrow event from a tx + meta (works for live stream and account_tx).
  function parseEscrow(t, meta, closeIso) {
    if (!t) return null;
    var type = t.TransactionType;
    if (type !== 'EscrowFinish' && type !== 'EscrowCreate') return null;
    if (meta && meta.TransactionResult && meta.TransactionResult !== 'tesSUCCESS') return null;
    var isFinish = (type === 'EscrowFinish');
    var xrp = 0, owner = t.Account, dest = null;
    var nodes = (meta && meta.AffectedNodes) || [];
    for (var i = 0; i < nodes.length; i++) {
      var nd = nodes[i].DeletedNode || nodes[i].CreatedNode;
      if (nd && nd.LedgerEntryType === 'Escrow') {
        var ff = nd.FinalFields || nd.NewFields || {};
        if (typeof ff.Amount === 'string') xrp = parseInt(ff.Amount, 10) / 1e6;
        if (ff.Destination) dest = ff.Destination;
        if (ff.Account) owner = ff.Account;
        break;
      }
    }
    if (!isFinish && xrp <= 0 && typeof t.Amount === 'string') xrp = parseInt(t.Amount, 10) / 1e6;
    if (!(xrp > 0)) return null;
    var ts = closeIso ? Date.parse(closeIso) : (typeof t.date === 'number' ? (t.date + 946684800) * 1000 : Date.now());
    return { hash: t.hash, type: isFinish ? 'UNLOCK' : 'LOCK', xrp: Math.floor(xrp),
      owner: owner, dest: isFinish ? (dest || null) : null, ts: ts || Date.now(), ledger: t.ledger_index || null };
  }

  function record(evt) {
    if (!evt || !evt.hash) return false;
    if (history.some(function (e) { return e.hash === evt.hash; })) return false; // dedupe by hash
    history.unshift(evt); prune(); persist();
    if (document.getElementById('escrow-modal')) renderPanel();
    return true;
  }

  function summary() {
    var win = history.filter(inWindow);
    var unlocks = win.filter(function (e) { return e.type === 'UNLOCK'; });
    var locks = win.filter(function (e) { return e.type === 'LOCK'; });
    var totUnlock = unlocks.reduce(function (a, e) { return a + (e.xrp || 0); }, 0);
    var totLock = locks.reduce(function (a, e) { return a + (e.xrp || 0); }, 0);
    var largest = win.slice().sort(function (a, b) { return (b.xrp || 0) - (a.xrp || 0); })[0] || null;
    return { win: win, unlocks: unlocks.length, locks: locks.length, totUnlock: totUnlock, totLock: totLock, largest: largest, lookbackH: lookbackMs() / HOUR };
  }
  // exposed so the Brief Console / report generators can reuse the same summary
  function computeSummary() { prune(); return summary(); }

  // ── read-only backfill via account_tx for known Ripple/escrow wallets ──
  function escrowWallets() {
    var out = [], seen = {};
    function add(a) { if (a && !seen[a]) { seen[a] = 1; out.push(a); } }
    try {
      (typeof PRELOADED_HVTS !== 'undefined' ? PRELOADED_HVTS : []).forEach(function (w) {
        if (w && w.address && (w.type === 'RIPPLE' || /^RIPPLE_/i.test(w.label || ''))) add(w.address);
      });
      (typeof customHvts !== 'undefined' ? customHvts : []).forEach(function (c) {
        if (c && c.address && /ripple|escrow/i.test(c.label || '')) add(c.address);
      });
    } catch (e) {}
    // Known Ripple escrow distribution accounts (ensure coverage incl. the 500M owner).
    ['r9NpyVfLfUG8hatuCCHKzosyDtKnBdsEN3', 'rMhkqz3DeU7GUUJKGZofusbrTwZe6bDyb1',
     'rMQ98K56yXJbDGv49ZSmW51sLn94Xe1mu1', 'rKveEyR1SrkWbJX214xcfH43ZsoGMb3PEv'].forEach(add);
    return out.slice(0, 24);
  }

  function backfill(force) {
    if (_bfDone && !force) return;
    if (!socketReady()) { if (_bfRetries++ < 12) setTimeout(function () { backfill(force); }, 2500); return; }
    _bfDone = true;
    var targets = escrowWallets(); var i = 0;
    targets.forEach(function (addr) {
      setTimeout(function () {
        if (!socketReady()) return;
        try { socket.send(JSON.stringify({ id: 'esc_' + addr, command: 'account_tx', account: addr, ledger_index_min: -1, ledger_index_max: -1, limit: 40, forward: false })); } catch (e) {}
      }, (i++) * 160);
    });
  }

  // routed from app.js onmessage for ids starting "esc_"
  function handleResp(d) {
    var txs = (d && d.result && d.result.transactions) || [];
    var added = 0;
    txs.forEach(function (item) {
      var t = item.tx || item.tx_json || item;
      var meta = item.meta || item.metaData;
      var evt = parseEscrow(t, meta, item.close_time_iso);
      if (evt && record(evt)) added++;
    });
    if (added && document.getElementById('escrow-modal')) renderPanel();
  }

  // ── UI ────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('escrow-style')) return;
    var s = document.createElement('style'); s.id = 'escrow-style';
    s.textContent = [
      '#escrow-modal{position:fixed;inset:0;z-index:9450;display:none;flex-direction:column;background:rgba(0,0,0,0.95);font-family:"Share Tech Mono",monospace;}',
      '#escrow-modal.active{display:flex;}',
      '#escrow-head{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid var(--lime-dim,#004400);background:rgba(0,30,0,0.6);}',
      '#escrow-head .t{font-family:"Orbitron",sans-serif;font-weight:900;letter-spacing:2px;color:#ffd700;font-size:14px;}',
      '#escrow-close{background:transparent;border:1px solid #555;color:#888;padding:5px 12px;cursor:pointer;font-size:12px;}',
      '#escrow-body{flex:1;overflow-y:auto;padding:14px;-webkit-overflow-scrolling:touch;}',
      '.esc-sum{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;}',
      '.esc-stat{border:1px solid #113311;border-radius:8px;padding:9px;background:rgba(0,18,0,0.7);}',
      '.esc-stat .k{font-size:8px;letter-spacing:1px;color:#55aa55;}',
      '.esc-stat .v{font-size:15px;font-weight:bold;color:#00ff88;margin-top:3px;}',
      '.esc-stat.lock .v{color:#ffaa00;}',
      '.esc-note{font-size:9px;color:#ccaa33;border:1px solid #443300;background:rgba(40,30,0,0.4);border-radius:6px;padding:7px;margin-bottom:12px;}',
      '.esc-row{border:1px solid #112211;border-radius:8px;padding:9px;margin-bottom:8px;background:rgba(0,12,0,0.8);}',
      '.esc-row .top{display:flex;justify-content:space-between;align-items:center;}',
      '.esc-badge{font-size:9px;font-weight:bold;padding:2px 7px;border-radius:4px;letter-spacing:1px;}',
      '.esc-badge.unlock{background:#443300;color:#ffd700;border:1px solid #ffd700;}',
      '.esc-badge.lock{background:#222;color:#ffaa00;border:1px solid #664400;}',
      '.esc-amt{font-size:15px;font-weight:bold;color:#fff;}',
      '.esc-meta{font-size:10px;color:#88aa88;margin-top:5px;line-height:1.5;word-break:break-all;}',
      '.esc-meta a{color:#66ccff;text-decoration:none;}',
      '.esc-actions{display:flex;gap:6px;margin-top:7px;}',
      '.esc-btn{flex:1;font-size:9px;font-family:"Share Tech Mono";background:#001100;border:1px solid #004400;color:#00cc66;padding:6px;border-radius:4px;cursor:pointer;text-align:center;}',
      '.esc-btn:active{background:#00cc66;color:#000;}',
      '.esc-empty{color:#557755;text-align:center;margin-top:40px;font-size:12px;letter-spacing:1px;}'
    ].join('\n');
    document.head.appendChild(s);
  }

  function build() {
    if (document.getElementById('escrow-modal')) return;
    injectStyles();
    var m = document.createElement('div'); m.id = 'escrow-modal';
    m.innerHTML = '<div id="escrow-head"><span class="t">⛓ ESCROW WATCH</span><button id="escrow-close">[ CLOSE ]</button></div><div id="escrow-body"></div>';
    document.body.appendChild(m);
    document.getElementById('escrow-close').addEventListener('click', close);
  }

  function renderPanel() {
    var body = document.getElementById('escrow-body'); if (!body) return;
    var s = computeSummary();
    var h = '';
    h += '<div class="esc-note">Treasury / supply movement. <b>Not a trade signal.</b> Lookback window: last ' + s.lookbackH + 'h · history kept 30 days (permanent only if saved to Evidence).</div>';
    h += '<div class="esc-sum">' +
      '<div class="esc-stat"><div class="k">UNLOCKED (' + s.lookbackH + 'h)</div><div class="v">' + xshort(s.totUnlock) + ' XRP</div></div>' +
      '<div class="esc-stat lock"><div class="k">LOCKED (' + s.lookbackH + 'h)</div><div class="v">' + xshort(s.totLock) + ' XRP</div></div>' +
      '<div class="esc-stat"><div class="k">EVENTS IN WINDOW</div><div class="v">' + (s.unlocks + s.locks) + '</div></div>' +
      '<div class="esc-stat"><div class="k">LARGEST EVENT</div><div class="v">' + (s.largest ? xshort(s.largest.xrp) + ' XRP' : '—') + '</div></div>' +
      '</div>';
    if (!history.length) { body.innerHTML = h + '<div class="esc-empty">No escrow unlocks or locks recorded yet.<br>Backfilling recent Ripple escrow activity…</div>'; return; }
    h += '<div style="font-size:9px;letter-spacing:1px;color:#55aa55;margin:6px 0;">RECENT ESCROW HISTORY (30D)</div>';
    history.slice(0, 100).forEach(function (e) {
      var t = e.type === 'UNLOCK' ? 'unlock' : 'lock';
      h += '<div class="esc-row"><div class="top"><span class="esc-badge ' + t + '">ESCROW ' + e.type + '</span><span class="esc-amt">' + Math.floor(e.xrp).toLocaleString() + ' XRP</span></div>' +
        '<div class="esc-meta">owner: ' + esc(e.owner || '?') + (e.dest ? ('<br>dest: ' + esc(e.dest)) : '') +
        '<br>' + (e.ts ? new Date(e.ts).toLocaleString() : '?') + (e.ledger ? (' · ledger ' + e.ledger) : '') +
        '<br>tx: <a href="' + xrpscanTx(e.hash) + '" target="_blank" rel="noopener">' + esc((e.hash || '').slice(0, 24)) + '…</a></div>' +
        '<div class="esc-actions"><a class="esc-btn" href="' + xrpscanTx(e.hash) + '" target="_blank" rel="noopener">XRPSCAN</a>' +
        '<button class="esc-btn" onclick="SW_ESCROW.saveEvidence(\'' + esc(e.hash) + '\')">SAVE TO EVIDENCE</button></div></div>';
    });
    body.innerHTML = h;
  }

  function saveEvidence(hash) {
    var e = history.filter(function (x) { return x.hash === hash; })[0]; if (!e) return;
    try { if (typeof saveCase === 'function') saveCase({ hash: e.hash, amt: e.xrp, from: e.owner, to: e.dest || e.owner, type: 'ESCROW ' + e.type }); } catch (err) {}
  }

  function open() { build(); document.getElementById('escrow-modal').classList.add('active'); renderPanel(); backfill(); }
  function close() { var m = document.getElementById('escrow-modal'); if (m) m.classList.remove('active'); }

  // Kick a backfill shortly after load so history is populated without the panel open.
  function _init() { setTimeout(function () { try { backfill(); } catch (e) {} }, 4000); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _init); else _init();

  window.SW_ESCROW = { record: record, parseEscrow: parseEscrow, backfill: backfill, handleResp: handleResp,
    computeSummary: computeSummary, escrowWallets: escrowWallets, saveEvidence: saveEvidence, history: function () { return history; } };
  window.openEscrowWatch = open;
  window.closeEscrowWatch = close;
})();

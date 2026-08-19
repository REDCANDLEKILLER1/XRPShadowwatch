/* ════════════════════════════════════════════════════════════════════
   ESCROW WATCH  (main app — read-only)
   Two separate measurements:
     1) CURRENT RIPPLE ESCROW POSITION — validated-ledger Escrow objects owned
        by Ripple's 20 published public escrow wallets.
     2) RECENT ESCROW ACTIVITY — observed EscrowCreate/EscrowFinish events.
   Other XRPL escrows remain visible separately. No signing/trading/submission.
   Storage: localStorage XRPMAN_ESCROW_HISTORY_V1 (event history, 30-day).
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var KEY = 'XRPMAN_ESCROW_HISTORY_V1';
  var HOUR = 3600000, DAY = 86400000, KEEP_MS = 30 * DAY;
  var REGISTRY_SRC = '/src/shared/ripple-escrow-registry.js?v=20260816.1';
  var history = load();
  var _bfRetries = 0, _bfDone = false, _posRetries = 0;
  var _objReqs = {}, _reqSeq = 0;
  var _position = freshPosition();

  function socketReady() { return typeof socket !== 'undefined' && socket && socket.readyState === WebSocket.OPEN; }
  function esc(s) { return (window.SW && SW.escapeHtml) ? SW.escapeHtml(s) : String(s == null ? '' : s); }
  function xshort(n) { n = Number(n) || 0; if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return Math.floor(n).toLocaleString(); }
  function xrpscanTx(h) { return 'https://xrpscan.com/tx/' + encodeURIComponent(h); }
  function registry() { return window.SW_RIPPLE_ESCROW_REGISTRY || null; }
  function publicRippleAddresses() { var r = registry(); return r && Array.isArray(r.addresses) ? r.addresses.slice() : []; }

  function ensureRegistry(cb) {
    if (registry()) { if (cb) cb(registry()); return; }
    var old = document.querySelector('script[data-sw-ripple-escrow-registry]');
    if (old) { if (cb) old.addEventListener('load', function () { cb(registry()); }, { once: true }); return; }
    var s = document.createElement('script');
    s.src = REGISTRY_SRC; s.async = false; s.setAttribute('data-sw-ripple-escrow-registry', '2026.08.16.1');
    if (cb) s.addEventListener('load', function () { cb(registry()); }, { once: true });
    (document.head || document.documentElement).appendChild(s);
  }

  function isRippleOwner(addr) {
    if (!addr) return false;
    var r = registry();
    return !!(r && r.by_address && r.by_address[addr]);
  }
  function escrowCategory(evt) { return evt && isRippleOwner(evt.owner) ? 'RIPPLE' : 'OTHER_XRPL'; }

  function load() { try { var a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function persist() { try { localStorage.setItem(KEY, JSON.stringify(history)); } catch (e) {} }
  function prune() { var cut = Date.now() - KEEP_MS; history = history.filter(function (e) { return (e.ts || 0) >= cut; }); }
  function lookbackMs() { var d = new Date().getUTCDay(); return (d === 6 || d === 0 || d === 1) ? 96 * HOUR : 36 * HOUR; }
  function inWindow(e) { return (e.ts || 0) >= (Date.now() - lookbackMs()); }

  function parseEscrow(t, meta, closeIso) {
    if (!t) return null;
    var type = t.TransactionType;
    if (type !== 'EscrowFinish' && type !== 'EscrowCreate') return null;
    if (meta && meta.TransactionResult && meta.TransactionResult !== 'tesSUCCESS') return null;
    var isFinish = type === 'EscrowFinish';
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
    return { hash: t.hash, type: isFinish ? 'UNLOCK' : 'LOCK', xrp: Math.floor(xrp), owner: owner,
      dest: isFinish ? (dest || null) : null, ts: ts || Date.now(), ledger: t.ledger_index || null };
  }

  function record(evt) {
    if (!evt || !evt.hash) return false;
    if (history.some(function (e) { return e.hash === evt.hash; })) return false;
    history.unshift(evt); prune(); persist();
    renderHomeLine();
    if (document.getElementById('escrow-modal')) renderPanel();
    return true;
  }

  function laneSummary(rows) {
    var unlocks = rows.filter(function (e) { return e.type === 'UNLOCK'; });
    var locks = rows.filter(function (e) { return e.type === 'LOCK'; });
    return {
      win: rows, unlocks: unlocks.length, locks: locks.length,
      totUnlock: unlocks.reduce(function (a, e) { return a + Number(e.xrp || 0); }, 0),
      totLock: locks.reduce(function (a, e) { return a + Number(e.xrp || 0); }, 0),
      largest: rows.slice().sort(function (a, b) { return Number(b.xrp || 0) - Number(a.xrp || 0); })[0] || null
    };
  }

  function summary() {
    var win = history.filter(inWindow);
    var all = laneSummary(win);
    all.lookbackH = lookbackMs() / HOUR;
    all.ripple = laneSummary(win.filter(function (e) { return escrowCategory(e) === 'RIPPLE'; }));
    all.other = laneSummary(win.filter(function (e) { return escrowCategory(e) === 'OTHER_XRPL'; }));
    return all;
  }
  function computeSummary() { prune(); return summary(); }

  // Official public Ripple escrow owners come first; optional additional watched
  // Ripple/escrow accounts are retained for event history but never counted in
  // the CURRENT RIPPLE ESCROW POSITION unless they are in the canonical registry.
  function escrowWallets() {
    var out = [], seen = {};
    function add(a) { if (a && !seen[a]) { seen[a] = 1; out.push(a); } }
    publicRippleAddresses().forEach(add);
    try {
      (typeof PRELOADED_HVTS !== 'undefined' ? PRELOADED_HVTS : []).forEach(function (w) {
        if (w && w.address && (w.type === 'RIPPLE' || /^RIPPLE_/i.test(w.label || ''))) add(w.address);
      });
      (typeof customHvts !== 'undefined' ? customHvts : []).forEach(function (c) {
        if (c && c.address && /ripple|escrow/i.test(c.label || '')) add(c.address);
      });
    } catch (e) {}
    return out.slice(0, 40);
  }

  function backfill(force) {
    if (_bfDone && !force) return;
    if (!registry()) { ensureRegistry(function () { backfill(force); }); return; }
    if (!socketReady()) { if (_bfRetries++ < 12) setTimeout(function () { backfill(force); }, 2500); return; }
    _bfDone = true;
    var targets = escrowWallets(), i = 0;
    targets.forEach(function (addr) {
      setTimeout(function () {
        if (!socketReady()) return;
        try { socket.send(JSON.stringify({ id: 'esc_tx_' + addr, command: 'account_tx', account: addr,
          ledger_index_min: -1, ledger_index_max: -1, limit: 40, forward: false })); } catch (e) {}
      }, (i++) * 120);
    });
  }

  // ── CURRENT RIPPLE ESCROW POSITION — validated ledger objects ─────────
  function freshPosition() {
    return { status: 'WAITING', expected_owners: 20, answered_owners: 0, failed_owners: 0,
      active_objects: 0, locked_xrp: 0, non_xrp_objects: 0, complete: false,
      started_at: null, completed_at: null, ledger_index: null, generation: 0,
      failures: [], owner_status: {}, _objects: {} };
  }

  function publicPosition() {
    return {
      status: _position.status, expected_owners: _position.expected_owners,
      answered_owners: _position.answered_owners, failed_owners: _position.failed_owners,
      active_objects: _position.active_objects, locked_xrp: _position.locked_xrp,
      non_xrp_objects: _position.non_xrp_objects, complete: _position.complete,
      started_at: _position.started_at, completed_at: _position.completed_at,
      ledger_index: _position.ledger_index, generation: _position.generation,
      failures: _position.failures.slice()
    };
  }

  function recomputePosition() {
    var xrp = 0, count = 0, nonXrp = 0;
    Object.keys(_position._objects).forEach(function (k) {
      var o = _position._objects[k] || {};
      if (typeof o.Amount === 'string' && /^\d+$/.test(o.Amount)) { xrp += Number(o.Amount) / 1e6; count++; }
      else { nonXrp++; }
    });
    _position.locked_xrp = xrp;
    _position.active_objects = count;
    _position.non_xrp_objects = nonXrp;
    var vals = Object.keys(_position.owner_status).map(function (a) { return _position.owner_status[a]; });
    _position.answered_owners = vals.filter(function (v) { return v === 'DONE'; }).length;
    _position.failed_owners = vals.filter(function (v) { return v === 'FAILED'; }).length;
    var finished = _position.answered_owners + _position.failed_owners;
    if (finished >= _position.expected_owners) {
      _position.complete = _position.failed_owners === 0 && _position.answered_owners === _position.expected_owners;
      _position.status = _position.complete ? 'COMPLETE' : 'PARTIAL';
      _position.completed_at = new Date().toISOString();
    } else {
      _position.complete = false;
      _position.status = 'LOADING';
    }
    renderHomeLine();
    if (document.getElementById('escrow-modal')) renderPanel();
    try { window.dispatchEvent(new CustomEvent('shadowwatch:ripple-escrow-position', { detail: publicPosition() })); } catch (e) {}
  }

  function sendObjectPage(address, marker, generation) {
    if (!socketReady() || generation !== _position.generation) return;
    var id = 'esc_obj_' + generation + '_' + (++_reqSeq);
    _objReqs[id] = { address: address, generation: generation };
    var req = { id: id, command: 'account_objects', account: address, type: 'escrow', ledger_index: 'validated', limit: 400 };
    if (marker) req.marker = marker;
    try { socket.send(JSON.stringify(req)); }
    catch (e) { delete _objReqs[id]; markOwnerFailed(address, e && e.message || 'send failed', generation); }
  }

  function markOwnerFailed(address, reason, generation) {
    if (generation !== _position.generation) return;
    _position.owner_status[address] = 'FAILED';
    if (_position.failures.indexOf(address) < 0) _position.failures.push(address);
    recomputePosition();
  }

  function objectKey(o, address, n) {
    return o && (o.index || o.LedgerIndex || o.Index) || [address, o && o.Sequence, o && o.Amount, o && o.FinishAfter, n].join(':');
  }

  function handleObjectResp(d, req) {
    delete _objReqs[String(d && d.id || '')];
    if (!req || req.generation !== _position.generation) return;
    if (!d || d.status === 'error' || d.error || (d.result && d.result.error)) {
      markOwnerFailed(req.address, String(d && (d.error_message || d.error) || 'XRPL response error'), req.generation); return;
    }
    var res = d.result || {}, rows = res.account_objects || [];
    if (res.ledger_index) _position.ledger_index = res.ledger_index;
    rows.forEach(function (o, i) {
      if (!o || (o.LedgerEntryType && o.LedgerEntryType !== 'Escrow')) return;
      _position._objects[objectKey(o, req.address, i)] = o;
    });
    if (res.marker) { sendObjectPage(req.address, res.marker, req.generation); return; }
    _position.owner_status[req.address] = 'DONE';
    recomputePosition();
  }

  function refreshRipplePosition(force) {
    if (!registry()) { ensureRegistry(function () { refreshRipplePosition(force); }); return; }
    if (!socketReady()) {
      _position.status = 'WAITING'; renderHomeLine();
      if (_posRetries++ < 12) setTimeout(function () { refreshRipplePosition(force); }, 2500);
      return;
    }
    if (!force && _position.complete && _position.completed_at && Date.now() - Date.parse(_position.completed_at) < 5 * 60000) return;
    var r = registry(), addresses = (r && r.addresses || []).slice();
    _position = freshPosition();
    _position.generation = Date.now();
    _position.expected_owners = addresses.length || 20;
    _position.started_at = new Date().toISOString();
    _position.status = 'LOADING';
    addresses.forEach(function (a) { _position.owner_status[a] = 'PENDING'; });
    renderHomeLine();
    addresses.forEach(function (address, i) {
      setTimeout(function () { sendObjectPage(address, null, _position.generation); }, i * 90);
    });
  }

  // app.js routes every response whose id starts with "esc_" here.
  function handleResp(d) {
    var id = String(d && d.id || '');
    if (_objReqs[id]) { handleObjectResp(d, _objReqs[id]); return; }
    var txs = (d && d.result && d.result.transactions) || [], added = 0;
    txs.forEach(function (item) {
      var t = item.tx || item.tx_json || item, meta = item.meta || item.metaData;
      var evt = parseEscrow(t, meta, item.close_time_iso);
      if (evt && record(evt)) added++;
    });
    if (added && document.getElementById('escrow-modal')) renderPanel();
  }

  // ── HOME — dedicated first-class Ripple escrow line ──────────────────
  function mountHomeLine() {
    if (document.getElementById('sw-ripple-escrow-home')) return true;
    var grid = document.querySelector('.dash-card-grid');
    if (!grid) return false;
    var b = document.createElement('button');
    b.type = 'button'; b.id = 'sw-ripple-escrow-home';
    b.setAttribute('aria-label', 'Open Ripple Escrow Watch');
    b.innerHTML = '<span class="sw-re-k">RIPPLE ESCROW LOCKED</span>' +
      '<span class="sw-re-v" id="homeRippleEscrowLocked">CHECKING XRPL…</span>' +
      '<span class="sw-re-m" id="homeRippleEscrowMeta">ESCROW WATCH · 0/20 PUBLIC OWNERS</span>' +
      '<span class="sw-re-r" id="homeRippleEscrowRecent">RECENT ACTIVITY · CHECKING…</span>';
    b.addEventListener('click', open);
    grid.appendChild(b);
    var st = document.createElement('style'); st.id = 'sw-ripple-escrow-home-style';
    st.textContent = '#sw-ripple-escrow-home{grid-column:1/-1;width:100%;display:grid;grid-template-columns:minmax(140px,.8fr) minmax(150px,1fr) minmax(210px,1.3fr);grid-template-areas:"k v m" "k v r";gap:2px 14px;align-items:center;text-align:left;padding:12px 14px;border:1px solid rgba(255,200,61,.48);border-left:4px solid #ffc83d;border-radius:10px;background:linear-gradient(90deg,rgba(255,200,61,.08),rgba(0,255,0,.035));color:#e6f1ea;cursor:pointer;box-sizing:border-box;font-family:Rajdhani,sans-serif}.sw-re-k{grid-area:k;font:900 11px Orbitron,sans-serif;letter-spacing:.12em;color:#ffc83d}.sw-re-v{grid-area:v;font:900 24px Orbitron,sans-serif;color:#00ff00;white-space:nowrap}.sw-re-m{grid-area:m;font:700 10px Rajdhani,sans-serif;letter-spacing:.08em;color:#9fc7aa}.sw-re-r{grid-area:r;font:600 9.5px "Share Tech Mono",monospace;color:#7c8c86}@media(max-width:620px){#sw-ripple-escrow-home{grid-template-columns:1fr;grid-template-areas:"k" "v" "m" "r";gap:5px;padding:11px 12px}.sw-re-v{font-size:21px}}';
    document.head.appendChild(st);
    renderHomeLine(); return true;
  }

  function renderHomeLine() {
    mountHomeLine();
    var val = document.getElementById('homeRippleEscrowLocked'), meta = document.getElementById('homeRippleEscrowMeta'), recent = document.getElementById('homeRippleEscrowRecent');
    if (!val || !meta || !recent) return;
    if (_position.complete) val.textContent = xshort(_position.locked_xrp) + ' XRP';
    else if (_position.status === 'PARTIAL') val.textContent = 'PARTIAL — RETRY';
    else val.textContent = 'CHECKING XRPL…';
    meta.textContent = 'ESCROW WATCH · ' + _position.answered_owners + '/' + _position.expected_owners + ' PUBLIC OWNERS' +
      (_position.complete ? ' · ' + _position.active_objects + ' ACTIVE OBJECTS' : (_position.failed_owners ? ' · ' + _position.failed_owners + ' FAILED' : ''));
    var s = computeSummary();
    recent.textContent = 'LAST ' + s.lookbackH + 'H · ' + s.ripple.unlocks + ' RELEASE' + (s.ripple.unlocks === 1 ? '' : 'S') + ' · ' + s.ripple.locks + ' NEW LOCK' + (s.ripple.locks === 1 ? '' : 'S');
  }

  // ── MODAL UI ─────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('escrow-style')) return;
    var s = document.createElement('style'); s.id = 'escrow-style';
    s.textContent = [
      '#escrow-modal{position:fixed;inset:0;z-index:9450;display:none;flex-direction:column;background:rgba(0,0,0,.96);font-family:"Share Tech Mono",monospace}',
      '#escrow-modal.active{display:flex}','#escrow-head{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #443300;background:rgba(35,25,0,.55)}',
      '#escrow-head .t{font-family:"Orbitron",sans-serif;font-weight:900;letter-spacing:2px;color:#ffd700;font-size:14px}','#escrow-close{background:transparent;border:1px solid #555;color:#888;padding:5px 12px;cursor:pointer;font-size:12px}',
      '#escrow-body{flex:1;overflow-y:auto;padding:14px;-webkit-overflow-scrolling:touch}',
      '.esc-current{border:1px solid rgba(255,200,61,.55);border-left:4px solid #ffc83d;border-radius:10px;padding:13px;margin-bottom:12px;background:linear-gradient(90deg,rgba(255,200,61,.09),rgba(0,255,0,.035))}',
      '.esc-current .k{font:900 10px Orbitron,sans-serif;letter-spacing:1.5px;color:#ffc83d}.esc-current .v{font:900 27px Orbitron,sans-serif;color:#00ff88;margin:6px 0 4px}.esc-current .m{font-size:10px;color:#88aa88;line-height:1.5}.esc-current .warn{color:#ffb828}',
      '.esc-sum{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}.esc-stat{border:1px solid #113311;border-radius:8px;padding:9px;background:rgba(0,18,0,.7)}.esc-stat .k{font-size:8px;letter-spacing:1px;color:#55aa55}.esc-stat .v{font-size:15px;font-weight:bold;color:#00ff88;margin-top:3px}.esc-stat.lock .v{color:#ffaa00}',
      '.esc-note{font-size:9px;color:#ccaa33;border:1px solid #443300;background:rgba(40,30,0,.4);border-radius:6px;padding:7px;margin-bottom:12px}.esc-lane{margin:14px 0 7px;padding:7px 9px;border-left:3px solid #00ff00;background:rgba(0,35,0,.45)}.esc-lane.other{border-left-color:#66ccff;background:rgba(0,20,35,.45)}.esc-lane .name{font-size:11px;font-weight:bold;letter-spacing:1.5px;color:#00ff88}.esc-lane.other .name{color:#66ccff}.esc-lane .sub{font-size:9px;color:#668866;margin-top:3px}',
      '.esc-row{border:1px solid #112211;border-radius:8px;padding:9px;margin-bottom:8px;background:rgba(0,12,0,.8)}.esc-row .top{display:flex;justify-content:space-between;align-items:center}.esc-badge{font-size:9px;font-weight:bold;padding:2px 7px;border-radius:4px;letter-spacing:1px}.esc-badge.unlock{background:#443300;color:#ffd700;border:1px solid #ffd700}.esc-badge.lock{background:#222;color:#ffaa00;border:1px solid #664400}.esc-amt{font-size:15px;font-weight:bold;color:#fff}.esc-meta{font-size:10px;color:#88aa88;margin-top:5px;line-height:1.5;word-break:break-all}.esc-meta a{color:#66ccff;text-decoration:none}.esc-actions{display:flex;gap:6px;margin-top:7px}.esc-btn{flex:1;font-size:9px;font-family:"Share Tech Mono";background:#001100;border:1px solid #004400;color:#00cc66;padding:6px;border-radius:4px;cursor:pointer;text-align:center}.esc-empty{color:#557755;text-align:center;margin:18px 0;font-size:11px;letter-spacing:1px}'
    ].join('\n');
    document.head.appendChild(s);
  }

  function build() {
    if (document.getElementById('escrow-modal')) return;
    injectStyles();
    var m = document.createElement('div'); m.id = 'escrow-modal';
    m.innerHTML = '<div id="escrow-head"><span class="t">⛓ RIPPLE ESCROW / ESCROW WATCH</span><button id="escrow-close">[ CLOSE ]</button></div><div id="escrow-body"></div>';
    document.body.appendChild(m); document.getElementById('escrow-close').addEventListener('click', close);
  }

  function renderRows(rows, lane) {
    var h = '';
    rows.forEach(function (e) {
      var t = e.type === 'UNLOCK' ? 'unlock' : 'lock';
      h += '<div class="esc-row"><div class="top"><span class="esc-badge ' + t + '">' + lane + ' · ' + e.type + '</span><span class="esc-amt">' + Math.floor(e.xrp).toLocaleString() + ' XRP</span></div>' +
        '<div class="esc-meta">owner: ' + esc(e.owner || '?') + (e.dest ? '<br>dest: ' + esc(e.dest) : '') + '<br>' + (e.ts ? new Date(e.ts).toLocaleString() : '?') + (e.ledger ? ' · ledger ' + e.ledger : '') +
        '<br>tx: <a href="' + xrpscanTx(e.hash) + '" target="_blank" rel="noopener">' + esc((e.hash || '').slice(0, 24)) + '…</a></div>' +
        '<div class="esc-actions"><a class="esc-btn" href="' + xrpscanTx(e.hash) + '" target="_blank" rel="noopener">XRPSCAN</a><button class="esc-btn" onclick="SW_ESCROW.saveEvidence(\'' + esc(e.hash) + '\')">SAVE TO EVIDENCE</button></div></div>';
    }); return h;
  }

  function renderPanel() {
    var body = document.getElementById('escrow-body'); if (!body) return;
    var s = computeSummary(), rippleHistory = history.filter(function (e) { return escrowCategory(e) === 'RIPPLE'; }), otherHistory = history.filter(function (e) { return escrowCategory(e) === 'OTHER_XRPL'; });
    var h = '<div class="esc-current"><div class="k">RIPPLE ESCROW — CURRENT VALIDATED-LEDGER POSITION</div>';
    if (_position.complete) h += '<div class="v">' + xshort(_position.locked_xrp) + ' XRP LOCKED</div><div class="m">' + _position.active_objects + ' active escrow objects · coverage ' + _position.answered_owners + '/' + _position.expected_owners + ' published Ripple escrow owners' + (_position.ledger_index ? ' · validated ledger ' + _position.ledger_index : '') + '</div>';
    else if (_position.status === 'PARTIAL') h += '<div class="v warn">PARTIAL — RETRY REQUIRED</div><div class="m">' + _position.answered_owners + '/' + _position.expected_owners + ' owners answered · ' + _position.failed_owners + ' failed. No incomplete XRP total is presented as final.</div>';
    else h += '<div class="v">CHECKING XRPL…</div><div class="m">' + _position.answered_owners + '/' + _position.expected_owners + ' published Ripple escrow owners answered.</div>';
    h += '<div class="m" style="margin-top:7px">Recent activity is separate: last ' + s.lookbackH + 'h · ' + s.ripple.unlocks + ' release(s) · ' + s.ripple.locks + ' new lock(s).</div></div>';
    h += '<div class="esc-note"><b>ESCROW WATCH</b> separates current locked inventory from recent create/finish activity. A quiet 96h window never means Ripple escrow is empty. Other XRPL escrows remain a separate lane.</div>';
    h += '<div class="esc-sum"><div class="esc-stat"><div class="k">ALL UNLOCKED (' + s.lookbackH + 'h)</div><div class="v">' + xshort(s.totUnlock) + ' XRP</div></div><div class="esc-stat lock"><div class="k">ALL LOCKED (' + s.lookbackH + 'h)</div><div class="v">' + xshort(s.totLock) + ' XRP</div></div><div class="esc-stat"><div class="k">RIPPLE EVENTS</div><div class="v">' + (s.ripple.unlocks + s.ripple.locks) + '</div></div><div class="esc-stat"><div class="k">OTHER XRPL EVENTS</div><div class="v">' + (s.other.unlocks + s.other.locks) + '</div></div></div>';
    h += '<div class="esc-lane"><div class="name">RIPPLE ESCROW — RECENT ACTIVITY</div><div class="sub">' + s.ripple.unlocks + ' release(s) · ' + xshort(s.ripple.totUnlock) + ' XRP released · ' + s.ripple.locks + ' new lock(s) · ' + xshort(s.ripple.totLock) + ' XRP locked</div></div>';
    h += rippleHistory.length ? renderRows(rippleHistory.slice(0, 50), 'RIPPLE ESCROW') : '<div class="esc-empty">No Ripple escrow create/finish events recorded in retained history. Current locked inventory is shown above independently.</div>';
    h += '<div class="esc-lane other"><div class="name">OTHER XRPL ESCROWS</div><div class="sub">' + s.other.unlocks + ' release(s) · ' + xshort(s.other.totUnlock) + ' XRP released · ' + s.other.locks + ' lock(s) · ' + xshort(s.other.totLock) + ' XRP locked</div></div>';
    h += otherHistory.length ? renderRows(otherHistory.slice(0, 50), 'OTHER XRPL') : '<div class="esc-empty">No non-Ripple XRPL escrow events recorded in retained history.</div>';
    body.innerHTML = h;
  }

  function saveEvidence(hash) { var e = history.filter(function (x) { return x.hash === hash; })[0]; if (!e) return; try { if (typeof saveCase === 'function') saveCase({ hash:e.hash, amt:e.xrp, from:e.owner, to:e.dest || e.owner, type:'ESCROW ' + e.type }); } catch (err) {} }
  function open() { build(); document.getElementById('escrow-modal').classList.add('active'); renderPanel(); backfill(); refreshRipplePosition(false); }
  function close() { var m = document.getElementById('escrow-modal'); if (m) m.classList.remove('active'); }

  function syncMenuLabel() {
    try { var items = document.querySelectorAll('.menu-item'); for (var i=0;i<items.length;i++) { var b=items[i].querySelector('b'); if (!b || (b.textContent.trim() !== 'ESCROW WATCH' && b.textContent.trim() !== 'ESCROWS')) continue; b.textContent='RIPPLE ESCROW / ESCROWS'; var sub=items[i].querySelector('i'); if (sub) sub.textContent='Current Ripple lock + recent XRPL escrow activity'; break; } } catch (e) {}
  }

  function _init() {
    syncMenuLabel(); mountHomeLine();
    ensureRegistry(function () {
      renderHomeLine();
      setTimeout(function () { try { backfill(); refreshRipplePosition(false); } catch (e) {} }, 4000);
    });
    var tries=0, timer=setInterval(function(){ tries++; if (mountHomeLine() || tries>30) clearInterval(timer); }, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _init); else _init();

  window.SW_ESCROW = {
    record: record, parseEscrow: parseEscrow, backfill: backfill, handleResp: handleResp,
    computeSummary: computeSummary, escrowWallets: escrowWallets, classify: escrowCategory,
    saveEvidence: saveEvidence, history: function () { return history; },
    refreshRipplePosition: refreshRipplePosition, currentRipplePosition: publicPosition,
    rippleRegistry: function () { return registry(); }, read_only: true
  };
  window.openEscrowWatch = open;
  window.closeEscrowWatch = close;
})();

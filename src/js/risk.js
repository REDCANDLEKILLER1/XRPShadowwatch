/* ════════════════════════════════════════════════════════════════════
   ACCOUNT / ISSUER RISK ASSESSMENT  (self-contained module)
   Uses the live XRPL WebSocket (global `socket`) to pull account_info,
   gateway_balances, account_lines and account_tx for an r-address, then
   scores a heuristic risk verdict. Not financial advice.
   Entry: window.openRiskPanel(prefillAddr)  ·  responses routed here from
   app.js onmessage via window.__riskOnMessage(d) for ids starting "risk_".
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // XRPL AccountRoot lsf flags
  var F = {
    DEFAULT_RIPPLE: 0x00800000, DEPOSIT_AUTH: 0x01000000, DISABLE_MASTER: 0x00100000,
    GLOBAL_FREEZE: 0x00400000, NO_FREEZE: 0x00200000, REQUIRE_AUTH: 0x00040000,
    REQUIRE_DEST_TAG: 0x00020000, DISALLOW_XRP: 0x00080000
  };
  var BLACKHOLE = ['rrrrrrrrrrrrrrrrrrrrrhoLvTp', 'rrrrrrrrrrrrrrrrrrrrBZbvji', 'rrrrrrrrrrrrrrrrrNAMEtxvNvQ'];
  var ADDR_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
  var R = null; // active assessment

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function hexToStr(h) { try { return decodeURIComponent(h.replace(/(..)/g, '%$1')); } catch (e) { try { return h.replace(/(..)/g, function (m, p) { return String.fromCharCode(parseInt(p, 16)); }); } catch (_) { return h; } } }
  function socketReady() { return typeof socket !== 'undefined' && socket && socket.readyState === WebSocket.OPEN; }
  function send(o) { if (!socketReady()) return false; try { socket.send(JSON.stringify(o)); return true; } catch (e) { return false; } }

  // ── styles (injected once) ───────────────────────────────────────────
  function injectStyles() {
    if ($('risk-style')) return;
    var s = document.createElement('style'); s.id = 'risk-style';
    s.textContent = [
      '#risk-modal{position:fixed;inset:0;z-index:9400;display:none;flex-direction:column;background:rgba(0,0,0,0.94);font-family:"Share Tech Mono",monospace;}',
      '#risk-modal.active{display:flex;}',
      '#risk-head{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid var(--lime-dim,#004400);background:rgba(0,30,0,0.6);}',
      '#risk-head .t{font-family:"Orbitron",sans-serif;font-weight:900;letter-spacing:2px;color:var(--lime-main,#0f0);font-size:14px;}',
      '#risk-close{background:transparent;border:1px solid #555;color:#888;padding:5px 12px;cursor:pointer;font-size:12px;}',
      '#risk-bar{display:flex;gap:8px;padding:12px;border-bottom:1px solid #112211;}',
      '#risk-input{flex:1;min-width:0;background:#000;border:1px solid var(--lime-dim,#004400);color:var(--lime-main,#0f0);padding:10px;font-family:"Share Tech Mono",monospace;font-size:13px;border-radius:6px;}',
      '#risk-run{background:#001100;border:1px solid var(--lime-main,#0f0);color:var(--lime-main,#0f0);padding:0 16px;font-weight:bold;cursor:pointer;border-radius:6px;letter-spacing:1px;font-family:"Orbitron",sans-serif;font-size:12px;}',
      '#risk-run:active{background:var(--lime-main,#0f0);color:#000;}',
      '#risk-body{flex:1;overflow-y:auto;padding:14px;-webkit-overflow-scrolling:touch;}',
      '.risk-score{display:flex;align-items:center;gap:14px;padding:14px;border-radius:10px;border:1px solid;margin-bottom:14px;}',
      '.risk-score .num{font-family:"Orbitron",sans-serif;font-size:34px;font-weight:900;line-height:1;}',
      '.risk-score .band{font-size:11px;letter-spacing:2px;opacity:0.85;}',
      '.risk-find{display:flex;gap:10px;padding:9px 10px;border-bottom:1px solid #0e1a0e;font-size:12px;line-height:1.4;}',
      '.risk-find .ic{flex-shrink:0;width:18px;text-align:center;font-weight:bold;}',
      '.rf-bad{color:#ff5555;}.rf-warn{color:#ffaa00;}.rf-good{color:#33dd66;}.rf-neu{color:#88aa88;}',
      '.risk-sec{font-size:9px;letter-spacing:1.5px;color:#55aa55;margin:14px 0 6px;}',
      '.risk-kv{display:flex;justify-content:space-between;font-size:11px;color:#bdf;padding:3px 0;border-bottom:1px solid #0c140c;}',
      '.risk-kv span:first-child{color:#779977;}',
      '#risk-disc{font-size:9px;color:#557755;margin-top:16px;line-height:1.5;border-top:1px solid #112211;padding-top:10px;}'
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── modal DOM (built once) ───────────────────────────────────────────
  function build() {
    if ($('risk-modal')) return;
    injectStyles();
    var m = document.createElement('div'); m.id = 'risk-modal';
    m.innerHTML =
      '<div id="risk-head"><span class="t">CA / ACCOUNT RISK ASSESSMENT</span><button id="risk-close">[ CLOSE ]</button></div>' +
      '<div id="risk-bar"><input id="risk-input" placeholder="r... XRPL address / token issuer" autocapitalize="off" autocomplete="off" spellcheck="false"><button id="risk-run">ASSESS</button></div>' +
      '<div id="risk-body"><div style="color:#557755;text-align:center;margin-top:40px;font-size:12px;letter-spacing:1px;">Enter an XRPL r-address to assess.</div></div>';
    document.body.appendChild(m);
    $('risk-close').addEventListener('click', closePanel);
    $('risk-run').addEventListener('click', run);
    $('risk-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
  }

  function closePanel() { var m = $('risk-modal'); if (m) m.classList.remove('active'); }

  function openPanel(prefill) {
    build();
    $('risk-modal').classList.add('active');
    if (prefill) { $('risk-input').value = prefill; run(); }
    else $('risk-input').focus();
  }

  function status(msg, isErr) {
    var b = $('risk-body'); if (!b) return;
    b.innerHTML = '<div style="text-align:center;margin-top:40px;font-size:12px;letter-spacing:1px;color:' + (isErr ? '#ff6666' : '#557755') + '">' + esc(msg) + '</div>';
  }

  function run() {
    build();
    var addr = ($('risk-input').value || '').trim();
    if (!addr) return status('Enter an r... address.', true);
    if (!ADDR_RE.test(addr)) return status('"' + addr + '" is not a valid XRPL r-address.', true);
    if (!socketReady()) return status('Ledger uplink not ready — activate / wait for ACTIVE, then retry.', true);
    R = { addr: addr, info: null, gw: null, lines: null, tx: null, first: null, pending: { info: 1, gw: 1, lines: 1, tx: 1, first: 1 } };
    status('◐ Scanning ledger for ' + addr.slice(0, 10) + '…');
    var ok = send({ id: 'risk_info_' + addr, command: 'account_info', account: addr, ledger_index: 'validated' })
      && send({ id: 'risk_gw_' + addr, command: 'gateway_balances', account: addr, ledger_index: 'validated' })
      && send({ id: 'risk_lines_' + addr, command: 'account_lines', account: addr, limit: 400 })
      && send({ id: 'risk_tx_' + addr, command: 'account_tx', account: addr, ledger_index_min: -1, ledger_index_max: -1, limit: 200, forward: false })
      && send({ id: 'risk_first_' + addr, command: 'account_tx', account: addr, ledger_index_min: -1, ledger_index_max: -1, limit: 1, forward: true });
    if (!ok) return status('Uplink dropped mid-request — retry.', true);
    R.timer = setTimeout(finalize, 15000);
  }

  // routed from app.js onmessage
  window.__riskOnMessage = function (d) {
    if (!R || !d || !d.id) return;
    var a = R.addr;
    if (d.id === 'risk_info_' + a) { R.info = d; delete R.pending.info; }
    else if (d.id === 'risk_gw_' + a) { R.gw = d; delete R.pending.gw; }
    else if (d.id === 'risk_lines_' + a) { R.lines = d; delete R.pending.lines; }
    else if (d.id === 'risk_tx_' + a) { R.tx = d; delete R.pending.tx; }
    else if (d.id === 'risk_first_' + a) { R.first = d; delete R.pending.first; }
    else return;
    if (Object.keys(R.pending).length === 0) finalize();
  };

  function finalize() {
    if (!R || R.done) return;
    R.done = true; if (R.timer) clearTimeout(R.timer);
    render(assess(R));
  }

  // ── scoring ──────────────────────────────────────────────────────────
  function assess(r) {
    var find = [], score = 0, stats = {};
    var info = r.info && r.info.result, ad = info && info.account_data;
    var notFound = (r.info && r.info.error === 'actNotFound') || (info && info.error === 'actNotFound');

    if (notFound || !ad) {
      find.push(['bad', 'Account not found / unfunded on the validated ledger. It does not exist yet or has never been activated.']);
      return { addr: r.addr, score: 80, band: band(80), find: find, stats: { Status: 'NOT FOUND' } };
    }

    // balance + flags
    var bal = parseFloat(ad.Balance || '0') / 1e6;
    var flags = ad.Flags || 0;
    stats['XRP Balance'] = bal.toLocaleString(undefined, { maximumFractionDigits: 6 });
    stats['Owner objects'] = ad.OwnerCount != null ? ad.OwnerCount : '—';
    if (ad.Domain) stats['Domain'] = hexToStr(ad.Domain);

    // age from oldest sampled tx
    var txs = (r.tx && r.tx.result && r.tx.result.transactions) || [];
    var minDate = null, capped = !!(r.tx && r.tx.result && r.tx.result.marker);
    txs.forEach(function (e) {
      var t = e.tx || e.tx_json || e; var dt = (t && typeof t.date === 'number') ? t.date : null;
      if (dt != null && (minDate === null || dt < minDate)) minDate = dt;
    });
    var ageDays = null;
    if (minDate != null) {
      ageDays = Math.floor((Date.now() - (minDate + 946684800) * 1000) / 86400000);
      stats['First activity'] = ageDays + 'd ago' + (capped ? ' (sampled, older likely)' : '');
    }
    stats['Tx sampled'] = txs.length + (capped ? '+' : '');

    // issuer?
    var gw = r.gw && r.gw.result;
    var obligations = (gw && gw.obligations) || {};
    var issuedCurs = Object.keys(obligations);
    var isIssuer = issuedCurs.length > 0;

    // trustlines
    var lines = (r.lines && r.lines.result && r.lines.result.lines) || [];
    var linesCapped = !!(r.lines && r.lines.result && r.lines.result.marker);
    stats['Trustlines'] = lines.length + (linesCapped ? '+' : '');

    // ── signals ──
    // blackhole / mint control
    var masterDisabled = !!(flags & F.DISABLE_MASTER);
    var hasRegular = !!ad.RegularKey;
    var regularBurned = hasRegular && BLACKHOLE.indexOf(ad.RegularKey) !== -1;
    var blackholed = masterDisabled && (!hasRegular || regularBurned);

    if (isIssuer) {
      find.push(['neu', 'Token issuer: issues ' + issuedCurs.map(function (c) { return decodeCur(c); }).join(', ') + '.']);
      if (blackholed) find.push(['good', 'Issuer appears BLACKHOLED (master key disabled, no usable regular key) — supply cannot be inflated further.']);
      else { find.push(['bad', 'Issuer is NOT blackholed — keys are still active, so the supply can be minted/changed at will.']); score += 30; }
    } else {
      find.push(['neu', 'Not currently a token issuer (no obligations on ledger).']);
    }

    if (flags & F.GLOBAL_FREEZE) { find.push(['bad', 'Global Freeze is SET — the issuer has frozen all trustlines for its token(s).']); score += 25; }
    if (flags & F.NO_FREEZE) find.push(['good', 'NoFreeze is set — issuer has permanently given up the ability to freeze balances.']);
    if (flags & F.REQUIRE_AUTH) { find.push(['warn', 'RequireAuth is set — holders must be individually authorized by the issuer.']); score += 8; }
    if (flags & F.DEPOSIT_AUTH) find.push(['neu', 'DepositAuth is set — account only accepts pre-authorized payments.']);

    // age
    if (ageDays != null) {
      if (ageDays < 7) { find.push(['bad', 'Very new: first activity only ' + ageDays + ' day(s) ago.']); score += 28; }
      else if (ageDays < 30) { find.push(['warn', 'Young account: first activity ~' + ageDays + ' days ago.']); score += 15; }
      else if (ageDays > 365) find.push(['good', 'Established: active for over a year (sampled).']);
      else find.push(['neu', 'First sampled activity ~' + ageDays + ' days ago.']);
    } else {
      find.push(['warn', 'Could not determine age from recent transactions.']); score += 5;
    }

    // balance / reserve
    if (bal < 1) { find.push(['bad', 'Balance below the base reserve (' + bal + ' XRP) — effectively empty/abandoned.']); score += 20; }
    else if (bal < 15) { find.push(['warn', 'Low balance (' + bal.toFixed(2) + ' XRP) — barely above reserve.']); score += 6; }

    // holder concentration (issuer)
    if (isIssuer) {
      if (!linesCapped && lines.length <= 5) { find.push(['warn', 'Only ' + lines.length + ' trustline(s) to this issuer — thin holder base / low liquidity.']); score += 12; }
      else if (lines.length > 50 || linesCapped) find.push(['good', 'Broad holder base (' + lines.length + (linesCapped ? '+' : '') + ' trustlines).']);
    }

    // activity volume
    if (txs.length === 0) { find.push(['warn', 'No recent transactions returned.']); score += 8; }

    if (ad.Domain) find.push(['neu', 'Domain set: ' + hexToStr(ad.Domain) + ' (verify it independently — domains can be spoofed).']);

    // ── KOI wallet score + watchdog (read-only enrichment) ──
    try {
      if (window.SW && SW.wallet) {
        var oc = 0, ox = 0, dates = [], cps = [], pairs = [];
        txs.forEach(function (e) {
          var t = e.tx || e.tx_json || e; if (!t) return;
          if (t.TransactionType === 'OfferCreate') oc++;
          if (t.TransactionType === 'OfferCancel') ox++;
          if (typeof t.date === 'number') dates.push((t.date + 946684800) * 1000);
          var other = (t.Account === r.addr) ? t.Destination : t.Account;
          if (other) cps.push(other);
          if (t.Account && t.Destination) pairs.push([t.Account, t.Destination]);
        });
        var actExch = null, koiAgeYears = (ageDays != null) ? ageDays / 365 : 0;
        var ft = r.first && r.first.result && r.first.result.transactions && r.first.result.transactions[0];
        if (ft) {
          var ftx = ft.tx || ft.tx_json || ft;
          if (ftx && ftx.Account) actExch = SW.wallet.activationExchange(ftx.Account);
          var fdate = ft.close_time_iso ? Date.parse(ft.close_time_iso) : (ftx && typeof ftx.date === 'number' ? (ftx.date + 946684800) * 1000 : null);
          if (fdate) koiAgeYears = (Date.now() - fdate) / (365.25 * 864e5);
        }
        var ws = SW.wallet.score({ balanceXrp: bal, accountAgeYears: koiAgeYears, activationExchange: actExch, offerCreateCount: oc, offerCancelCount: ox });
        stats['KOI wallet score'] = ws.rating.toUpperCase() + ' (' + ws.score + '/' + ws.maxScore + ')';
        if (actExch) stats['Activation source'] = actExch;
        var sev = ws.rating === 'green' ? 'good' : (ws.rating === 'yellow' ? 'warn' : 'bad');
        find.push([sev, 'KOI wallet rating ' + ws.rating.toUpperCase() + ' (' + ws.score + '/' + ws.maxScore + '): ' + ws.breakdown.map(function (b) { return b[1]; }).join(', ') + '.']);

        if (SW.watchdog) {
          var burst = SW.watchdog.burstScore(dates), conc = SW.watchdog.concentrationScore(cps), rev = SW.watchdog.reversalFlag(pairs);
          stats['Burst (1h peak)'] = Math.round(burst * 100) + '%';
          stats['Top counterparty'] = Math.round(conc * 100) + '%';
          if (burst >= 0.7) find.push(['warn', 'Watchdog — burst activity: ' + Math.round(burst * 100) + '% of sampled tx in one hour.']);
          if (conc >= 0.6) find.push(['warn', 'Watchdog — counterparty concentration: ' + Math.round(conc * 100) + '% with a single address.']);
          if (rev) find.push(['warn', 'Watchdog — circular/reversal behaviour (A→B and B→A in sample).']);
        }
      }
    } catch (e) { /* KOI enrichment is best-effort */ }

    if (!find.some(function (f) { return f[0] === 'bad' || f[0] === 'warn'; })) find.push(['good', 'No major red flags detected in the sampled data.']);

    score = Math.max(0, Math.min(100, score));
    return { addr: r.addr, score: score, band: band(score), find: find, stats: stats };
  }

  function decodeCur(c) {
    if (/^[A-Z0-9]{3}$/.test(c)) return c;
    if (/^[0-9A-Fa-f]{40}$/.test(c)) { var s = hexToStr(c).replace(/\0+$/, ''); return s || c.slice(0, 8); }
    return c;
  }
  function band(s) {
    if (s >= 65) return { label: 'CRITICAL RISK', color: '#ff4444' };
    if (s >= 40) return { label: 'HIGH RISK', color: '#ff8800' };
    if (s >= 20) return { label: 'ELEVATED', color: '#ffd000' };
    return { label: 'LOW RISK', color: '#33dd66' };
  }

  // ── render ───────────────────────────────────────────────────────────
  function render(a) {
    var b = $('risk-body'); if (!b) return;
    var ic = { bad: '✕', warn: '!', good: '✓', neu: '•' };
    var html = '';
    html += '<div class="risk-score" style="border-color:' + a.band.color + ';background:' + a.band.color + '14;">' +
      '<div class="num" style="color:' + a.band.color + '">' + a.score + '</div>' +
      '<div><div class="band" style="color:' + a.band.color + '">' + a.band.label + '</div>' +
      '<div style="font-size:10px;color:#779977;word-break:break-all;margin-top:4px;">' + esc(a.addr) + '</div></div></div>';

    html += '<div class="risk-sec">SIGNALS</div>';
    a.find.forEach(function (f) {
      html += '<div class="risk-find"><span class="ic rf-' + f[0] + '">' + ic[f[0]] + '</span><span>' + esc(f[1]) + '</span></div>';
    });

    html += '<div class="risk-sec">ON-LEDGER STATS</div>';
    Object.keys(a.stats).forEach(function (k) {
      html += '<div class="risk-kv"><span>' + esc(k) + '</span><span>' + esc(a.stats[k]) + '</span></div>';
    });

    html += '<div id="risk-disc">Heuristic assessment from live ledger reads (account_info, gateway_balances, account_lines, account_tx). ' +
      'Sampled data is capped (last ~200 tx / 400 trustlines), so age and holder counts are lower bounds. ' +
      'This is not financial advice — always verify independently.</div>';
    b.innerHTML = html;
  }

  // expose
  window.openRiskPanel = openPanel;
  window.closeRiskPanel = closePanel;
})();

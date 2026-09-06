#!/usr/bin/env node
// Acceptance for the report-truth-integrity fixes (audit priorities 1-4).
//
//   1. link loss narrative    — Morning Story must refuse to narrate a dead scan
//   2. wallet_results movement — a +40M XRP move must reach every section
//   3. richlist validation     — the corrupt row is gone and cannot come back
//   4. pack contract           — every key a renderer reads exists on a real pack
//   5. clean-run regression    — and a scan that FINISHED still reports normally
//
// Runs the real brief-console in headless Chromium against a local static server,
// so these exercise the shipped code paths rather than a shim.
//
//   node scripts/report-truth-acceptance.test.js [baseURL]
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.SW_TEST_PORT || 8123);
const BASE = process.argv[2] || ('http://127.0.0.1:' + PORT);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serve() {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      let u = decodeURIComponent(req.url.split('?')[0]);
      if (u === '/') u = '/index.html';
      const f = path.join(ROOT, u);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    }).listen(PORT, () => resolve(s));
  });
}

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (_) { try { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); } catch (e) {
    console.error('playwright not available — cannot run acceptance'); process.exit(2); } }

  const server = process.argv[2] ? null : await serve();
  const exe = process.env.SW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch(fs.existsSync(exe) ? { executablePath: exe, args: ['--no-sandbox'] } : { args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.route('**/*', r => r.request().url().startsWith(BASE) ? r.continue() : r.abort());
  await page.goto(BASE + '/brief-console.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);

  const r = await page.evaluate(() => {
    const out = {};
    const mkWallets = n => WATCHLIST.slice(0, n).map((w, i) => ({
      ...w, status: 'CHECKED', balance_xrp: 1e6 + (i === 0 ? 4e7 : 0),
      prev_balance_xrp: 1e6, delta_xrp: i === 0 ? 4e7 : 0
    }));

    // ── 1. link loss narrative ──────────────────────────────────────────────
    const W = mkWallets(20);
    const healthy = {
      date: '2026-08-21', scan_id: 'SC-ACC', wallets_checked: 20, wallets_failed: 0,
      // A clean run PROVED its transaction window; it does not merely omit the
      // question. Absence now renders NOT MEASURED — the whole point of the
      // change — so a fixture standing for a healthy run has to say so.
      tx_scan_coverage: { target_wallets: 20, complete_wallets: 20,
                          failed_wallets: 0, truncated_wallets: 0,
                          unproven_wallets: 0, unknown_status_wallets: 0,
                          anchor_ok: true, counts_reconcile: true,
                          full_window_complete: true },
      wallets_invalid: 0, watchlist_total: 20, wallet_results: W,
      xrp_price: 1.005, xrp_delta_24h_pct: -0.3, total_balance_delta_xrp: 4e7,
      shadow_volume_xrp: 4e7, tx_24h_count: 800, fragmentation_flags: [],
      large_transfers: [{ from: W[0].address, to: W[1].address, amount: 4e7 }],
      receiver_followthrough: [{ address: W[2].address, balance_xrp: 4e7, forwarded_large_count: 0, tx_count: 3 }],
      offers_scanned_count: 12, scan_link_lost: false,
      risk_score: { score: 42, label: 'YELLOW / WATCH', drivers: ['large transfer count'] }
    };
    const degraded = Object.assign({}, healthy, {
      scan_link_lost: true, scan_link_lost_at: '2026-08-21T17:00:00Z',
      large_transfers: [], receiver_followthrough: [], offers_scanned_count: undefined,
      total_balance_delta_xrp: 0, shadow_volume_xrp: 0, tx_24h_count: 0,
      risk_score: { score: 5, label: 'GREEN / QUIET', drivers: ['net watchlist delta'] }
    });
    const storyOK   = PUBLIC_REPORT_PIPELINE_V1.assemble(healthy).text;
    const storyLost = PUBLIC_REPORT_PIPELINE_V1.assemble(degraded).text;
    out.lostHeadline  = /SCAN INCOMPLETE — CONNECTION LOST/.test(storyLost);
    out.lostNotSealed = /REPORT NOT SEALED/.test(storyLost);
    out.lostNoQuiet   = !/quiet night|nothing found|no villain broke cover|steady patrol|No move crossed the line|Boring is a result/i.test(storyLost);
    // one source of truth: the structured report and the brief agree with the story
    const si = scanIntegrity(degraded);
    out.sealedFalseWhenLost = si.sealed === false && si.linkLost === true;
    out.sealedTrueWhenOK    = scanIntegrity(healthy).sealed === true;
    out.structuredAgrees    = /INCOMPLETE SCAN/.test(buildXRPMainReport(degraded));

    // ── 1b. link loss WITH evidence already collected ───────────────────────
    // The shape a REAL mid-scan drop takes. Balances are read first, so the
    // phases that completed still produce interpretations — every narrative
    // branch is live, and a guard placed after them never fires. The synthetic
    // `degraded` pack above cannot catch that, because it has no signal at all.
    const lostRich = Object.assign({}, healthy, {
      scan_link_lost: true, scan_link_lost_at: '2026-08-21T17:00:00Z'
    });
    const storyRich = PUBLIC_REPORT_PIPELINE_V1.assemble(lostRich).text;
    const richSec = {};
    storyRich.split(/\n\n(?=[^\n]+\n\u2500{3,}\n)/).forEach(chunk => {
      const m = chunk.match(/^([^\n]+)\n\u2500{3,}\n([\s\S]*)$/);
      if (m) richSec[m[1].trim()] = m[2].trim();
    });
    // Not one of the six narrative sections may present a finding as settled.
    const CONFIDENT = /caught my eye|read one thing|the tell of the night|Here are the receipts|I traced it|Cut through the noise|carried the whole night|quiet night|steady patrol|calm water|still night/i;
    out.richLeaks = ['EXECUTIVE SUMMARY','WHAT MATTERED MOST','EVIDENCE',
                     'WHAT TO WATCH NEXT','VERDICT','LEDGER DIAGNOSTICS']
      .filter(n => CONFIDENT.test(richSec[n] || ''));
    out.richGuarded = /SCAN INCOMPLETE — CONNECTION LOST/.test(richSec['EXECUTIVE SUMMARY'] || '') &&
                      /scan did not finish/i.test(richSec['WHAT MATTERED MOST'] || '') &&
                      /No evidence is offered/i.test(richSec['EVIDENCE'] || '') &&
                      /Re-run the scan/i.test(richSec['WHAT TO WATCH NEXT'] || '') &&
                      /NOT SEALED/.test(richSec['VERDICT'] || '') &&
                      /NOT SEALED/.test(richSec['LEDGER DIAGNOSTICS'] || '');

    // ── 2. wallet_results movement ──────────────────────────────────────────
    const withFail = mkWallets(12).concat([{ label: 'BROKEN_1', address: 'rBrokenXXXXXXXXXXXXXXXXXXXXXXXXXXX', status: 'FAILED', error: 'x' }]);
    const movePack = Object.assign({}, healthy, {
      wallet_results: withFail, wallets_checked: 12, wallets_failed: 1, watchlist_total: 13
    });
    const rep = buildXRPMainReport(movePack);
    out.shadowWatchShowsMove = /gained \+40\.00M XRP/.test(rep);
    out.anomalyPresent       = /4\. ANOMALY DETECTION/.test(rep);
    out.anomalyCitesMove     = /40\.00M XRP/.test((rep.split('4. ANOMALY DETECTION')[1] || '').split(/\n\d+\. /)[0] || '');
    out.failedWalletNamed    = /BROKEN_1/.test(rep);            // uppercase-status half
    out.baselineReadsResults = deltaBaseline(movePack).measured === 12;  // 12 CHECKED; the FAILED wallet is correctly excluded

    // ── 3. richlist validation ──────────────────────────────────────────────
    const SEED = window.RICHLIST_EMBEDDED_SEED_V1 || [];
    const U = (typeof state !== 'undefined' && state.richlistUniverse) || {};
    out.corruptGoneFromSeed  = !SEED.some(e => e.a === 'rNWafYHcr3zJvfvSZ4wZFdABwb6Sv8rLfe');
    out.corruptGoneFromUniv  = !U['rNWafYHcr3zJvfvSZ4wZFdABwb6Sv8rLfe'];
    out.noneAboveSupply      = !SEED.some(e => (e.b || 0) > 1e11);
    out.giantCount           = Object.keys(U).filter(a => (U[a].balance_xrp_normalized || 0) >= 1e9).length;
    // every seed address must be well-formed
    out.badSeedAddrs = SEED.filter(e => !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(String(e.a || ''))).length;
    // and a planted impossible row must be rejected by the loader
    const saved = window.RICHLIST_EMBEDDED_SEED_V1;
    window.RICHLIST_EMBEDDED_SEED_V1 = saved.concat([
      { a: 'rNWafYHcr3zJvfvSZ4wZFdABwb6Sv8rLfe', r: 4647, b: 5141091648 },   // the original
      { a: 'rPyCQm8E5j78PDbrfKF24fRC7qUAk1kDMZ'.replace(/.$/, 'X'), r: 5000, b: 99e9 } // absurd
    ]);
    let replanted = {};
    try { loadEmbeddedRichlistSeed(); replanted = (state && state.richlistUniverse) || {}; } catch (_) {}
    out.plantedRejected = !replanted['rNWafYHcr3zJvfvSZ4wZFdABwb6Sv8rLfe'];
    window.RICHLIST_EMBEDDED_SEED_V1 = saved;
    try { loadEmbeddedRichlistSeed(); } catch (_) {}

    // ── 4. pack contract ────────────────────────────────────────────────────
    const v = validatePackSchema(healthy);
    out.contractOK      = v.ok;
    out.contractMissing = v.missing.map(m => m.key);
    out.contractWrong   = v.wrongType.map(m => m.key + ':' + m.got);
    out.contractSize    = v.checked;
    // it must actually FAIL on the pre-fix shape (`wallets` instead of `wallet_results`)
    const legacy = Object.assign({}, healthy); delete legacy.wallet_results; legacy.wallets = W;
    const lv = validatePackSchema(legacy);
    out.contractCatchesDrift = !lv.ok && lv.missing.some(m => m.key === 'wallet_results');

    // ── 5. clean-run regression (audit follow-up) ─────────────────────────
    // The OPPOSITE assertion to group 1, and the more important one to keep.
    // Group 1 proves a dead scan cannot be narrated as calm. This proves the
    // guard stays out of the way of a scan that finished: a complete run with no
    // link loss must still produce a full Morning Story — no incomplete banner
    // anywhere, a real verdict with its real score, and a valid seal.
    //
    // Without this, a future change that made _intg() return linkLost:true
    // unconditionally would pass every check above while making EVERY report
    // read out as incomplete on air.
    const clean = JSON.parse(JSON.stringify(healthy));
    delete clean.scan_link_lost;                 // absent, not merely false
    const cleanStory = PUBLIC_REPORT_PIPELINE_V1.assemble(clean).text;
    const sections = {};
    cleanStory.split(/\n\n(?=[^\n]+\n\u2500{3,}\n)/).forEach(chunk => {
      const m = chunk.match(/^([^\n]+)\n\u2500{3,}\n([\s\S]*)$/);
      if (m) sections[m[1].trim()] = m[2].trim();
    });
    const SECT = ['EXECUTIVE SUMMARY','WHAT MATTERED MOST','EVIDENCE',
                  'WHAT TO WATCH NEXT','VERDICT','LEDGER DIAGNOSTICS'];
    out.cleanSectionsMissing = SECT.filter(n => !sections[n] || sections[n].length < 20);
    out.cleanNoBanner   = !/SCAN INCOMPLETE|NOT SEALED/.test(cleanStory);
    out.cleanNoBanner2  = !/SCAN INCOMPLETE|NOT SEALED/.test(storyOK);   // scan_link_lost:false
    out.cleanNormal     = /Today’s forensic read|The read, straight up|Bottom line off the Ledger|My call this morning/.test(cleanStory);
    // a real verdict: the actual risk score is stated as a verdict, not withheld
    out.cleanVerdictScored   = /\(42\/100\)\./.test(sections['VERDICT'] || '');
    out.cleanVerdictNotHeld  = !/not a verdict|no verdict tonight|withholding the call|stopped partway|honest verdict is that there is no verdict/i.test(sections['VERDICT'] || '');
    out.cleanVerdictSignoff  = /I\u2019m XRPMan, and I tell on the banks\.$/.test((sections['VERDICT'] || '').trim());
    // the other five gated builders keep their normal output too
    out.cleanEvidenceReal    = !/No evidence is offered for this run/.test(sections['EVIDENCE'] || '');
    out.cleanWmmReal         = !/scan did not finish/i.test(sections['WHAT MATTERED MOST'] || '');
    out.cleanWatchNoRerun    = !/Re-run the scan/i.test(sections['WHAT TO WATCH NEXT'] || '');
    out.cleanExecReal        = !/SCAN INCOMPLETE|did not finish|warning label|NOT SEALED/i.test(sections['EXECUTIVE SUMMARY'] || '') &&
                               (sections['EXECUTIVE SUMMARY'] || '').length > 40;
    out.cleanDiagPrice       = /XRP price: ~\$1\.0050/.test(sections['LEDGER DIAGNOSTICS'] || '');
    // the seal itself, on both surfaces that publish it
    const ci = scanIntegrity(clean);
    out.cleanSealed     = ci.sealed === true && ci.linkLost === false &&
                          ci.headline === '' && ci.sealLine === '' && ci.line === '' &&
                          (ci.missing || []).length === 0;
    out.cleanStructured = !/INCOMPLETE SCAN/.test(buildXRPMainReport(clean));
    // and the whole assembly ran, not just the six gated sections: the branded
    // banner and the append-only appendix are present too. (Length is NOT a
    // proxy here — the link-loss path is deliberately wordy, so a degraded story
    // can legitimately run longer than a calm one.)
    out.cleanAppendix = /THE DAILY PRAYER/.test(cleanStory) &&
                        /THE DAILY SCRIPTURE/.test(cleanStory) &&
                        /\nSOURCES\n/.test(cleanStory);
    out.cleanBanner   = /SHADOW|\uFF33\uFF28\uFF21\uFF24\uFF2F\uFF37/.test(cleanStory.slice(0, 400));
    out.cleanLen      = cleanStory.length;
    return out;
  });

  console.log('\n1. link loss narrative');
  check('Morning Story prints SCAN INCOMPLETE — CONNECTION LOST', r.lostHeadline);
  check('Morning Story prints REPORT NOT SEALED', r.lostNotSealed);
  check('Morning Story does NOT claim quiet / nothing found', r.lostNoQuiet);
  check('scanIntegrity.sealed is false when lost, true when clean', r.sealedFalseWhenLost && r.sealedTrueWhenOK);
  check('structured report agrees with the Morning Story (one source of truth)', r.structuredAgrees);
  check('realistic link loss (evidence already collected): all six sections guarded', r.richGuarded);
  check('realistic link loss: no section presents a confident finding', r.richLeaks.length === 0, r.richLeaks);

  console.log('\n2. wallet_results movement');
  check('SHADOW WATCH reports the +40M XRP move', r.shadowWatchShowsMove);
  check('ANOMALY DETECTION section is present', r.anomalyPresent);
  check('ANOMALY DETECTION cites the move', r.anomalyCitesMove);
  check('failed wallet is named (uppercase status)', r.failedWalletNamed);
  check('deltaBaseline reads wallet_results', r.baselineReadsResults, r.baselineReadsResults);

  console.log('\n3. richlist validation');
  check('corrupt row absent from the seed', r.corruptGoneFromSeed);
  check('corrupt row absent from the loaded universe', r.corruptGoneFromUniv);
  check('no seed row exceeds total XRP supply', r.noneAboveSupply);
  check('all seed addresses well-formed', r.badSeedAddrs === 0, r.badSeedAddrs);
  check('exactly 6 genuine 1B+ holders remain', r.giantCount === 6, r.giantCount);
  check('a re-planted impossible row is rejected by the loader', r.plantedRejected);

  console.log('\n4. pack contract');
  check('a real pack satisfies the contract', r.contractOK, { missing: r.contractMissing, wrong: r.contractWrong });
  check('contract covers the keys renderers read', r.contractSize >= 14, r.contractSize);
  check('contract CATCHES the pre-fix shape drift', r.contractCatchesDrift);

  console.log('\n5. clean-run regression \u2014 a finished scan still reports normally');
  check('all six Morning Story sections are built', r.cleanSectionsMissing.length === 0, r.cleanSectionsMissing);
  check('no SCAN INCOMPLETE / NOT SEALED anywhere in the story', r.cleanNoBanner);
  check('same when scan_link_lost is explicitly false', r.cleanNoBanner2);
  check('verdict keeps its normal opening voice', r.cleanNormal);
  check('verdict states the real score (42/100), not a withheld call', r.cleanVerdictScored && r.cleanVerdictNotHeld);
  check('verdict keeps the XRPMan sign-off', r.cleanVerdictSignoff);
  check('EXECUTIVE SUMMARY is a finding, not an outage notice', r.cleanExecReal);
  check('WHAT MATTERED MOST is answered', r.cleanWmmReal);
  check('EVIDENCE is offered', r.cleanEvidenceReal);
  check('WHAT TO WATCH NEXT does not demand a re-run', r.cleanWatchNoRerun);
  check('LEDGER DIAGNOSTICS prints the real price line', r.cleanDiagPrice);
  check('scanIntegrity seals a clean pack (no headline, no missing phases)', r.cleanSealed);
  check('structured report carries no INCOMPLETE SCAN marker', r.cleanStructured);
  check('the full assembly ran (banner + prayer + scripture + sources)',
        r.cleanBanner && r.cleanAppendix && r.cleanLen > 1200,
        { banner: r.cleanBanner, appendix: r.cleanAppendix, len: r.cleanLen });

  check('no page errors', errs.length === 0, errs.slice(0, 3));

  console.log('\n' + (fail === 0
    ? 'ALL ' + pass + ' ACCEPTANCE CHECKS PASS'
    : fail + ' FAILED of ' + (pass + fail)));
  await browser.close();
  if (server) server.close();
  process.exit(fail === 0 ? 0 : 1);
})();

#!/usr/bin/env node
/* ── IN-PAGE SMOKE — no NEW failures ─────────────────────────────────────────
   The app ships dozens of in-page smoke suites (every `window.*SmokeTest`
   function). Many of them cannot pass in a build sandbox: they assert on a
   completed Morning Story, MARKET SNAPSHOT or CONFIDENCE FRAME, and producing
   those needs a real XRPL scan, which this environment cannot reach.

   So the gate is NOT "zero failures" — that would be red forever and therefore
   ignored. The gate is "no failures that main does not already have", which is
   exactly the comparison that has been run by hand on every PR this session
   (`comm -13 baseline head`).

   scripts/smoke-baseline.txt is that baseline, generated from main. A failure
   present here and absent from the baseline fails the build. A baseline entry
   that has started passing is reported, not failed — but the baseline should
   then be regenerated so it never silently drifts upward.

   Regenerate:  node scripts/in-page-smoke.test.js --write-baseline

   Run: node scripts/in-page-smoke.test.js
   Env: SW_TEST_PORT to override the port (default 8306).
   Env: SW_SMOKE_SETTLE to override settle time in ms (default 9000).
──── */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT     = path.join(__dirname, '..');
const PORT     = Number(process.env.SW_TEST_PORT || 8306);
const SETTLE   = Number(process.env.SW_SMOKE_SETTLE || 9000);
const BASELINE = path.join(__dirname, 'smoke-baseline.txt');
const WRITE    = process.argv.includes('--write-baseline');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
               '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png' };

function serve() {
  return http.createServer((q, r) => {
    let u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/') u = '/index.html';
    const f = path.join(ROOT, u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      r.writeHead(404); r.end('not found'); return;
    }
    r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(r);
  }).listen(PORT);
}
function chromium() {
  try { return require('playwright').chromium; }
  catch (_) { return require('/opt/node22/lib/node_modules/playwright').chromium; }
}

(async () => {
  const srv = serve();
  const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium().launch(
    fs.existsSync(exe) ? { executablePath: exe, args: ['--no-sandbox'] } : { args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.route('**/*', r =>
    r.request().url().startsWith('http://127.0.0.1:' + PORT) ? r.continue() : r.abort());
  await page.goto('http://127.0.0.1:' + PORT + '/brief-console.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(SETTLE);

  const out = await page.evaluate(() => {
    const names = Object.keys(window)
      .filter(k => /SmokeTest$/.test(k) && typeof window[k] === 'function');
    const failures = [];
    names.forEach(nm => {
      try {
        const r = window[nm]();
        if (r && typeof r.fail === 'number') {
          (r.results || []).forEach(x => {
            if (/^✗/.test(x)) failures.push(nm + ' :: ' + x.replace(/^✗\s*/, ''));
          });
        }
      } catch (e) {
        failures.push(nm + ' :: THREW ' + (e && e.message));
      }
    });
    return { suites: names.length, failures };
  });

  await browser.close(); srv.close();

  const current = out.failures.slice().sort();

  if (WRITE) {
    fs.writeFileSync(BASELINE, current.join('\n') + (current.length ? '\n' : ''));
    console.log('baseline written: ' + current.length + ' known failures across ' +
                out.suites + ' suites');
    process.exit(0);
  }

  if (!fs.existsSync(BASELINE)) {
    console.error('IN-PAGE SMOKE\n\n  no baseline at scripts/smoke-baseline.txt — refusing to pass.');
    console.error('  generate it with: node scripts/in-page-smoke.test.js --write-baseline');
    process.exit(1);
  }
  const baseline = fs.readFileSync(BASELINE, 'utf8')
    .split('\n').map(s => s.trim()).filter(Boolean).sort();

  const known = new Set(baseline);
  const now   = new Set(current);
  const added = current.filter(f => !known.has(f));
  const fixed = baseline.filter(f => !now.has(f));

  console.log('IN-PAGE SMOKE\n');
  console.log('  suites run      : ' + out.suites);
  console.log('  failures now    : ' + current.length);
  console.log('  known baseline  : ' + baseline.length);
  console.log('  new failures    : ' + added.length);
  console.log('  newly passing   : ' + fixed.length + '\n');

  if (fixed.length) {
    console.log('  These baseline entries now PASS — regenerate the baseline so it');
    console.log('  cannot drift upward unnoticed:');
    fixed.slice(0, 10).forEach(f => console.log('    + ' + f));
    if (fixed.length > 10) console.log('    … and ' + (fixed.length - 10) + ' more');
    console.log('');
  }

  if (added.length) {
    console.log('  NEW failures introduced by this change:');
    added.forEach(f => console.log('    ✗ ' + f));
    console.log('\n' + added.length + ' NEW SMOKE FAILURE' + (added.length === 1 ? '' : 'S'));
    process.exit(1);
  }

  console.log('NO NEW SMOKE FAILURES');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

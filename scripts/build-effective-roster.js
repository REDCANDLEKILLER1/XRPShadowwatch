#!/usr/bin/env node
/* ── EFFECTIVE ROSTER MANIFEST ────────────────────────────────────────────────
   What the apps ACTUALLY watch at runtime, measured by loading them.

   WHY THIS EXISTS

   src/shared/hvt-roster.js is generated and lists 243 targets. That is not what
   either app watches. Three separate modules push additional targets onto
   window.SW_HVT_ROSTER.targets after the roster file loads:

     src/shared/hvt-history.js                    (both apps)
     src/brief/17-report-scan-tuning-20260816.js  (report only)
     src/brief/38-na2tm-acceptance-cleanup-*.js   (report only)

   The result is that the LIVE WALL and the REPORT watch DIFFERENT ROSTERS —
   243 and 251 respectively — from the same generated file. Anything that reads
   hvt-roster.js alone and calls the answer "the roster" is wrong for both.

   This bit the seed validator: its coverage check compared against the 243 in
   the generated file, so a seed missing all 8 report-only targets scored
   "243 of 243 — 100%" and passed --expect-complete. The requirement is 251.

   Counting these by hand is exactly the stale-hard-coded-count failure that has
   produced false results repeatedly in this repo (197 → 226 → 228 → 229 → 251).
   So the number is never typed. It is measured, here, by loading each app in a
   real browser and reading what the engine ended up with.

   Re-run this whenever a module gains or loses a target. The seed validator
   reads the manifest and refuses to guess if it is missing.

   Usage:  node scripts/build-effective-roster.js [--check]
             (default)  write scripts/effective-roster.json
             --check    verify the committed manifest still matches reality,
                        exit 1 if it has drifted. For CI / pre-commit.
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT     = path.join(__dirname, '..');
const OUT      = path.join(__dirname, 'effective-roster.json');
const PORT     = Number(process.env.SW_ROSTER_PORT || 8171);
const CHECK    = process.argv.includes('--check');
const SETTLE   = Number(process.env.SW_SETTLE_MS || 11000);

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

  const apps = { wall: 'index.html', report: 'brief-console.html' };
  const measured = {};

  for (const [name, page] of Object.entries(apps)) {
    const p = await browser.newPage();
    await p.route('**/*', r =>
      r.request().url().startsWith('http://127.0.0.1:' + PORT) ? r.continue() : r.abort());
    await p.goto('http://127.0.0.1:' + PORT + '/' + page, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(SETTLE);
    measured[name] = await p.evaluate(() => {
      const R = (window.SW_HVT_ROSTER || {});
      return {
        targets: (R.targets || []).map(t => t.address),
        labels: Object.fromEntries((R.targets || []).map(t => [t.address, t.label || ''])),
        rosterVersion: R.version || null
      };
    });
    await p.close();
  }
  await browser.close();
  srv.close();

  // The generated file, for the record — so the manifest shows the gap rather
  // than hiding it.
  const w = {};
  const src = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'hvt-roster.js'), 'utf8');
  new Function('window', src + '\n;').call({ window: w }, w);
  const generated = (w.SW_HVT_ROSTER.targets || []).map(t => t.address);

  const wallSet = new Set(measured.wall.targets);
  const genSet  = new Set(generated);
  const reportOnly = measured.report.targets.filter(a => !wallSet.has(a));
  const runtimeOnly = measured.report.targets.filter(a => !genSet.has(a));

  const manifest = {
    // Deliberately no generated-at timestamp: it would make every regeneration a
    // diff even when nothing changed, and the point of this file is to show when
    // the roster genuinely moves.
    rosterVersion: measured.report.rosterVersion,
    generatedCount: generated.length,
    counts: { wall: measured.wall.targets.length, report: measured.report.targets.length },
    // The canonical roster for seed completeness is the REPORT's. The report is
    // the engine that produces the sealed forensic run the seed is taken from;
    // the wall watches a subset.
    canonical: 'report',
    canonicalCount: measured.report.targets.length,
    reportTargets: measured.report.targets.slice().sort(),
    wallTargets: measured.wall.targets.slice().sort(),
    reportOnly: reportOnly.map(a => ({ address: a, label: measured.report.labels[a] || '' })),
    runtimeOnly: runtimeOnly.map(a => ({ address: a, label: measured.report.labels[a] || '' }))
  };

  const json = JSON.stringify(manifest, null, 1) + '\n';

  console.log('EFFECTIVE ROSTER');
  console.log('  generated file : ' + manifest.generatedCount);
  console.log('  live wall      : ' + manifest.counts.wall);
  console.log('  report         : ' + manifest.counts.report + '   <- canonical for seed completeness');
  console.log('  report-only    : ' + reportOnly.length + ' target(s) the wall never sees');
  console.log('  runtime-only   : ' + runtimeOnly.length + ' target(s) absent from the generated file');

  if (CHECK) {
    if (!fs.existsSync(OUT)) {
      console.log('\nNo committed manifest at ' + path.relative(ROOT, OUT) + ' — run without --check to create it.');
      process.exit(1);
    }
    const committed = fs.readFileSync(OUT, 'utf8');
    if (committed === json) { console.log('\nManifest is current.'); process.exit(0); }
    console.log('\nMANIFEST HAS DRIFTED — a module changed what the apps watch.');
    console.log('Re-run: node scripts/build-effective-roster.js   then review the diff.');
    const old = JSON.parse(committed);
    if (old.canonicalCount !== manifest.canonicalCount)
      console.log('  canonical count: ' + old.canonicalCount + ' -> ' + manifest.canonicalCount);
    process.exit(1);
  }

  fs.writeFileSync(OUT, json);
  console.log('\nwrote ' + path.relative(ROOT, OUT));
})().catch(e => { console.error(e); process.exit(1); });

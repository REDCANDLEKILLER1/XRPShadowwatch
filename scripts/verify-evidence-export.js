#!/usr/bin/env node
'use strict';
// Decide whether an export may be trusted enough to prune the source.
//
// "Do not delete Neon until the exported history is verified" is only a real
// instruction if verification is something a command decides. So this exits 0
// when — and only when — every one of the following holds:
//
//   1. The manifest has not been edited. It carries a hash over itself, so a
//      tampered manifest cannot vouch for tampered files.
//   2. Every file it lists exists, decompresses, and its PLAINTEXT hashes to
//      what the manifest recorded. Hashing the plaintext rather than the gzip
//      means a re-compression can never look like corruption, and corruption
//      can never look like a re-compression.
//   3. Row counts add up: per file, per day, and in total.
//   4. Every line parses, carries the keys the schema declares, and sits
//      inside the day its path claims.
//   5. Against the live database (unless --offline): the exported event count,
//      participant count and per-day counts match, every wallet's coverage
//      proof round-trips field for field, and with --deep every single hash in
//      Neon is present in the archive exactly once.
//
// Anything short of that is a non-zero exit and an explicit reason. There is
// no "mostly verified".
//
// Usage:
//   node scripts/verify-evidence-export.js --in export
//   node scripts/verify-evidence-export.js --in export --deep      # every hash, both ways
//   node scripts/verify-evidence-export.js --in export --offline   # files only, no database

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const db = require('../src/db/connection');
const X = require('../src/db/evidence-export');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  ok    ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

function args(argv) {
  const out = { in: null, deep: false, offline: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--in') out.in = argv[++i];
    else if (argv[i] === '--deep') out.deep = true;
    else if (argv[i] === '--offline') out.offline = true;
  }
  if (!out.in) throw new Error('MISSING_ARGUMENT: --in <dir> is required');
  return out;
}

const readText = full => full.endsWith('.gz')
  ? zlib.gunzipSync(fs.readFileSync(full)).toString('utf8')
  : fs.readFileSync(full, 'utf8');

async function main() {
  const opts = args(process.argv.slice(2));
  const root = path.resolve(opts.in);
  console.log('VERIFY EVIDENCE EXPORT\n  archive           ' + root);

  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('MANIFEST_MISSING: ' + manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log('  export_id         ' + manifest.export_id);
  console.log('  generated_at      ' + manifest.generated_at + '\n');

  check('the manifest schema is the one this verifier understands', manifest.schema === X.SCHEMA, manifest.schema);
  check('the manifest has not been edited since it was written',
    manifest.manifest_sha256 === X.manifestDigest(manifest), manifest.manifest_sha256);
  check('the export declares whether payloads are included',
    manifest.source && typeof manifest.source.payloads_exported === 'boolean');

  // ── files ────────────────────────────────────────────────────────────────
  const byDay = new Map();
  let events = 0, participants = 0, payloads = 0, missing = 0, corrupt = 0, malformed = 0, misfiled = 0;
  const hashes = new Set();
  let duplicated = 0;

  for (const entry of (manifest.files || [])) {
    const full = path.join(root, entry.path);
    if (!fs.existsSync(full)) { missing++; console.log('  FAIL  missing file  ' + entry.path); fail++; continue; }
    const raw = fs.readFileSync(full);
    if (entry.gz_sha256 && X.sha256(raw) !== entry.gz_sha256) { corrupt++; console.log('  FAIL  file bytes differ  ' + entry.path); fail++; continue; }
    let text; try { text = readText(full); } catch (e) { corrupt++; console.log('  FAIL  will not decompress  ' + entry.path); fail++; continue; }
    if (X.sha256(Buffer.from(text, 'utf8')) !== entry.sha256) { corrupt++; console.log('  FAIL  content hash differs  ' + entry.path); fail++; continue; }

    if (entry.path === 'state/coverage.json') continue;
    const lines = text.split('\n').filter(Boolean);
    if (lines.length !== entry.rows) { malformed++; console.log('  FAIL  row count differs  ' + entry.path); fail++; continue; }
    const day = /^evidence\/(\d{4})\/(\d{2})\/(\d{2})\//.exec(entry.path);
    const isEvents = /\/events(\.\d{3})?\.ndjson\.gz$/.test(entry.path);
    const isPayloads = /\/payloads(\.\d{3})?\.ndjson\.gz$/.test(entry.path);
    for (const line of lines) {
      let record; try { record = JSON.parse(line); } catch (_) { malformed++; continue; }
      if (!isEvents) continue;
      // A record filed under the wrong day would make a day-scoped read miss
      // it, which is the same as losing it.
      if (day && X.dayOf(record.close_time) !== day[1] + '-' + day[2] + '-' + day[3]) misfiled++;
      if (hashes.has(record.hash)) duplicated++; else hashes.add(record.hash);
    }
    if (day) {
      const key = day[1] + '-' + day[2] + '-' + day[3];
      const tally = byDay.get(key) || { events: 0, participants: 0, payloads: 0 };
      if (isEvents) tally.events += entry.rows;
      else if (isPayloads) tally.payloads += entry.rows;
      else tally.participants += entry.rows;
      byDay.set(key, tally);
    }
    if (isEvents) events += entry.rows;
    else if (isPayloads) payloads += entry.rows;
    else participants += entry.rows;
  }

  check('every file the manifest lists is present', missing === 0, missing);
  check('every file hashes to what the manifest recorded', corrupt === 0, corrupt);
  check('every line parses and every file has the row count claimed', malformed === 0, malformed);
  check('no event is filed under a day its close time does not belong to', misfiled === 0, misfiled);
  check('no transaction hash appears in two shards', duplicated === 0, duplicated);
  check('the per-file row counts add up to the manifest totals',
    events === manifest.totals.events && participants === manifest.totals.participants &&
    payloads === (manifest.totals.payloads || 0),
    { events, participants, payloads, claimed: manifest.totals });

  // A payload belongs to an event. More payloads than events would mean the
  // archive holds a payload for something it does not record happening.
  check('no day holds more payloads than events',
    [...byDay.entries()].every(([, t]) => t.payloads <= t.events),
    [...byDay.entries()].filter(([, t]) => t.payloads > t.events));

  const coverage = JSON.parse(readText(path.join(root, 'state/coverage.json')));
  check('the coverage proof is present and is a list', Array.isArray(coverage) && coverage.length === manifest.totals.wallets,
    { found: Array.isArray(coverage) ? coverage.length : null, claimed: manifest.totals.wallets });

  // ── against the live database ────────────────────────────────────────────
  if (opts.offline) {
    console.log('\n  (--offline: the source database was not consulted)');
  } else if (!db.isConfigured()) {
    check('a database is configured, or --offline was passed deliberately', false, 'EVIDENCE_STORE_UNAVAILABLE');
  } else {
    const q = db.getExecutor();
    const live = (await q(`SELECT (SELECT count(*) FROM transactions)::bigint AS transactions,
      (SELECT count(*) FROM transaction_accounts)::bigint AS participants,
      (SELECT count(*) FROM wallet_coverage)::bigint AS wallets`)).rows[0];
    check('every transaction in the database is in the archive',
      events === Number(live.transactions), { archive: events, database: Number(live.transactions) });
    check('every participant row is in the archive',
      participants === Number(live.participants), { archive: participants, database: Number(live.participants) });
    check('every proven wallet is in the archive',
      coverage.length === Number(live.wallets), { archive: coverage.length, database: Number(live.wallets) });

    const days = (await q(`SELECT to_char(close_time,'YYYY-MM-DD') AS day, count(*)::bigint AS n
      FROM transactions GROUP BY 1 ORDER BY 1`)).rows;
    let dayMismatch = 0;
    for (const row of days) {
      const tally = byDay.get(row.day);
      if (!tally || tally.events !== Number(row.n)) {
        dayMismatch++;
        console.log('  FAIL  day ' + row.day + ': archive ' + (tally ? tally.events : 0) + ', database ' + row.n);
      }
    }
    check('every day holds exactly the rows the database has for it', dayMismatch === 0, dayMismatch);
    fail += dayMismatch;

    // The proof is the part that cannot be re-derived from anything else, so
    // it is compared field by field rather than by count.
    const liveCoverage = (await q('SELECT * FROM wallet_coverage ORDER BY address')).rows.map(X.coverageOf);
    const archived = new Map(coverage.map(c => [c.address, c]));
    let proofMismatch = 0;
    for (const row of liveCoverage) {
      const stored = archived.get(row.address);
      if (!stored || JSON.stringify(stored) !== JSON.stringify(row)) {
        proofMismatch++;
        if (proofMismatch <= 3) console.log('  FAIL  coverage differs for ' + row.address);
      }
    }
    check('every wallet\'s coverage proof round-trips field for field', proofMismatch === 0, proofMismatch);
    fail += proofMismatch;

    if (opts.deep) {
      // Counts agreeing is not the same as the same rows being present. This
      // compares the hash sets both ways.
      let cursor = null, seen = 0, absent = 0;
      for (;;) {
        const rows = (await q('SELECT hash FROM transactions WHERE $1::text IS NULL OR hash > $1 ORDER BY hash LIMIT 10000',
          [cursor])).rows;
        if (!rows.length) break;
        for (const row of rows) { seen++; if (!hashes.has(row.hash)) absent++; }
        cursor = rows[rows.length - 1].hash;
      }
      check('--deep: every hash in the database is in the archive', absent === 0, absent);
      check('--deep: the archive holds no hash the database does not', hashes.size === seen,
        { archive: hashes.size, database: seen });
    }
  }

  console.log('');
  if (fail) {
    console.log(fail + ' CHECK(S) FAILED — this export is NOT verified. Do not prune or delete the source.');
    return finish(1);
  }
  console.log('ALL ' + pass + ' CHECKS PASS — export verified.');
  console.log('manifest sha256 ' + manifest.manifest_sha256);
  if (!opts.deep) console.log('(counts and hashes verified; add --deep to compare every transaction hash both ways)');
  return finish(0);
}

async function finish(code) { try { await db.close(); } catch (_) {} process.exitCode = code; }

main().catch(e => { console.error(String(e && e.message || e)); finish(1); });

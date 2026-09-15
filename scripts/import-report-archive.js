#!/usr/bin/env node
'use strict';
// Import a local archive of sealed ShadowWatch TOTAL REPORT files into the
// evidence repository, preserving exactly what was sealed.
//
// ── WHAT IS PRESERVED, AND WHY EACH ────────────────────────────────────────
//
//   the exact bytes        A seal covers a rendering. Re-wrapping, reflowing or
//                          re-encoding it breaks the only thing that proves the
//                          report is the one that was published.
//   the original filename  It carries the report id and the date the operator
//                          filed it under, and it is how they will look for it.
//   sha256 of those bytes  So a later reader can tell the file is unaltered
//                          without re-deriving anything.
//   the capsule seal       report_id, scan_id, version, date, public_hash,
//                          full_hash, master_hash, generated_at — lifted, not
//                          recomputed. These are the run's own claims.
//   every variant          Two files with one report id are two facts, not a
//                          duplicate to resolve. Both are kept, each under its
//                          own content hash, and the index says how many exist.
//
// ── WHAT IT DOES NOT CLAIM ─────────────────────────────────────────────────
//
// These are sealed report artifacts — rendered conclusions — not raw XRPL
// transaction history. Addresses and hashes appearing in a report are quoted by
// it, not proven by this import. The manifest says so in as many words, because
// an archive that blurs the two would let a later reader treat a rendered
// sentence as ledger evidence.
//
// Usage:
//   node scripts/import-report-archive.js --from ./reports
//   node scripts/import-report-archive.js --from ./reports --apply

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const A = require('../src/db/github-archive');

const ROOT_PREFIX = 'history';
const BATCH = 25;
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const gitSha = buf => crypto.createHash('sha1')
  .update('blob ' + buf.length + '\0', 'utf8').update(buf).digest('hex');

function args(argv) {
  const out = { from: null, apply: false, batch: BATCH };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') out.from = argv[++i];
    else if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--batch') out.batch = Number(argv[++i]);
  }
  if (!out.from) throw new Error('MISSING_ARGUMENT: --from <dir> is required');
  return out;
}

// The seal is a JSON object under SECTION 01. Lifted verbatim; nothing here
// recomputes a hash the run already committed to.
function sealOf(text) {
  const section = text.indexOf('SECTION 01');
  if (section < 0) return null;
  const open = text.indexOf('{', section);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(open, i + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}

const isReportId = v => /^SW-\d{8}-[A-Z0-9]{5}$/.test(String(v || ''));
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// Everything the import decides, with no output and no network, so the suite
// can assert on the actual bytes and the actual rejections rather than on the
// shape of the source text.
function plan(fromDir) {
  const dir = path.resolve(fromDir);
  const names = fs.readdirSync(dir).filter(n => fs.statSync(path.join(dir, n)).isFile());
  const records = [], rejected = [];

  for (const name of names) {
    const bytes = fs.readFileSync(path.join(dir, name));
    const seal = sealOf(bytes.toString('utf8'));
    if (!seal || !isReportId(seal.report_id)) {
      rejected.push({ file: name, reason: seal ? 'SEAL_HAS_NO_REPORT_ID' : 'NO_EVIDENCE_CAPSULE_SEAL' });
      continue;
    }
    const date = isDate(seal.date) ? seal.date : (/(\d{4}-\d{2}-\d{2})/.exec(name) || [])[1] || null;
    if (!date) { rejected.push({ file: name, reason: 'NO_DATE' }); continue; }
    records.push({
      original_filename: name, bytes: bytes.length, sha256: sha256(bytes),
      report_id: seal.report_id, scan_id: seal.scan_id || null, version: seal.version || null, date,
      public_hash: seal.public_hash || null, full_hash: seal.full_hash || null,
      master_hash: seal.master_hash || null, generated_at: seal.generated_at || null,
      _buffer: bytes
    });
  }

  // Group by report id. A report id with more than one DISTINCT content hash
  // has variants, and every one of them is filed under its own hash — not the
  // first one plain and the rest suffixed, which would silently make one of
  // them canonical.
  const byId = new Map();
  for (const r of records) {
    if (!byId.has(r.report_id)) byId.set(r.report_id, []);
    byId.get(r.report_id).push(r);
  }
  let variants = 0, identical = 0;
  for (const [id, list] of byId) {
    const distinct = new Set(list.map(r => r.sha256));
    if (list.length > 1 && distinct.size === 1) identical += list.length - 1;
    if (distinct.size > 1) variants++;
    for (const r of list) {
      const base = ROOT_PREFIX + '/' + r.date.replace(/-/g, '/') + '/' + id;
      const stem = distinct.size > 1 ? '/' + r.sha256.slice(0, 12) + '.' : '/';
      r.path = base + stem + 'report.txt';
      r.receipt_path = base + stem + 'receipt.json';
      r.variant_count = distinct.size;
    }
  }
  const dates = [...new Set(records.map(r => r.date))].sort();
  return { records, rejected, byId, variants, identical, dates, names };
}

// Byte-identical duplicates collapse to one stored file; the receipt records
// every filename it arrived under, so nothing about the source is lost.
function build(planned) {
  const { byId, dates, variants } = planned;
  const files = {}, index = [];
  for (const [id, list] of byId) {
    const seen = new Map();
    for (const r of list) {
      if (seen.has(r.sha256)) continue;
      seen.set(r.sha256, r);
      files[r.path] = r._buffer;
      files[r.receipt_path] = JSON.stringify({
        report_id: r.report_id, scan_id: r.scan_id, version: r.version, date: r.date,
        public_hash: r.public_hash, full_hash: r.full_hash, master_hash: r.master_hash,
        generated_at: r.generated_at,
        original_filename: r.original_filename, bytes: r.bytes, sha256: r.sha256,
        variant_count: r.variant_count, stored_path: r.path,
        also_filed_as: list.filter(o => o.sha256 === r.sha256 && o.original_filename !== r.original_filename)
          .map(o => o.original_filename),
        artifact_kind: 'SEALED_REPORT_RENDERING',
        not_a_claim: 'A rendered report quotes addresses and transaction hashes; it does not prove them. ' +
          'This file is the published conclusion, not raw XRPL evidence.',
        // The other direction, and the more dangerous one. A report renders
        // what the run chose to say, which is never everything the ledger did.
        // Reading absence as evidence of absence would turn a narrative
        // omission into a claim that nothing happened.
        absence_proves_nothing: 'A transaction not appearing in this report was not necessarily absent from ' +
          'the ledger. Reports render selected findings; they do not enumerate the window.'
      }, null, 2) + '\n';
    }
    for (const r of seen.values()) {
      index.push({ report_id: id, date: r.date, scan_id: r.scan_id, sha256: r.sha256,
        path: r.path, bytes: r.bytes, generated_at: r.generated_at, variant_count: r.variant_count });
    }
  }
  index.sort((a, b) => (a.date + a.report_id + a.sha256).localeCompare(b.date + b.report_id + b.sha256));
  files[ROOT_PREFIX + '/index.json'] = JSON.stringify({
    schema: 'shadowwatch-report-history/1',
    imported_at: new Date().toISOString(),
    source: 'operator device archive',
    artifact_kind: 'SEALED_REPORT_RENDERINGS',
    not_raw_ledger_evidence: 'These are sealed report artifacts — rendered conclusions with their capsule ' +
      'hashes. Addresses and transaction hashes appearing inside them are quoted by the report, not proven ' +
      'by this archive. Raw XRPL evidence lives under evidence/.',
    absence_proves_nothing: 'Nor is this archive a complete ledger history. A transaction absent from every ' +
      'report here was not necessarily absent from the ledger: reports render selected findings, they do not ' +
      'enumerate a window. Do not infer an unrendered transaction did not occur.',
    reports: index.length, distinct_report_ids: byId.size,
    first_date: dates[0] || null, last_date: dates[dates.length - 1] || null,
    ids_with_variants: variants,
    index
  }, null, 2) + '\n';
  return { files, index };
}

async function publish(files, paths, opts) {
  const { token, repo, branch } = A.evidenceTarget(process.env);
  const gh = A.client(token, repo, fetch);
  const ref = await A.archiveRef(gh, branch);
  const commit = await gh('GET', '/git/commits/' + ref.object.sha);
  const tree = await gh('GET', '/git/trees/' + commit.tree.sha + '?recursive=1');
  const existing = new Map((tree.tree || []).filter(n => n.type === 'blob').map(n => [n.path, n.sha]));

  const pending = paths.filter(p => {
    const buf = Buffer.isBuffer(files[p]) ? files[p] : Buffer.from(files[p], 'utf8');
    return existing.get(p) !== gitSha(buf);
  });
  console.log('  already present   ' + (paths.length - pending.length));
  console.log('  to upload         ' + pending.length);
  if (!pending.length) { console.log('\nNothing to do — this archive is already imported in full.'); return; }

  let written = 0, commits = 0;
  for (let offset = 0; offset < pending.length; offset += opts.batch) {
    const chunk = pending.slice(offset, offset + opts.batch);
    const payload = {};
    for (const p of chunk) payload[p] = files[p];
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await gh('GET', '/git/ref/heads/' + branch);
      try {
        const done = await A.commitFiles(gh, branch, current.object.sha, payload,
          'history: import sealed reports ' + (offset + chunk.length) + '/' + pending.length);
        written += done.files_written; commits++;
        break;
      } catch (e) { if (!e.refConflict || attempt === 3) throw e; }
    }
    process.stdout.write('  uploaded ' + written + '/' + pending.length + '…\r');
  }
  console.log('\n\nIMPORTED');
  console.log('  files             ' + written + ' in ' + commits + ' commit(s)');
  console.log('  repository        ' + repo + ' @ ' + branch);
  console.log('  path              ' + ROOT_PREFIX + '/');
  console.log('\nExact bytes preserved. Nothing under evidence/ was touched.');
}

function main() {
  const opts = args(process.argv.slice(2));
  const planned = plan(opts.from);
  const { records, rejected, byId, variants, identical, dates, names } = planned;

  console.log('IMPORT SEALED REPORT ARCHIVE');
  console.log('  source            ' + path.resolve(opts.from));
  console.log('  files             ' + names.length);
  console.log('  sealed reports    ' + records.length + ' · ' + byId.size + ' distinct report ids');
  console.log('  window            ' + (dates[0] || '(none)') + ' -> ' + (dates[dates.length - 1] || '(none)'));
  console.log('  ids with variants ' + variants + (variants ? ' (both kept, each under its own hash)' : ''));
  if (identical) console.log('  byte-identical    ' + identical + ' duplicate file(s), kept once');
  console.log('  bytes             ' + (records.reduce((n, r) => n + r.bytes, 0) / 1048576).toFixed(1) + ' MB');
  if (rejected.length) {
    console.log('  NOT IMPORTED      ' + rejected.length);
    for (const r of rejected) console.log('    ' + r.reason + '  ' + r.file);
  }

  const { files } = build(planned);
  const paths = Object.keys(files).sort();
  console.log('  files to write    ' + paths.length);
  console.log('  mode              ' + (opts.apply ? 'APPLY' : 'DRY RUN (pass --apply to publish)'));
  if (!opts.apply) {
    console.log('\nDry run. Nothing was uploaded. Sample paths:');
    for (const p of paths.slice(0, 4)) console.log('    ' + p);
    return;
  }
  return publish(files, paths, opts);
}

module.exports = { sealOf, isReportId, isDate, plan, build, ROOT_PREFIX };

if (require.main === module) {
  try {
    const r = main();
    if (r && r.catch) r.catch(e => { console.error(String(e && e.message || e)); process.exitCode = 1; });
  } catch (e) { console.error(String(e && e.message || e)); process.exitCode = 1; }
}

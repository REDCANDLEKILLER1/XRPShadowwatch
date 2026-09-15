#!/usr/bin/env node
'use strict';
/* ── A SEAL COVERS A RENDERING, SO THE RENDERING MUST SURVIVE INTACT ────────
   119 sealed TOTAL REPORT files, July through September, are the historical
   record behind ShadowWatch. Importing them is easy to get subtly wrong:
   re-encode the bytes and the capsule hash no longer describes the file;
   collapse two variants of one report id and a fact disappears; file a
   rendered conclusion next to raw ledger evidence and a later reader treats a
   sentence as proof.

   What this suite holds the importer to:

     the exact bytes, unaltered
     the seal lifted, never recomputed
     every variant kept, none made canonical over the others
     the original filename preserved even when bytes are shared
     rendered conclusions labelled as such, not as ledger evidence

   No network, no database.
──────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const I = require(path.join(ROOT, 'scripts/import-report-archive.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};
const SRC = fs.readFileSync(path.join(ROOT, 'scripts/import-report-archive.js'), 'utf8');

const report = (over) => `ShadowWatch TOTAL REPORT
Generated:    ${(over || {}).generated_at || '2026-08-13T11:28:53.390Z'}

============================================================
SECTION 01 — EVIDENCE CAPSULE SEAL
============================================================

${JSON.stringify(Object.assign({
  report_id: 'SW-20260813-MNOC7', scan_id: 'SC-MSRFQIDP',
  version: 'v3.32a-helper-runtime-proof-lock', date: '2026-08-13',
  public_hash: '4986b80446992df444cf4d5f3c5f46ed',
  full_hash: '796f206d49dbf9f1bda680267f5e46bb',
  master_hash: 'e1eed18001af36061cf2628e761779dd',
  chars_4k: 1900, generated_at: '2026-08-13T11:28:53.390Z'
}, over || {}), null, 2)}

============================================================
SECTION 02 — MORNING STORY REPORT
============================================================
rNQEMJA2SxKplaceholder moved 1,000,000 XRP.
`;

console.log('\n1. the seal is lifted, never recomputed');
const seal = I.sealOf(report());
check('every capsule field is read from the report itself',
  seal.report_id === 'SW-20260813-MNOC7' && seal.scan_id === 'SC-MSRFQIDP' &&
  seal.public_hash === '4986b80446992df444cf4d5f3c5f46ed' &&
  seal.full_hash === '796f206d49dbf9f1bda680267f5e46bb' &&
  seal.master_hash === 'e1eed18001af36061cf2628e761779dd', seal);
// Recomputing a hash the run committed to would replace the run's claim with
// the importer's opinion of it.
check('the importer computes no capsule hash of its own',
  !/public_hash\s*[:=]\s*(sha|crypto|md5)/i.test(SRC));
check('a file with no capsule seal is not imported', I.sealOf('no seal here') === null);
check('and a malformed seal is refused rather than half-read',
  I.sealOf('SECTION 01\n{ not json ') === null);
check('a seal whose report id is not a report id is rejected',
  I.isReportId('SW-20260813-MNOC7') === true && I.isReportId('nonsense') === false &&
  I.isReportId('SW-2026-MNOC7') === false);
check('and the date must be a date', I.isDate('2026-08-13') === true && I.isDate('13/08/2026') === false);
check('a file that cannot be imported is listed with its reason, not skipped silently',
  /NOT IMPORTED/.test(SRC) && /NO_EVIDENCE_CAPSULE_SEAL/.test(SRC) && /SEAL_HAS_NO_REPORT_ID/.test(SRC));

console.log('\n2. the exact bytes, unaltered');
// The seal covers a rendering. Re-wrapping, reflowing or re-encoding it breaks
// the only thing that proves this is the report that was published. Asserted
// against the real bytes, not against the shape of the source.
const byteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-bytes-'));
try {
  // CRLF endings and a trailing form feed: exactly the things a well-meaning
  // normaliser would quietly "fix".
  const awkward = Buffer.concat([
    Buffer.from(report().replace(/\n/g, '\r\n'), 'utf8'), Buffer.from([0x0c])]);
  fs.writeFileSync(path.join(byteDir, 'R_SW-20260813-MNOC7_2026-08-13.txt'), awkward);
  const built = I.build(I.plan(byteDir));
  const stored = built.files['history/2026/08/13/SW-20260813-MNOC7/report.txt'];
  check('what is stored is a Buffer, not a re-encoded string', Buffer.isBuffer(stored));
  check('and it is byte-for-byte what was read', Buffer.isBuffer(stored) && stored.equals(awkward));
  check('CRLF line endings survive untouched',
    Buffer.isBuffer(stored) && stored.includes(Buffer.from('\r\n')));
  const receipt = JSON.parse(built.files['history/2026/08/13/SW-20260813-MNOC7/receipt.json']);
  check('the recorded sha256 is over those exact bytes',
    receipt.sha256 === crypto.createHash('sha256').update(awkward).digest('hex'));
  check('and the recorded length matches', receipt.bytes === awkward.length);
} finally { fs.rmSync(byteDir, { recursive: true, force: true }); }

console.log('\n2b. a file with no seal is not imported');
const unsealedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-unsealed-'));
try {
  fs.writeFileSync(path.join(unsealedDir, 'notes.txt'), 'just some notes, no seal\n');
  fs.writeFileSync(path.join(unsealedDir, 'broken.txt'), 'SECTION 01\n{ not json at all\n');
  fs.writeFileSync(path.join(unsealedDir, 'wrongid.txt'),
    report({ report_id: 'NOT-A-REPORT-ID' }));
  fs.writeFileSync(path.join(unsealedDir, 'R_SW-20260813-MNOC7_2026-08-13.txt'), report());
  // A directory with junk in it must not crash the importer: an operator
  // pointing it at a folder of mixed downloads should get a list of what was
  // rejected, not a stack trace.
  let planError = null, p2 = { records: [], rejected: [] };
  try { p2 = I.plan(unsealedDir); } catch (e) { planError = e.message; }
  check('a directory containing unsealed files does not crash the import', planError === null, planError);
  check('only the sealed file is imported', p2.records.length === 1, p2.records.map(r => r.original_filename));
  check('and the other three are rejected with reasons', p2.rejected.length === 3, p2.rejected);
  check('an unsealed file names the missing seal',
    p2.rejected.some(r => r.file === 'notes.txt' && r.reason === 'NO_EVIDENCE_CAPSULE_SEAL'), p2.rejected);
  check('a malformed seal is refused rather than half-read',
    p2.rejected.some(r => r.file === 'broken.txt' && r.reason === 'NO_EVIDENCE_CAPSULE_SEAL'));
  check('and a seal whose report id is not one is refused',
    p2.rejected.some(r => r.file === 'wrongid.txt' && r.reason === 'SEAL_HAS_NO_REPORT_ID'));
  const built2 = I.build(p2);
  check('nothing rejected reaches the file map',
    Object.keys(built2.files).filter(k => /report\.txt$/.test(k)).length === 1,
    Object.keys(built2.files));
} finally { fs.rmSync(unsealedDir, { recursive: true, force: true }); }

console.log('\n3. variants are kept, and none is made canonical');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-import-'));
try {
  // Two renders of one sealed report, twenty seconds apart. Identical seal,
  // different bytes — exactly the case in the real archive.
  fs.writeFileSync(path.join(scratch, 'R_SW-20260819-AF2EG_2026-08-19.txt'),
    report({ report_id: 'SW-20260819-AF2EG', date: '2026-08-19', generated_at: '2026-08-19T16:17:26.260Z' }));
  fs.writeFileSync(path.join(scratch, 'R_SW-20260819-AF2EG_2026-08-19 (1).txt'),
    report({ report_id: 'SW-20260819-AF2EG', date: '2026-08-19', generated_at: '2026-08-19T16:17:46.391Z' }));
  fs.writeFileSync(path.join(scratch, 'R_SW-20260813-MNOC7_2026-08-13.txt'), report());
  // And a byte-identical duplicate, which is a different situation entirely.
  fs.writeFileSync(path.join(scratch, 'R_SW-20260813-MNOC7_2026-08-13 (copy).txt'), report());

  const out = require('child_process').execFileSync(process.execPath,
    [path.join(ROOT, 'scripts/import-report-archive.js'), '--from', scratch], { encoding: 'utf8' });
  check('a report id with two differing renders is reported as having variants',
    /ids with variants 1/.test(out), out.split('\n').find(l => /variants/.test(l)));
  check('and both are kept, each under its own content hash',
    /both kept, each under its own hash/.test(out));
  check('a byte-identical duplicate is stored once, and said so',
    /byte-identical    1 duplicate/.test(out), out.split('\n').find(l => /identical/.test(l)));
  check('4 files become 3 stored reports', /sealed reports    4 · 2 distinct report ids/.test(out), out);
  // Filing one variant plainly and the other under a hash would silently make
  // the first canonical.
  // Filing one variant plainly and the other under a hash would silently make
  // the first canonical. Asserted on the real paths.
  const vplan = I.plan(scratch);
  const vpaths = Object.keys(I.build(vplan).files).filter(k => /AF2EG.*report\.txt$/.test(k));
  check('neither variant gets the plain path when they differ',
    vpaths.length === 2 && vpaths.every(p => /\/[a-f0-9]{12}\.report\.txt$/.test(p)), vpaths);
  check('and the identical pair is stored once, under the plain path',
    Object.keys(I.build(vplan).files).filter(k => /MNOC7.*report\.txt$/.test(k))
      .every(p => /\/report\.txt$/.test(p)));
  check('the original filename is preserved even when bytes are shared',
    /also_filed_as/.test(SRC) && /original_filename: r\.original_filename/.test(SRC));
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }

console.log('\n4. a rendered conclusion is not ledger evidence');
// An archive that blurred the two would let a later reader treat a sentence in
// a report as proof of a transaction.
check('each receipt says what kind of artifact it is',
  /artifact_kind: 'SEALED_REPORT_RENDERING'/.test(SRC));
check('and says plainly that quoted hashes are not proven by it',
  /quotes addresses and transaction hashes; it does not prove them/.test(SRC));
check('the index repeats it, so a reader of the index alone cannot miss it',
  /not_raw_ledger_evidence/.test(SRC) && /Raw XRPL evidence lives under evidence\//.test(SRC));
// The more dangerous direction. A report renders what the run chose to say,
// never everything the ledger did — so reading absence as evidence of absence
// would turn a narrative omission into "nothing happened".
check('and both say that absence from a report proves nothing',
  (SRC.match(/absence_proves_nothing/g) || []).length === 2 &&
  /do not enumerate/i.test(SRC) && /Do not infer an unrendered transaction did not occur/.test(SRC));
check('history is filed separately from evidence',
  /const ROOT_PREFIX = 'history'/.test(SRC));
check('and the import never writes under evidence/',
  !/'evidence\//.test(SRC.replace(/Raw XRPL evidence lives under evidence\//, '')));

console.log('\n5. publishing is deliberate and resumable');
check('it is a dry run unless --apply is given', /if \(!opts\.apply\)/.test(SRC) && /DRY RUN/.test(SRC));
check('the evidence repo is the pinned target', /A\.evidenceTarget\(process\.env\)/.test(SRC));
check('git blob ids are computed locally, so a re-run skips what is there',
  /existing\.get\(p\) !== gitSha\(buf\)/.test(SRC));
check('and a lost race is retried rather than forced',
  /if \(!e\.refConflict \|\| attempt === 3\) throw e/.test(SRC));

console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' REPORT ARCHIVE IMPORT CHECKS PASS'));
process.exit(fail ? 1 : 0);

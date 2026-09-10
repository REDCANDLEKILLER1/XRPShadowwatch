#!/usr/bin/env node
'use strict';
// Publish a VERIFIED evidence export to the archive branch.
//
// Same token, same pinned repository and branch as the sealed-report archive,
// and the same fast-forward commit path (src/db/github-archive.js). The token
// is server-side only and never reaches browser JS; this is an operator
// script, run from a machine that has it.
//
// ── IT REFUSES TO PUBLISH WHAT IT CANNOT VERIFY ────────────────────────────
//
// Before a single blob is uploaded it re-checks the manifest's own hash and
// every file's plaintext hash. Publishing is the step that makes the archive
// permanent — a git repository cannot un-commit — so an archive that does not
// verify locally does not get uploaded, and the operator is sent back to
// scripts/verify-evidence-export.js, which also checks it against the live
// database.
//
// ── IT IS RESUMABLE, AND RE-RUNNING IS FREE ────────────────────────────────
//
// The branch's tree is read once and every local file's git blob sha1 is
// computed offline. Files already present with identical content are skipped,
// so a run interrupted at file 300 of 700 continues rather than restarting,
// and a completed export republished twice writes nothing the second time.
//
// Usage:
//   node scripts/github-publish-export.js --in export            # dry run
//   node scripts/github-publish-export.js --in export --apply
//   node scripts/github-publish-export.js --in export --apply --batch 60

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const A = require('../src/db/github-archive');
const X = require('../src/db/evidence-export');

// GitHub warns above 50 MB and refuses above 100. The exporter's shard cap is
// well under, so this firing means something upstream changed.
const MAX_BLOB_BYTES = 45 * 1024 * 1024;
const DEFAULT_BATCH = 40;

function args(argv) {
  const out = { in: null, apply: false, batch: DEFAULT_BATCH };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--in') out.in = argv[++i];
    else if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--batch') out.batch = Number(argv[++i]);
  }
  if (!out.in) throw new Error('MISSING_ARGUMENT: --in <dir> is required');
  if (!Number.isFinite(out.batch) || out.batch < 1 || out.batch > 200) throw new Error('INVALID_BATCH: 1..200');
  return out;
}

// Git's own object id: sha1 over "blob <bytes>\0" + content. Computing it
// locally is what makes the skip decision free — no download, no comparison
// against content we would have to fetch first.
function blobSha(buffer) {
  return crypto.createHash('sha1')
    .update('blob ' + buffer.length + '\0', 'utf8').update(buffer).digest('hex');
}
const mb = bytes => (bytes / (1024 * 1024)).toFixed(1) + ' MB';

async function main() {
  const opts = args(process.argv.slice(2));
  const root = path.resolve(opts.in);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

  console.log('PUBLISH EVIDENCE EXPORT');
  console.log('  archive           ' + root);
  console.log('  export_id         ' + manifest.export_id);

  if (manifest.schema !== X.SCHEMA) throw new Error('MANIFEST_SCHEMA_UNKNOWN: ' + manifest.schema);
  if (manifest.manifest_sha256 !== X.manifestDigest(manifest)) {
    throw new Error('MANIFEST_EDITED: the manifest does not hash to its own recorded digest; ' +
      're-export rather than publishing it');
  }

  // Re-verify locally. Publishing is permanent.
  const local = [];
  for (const entry of manifest.files) {
    const full = path.join(root, entry.path);
    if (!fs.existsSync(full)) throw new Error('EXPORT_INCOMPLETE: missing ' + entry.path);
    const raw = fs.readFileSync(full);
    if (entry.gz_sha256 && X.sha256(raw) !== entry.gz_sha256) throw new Error('EXPORT_CORRUPT: ' + entry.path);
    const text = entry.path.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    if (X.sha256(Buffer.from(text, 'utf8')) !== entry.sha256) throw new Error('EXPORT_CORRUPT: ' + entry.path);
    if (raw.length > MAX_BLOB_BYTES) throw new Error('BLOB_TOO_LARGE: ' + entry.path + ' is ' + mb(raw.length) +
      '; GitHub refuses blobs over 100 MB. Re-export with a smaller shard cap.');
    local.push({ path: entry.path, buffer: raw, sha: blobSha(raw) });
  }
  // The manifest travels with the files it vouches for.
  const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  local.push({ path: 'manifest.json', buffer: manifestBuffer, sha: blobSha(manifestBuffer) });
  console.log('  files verified    ' + local.length + ' · ' + mb(local.reduce((n, f) => n + f.buffer.length, 0)));

  const { token, repo, branch } = A.archiveTarget(process.env);
  const gh = A.client(token, repo, fetch);
  const ref = await A.archiveRef(gh, branch);
  const commit = await gh('GET', '/git/commits/' + ref.object.sha);
  const tree = await gh('GET', '/git/trees/' + commit.tree.sha + '?recursive=1');
  const existing = new Map((tree.tree || []).filter(n => n.type === 'blob').map(n => [n.path, n.sha]));

  // Everything under evidence/ and state/ is namespaced by the export so a
  // second export never silently overwrites the first, and reports/ — the
  // sealed-report archive — is never touched by this script at all.
  const prefix = 'evidence-export/' + manifest.export_id + '/';
  const pending = local
    .map(f => ({ ...f, target: prefix + f.path }))
    .filter(f => existing.get(f.target) !== f.sha);

  console.log('  branch            ' + branch + ' @ ' + ref.object.sha.slice(0, 7));
  console.log('  destination       ' + prefix);
  console.log('  already present   ' + (local.length - pending.length));
  console.log('  to upload         ' + pending.length + ' · ' + mb(pending.reduce((n, f) => n + f.buffer.length, 0)));
  console.log('  mode              ' + (opts.apply ? 'APPLY' : 'DRY RUN (pass --apply to publish)'));

  if (!pending.length) { console.log('\nNothing to do — this export is already published in full.'); return finish(0); }
  if (!opts.apply) { console.log('\nDry run. Nothing was uploaded.'); return finish(0); }

  let written = 0, bytes = 0, commits = 0;
  for (let offset = 0; offset < pending.length; offset += opts.batch) {
    const chunk = pending.slice(offset, offset + opts.batch);
    const files = {};
    for (const file of chunk) files[file.target] = file.buffer;
    let head = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await gh('GET', '/git/ref/heads/' + branch);
      try {
        head = await A.commitFiles(gh, branch, current.object.sha, files,
          'evidence export ' + manifest.export_id + ': ' + (offset + chunk.length) + '/' + pending.length + ' files');
        break;
      } catch (e) { if (!e.refConflict || attempt === 3) throw e; }
    }
    written += head.files_written; bytes += head.bytes_written; commits++;
    process.stdout.write('  uploaded ' + written + '/' + pending.length + ' files…\r');
  }

  console.log('\n\nPUBLISHED');
  console.log('  files             ' + written);
  console.log('  bytes             ' + mb(bytes));
  console.log('  commits           ' + commits);
  console.log('  path              ' + branch + ':' + prefix);
  console.log('  manifest sha256   ' + manifest.manifest_sha256);
  console.log('\nThe sealed-report archive under reports/ was not touched.');
  return finish(0);
}

function finish(code) { process.exitCode = code; }

main().catch(e => { console.error(String(e && e.message || e)); finish(1); });

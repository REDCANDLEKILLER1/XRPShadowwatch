#!/usr/bin/env node
// Syntax gate for every executable JavaScript file in the repo.
//
// The previous gate was a package.json one-liner globbing three directories:
//     src/js/*.js  src/brief/*.js  src/assets/*.js
// It therefore checked 47 of the repo's 61 JavaScript files and silently skipped
//     api/            the Vercel serverless proxy — the only server-side code
//     src/shared/     4,418 lines, including the MACHINE-GENERATED hvt-roster.js
//     src/js/intel/   the scoring helpers
//     scripts/        this file's neighbours
//     sw.js           the service worker
// (src/assets/*.js matched nothing at all — there are no .js files there.)
//
// That was demonstrated, not assumed: a deliberate syntax error written into
// src/shared/hvt-roster.js still produced "all 47 scripts parse". A generated
// file is exactly the kind that breaks without a human noticing, and a broken
// roster or a broken proxy reaches production the same way.
//
// This enumerates from `git ls-files` so newly added directories are covered
// automatically and nothing has to be remembered. It reports EVERY failure
// rather than stopping at the first, so one run tells you the whole story.
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.vercel', 'dist', 'build', 'coverage']);

function listTracked() {
  try {
    return execFileSync('git', ['ls-files', '*.js'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(Boolean);
  } catch (_) {
    return null;   // not a git checkout — fall back to a walk
  }
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(path.relative(ROOT, path.join(dir, entry.name)));
    }
  }
  return out;
}

const files = (listTracked() || walk(ROOT, [])).sort();

if (!files.length) {
  console.error('check-syntax: found no JavaScript files to check — refusing to pass.');
  process.exit(1);
}

const failures = [];
for (const rel of files) {
  const res = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8' });
  if (res.status !== 0) {
    failures.push({ file: rel, detail: (res.stderr || '').trim() });
  }
}

if (failures.length) {
  console.error('\n✖ SYNTAX CHECK FAILED — ' + failures.length + ' of ' + files.length + ' file(s)\n');
  for (const f of failures) {
    console.error('  ' + f.file);
    for (const line of f.detail.split('\n').slice(0, 6)) console.error('    ' + line);
    console.error('');
  }
  process.exit(1);
}

const dirs = [...new Set(files.map(f => path.dirname(f)))].sort();
console.log('all ' + files.length + ' scripts parse  (' + dirs.join(', ') + ')');

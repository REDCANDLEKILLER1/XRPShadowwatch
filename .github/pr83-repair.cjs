'use strict';
// One-shot, branch-restricted publisher for the locally tested PR83 repair.
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const cp = require('child_process');
const assert = require('assert');
const branch = 'agent/pr83-preview-memory-repair';
assert.strictEqual(process.env.GITHUB_REF, 'refs/heads/' + branch, 'wrong branch');
assert.strictEqual(cp.execFileSync('git', ['rev-parse', 'HEAD^'], {encoding:'utf8'}).trim(),
  '65fd5952958b6758500fc99047690a85d16c3cc1', 'base moved');
const bytes = zlib.gunzipSync(fs.readFileSync('.github/pr83-repair.json.gz'));
assert.strictEqual(crypto.createHash('sha256').update(bytes).digest('hex'),
  '92127d3ca5073cfe7e2d8bffd4af429ff9e4cc2705a4b0fc26e09ca373302d59', 'payload changed');
const patch = JSON.parse(bytes);
const allowed = new Set([
  'api/delta.js','docs/CONTRACT.md','src/brief/02-core.js',
  'src/brief/45-delta-evidence-index-20260911.js',
  'src/brief/46-memory-guard-20260923.js',
  'src/brief/47-preview-no-direct-xrpl-20260923.js',
  'src/brief/48-coordination-render-20260923.js',
  'scripts/coordination-render-memory.test.js','scripts/memory-guard.test.js',
  'scripts/preview-no-direct-xrpl-fallback.test.js'
]);
function blob(data) {
  return crypto.createHash('sha1').update('blob ' + data.length + '\0').update(data).digest('hex');
}
for (const [file, sha] of Object.entries(patch.expected_blobs)) {
  assert(allowed.has(file));
  assert.strictEqual(blob(fs.readFileSync(file)), sha, 'base blob changed: '+file);
}
for (const {path:file, old, new:replacement} of patch.edits) {
  assert(allowed.has(file));
  const source = fs.readFileSync(file, 'utf8');
  assert(old.length > 0 && source.split(old).length === 2, 'replacement is not unique: '+file);
  fs.writeFileSync(file, source.replace(old, replacement));
}
for (const [file, text] of Object.entries(patch.files)) {
  assert(allowed.has(file)); fs.writeFileSync(file, text);
}
for (const file of patch.deletes) { assert(allowed.has(file)); fs.unlinkSync(file); }
const expected = {
  'api/delta.js':'6b908f0bd2830c90cb5997d1618d2398a276821f',
  'src/brief/02-core.js':'6b751b088266d9c220c0f8d61ef911ffca7a4612',
  'src/brief/45-delta-evidence-index-20260911.js':'1e0f5a32c0a3507426e30556180a4c3aa692c571',
  'src/brief/46-memory-guard-20260923.js':'7773ce0ac69eb5bc74802cd91b8987661ef9dbe1',
  'scripts/coordination-render-memory.test.js':'03c4a498d2ff8ae5907429b0578724b55437880b',
  'scripts/memory-guard.test.js':'92f5176bdd32f29bfc6e68bd3c60c8986f2b0860',
  'scripts/preview-no-direct-xrpl-fallback.test.js':'13536573924a5b3a546be34952ef0193a0af5955'
};
for (const [file, sha] of Object.entries(expected)) {
  const actual = blob(fs.readFileSync(file));
  assert.strictEqual(actual, sha, 'output differs from locally tested source: '+file);
  console.log(actual+'  '+file);
}
console.log('PR83 repair applied; all seven tested source/test blobs match.');

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createHash } = require('crypto');
const BASE58_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,35}$/;

// Read the same committed roster definitions the report loads. No committed
// balance or cursor enters the database proof path. Local discovery remains
// local unless a candidate passes the server-verified GitHub promotion gate.
function roster() {
  const core = fs.readFileSync(path.join(__dirname, '../brief/02-core.js'), 'utf8');
  const begin = core.indexOf('const WATCHLIST = [');
  const end = core.indexOf('// v3.4: merge user-added discovery', begin);
  if (begin < 0 || end < 0) throw new Error('Canonical report roster was not found');
  const list = vm.runInNewContext(core.slice(begin, end) + '\nWATCHLIST;', {}, { timeout: 1000 });
  const shared = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../shared/hvt-roster.js'), 'utf8'), shared, { timeout: 1000 });
  const cats = { EXCH: 'exchange', RIPPLE: 'escrow', HVT: 'whale' };
  for (const t of shared.window.SW_HVT_ROSTER.targets) {
    if (!list.some(w => w.address === t.address)) list.push({ address: t.address, label: t.handle || t.label, cat: cats[t.type] || 'whale' });
  }

  // Machine-managed, data-only additions. This file can be updated by the
  // production promotion endpoint, but it cannot alter proof/checkpoint state
  // and it is parsed as JSON rather than executed as code.
  const autoPath = path.join(__dirname, '../shared/auto-watchlist.json');
  if (fs.existsSync(autoPath)) {
    let auto;
    try { auto = JSON.parse(fs.readFileSync(autoPath, 'utf8')); }
    catch (_) { throw new Error('AUTO_WATCHLIST_INVALID_JSON'); }
    if (!auto || auto.version !== 1 || !Array.isArray(auto.entries)) throw new Error('AUTO_WATCHLIST_INVALID');
    for (const entry of auto.entries) {
      if (!entry || !BASE58_RE.test(String(entry.address || ''))) throw new Error('AUTO_WATCHLIST_INVALID_ADDRESS');
      const label = String(entry.handle || ('AUTO_' + entry.address.slice(0, 6) + '_' + entry.address.slice(-4))).slice(0, 80);
      const cat = String(entry.cat || 'discovered_receiver').slice(0, 40);
      if (!list.some(w => w.address === entry.address)) list.push({ address: entry.address, label, cat });
    }
  }

  for (const [file, variable, boundary] of [
    ['17-report-scan-tuning-20260816.js', 'PROMOTIONS', 'function promoteOne'],
    ['38-na2tm-acceptance-cleanup-20260820.js', 'PROMOTION', 'function promoteWallet']
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '../brief', file), 'utf8');
    const start = source.indexOf('var ' + variable + ' =');
    const stop = source.indexOf(boundary, start);
    if (start < 0 || stop < 0) throw new Error('Canonical promotion configuration missing');
    const value = vm.runInNewContext(source.slice(start, stop) + '\n' + variable, {}, { timeout: 1000 });
    for (const p of Array.isArray(value) ? value : [value]) {
      if (!list.some(w => w.address === p.address)) list.push({ address: p.address, label: p.label, cat: p.cat });
    }
  }
  return list;
}
function identity(addresses) {
  return createHash('sha256').update(Array.from(new Set(addresses)).sort().join('\n')).digest('hex');
}
function select(addresses) {
  const known = roster();
  const allowed = new Set(known.map(w => w.address));
  const chosen = addresses === undefined ? [...allowed] : addresses;
  if (!Array.isArray(chosen) || !chosen.length || chosen.length > allowed.size ||
      new Set(chosen).size !== chosen.length || chosen.some(a => !allowed.has(a))) throw new Error('ROSTER_MISMATCH');
  return { accounts: chosen.slice(), hash: identity(chosen), canonical_hash: identity([...allowed]) };
}
module.exports = { roster, identity, select };

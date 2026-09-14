'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createHash } = require('crypto');

// Read the same committed roster definitions the report loads. No committed
// balance or cursor enters the database proof path. Local discovery remains
// in the browser; an unknown address cannot silently alter this server roster.
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

  // v16.8: canonical ADD promotions are now committed to a dedicated data file
  // instead of being hand-copied into another runtime patch. The browser loads
  // this same file before a scan; keeping the server on the identical source is
  // what prevents a promoted address from causing ROSTER_MISMATCH.
  const promotionPath = path.join(__dirname, '../shared/watchlist-promotions.json');
  let promotions;
  try { promotions = JSON.parse(fs.readFileSync(promotionPath, 'utf8')); }
  catch (_) { throw new Error('Canonical watchlist promotion roster is invalid'); }
  if (!Array.isArray(promotions)) throw new Error('Canonical watchlist promotion roster is invalid');
  for (const p of promotions) {
    if (!p || typeof p.address !== 'string' || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(p.address))
      throw new Error('Canonical watchlist promotion entry is invalid');
    if (!list.some(w => w.address === p.address)) list.push({
      address: p.address,
      label: (typeof p.label === 'string' && p.label) ? p.label : 'AUTO_WATCH_' + p.address.slice(0, 8),
      cat: (typeof p.cat === 'string' && p.cat) ? p.cat : 'discovered_unknown_highval'
    });
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

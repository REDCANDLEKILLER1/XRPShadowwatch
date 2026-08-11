// Build src/shared/hvt-roster.js from the two apps' target lists + the registry.
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..') + '/';

const core = fs.readFileSync(R + 'src/brief/02-core.js', 'utf8');
const wlSrc = core.slice(core.indexOf('const WATCHLIST = ['), core.indexOf('const KNOWN = Object.fromEntries'));
const report = [...wlSrc.matchAll(/\[\s*'([^']+)'\s*,\s*'(r[1-9A-HJ-NP-Za-km-z]{20,})'\s*,\s*'([a-z_]+)'\s*\]/g)]
  .map(m => ({ handle: m[1], address: m[2], cat: m[3] }));

const app = fs.readFileSync(R + 'src/js/app.js', 'utf8');
let hvtSrc = app.slice(app.indexOf('const PRELOADED_HVTS = ['));
hvtSrc = hvtSrc.slice(0, hvtSrc.indexOf('\n        ];'));
const wall = [...hvtSrc.matchAll(/label:\s*"([^"]+)",\s*address:\s*"(r[^"]+)",\s*type:\s*"([A-Z]+)"/g)]
  .map(m => ({ label: m[1], address: m[2], type: m[3] }));

// registry
const regSrc = fs.readFileSync(R + 'src/shared/wallet-identities.js', 'utf8');
const REG = JSON.parse(regSrc.slice(regSrc.indexOf('{'), regSrc.lastIndexOf('}') + 1));

// "20M Split 1" / "RIPPLE_1.3B" / "Main 300M Reserve" → the size the label claims.
// This is what makes a drained target detectable: a wallet labelled 100M holding
// 50 XRP is not a rounding error, it is an event.
function expectedFromLabel(s) {
  if (!s) return null;
  const m = /(\d+(?:\.\d+)?)\s*([MB])(?![A-Za-z])/.exec(String(s));
  if (!m) return null;
  const v = parseFloat(m[1]) * (m[2].toUpperCase() === 'B' ? 1e9 : 1e6);
  return (v >= 1e6 && v <= 1e11) ? v : null;
}

const CAT_TYPE = { exchange: 'EXCH', escrow: 'RIPPLE', whale: 'HVT' };

// An address the ledger will never answer for is a dead row on the board and a
// wasted scan slot every sweep. The alphabet check alone is not enough — it
// passed BITRUE_COLD (lowercase L, caught) but ALSO passed INDODAX_COLD, which
// the ledger rejects outright ("scanOffers: Account malformed"). Only the
// base58check checksum catches a typo that happens to use legal characters.
const crypto = require('crypto');
const B58 = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
function b58decode(s) {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) return null; n = n * 58n + BigInt(i); }
  let h = n.toString(16); if (h.length % 2) h = '0' + h;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(h, 'hex');
  let pad = 0; for (const c of s) { if (c === B58[0]) pad++; else break; }
  return Buffer.concat([Buffer.alloc(pad), body]);
}
function isXrplAddress(s) {
  if (typeof s !== 'string' || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(s)) return false;
  const b = b58decode(s);
  // 1 version byte (0x00 for an account) + 20 payload + 4 checksum
  if (!b || b.length !== 25 || b[0] !== 0) return false;
  const sha = x => crypto.createHash('sha256').update(x).digest();
  return sha(sha(b.subarray(0, 21))).subarray(0, 4).equals(b.subarray(21));
}
const rejected = [];

const byAddr = new Map();
function put(addr, patch, source) {
  const cur = byAddr.get(addr) || { address: addr, sources: [] };
  Object.keys(patch).forEach(k => { if (patch[k] != null && cur[k] == null) cur[k] = patch[k]; });
  if (!cur.sources.includes(source)) cur.sources.push(source);
  byAddr.set(addr, cur);
}
report.forEach(r => put(r.address, { handle: r.handle, type: CAT_TYPE[r.cat] || 'HVT', cat: r.cat }, 'report'));
wall.forEach(w => put(w.address, { wall_label: w.label, type: w.type }, 'wall'));

const targets = [...byAddr.values()].filter(t => {
  if (isXrplAddress(t.address)) return true;
  rejected.push({ address: t.address, label: t.wall_label || t.handle, sources: t.sources });
  return false;
}).map(t => {
  const id = REG[t.address];
  const label = (id && id.name) || t.wall_label || t.handle || t.address.slice(0, 10) + '…';
  return {
    address: t.address,
    label,
    handle: t.handle || null,
    type: (id && id.type) || t.type || 'HVT',
    identified: !!(id && id.name),
    confidence: (id && id.confidence) || null,
    expected_xrp: expectedFromLabel(t.wall_label) || expectedFromLabel(t.handle) || null,
    sources: t.sources.sort()
  };
});

// Stable order: identified first, then by label — the file is committed, so a
// stable sort keeps the diffs readable when targets are added.
targets.sort((a, b) => (b.identified - a.identified) || a.label.localeCompare(b.label) || a.address.localeCompare(b.address));

const stats = {
  total: targets.length,
  identified: targets.filter(t => t.identified).length,
  from_report_only: targets.filter(t => t.sources.length === 1 && t.sources[0] === 'report').length,
  from_wall_only: targets.filter(t => t.sources.length === 1 && t.sources[0] === 'wall').length,
  both: targets.filter(t => t.sources.length === 2).length,
  with_expected: targets.filter(t => t.expected_xrp).length,
  rejected_invalid: 0            // filled in below — the generator drops these
};

stats.rejected_invalid = rejected.length;

const header = `// ── SHARED HIGH-VALUE TARGET ROSTER ──────────────────────────────────────────
// The one list of wallets both apps consider high-value. Before this file the
// live wall watched ${wall.length} targets and the report console watched ${report.length}, and only
// ${stats.both} addresses were on both — so a wallet could be a headline in the morning
// brief and completely absent from the HVT board, or drain to nothing on the
// board without the report ever looking at it.
//
// Loaded by BOTH index.html and brief-console.html. They are separate documents
// with separate engines; a committed file is the only thing they can both read.
// Same pattern, and the same rules, as src/shared/wallet-identities.js:
//   · \`label\` is a NAME only when the identity registry establishes one
//     (\`identified: true\`). Otherwise it is the internal handle or the wall's
//     own label — a description, not a claim of ownership.
//   · \`expected_xrp\` is the size the label itself asserts ("20M Split 1",
//     "RIPPLE_1.3B"). It is what the balance watch measures a drain against:
//     a target labelled 100M holding 50 XRP is an event, not noise.
//   · \`sources\` records which app contributed the address, so neither side
//     silently loses its own targets when this file is regenerated.
//
// Regenerate with scripts/build-hvt-roster.js after adding wallets to either
// app. Do not hand-edit — the generator is the source of truth.
//
// ${stats.total} targets · ${stats.identified} with a sourced identity · ${stats.with_expected} carrying a size claim
`;

const body = 'window.SW_HVT_ROSTER = ' + JSON.stringify({
  version: 1,
  generated: '__GENERATED__',
  stats,
  targets
}, null, 1) + ';\n';

// The generated date is passed in rather than stamped from the clock, so
// re-running the generator on an unchanged input produces an identical file and
// an empty diff.
const stamp = process.argv[2] || new Date().toISOString().slice(0, 10);
const out = header + body.replace('__GENERATED__', stamp);
fs.writeFileSync(R + 'src/shared/hvt-roster.js', out);
console.log('wrote src/shared/hvt-roster.js — ' + JSON.stringify(stats));
if (rejected.length) {
  console.log('\nREJECTED (fails base58check — the ledger will never answer for these):');
  rejected.forEach(r => console.log('  ' + r.address + '  ' + (r.label || '') + '  [' + r.sources.join(',') + ']'));
}

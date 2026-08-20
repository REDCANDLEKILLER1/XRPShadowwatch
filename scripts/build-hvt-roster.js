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

// A size we know from a SOURCE rather than from the label or from our own
// scanning. Kept as an explicit, annotated map rather than folded into the label
// parser, because every entry here is a number this app did not read off the
// ledger itself and that distinction has to stay visible.
//
// The bridge is the case that forced it: we started watching it AFTER it was
// emptied, so its first reading (493.5 XRP) becomes its own high-water mark and
// the drain watch has nothing to measure against — the single most important
// fact about the wallet is invisible precisely because we arrived late.
const SOURCED_EXPECTED = {
  // Held ~200,410 XRP before the 2026-08-09 drain; ~199,916 left in 97 minutes.
  // xrpl.to Insights 2026-08-11, reproducible with account_tx over ledgers
  // 106,183,346-842. Our own 2026-08-11 scan independently read the OTHER side
  // of this number — 493.543894 XRP remaining, against the article's 493.5.
  'rxXXXeMX8Gy5YvibvGLnQJ1XKKD7UswM1': 200410
};

// Report-approved promotions that have not yet been written into 02-core's
// legacy WATCHLIST array. Keeping them here prevents a later roster regeneration
// from deleting a wallet the Report itself already promoted. These are behavioral
// handles only — no identity claim is made here.
const REPORT_PROMOTIONS = [
  { handle: 'WHALE_RECV_rpY7bZ', address: 'rpY7bZBkA98P8zds5LdBktAKj9ifekPdkE', cat: 'discovered_whale' },
  { handle: 'WHALE_RECV_rU5NDV', address: 'rU5NDVnQ6nHBvD33en6HjWipY67PJ7hcXG', cat: 'discovered_whale' },
  { handle: 'EXOUT_RECV_rsnXj9', address: 'rsnXj9TDwt49XxCM64YrTEnSzwcY4awZnn', cat: 'discovered_receiver' },
  { handle: 'LARGE_RECV_rw1xqK', address: 'rw1xqK3TvKCZcdTcHGp6b2Q8dELnCCGFvT', cat: 'discovered_receiver' },
  { handle: 'LARGE_RECV_rDHyd2', address: 'rDHyd2wTXnoT1MTvCigLGpm8o7WdhE5mGi', cat: 'discovered_receiver' },
  { handle: 'LARGE_RECV_rLG9Vp', address: 'rLG9Vpi3xLgfkzAfPkL9AJmD433DY7MoJk', cat: 'discovered_receiver' },
  { handle: 'SPLITTER_rhhB3i', address: 'rhhB3igjitCmsN3PLh5zAgUuYvHJD8mJdd', cat: 'next_hop_splitter' },
  { handle: 'SPLITTER_rBpFQo', address: 'rBpFQot2zM5kpEz8mQ1P76i5EU5ZzDEBC4', cat: 'next_hop_splitter' },
  { handle: 'LARGE_RECV_rML7EM', address: 'rML7EMb8QoaN8BraqHHdWZzSU4nReYRR9w', cat: 'discovered_receiver' },
  { handle: 'SPLITTER_r4x919', address: 'r4x919MCsHKknPJMSt87g7tjMdwwo9wk6K', cat: 'next_hop_splitter' },
  { handle: 'SPLITTER_rNAQWc', address: 'rNAQWcAYTbgC6wvdWLCa6su7VRsepiarTR', cat: 'next_hop_splitter' },
  { handle: 'EXOUT_RECV_rnrqyM', address: 'rnrqyM7kS6wmC5demJm9vrfdN2vLgS8LfY', cat: 'discovered_receiver' },
  { handle: 'WHALE_RECV_rDHYrd', address: 'rDHYrdu78ZU3qhiKttB7z73GJYpSQFMVHj', cat: 'discovered_whale' },
  { handle: 'WHALE_RECV_rUkxsG', address: 'rUkxsGUE3E7AUngmwRT46uGwRDJ8pa5L7s', cat: 'discovered_whale' }
];

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

const CAT_TYPE = {
  exchange: 'EXCH', escrow: 'RIPPLE', whale: 'HVT',
  discovered_whale: 'HVT', discovered_receiver: 'HVT',
  discovered_unknown_highval: 'HVT', next_hop_splitter: 'HVT'
};

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
REPORT_PROMOTIONS.forEach(r => put(r.address, { handle: r.handle, type: CAT_TYPE[r.cat] || 'HVT', cat: r.cat }, 'report'));
wall.forEach(w => put(w.address, { wall_label: w.label, type: w.type }, 'wall'));
// The registry used to be consulted only for NAMES, never as a source of
// targets — so 29 wallets we had positively identified (Bitget Global, SBI VC
// Trade, Revolut, Bitkub, Luno, Ceffu, both Evernorth treasury wallets, the
// Flare Core Vault) were named in every report and scanned by neither app. A
// wallet worth naming is a wallet worth watching; that is what the registry is
// for. Adding it here means the gap closes itself whenever an identity lands,
// instead of waiting for someone to notice and hand-copy the address.
Object.keys(REG).forEach(a => put(a, { type: REG[a].type || 'HVT' }, 'registry'));

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
    expected_xrp: SOURCED_EXPECTED[t.address] || expectedFromLabel(t.wall_label) || expectedFromLabel(t.handle) || null,
    expected_source: SOURCED_EXPECTED[t.address] ? 'published_source' : (expectedFromLabel(t.wall_label) || expectedFromLabel(t.handle) ? 'label_claim' : null),
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
  // Named by the registry and targeted by neither app until this file picked
  // them up — the gap that made the registry a third source.
  from_registry_only: targets.filter(t => t.sources.length === 1 && t.sources[0] === 'registry').length,
  both: targets.filter(t => t.sources.indexOf('report') >= 0 && t.sources.indexOf('wall') >= 0).length,
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

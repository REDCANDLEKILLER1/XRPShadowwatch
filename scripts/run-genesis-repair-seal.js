'use strict';

const handler = require('../api/lineage-repair');

const OWNER = 'REDCANDLEKILLER1';
const REPO = 'XRPShadowwatch';
const DATA_BRANCH = 'hub/genesis-lineage-data';
const MANIFEST_PATH = 'data/genesis-lineage/manifest.json';
const EXPECTED = {
  rnzi: {
    address: 'rnziParaNb8nsU4aruQdwYE3j5jUcqjzFm',
    from: 4181980,
    to: 10852617,
    txCount: 30974,
    effectCount: 4564,
    flowCount: 23
  },
  r9h: {
    address: 'r9hEDb4xBGRfBCcX3E4FirDWQBAYtpxC8K',
    from: 4181980,
    to: 10852617,
    txCount: 77407,
    effectCount: 27039,
    flowCount: 30
  }
};

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required');
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ShadowWatch-Genesis-Repair-Seal/1.0'
  };
}

async function readManifest() {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${MANIFEST_PATH}?ref=${encodeURIComponent(DATA_BRANCH)}`;
  const r = await fetch(url, { headers: Object.assign({}, ghHeaders(), { Accept: 'application/vnd.github.raw' }) });
  if (!r.ok) throw new Error(`manifest HTTP ${r.status}`);
  return r.json();
}

function isMissing(manifest, expected) {
  return (manifest.coverage?.missingSegments || []).some(x =>
    x.address === expected.address && Number(x.from) === expected.from && Number(x.to) === expected.to
  );
}

function assertCounts(label, got, expected) {
  for (const field of ['txCount', 'effectCount', 'flowCount']) {
    if (Number(got[field]) !== Number(expected[field])) {
      throw new Error(`${label} ${field} mismatch: expected ${expected[field]}, got ${got[field]}`);
    }
  }
  if (Number(got.from) !== expected.from || Number(got.to) !== expected.to) {
    throw new Error(`${label} ledger range mismatch`);
  }
}

async function invoke(query) {
  let statusCode = 200;
  let payload;
  const req = { method: 'GET', query };
  const res = {
    setHeader() {},
    status(n) { statusCode = n; return this; },
    json(v) { payload = v; return this; },
    send(v) { payload = v; return this; },
    end() { return this; }
  };
  await handler(req, res);
  if (statusCode >= 400) {
    const message = payload && payload.error ? payload.error : JSON.stringify(payload);
    throw new Error(`repair handler HTTP ${statusCode}: ${message}`);
  }
  return payload;
}

async function sealGap(id) {
  const expected = EXPECTED[id];
  let manifest = await readManifest();
  if (!isMissing(manifest, expected)) {
    console.log(`[SKIP] ${id}: range is not listed as missing.`);
    return;
  }

  console.log(`[VERIFY] ${id}: independently recomputing pinned parent before any write...`);
  const meta = await invoke({ gap: id, meta: '1' });
  assertCounts(`${id} verification`, meta, expected);
  if (meta.serverPolicy !== 'PINNED_PER_SHARD_RESTART_ON_FAIL') {
    throw new Error(`${id} repair did not use pinned-shard server policy`);
  }
  console.log(`[PASS] ${id}: tx=${meta.txCount} effects=${meta.effectCount} flows=${meta.flowCount}`);

  console.log(`[COMMIT] ${id}: recomputing and atomically storing exact repair evidence...`);
  const committed = await invoke({ gap: id, commit: '1' });
  assertCounts(`${id} committed repair`, committed.spec || {}, expected);
  console.log(`[COMMITTED] ${id}: data commit ${committed.commitSha}; coverage ${committed.evidenceComplete}/${committed.requiredSegments}; sealed=${committed.sealed}`);
}

(async () => {
  for (const id of ['rnzi', 'r9h']) await sealGap(id);
  const manifest = await readManifest();
  const missing = manifest.coverage?.missingSegments || [];
  console.log(`[FINAL] evidenceComplete=${manifest.coverage?.evidenceComplete}/${manifest.coverage?.requiredSegments}; missing=${missing.length}; scanComplete=${Boolean(manifest.coverage?.scanComplete)}; sealed=${Boolean(manifest.coverage?.sealed)}`);
  if (missing.some(x => Object.values(EXPECTED).some(e => x.address === e.address && Number(x.from) === e.from && Number(x.to) === e.to))) {
    throw new Error('one or more targeted repair ranges remain missing');
  }
})().catch(err => {
  console.error('[FAIL]', err && err.stack || err);
  process.exitCode = 1;
});

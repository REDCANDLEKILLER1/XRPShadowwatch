'use strict';

const crypto = require('crypto');
const ReaderPool = require('../src/db/xrpl-reader');
const Roster = require('../src/db/roster');
const { buildDailyResearchTable } = require('../research/price-regime/daily-table');
const { cohortMapFromRoster, adaptWallets } = require('../research/price-regime/shadowwatch-adapter');
const { MAX_BATCH, resolveLedgerRange, scanBatch } = require('../research/price-regime/historical-walker');

function cohortSelection(roster, mode) {
  const m = String(mode || 'large').toLowerCase();
  if (!['large', 'exchange', 'whale', 'all'].includes(m)) throw new Error('INVALID_RESEARCH_COHORT');
  return (roster || []).filter(w => {
    if (m === 'all') return true;
    if (m === 'large') return w.cat === 'exchange' || w.cat === 'whale';
    return w.cat === m;
  });
}

function digest(payments) {
  const h = crypto.createHash('sha256');
  const hashes = (payments || []).map(p => p.hash).filter(Boolean).sort();
  for (const hash of hashes) h.update(hash + '\n', 'utf8');
  return { payment_count: hashes.length, payment_hash_digest_sha256: h.digest('hex') };
}

function normalizedPayments(payments) {
  return (payments || []).map(p => ({
    hash: p.hash,
    date: p.close_time,
    from: p.from_account || '',
    to: p.to_account || '',
    amount_xrp: Number(p.amount_drops) / 1000000,
    currency: 'XRP',
    tx_type: 'Payment',
    tx_result: 'tesSUCCESS',
    ledger_index: p.ledger_index
  }));
}

async function runBatch(query, deps) {
  const d = deps || {};
  const roster = (d.roster || Roster.roster)();
  const selected = cohortSelection(roster, query.cohort);
  const offset = Number(query.offset || 0);
  const limit = Number(query.limit || MAX_BATCH);
  if (!Number.isInteger(offset) || offset < 0) throw new Error('INVALID_BATCH_OFFSET');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH) throw new Error('INVALID_BATCH_LIMIT');
  if (offset >= selected.length) throw new Error('BATCH_OFFSET_OUT_OF_RANGE');

  const batch = selected.slice(offset, offset + limit);
  const reader = d.reader || ReaderPool.acquireReader();
  const release = d.release || (r => ReaderPool.releaseReader(r));
  try {
    const range = await resolveLedgerRange(reader, query.start, query.end);
    const scanned = await scanBatch(reader, batch.map(w => w.address), range, {
      dedupeSet: new Set(selected.map(w => w.address)),
      scan_id: 'RESEARCH_HISTORY_' + range.start_iso.slice(0, 10) + '_' + range.end_iso.slice(0, 10),
      roster_hash: Roster.identity(selected.map(w => w.address))
    });

    const cohortMap = cohortMapFromRoster(roster);
    const researchWallets = adaptWallets(roster, cohortMap);
    const daily = buildDailyResearchTable({
      wallets: researchWallets,
      events: normalizedPayments(scanned.payments)
    }).map(row => ({
      date: row.date,
      payment_volume_xrp: row.payment_volume_xrp,
      exchange_inflow_xrp: row.exchange_inflow_xrp,
      exchange_outflow_xrp: row.exchange_outflow_xrp,
      whale_accumulation_xrp: row.whale_accumulation_xrp,
      whale_distribution_xrp: row.whale_distribution_xrp,
      large_move_volume_xrp: row.large_move_volume_xrp,
      large_move_count: row.large_move_count,
      active_wallets: row.active_wallets
    }));

    return {
      mode: 'READ_ONLY_HISTORICAL_PRICE_REGIME_BACKFILL',
      writes_enabled: false,
      cohort: String(query.cohort || 'large').toLowerCase(),
      selected_wallets: selected.length,
      batch_offset: offset,
      batch_limit: limit,
      batch_wallets: batch.map(w => ({ address: w.address, label: w.label || null, cat: w.cat || null })),
      range,
      wallets_requested: scanned.wallets_requested,
      wallets_complete: scanned.wallets_complete,
      wallets_failed: scanned.wallets_failed,
      wallet_results: scanned.wallet_results,
      ...digest(scanned.payments),
      daily,
      next_offset: offset + batch.length < selected.length ? offset + batch.length : null
    };
  } finally {
    release(reader);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });

  // This endpoint is a branch research instrument. It must never become a
  // production ShadowWatch workload, even if the research PR is merged by mistake.
  if (process.env.VERCEL_ENV === 'production') {
    return res.status(403).json({ error: 'RESEARCH_BACKFILL_DISABLED_IN_PRODUCTION' });
  }

  try {
    const result = await runBatch(req.query || {});
    return res.status(result.wallets_failed ? 206 : 200).json(result);
  } catch (e) {
    return res.status(500).json({
      error: 'RESEARCH_BACKFILL_FAILED',
      detail: String(e && e.message || e)
    });
  }
};

module.exports._test = { cohortSelection, digest, normalizedPayments, runBatch };

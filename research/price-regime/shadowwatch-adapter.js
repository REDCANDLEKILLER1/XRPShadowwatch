'use strict';

const ALLOWED_COHORTS = new Set(['exchange', 'whale', 'other']);

function finite(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(label + ' must be finite');
  return n;
}

function adaptCanonicalEvents(events) {
  const out = [];
  for (const e of events || []) {
    if (!e || e.validated !== true) continue;
    if (e.currency !== 'XRP') continue;
    if (typeof e.hash !== 'string' || !e.hash) throw new Error('canonical event missing hash');
    if (typeof e.close_time !== 'string' || !e.close_time) throw new Error('canonical event missing close_time: ' + e.hash);
    const drops = finite(e.amount_drops, 'canonical XRP amount_drops');
    if (drops < 0) throw new Error('canonical XRP amount cannot be negative: ' + e.hash);
    out.push({
      hash: e.hash,
      date: e.close_time,
      from: e.from_account || '',
      to: e.to_account || '',
      amount_xrp: drops / 1000000,
      currency: 'XRP',
      tx_type: e.tx_type || '',
      tx_result: e.tx_result || '',
      ledger_index: e.ledger_index == null ? null : Number(e.ledger_index),
      source: 'GITHUB_EVIDENCE_STORE'
    });
  }
  return out;
}

function adaptWallets(roster, cohortByAddress) {
  const cohorts = cohortByAddress || {};
  return (roster || []).map(w => {
    if (!w || typeof w.address !== 'string' || !w.address) throw new Error('roster wallet missing address');
    const cohort = cohorts[w.address];
    if (!ALLOWED_COHORTS.has(cohort)) {
      throw new Error('research cohort must be explicit for ' + w.address);
    }
    return {
      address: w.address,
      cohort,
      label: w.label || null,
      production_category: w.cat || null
    };
  });
}

function adaptCoverage(date, metrics) {
  metrics = metrics || {};
  const target = Number(metrics.target_wallets);
  const proven = Number(metrics.indexed_wallets);
  if (!Number.isFinite(target) || !Number.isFinite(proven)) {
    throw new Error('metrics must include target_wallets and indexed_wallets');
  }
  return [{
    date,
    target_wallets: target,
    proven_wallets: proven,
    source: metrics.scan_id || 'GITHUB_EVIDENCE_STORE'
  }];
}

module.exports = {
  adaptCanonicalEvents,
  adaptWallets,
  adaptCoverage
};

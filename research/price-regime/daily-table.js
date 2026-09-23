'use strict';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_COHORTS = new Set(['exchange', 'whale', 'other']);

function finiteNumber(value, label) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    throw new Error(label + ' must be finite');
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(label + ' must be finite');
  return n;
}

function isoDay(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(label + ' is required');
  if (DATE_RE.test(value)) return value;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) throw new Error(label + ' must be an ISO date/time');
  return d.toISOString().slice(0, 10);
}

function walletIndex(wallets) {
  const out = new Map();
  for (const row of wallets || []) {
    if (!row || typeof row.address !== 'string' || !row.address) {
      throw new Error('wallet address is required');
    }
    const cohort = row.cohort || 'other';
    if (!ALLOWED_COHORTS.has(cohort)) {
      throw new Error('unsupported wallet cohort for ' + row.address + ': ' + cohort);
    }
    if (out.has(row.address)) throw new Error('duplicate wallet address: ' + row.address);
    out.set(row.address, Object.assign({}, row, { cohort }));
  }
  return out;
}

function priceIndex(prices) {
  const out = new Map();
  for (const row of prices || []) {
    if (!row) continue;
    const day = isoDay(row.date, 'price date');
    const price = finiteNumber(row.price_usd, 'price_usd');
    if (price <= 0) throw new Error('price_usd must be > 0 for ' + day);
    if (out.has(day)) throw new Error('duplicate price row for ' + day);
    out.set(day, price);
  }
  return out;
}

function coverageIndex(rows) {
  const out = new Map();
  for (const row of rows || []) {
    if (!row) continue;
    const day = isoDay(row.date, 'coverage date');
    const target = Math.max(0, Math.trunc(finiteNumber(row.target_wallets, 'target_wallets')));
    const proven = Math.max(0, Math.trunc(finiteNumber(row.proven_wallets, 'proven_wallets')));
    if (proven > target) throw new Error('proven_wallets exceeds target_wallets for ' + day);
    out.set(day, {
      target_wallets: target,
      proven_wallets: proven,
      complete: target > 0 && proven === target,
      source: row.source || null
    });
  }
  return out;
}

function balancesByDay(rows, wallets) {
  const byDay = new Map();
  for (const row of rows || []) {
    if (!row) continue;
    const day = isoDay(row.date, 'balance date');
    if (!wallets.has(row.address)) continue;
    const balance = finiteNumber(row.balance_xrp, 'balance_xrp');
    if (balance < 0) throw new Error('balance_xrp cannot be negative for ' + row.address);
    if (!byDay.has(day)) byDay.set(day, new Map());
    const m = byDay.get(day);
    if (m.has(row.address)) throw new Error('duplicate balance row for ' + day + ' ' + row.address);
    m.set(row.address, balance);
  }
  return byDay;
}

function emptyRow(day, price, coverage) {
  return {
    date: day,
    xrp_price_usd: price,
    cohort_balance_xrp: null,
    net_cohort_change_xrp: null,
    exchange_inflow_xrp: 0,
    exchange_outflow_xrp: 0,
    whale_accumulation_xrp: 0,
    whale_distribution_xrp: 0,
    payment_volume_xrp: 0,
    large_move_volume_xrp: 0,
    large_move_count: 0,
    active_wallets: 0,
    evidence_coverage: coverage || {
      target_wallets: 0,
      proven_wallets: 0,
      complete: false,
      source: null
    },
    balance_coverage: {
      target_wallets: 0,
      observed_wallets: 0,
      complete: false
    }
  };
}

function buildDailyResearchTable(input) {
  input = input || {};
  const wallets = walletIndex(input.wallets || []);
  if (!wallets.size) throw new Error('at least one research wallet is required');

  const prices = priceIndex(input.prices || []);
  const coverage = coverageIndex(input.coverage || []);
  const balances = balancesByDay(input.balance_snapshots || [], wallets);
  const threshold = input.large_move_threshold_xrp == null
    ? 1_000_000
    : finiteNumber(input.large_move_threshold_xrp, 'large_move_threshold_xrp');
  if (threshold <= 0) throw new Error('large_move_threshold_xrp must be > 0');

  const days = new Set([...prices.keys(), ...coverage.keys(), ...balances.keys()]);
  const eventRows = new Map();
  const seenHashes = new Set();

  for (const event of input.events || []) {
    if (!event) continue;
    // Research flow is movement, not merely a transaction carrying an amount.
    // Only successful native-XRP Payments belong in these flow columns.
    if (event.tx_type !== 'Payment') continue;
    if (event.currency !== 'XRP') continue;
    if (event.tx_result !== 'tesSUCCESS') continue;
    if (typeof event.hash !== 'string' || !event.hash) throw new Error('successful XRP event missing hash');
    if (seenHashes.has(event.hash)) continue;
    seenHashes.add(event.hash);

    const day = isoDay(event.date, 'event date');
    const amount = finiteNumber(event.amount_xrp, 'amount_xrp');
    if (amount < 0) throw new Error('amount_xrp cannot be negative for ' + event.hash);
    days.add(day);
    if (!eventRows.has(day)) eventRows.set(day, []);
    eventRows.get(day).push(Object.assign({}, event, { amount_xrp: amount }));
  }

  const orderedDays = [...days].sort();
  const rows = [];
  let previousCompleteBalance = null;

  for (const day of orderedDays) {
    const row = emptyRow(day, prices.has(day) ? prices.get(day) : null, coverage.get(day));
    const active = new Set();

    for (const event of eventRows.get(day) || []) {
      const fromMeta = wallets.get(event.from) || null;
      const toMeta = wallets.get(event.to) || null;
      if (fromMeta) active.add(event.from);
      if (toMeta) active.add(event.to);

      const amount = event.amount_xrp;
      row.payment_volume_xrp += amount;
      if (amount >= threshold) {
        row.large_move_volume_xrp += amount;
        row.large_move_count += 1;
      }

      const fromCohort = fromMeta ? fromMeta.cohort : null;
      const toCohort = toMeta ? toMeta.cohort : null;

      // Boundary-crossing flow only. Internal exchange->exchange or whale->whale
      // transfers are movement but not accumulation/distribution for that cohort.
      if (toCohort === 'exchange' && fromCohort !== 'exchange') row.exchange_inflow_xrp += amount;
      if (fromCohort === 'exchange' && toCohort !== 'exchange') row.exchange_outflow_xrp += amount;
      if (toCohort === 'whale' && fromCohort !== 'whale') row.whale_accumulation_xrp += amount;
      if (fromCohort === 'whale' && toCohort !== 'whale') row.whale_distribution_xrp += amount;
    }

    row.active_wallets = active.size;

    const dayBalances = balances.get(day) || new Map();
    row.balance_coverage = {
      target_wallets: wallets.size,
      observed_wallets: dayBalances.size,
      complete: dayBalances.size === wallets.size
    };

    if (row.balance_coverage.complete) {
      let total = 0;
      for (const address of wallets.keys()) total += dayBalances.get(address);
      row.cohort_balance_xrp = total;
      if (previousCompleteBalance !== null) {
        row.net_cohort_change_xrp = total - previousCompleteBalance;
      }
      previousCompleteBalance = total;
    } else {
      // A partial day cannot silently become the prior baseline for a later delta.
      previousCompleteBalance = null;
    }

    rows.push(row);
  }

  return rows;
}

module.exports = {
  buildDailyResearchTable
};

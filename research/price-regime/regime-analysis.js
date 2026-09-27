'use strict';

const DEFAULT_BAND = Object.freeze({ low: 1.35, high: 1.45 });

function finite(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(label + ' must be finite');
  return n;
}

function priceState(price, band) {
  const p = finite(price, 'xrp_price_usd');
  if (p < band.low) return 'below';
  if (p > band.high) return 'above';
  return 'inside';
}

function blank() {
  return {
    days: 0,
    avg_price_usd: null,
    payment_volume_xrp: 0,
    exchange_inflow_xrp: 0,
    exchange_outflow_xrp: 0,
    exchange_net_xrp: 0,
    whale_accumulation_xrp: 0,
    whale_distribution_xrp: 0,
    whale_net_xrp: 0,
    large_move_volume_xrp: 0,
    large_move_count: 0,
    avg_active_wallets: null
  };
}

function analyzeRegime(dataset, options) {
  const input = dataset || {};
  const opts = options || {};
  const band = {
    low: opts.low == null ? DEFAULT_BAND.low : finite(opts.low, 'band low'),
    high: opts.high == null ? DEFAULT_BAND.high : finite(opts.high, 'band high')
  };
  if (!(band.low < band.high)) throw new Error('band low must be less than band high');

  const groups = { below: blank(), inside: blank(), above: blank() };
  const priceSums = { below: 0, inside: 0, above: 0 };
  const activeSums = { below: 0, inside: 0, above: 0 };
  const excluded = [];
  const included = [];

  for (const row of input.rows || []) {
    if (!row || row.missing === true || !Number.isFinite(Number(row.xrp_price_usd))) {
      excluded.push({ date: row && row.date || null, reason: 'MISSING_EVIDENCE_OR_PRICE' });
      continue;
    }
    if (row.coverage_status === 'PARTIAL_UTC_DAY_AT_SNAPSHOT') {
      excluded.push({ date: row.date, reason: 'PARTIAL_UTC_DAY_AT_SNAPSHOT' });
      continue;
    }

    const state = priceState(row.xrp_price_usd, band);
    const g = groups[state];
    const p = Number(row.xrp_price_usd);
    g.days += 1;
    priceSums[state] += p;
    g.payment_volume_xrp += Number(row.payment_volume_xrp || 0);
    g.exchange_inflow_xrp += Number(row.exchange_inflow_xrp || 0);
    g.exchange_outflow_xrp += Number(row.exchange_outflow_xrp || 0);
    g.whale_accumulation_xrp += Number(row.whale_accumulation_xrp || 0);
    g.whale_distribution_xrp += Number(row.whale_distribution_xrp || 0);
    g.large_move_volume_xrp += Number(row.large_move_volume_xrp || 0);
    g.large_move_count += Number(row.large_move_count || 0);
    activeSums[state] += Number(row.active_wallets || 0);
    included.push({ date: row.date, price_usd: p, state });
  }

  for (const state of Object.keys(groups)) {
    const g = groups[state];
    g.exchange_net_xrp = g.exchange_inflow_xrp - g.exchange_outflow_xrp;
    g.whale_net_xrp = g.whale_accumulation_xrp - g.whale_distribution_xrp;
    if (g.days) {
      g.avg_price_usd = priceSums[state] / g.days;
      g.avg_active_wallets = activeSums[state] / g.days;
    }
  }

  const coverageWarning = String(input.historical_coverage_warning || '');
  return {
    status: coverageWarning ? 'PROVISIONAL' : 'READY',
    hypothesis_band_usd: band,
    included_days: included.length,
    excluded_days: excluded,
    groups,
    included,
    coverage_warning: coverageWarning || null,
    interpretation_limits: [
      'Price bands are descriptive buckets, not evidence of intent or coordination.',
      'Exchange and whale labels use committed ShadowWatch operator categories.',
      'Net flow is cohort-boundary movement, not a direct measure of buying or selling.',
      'This summary is not a prediction and does not establish causation.'
    ]
  };
}

module.exports = { DEFAULT_BAND, priceState, analyzeRegime };

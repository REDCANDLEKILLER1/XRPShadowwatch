#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { buildDailyResearchTable } = require('../research/price-regime/daily-table');
const { toCsv } = require('../research/price-regime/build-daily');
const { adaptCanonicalEvents, cohortMapFromRoster, adaptWallets, adaptCoverage } = require('../research/price-regime/shadowwatch-adapter');
const { summarize, productionStyleTotal, researchFlow, dayOk, refOk, datasetDays, rangeOf, solveWindow } = require('../api/research-price-regime')._test;
const frozenDataset = require('../research/price-regime/data/2026-09-09_2026-09-22.json');
const { analyzeRegime } = require('../research/price-regime/regime-analysis');

const wallets = [
  { address: 'rEX', cohort: 'exchange' },
  { address: 'rWH', cohort: 'whale' },
  { address: 'rOT', cohort: 'other' }
];

const table = buildDailyResearchTable({
  wallets,
  prices: [
    { date: '2026-09-20', price_usd: 1.40 },
    { date: '2026-09-21', price_usd: 1.55 }
  ],
  coverage: [
    { date: '2026-09-20', target_wallets: 3, proven_wallets: 3, source: 'fixture' },
    { date: '2026-09-21', target_wallets: 3, proven_wallets: 3, source: 'fixture' }
  ],
  balance_snapshots: [
    { date: '2026-09-20', address: 'rEX', balance_xrp: 10 },
    { date: '2026-09-20', address: 'rWH', balance_xrp: 20 },
    { date: '2026-09-20', address: 'rOT', balance_xrp: 30 },
    { date: '2026-09-21', address: 'rEX', balance_xrp: 14 },
    { date: '2026-09-21', address: 'rWH', balance_xrp: 25 },
    { date: '2026-09-21', address: 'rOT', balance_xrp: 29 }
  ],
  events: [
    { hash: 'A', date: '2026-09-20T10:00:00Z', from: 'rOUT', to: 'rEX', amount_xrp: 2000000, currency: 'XRP', tx_type: 'Payment', tx_result: 'tesSUCCESS' },
    { hash: 'A', date: '2026-09-20T10:00:00Z', from: 'rOUT', to: 'rEX', amount_xrp: 2000000, currency: 'XRP', tx_type: 'Payment', tx_result: 'tesSUCCESS' },
    { hash: 'FAIL', date: '2026-09-20T11:00:00Z', from: 'rOUT', to: 'rEX', amount_xrp: 1000000000, currency: 'XRP', tx_type: 'Payment', tx_result: 'tecPATH_DRY' },
    { hash: 'TOK', date: '2026-09-20T12:00:00Z', from: 'rOUT', to: 'rEX', amount_xrp: 50000000, currency: 'USD', tx_type: 'Payment', tx_result: 'tesSUCCESS' },
    { hash: 'ESCROW', date: '2026-09-20T13:00:00Z', from: 'rOUT', to: 'rEX', amount_xrp: 900000000, currency: 'XRP', tx_type: 'EscrowCreate', tx_result: 'tesSUCCESS' },
    { hash: 'B', date: '2026-09-21T09:00:00Z', from: 'rEX', to: 'rWH', amount_xrp: 1500000, currency: 'XRP', tx_type: 'Payment', tx_result: 'tesSUCCESS' },
    { hash: 'C', date: '2026-09-21T10:00:00Z', from: 'rEX', to: 'rEX', amount_xrp: 3000000, currency: 'XRP', tx_type: 'Payment', tx_result: 'tesSUCCESS' },
    { hash: 'D', date: '2026-09-21T11:00:00Z', from: 'rWH', to: 'rOT', amount_xrp: 500000, currency: 'XRP', tx_type: 'Payment', tx_result: 'tesSUCCESS' }
  ]
});

assert.strictEqual(table.length, 2);
assert.strictEqual(table[0].date, '2026-09-20');
assert.strictEqual(table[0].xrp_price_usd, 1.40);
assert.strictEqual(table[0].exchange_inflow_xrp, 2000000);
assert.strictEqual(table[0].payment_volume_xrp, 2000000);
assert.strictEqual(table[0].large_move_volume_xrp, 2000000);
assert.strictEqual(table[0].large_move_count, 1);
assert.strictEqual(table[0].active_wallets, 1);
assert.strictEqual(table[0].cohort_balance_xrp, 60);
assert.strictEqual(table[0].net_cohort_change_xrp, null);
assert.strictEqual(table[0].evidence_coverage.complete, true);

assert.strictEqual(table[1].exchange_outflow_xrp, 1500000);
assert.strictEqual(table[1].whale_accumulation_xrp, 1500000);
assert.strictEqual(table[1].whale_distribution_xrp, 500000);
assert.strictEqual(table[1].payment_volume_xrp, 5000000);
assert.strictEqual(table[1].large_move_volume_xrp, 4500000);
assert.strictEqual(table[1].large_move_count, 2);
assert.strictEqual(table[1].active_wallets, 3);
assert.strictEqual(table[1].cohort_balance_xrp, 68);
assert.strictEqual(table[1].net_cohort_change_xrp, 8);

const partial = buildDailyResearchTable({
  wallets,
  prices: [
    { date: '2026-09-19', price_usd: 1.39 },
    { date: '2026-09-20', price_usd: 1.40 },
    { date: '2026-09-21', price_usd: 1.41 }
  ],
  balance_snapshots: [
    { date: '2026-09-19', address: 'rEX', balance_xrp: 1 },
    { date: '2026-09-19', address: 'rWH', balance_xrp: 2 },
    { date: '2026-09-19', address: 'rOT', balance_xrp: 3 },
    { date: '2026-09-20', address: 'rEX', balance_xrp: 2 },
    { date: '2026-09-21', address: 'rEX', balance_xrp: 3 },
    { date: '2026-09-21', address: 'rWH', balance_xrp: 4 },
    { date: '2026-09-21', address: 'rOT', balance_xrp: 5 }
  ]
});

assert.strictEqual(partial[0].cohort_balance_xrp, 6);
assert.strictEqual(partial[1].cohort_balance_xrp, null);
assert.strictEqual(partial[2].cohort_balance_xrp, 12);
assert.strictEqual(partial[2].net_cohort_change_xrp, null);

assert.throws(() => buildDailyResearchTable({
  wallets,
  events: [
    { hash: 'X', date: '2026-09-21', from: 'rOT', to: 'rEX', currency: 'XRP', tx_type: 'Payment', tx_result: 'tesSUCCESS' }
  ]
}), /amount_xrp must be finite/);


const adaptedEvents = adaptCanonicalEvents([
  { hash: 'CANON1', close_time: '2026-09-21T12:00:00Z', validated: true, tx_type: 'Payment',
    currency: 'XRP', amount_drops: '1500000', from_account: 'rOUT', to_account: 'rEX',
    tx_result: 'tesSUCCESS', ledger_index: 123 },
  { hash: 'FAILED', close_time: '2026-09-21T12:01:00Z', validated: true, tx_type: 'Payment',
    currency: 'XRP', amount_drops: '1000000000000000', from_account: 'rOUT', to_account: 'rEX',
    tx_result: 'tecPATH_DRY', ledger_index: 124 },
  { hash: 'ESCROW_CANON', close_time: '2026-09-21T12:02:00Z', validated: true, tx_type: 'EscrowCreate',
    currency: 'XRP', amount_drops: '900000000000000', from_account: 'rOUT', to_account: 'rEX',
    tx_result: 'tesSUCCESS', ledger_index: 125 },
  { hash: 'UNVALIDATED', close_time: '2026-09-21T12:03:00Z', validated: false, tx_type: 'Payment',
    currency: 'XRP', amount_drops: '999999999999', from_account: 'rOUT', to_account: 'rEX',
    tx_result: 'tesSUCCESS', ledger_index: 126 },
  { hash: 'TOKEN', close_time: '2026-09-21T12:04:00Z', validated: true, tx_type: 'Payment',
    currency: 'USD', amount_value: '20', from_account: 'rOUT', to_account: 'rEX',
    tx_result: 'tesSUCCESS', ledger_index: 127 }
]);
assert.strictEqual(adaptedEvents.length, 2);
assert.strictEqual(adaptedEvents[0].amount_xrp, 1.5);
assert.strictEqual(adaptedEvents[0].from, 'rOUT');
assert.strictEqual(adaptedEvents[0].to, 'rEX');
assert.strictEqual(adaptedEvents[0].source, 'GITHUB_EVIDENCE_STORE');
assert.strictEqual(adaptedEvents[1].tx_result, 'tecPATH_DRY');

const derivedCohorts = cohortMapFromRoster([
  { address: 'rEX', cat: 'exchange' },
  { address: 'rWH', cat: 'whale' },
  { address: 'rES', cat: 'escrow' }
]);
assert.deepStrictEqual(derivedCohorts, { rEX: 'exchange', rWH: 'whale', rES: 'other' });

const adaptedWallets = adaptWallets(
  [{ address: 'rEX', label: 'Exchange A', cat: 'exchange' }, { address: 'rWH', label: 'Whale A' }],
  { rEX: 'exchange', rWH: 'whale' }
);
assert.deepStrictEqual(adaptedWallets.map(x => x.cohort), ['exchange', 'whale']);
assert.throws(() => adaptWallets([{ address: 'rUNKNOWN' }], {}), /research cohort must be explicit/);

const adaptedCoverage = adaptCoverage('2026-09-21', {
  evidence_scan_id: 'gh-123', target_wallets: 418, complete_wallets: 418
});
assert.strictEqual(adaptedCoverage[0].source, 'gh-123');
assert.strictEqual(adaptedCoverage[0].proven_wallets, 418);

assert.strictEqual(dayOk('2026-09-22'), true);
assert.strictEqual(dayOk('22-09-2026'), false);
assert.strictEqual(refOk('50413d4b0f592bb5b108e34ac49e0f6521cac816'), true);
assert.strictEqual(refOk('main'), false);
const dsDays = datasetDays('2026-09-09', '2026-09-22');
assert.strictEqual(dsDays.length, 14);
assert.strictEqual(dsDays[0], '2026-09-09');
assert.strictEqual(dsDays[13], '2026-09-22');
assert.throws(() => datasetDays('2026-08-01', '2026-09-22'), /EXCEEDS_31_DAYS/);
assert.strictEqual(frozenDataset.dataset_id, 'SW-PRICE-REGIME-20260909-20260922');
assert.strictEqual(frozenDataset.evidence_ref, 'f1d40162179c599929b1d8d6d465ecc8de1ec981');
assert.strictEqual(frozenDataset.roster_wallets, 418);
assert.deepStrictEqual(frozenDataset.cohort_counts, { exchange: 58, whale: 100, other: 260 });
assert.strictEqual(frozenDataset.price_status, 'JOINED_COINBASE_XRP_USD_06AM_AMERICA_CHICAGO');
assert.strictEqual(frozenDataset.price_source.provider, 'Coinbase Exchange');
assert.strictEqual(frozenDataset.price_source.product_id, 'XRP-USD');
assert.strictEqual(frozenDataset.price_source.granularity_seconds, 3600);
assert.strictEqual(frozenDataset.price_source.timestamp_convention, '06:00 America/Chicago');
assert.strictEqual(frozenDataset.price_source.september_utc_equivalent, '11:00 UTC');
assert.strictEqual(frozenDataset.price_source.selected_field, 'open');
assert.strictEqual(frozenDataset.rows.length, 14);
assert.strictEqual(new Set(frozenDataset.rows.map(r => r.date)).size, 14);
assert.strictEqual(frozenDataset.rows.filter(r => r.missing).length, 0);
assert(frozenDataset.rows.every(r => Number.isFinite(r.xrp_price_usd) && r.xrp_price_usd > 0));
assert(frozenDataset.rows.every(r => r.price_timestamp_utc.endsWith('T11:00:00Z')));
assert(frozenDataset.rows.every(r => r.price_field === 'hourly_open'));
assert(frozenDataset.rows.every(r => /^[a-f0-9]{64}$/.test(r.hash_digest_sha256)));
assert.strictEqual(frozenDataset.rows[0].date, '2026-09-09');
assert.strictEqual(frozenDataset.rows[0].coverage_status, 'BANKED_DAY_PRESENT_NOT_FULL_COHORT_PROOF');
assert.strictEqual(frozenDataset.rows[13].date, '2026-09-22');
assert.strictEqual(frozenDataset.rows[13].coverage_status, 'PARTIAL_UTC_DAY_AT_SNAPSHOT');
assert.strictEqual(frozenDataset.rows[13].last_close_time, '2026-09-22T13:04:31.000Z');
assert.strictEqual(frozenDataset.rows[8].date, '2026-09-17');
assert.strictEqual(frozenDataset.rows[8].xrp_price_usd, 1.2948);
assert.strictEqual(frozenDataset.rows[12].date, '2026-09-21');
assert.strictEqual(frozenDataset.rows[12].xrp_price_usd, 1.4901);
assert.strictEqual(frozenDataset.rows[13].xrp_price_usd, 1.5315);
assert.strictEqual(frozenDataset.rows[8].large_move_count, 75);
assert(Math.abs(frozenDataset.rows[8].payment_volume_xrp - 1051687970.4603939) < 0.000001);


const bounded = rangeOf({ from: '2026-09-21T11:25:41Z', to: '2026-09-22T12:25:41Z' });
assert.strictEqual(bounded.days.length, 2);
assert.strictEqual(bounded.to - bounded.from, 25 * 60 * 60 * 1000);
assert.throws(() => rangeOf({ from: '2026-09-01T00:00:00Z', to: '2026-09-22T00:00:00Z' }), /EXCEEDS_7_DAYS/);

const solved = solveWindow([
  { hash: 'S1', close_time: '2026-09-22T12:00:00Z', validated: true, tx_type: 'Payment', currency: 'XRP', amount_drops: '3000000', tx_result: 'tesSUCCESS' },
  { hash: 'S2', close_time: '2026-09-22T11:00:00Z', validated: true, tx_type: 'Payment', currency: 'XRP', amount_drops: '2000000', tx_result: 'tesSUCCESS' },
  { hash: 'S3', close_time: '2026-09-22T10:00:00Z', validated: true, tx_type: 'Payment', currency: 'XRP', amount_drops: '1000000', tx_result: 'tesSUCCESS' }
], Date.parse('2026-09-22T12:30:00Z'), 2);
assert.strictEqual(solved.exact_timestamp_boundary, true);
assert.strictEqual(solved.solved_start_at_or_before, '2026-09-22T11:00:00.000Z');
assert.strictEqual(solved.prior_excluded_close_time, '2026-09-22T10:00:00.000Z');
assert.strictEqual(solved.selected_summary.distinct_events, 2);

const reconciled = summarize([
  { hash: 'R1', close_time: '2026-09-21T10:00:00Z', validated: true, tx_type: 'Payment',
    currency: 'XRP', amount_drops: '2000000000000', tx_result: 'tesSUCCESS' },
  { hash: 'R1', close_time: '2026-09-21T10:00:00Z', validated: true, tx_type: 'Payment',
    currency: 'XRP', amount_drops: '2000000000000', tx_result: 'tesSUCCESS' },
  { hash: 'RF', close_time: '2026-09-21T11:00:00Z', validated: true, tx_type: 'Payment',
    currency: 'XRP', amount_drops: '1000000000000000', tx_result: 'tecPATH_DRY' },
  { hash: 'RE', close_time: '2026-09-21T12:00:00Z', validated: true, tx_type: 'EscrowCreate',
    currency: 'XRP', amount_drops: '900000000000000', tx_result: 'tesSUCCESS' }
]);
assert.strictEqual(reconciled.event_rows, 4);
assert.strictEqual(reconciled.distinct_events, 3);
assert.strictEqual(reconciled.successful_xrp_moved, 2000000);
assert.strictEqual(reconciled.successful_native_amount_any_type, 902000000);
assert.strictEqual(reconciled.successful_native_amount_by_tx_type.Payment.xrp, 2000000);
assert.strictEqual(reconciled.successful_native_amount_by_tx_type.EscrowCreate.xrp, 900000000);
assert.strictEqual(reconciled.large_move_volume_xrp, 2000000);
assert.strictEqual(reconciled.large_move_count, 1);
const legacyWide = productionStyleTotal([
  { hash: 'P1', tx_type: 'Payment', currency: 'XRP', amount_drops: '2000000', tx_result: 'tesSUCCESS' },
  { hash: 'P2', tx_type: 'Payment', currency: 'XRP', amount_drops: '3000000', tx_result: '' },
  { hash: 'PF', tx_type: 'Payment', currency: 'XRP', amount_drops: '1000000000000000', tx_result: 'tecPATH_DRY' },
  { hash: 'EC', tx_type: 'EscrowCreate', currency: 'XRP', amount_drops: null, escrow_amount_drops: '4000000', tx_result: 'tesSUCCESS' }
]);
assert.strictEqual(legacyWide.total_xrp, 9);
assert.strictEqual(legacyWide.by_result['(blank)'].xrp, 3);
assert.strictEqual(legacyWide.by_tx_type.EscrowCreate.xrp, 4);

const liveCohortFlow = researchFlow([
  { hash: 'CF1', close_time: '2026-09-22T01:00:00Z', validated: true, tx_type: 'Payment',
    currency: 'XRP', amount_drops: '2000000', from_account: 'rExternal',
    to_account: 'rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh', tx_result: 'tesSUCCESS' },
  { hash: 'CF2', close_time: '2026-09-22T02:00:00Z', validated: true, tx_type: 'Payment',
    currency: 'XRP', amount_drops: '3000000', from_account: 'rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh',
    to_account: 'rPyCQm8E5j78PDbrfKF24fRC7qUAk1kDMZ', tx_result: 'tesSUCCESS' }
]);
assert(liveCohortFlow.roster_wallets >= 418);
assert(liveCohortFlow.cohort_counts.exchange > 0);
assert(liveCohortFlow.cohort_counts.whale > 0);
assert.strictEqual(liveCohortFlow.totals.payment_volume_xrp, 5);
assert.strictEqual(liveCohortFlow.totals.exchange_inflow_xrp, 2);
assert.strictEqual(liveCohortFlow.totals.exchange_outflow_xrp, 3);
assert.strictEqual(liveCohortFlow.totals.whale_accumulation_xrp, 3);

const provisionalBand = analyzeRegime(frozenDataset);
assert.strictEqual(provisionalBand.status, 'PROVISIONAL');
assert.deepStrictEqual(provisionalBand.hypothesis_band_usd, { low: 1.35, high: 1.45 });
assert.strictEqual(provisionalBand.included_days, 13);
assert.deepStrictEqual(provisionalBand.excluded_days, [
  { date: '2026-09-22', reason: 'PARTIAL_UTC_DAY_AT_SNAPSHOT' }
]);
assert.strictEqual(provisionalBand.groups.below.days, 5);
assert.strictEqual(provisionalBand.groups.inside.days, 7);
assert.strictEqual(provisionalBand.groups.above.days, 1);
assert(Math.abs(provisionalBand.groups.below.whale_net_xrp - (-615624692.6049006)) < 0.0001);
assert(Math.abs(provisionalBand.groups.inside.exchange_net_xrp - (-793146.0987877548)) < 0.0001);
assert(Math.abs(provisionalBand.groups.above.whale_net_xrp - (-16054451.115289167)) < 0.0001);


const csv = toCsv(table);
assert(csv.startsWith('date,xrp_price_usd,cohort_balance_xrp'));
assert(csv.includes('2026-09-20,1.4,60'));
assert(csv.includes('"{""target_wallets"":3,""proven_wallets"":3,""complete"":true,""source"":""fixture""}"'));

console.log('ALL PRICE-REGIME RESEARCH CHECKS PASS');

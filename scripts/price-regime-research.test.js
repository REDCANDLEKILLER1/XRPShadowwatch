#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { buildDailyResearchTable } = require('../research/price-regime/daily-table');
const { toCsv } = require('../research/price-regime/build-daily');
const { adaptCanonicalEvents, adaptWallets, adaptCoverage } = require('../research/price-regime/shadowwatch-adapter');
const { summarize, dayOk, refOk } = require('../api/research-price-regime')._test;

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
assert.strictEqual(table[0].large_move_volume_xrp, 2000000);
assert.strictEqual(table[0].large_move_count, 1);
assert.strictEqual(table[0].active_wallets, 1);
assert.strictEqual(table[0].cohort_balance_xrp, 60);
assert.strictEqual(table[0].net_cohort_change_xrp, null);
assert.strictEqual(table[0].evidence_coverage.complete, true);

assert.strictEqual(table[1].exchange_outflow_xrp, 1500000);
assert.strictEqual(table[1].whale_accumulation_xrp, 1500000);
assert.strictEqual(table[1].whale_distribution_xrp, 500000);
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
assert.strictEqual(reconciled.large_move_volume_xrp, 2000000);
assert.strictEqual(reconciled.large_move_count, 1);

const csv = toCsv(table);
assert(csv.startsWith('date,xrp_price_usd,cohort_balance_xrp'));
assert(csv.includes('2026-09-20,1.4,60'));
assert(csv.includes('"{""target_wallets"":3,""proven_wallets"":3,""complete"":true,""source"":""fixture""}"'));

console.log('ALL PRICE-REGIME RESEARCH CHECKS PASS');

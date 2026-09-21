#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { buildDailyResearchTable } = require('../research/price-regime/daily-table');
const { toCsv } = require('../research/price-regime/build-daily');
const { adaptCanonicalEvents, adaptWallets, adaptCoverage } = require('../research/price-regime/shadowwatch-adapter');

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
    { hash: 'A', date: '2026-09-20T10:00:00Z', from: 'rOUT', to: 'rEX', amount_xrp: 2000000, currency: 'XRP', tx_result: 'tesSUCCESS' },
    { hash: 'A', date: '2026-09-20T10:00:00Z', from: 'rOUT', to: 'rEX', amount_xrp: 2000000, currency: 'XRP', tx_result: 'tesSUCCESS' },
    { hash: 'FAIL', date: '2026-09-20T11:00:00Z', from: 'rOUT', to: 'rEX', amount_xrp: 1000000000, currency: 'XRP', tx_result: 'tecPATH_DRY' },
    { hash: 'TOK', date: '2026-09-20T12:00:00Z', from: 'rOUT', to: 'rEX', amount_xrp: 50000000, currency: 'USD', tx_result: 'tesSUCCESS' },
    { hash: 'B', date: '2026-09-21T09:00:00Z', from: 'rEX', to: 'rWH', amount_xrp: 1500000, currency: 'XRP', tx_result: 'tesSUCCESS' },
    { hash: 'C', date: '2026-09-21T10:00:00Z', from: 'rEX', to: 'rEX', amount_xrp: 3000000, currency: 'XRP', tx_result: 'tesSUCCESS' },
    { hash: 'D', date: '2026-09-21T11:00:00Z', from: 'rWH', to: 'rOT', amount_xrp: 500000, currency: 'XRP', tx_result: 'tesSUCCESS' }
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
    { hash: 'X', date: '2026-09-21', from: 'rOT', to: 'rEX', currency: 'XRP', tx_result: 'tesSUCCESS' }
  ]
}), /amount_xrp must be finite/);


const adaptedEvents = adaptCanonicalEvents([
  { hash: 'CANON1', date: '2026-09-21T12:00:00Z', validated: true, currency: 'XRP',
    amount: '1500000', from: 'rOUT', to: 'rEX', tx_result: 'tesSUCCESS', ledger_index: 123 },
  { hash: 'UNVALIDATED', date: '2026-09-21T12:00:00Z', validated: false, currency: 'XRP',
    amount: '999999999999', from: 'rOUT', to: 'rEX', tx_result: 'tesSUCCESS' },
  { hash: 'TOKEN', date: '2026-09-21T12:00:00Z', validated: true, currency: 'USD',
    amount: '20', from: 'rOUT', to: 'rEX', tx_result: 'tesSUCCESS' }
]);
assert.strictEqual(adaptedEvents.length, 1);
assert.strictEqual(adaptedEvents[0].amount_xrp, 1.5);
assert.strictEqual(adaptedEvents[0].source, 'GITHUB_EVIDENCE_STORE');

const adaptedWallets = adaptWallets(
  [{ address: 'rEX', label: 'Exchange A', cat: 'exchange' }, { address: 'rWH', label: 'Whale A' }],
  { rEX: 'exchange', rWH: 'whale' }
);
assert.deepStrictEqual(adaptedWallets.map(x => x.cohort), ['exchange', 'whale']);
assert.throws(() => adaptWallets([{ address: 'rUNKNOWN' }], {}), /research cohort must be explicit/);

const adaptedCoverage = adaptCoverage('2026-09-21', {
  scan_id: 'gh-123', target_wallets: 418, indexed_wallets: 418
});
assert.strictEqual(adaptedCoverage[0].source, 'gh-123');
assert.strictEqual(adaptedCoverage[0].proven_wallets, 418);

const csv = toCsv(table);
assert(csv.startsWith('date,xrp_price_usd,cohort_balance_xrp'));
assert(csv.includes('2026-09-20,1.4,60'));
assert(csv.includes('"{""target_wallets"":3,""proven_wallets"":3,""complete"":true,""source"":""fixture""}"'));

console.log('ALL PRICE-REGIME RESEARCH CHECKS PASS');

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const handler = require('../api/research-history');
const { cohortSelection, normalizedPayments, digest, runBatch } = handler._test;

async function main() {
  const roster = [
    { address: 'rEX', label: 'Exchange', cat: 'exchange' },
    { address: 'rWH', label: 'Whale', cat: 'whale' },
    { address: 'rOT', label: 'Other', cat: 'escrow' }
  ];
  assert.deepStrictEqual(cohortSelection(roster, 'large').map(x => x.address), ['rEX', 'rWH']);
  assert.deepStrictEqual(cohortSelection(roster, 'exchange').map(x => x.address), ['rEX']);
  assert.deepStrictEqual(cohortSelection(roster, 'whale').map(x => x.address), ['rWH']);
  assert.strictEqual(cohortSelection(roster, 'all').length, 3);
  assert.throws(() => cohortSelection(roster, 'guess'), /INVALID_RESEARCH_COHORT/);

  const normalized = normalizedPayments([
    { hash: 'A', close_time: '2026-08-20T12:00:00Z', from_account: 'rEX', to_account: 'rWH',
      amount_drops: '2500000', ledger_index: 150 }
  ]);
  assert.strictEqual(normalized[0].amount_xrp, 2.5);
  assert.strictEqual(normalized[0].tx_type, 'Payment');
  assert.strictEqual(digest([{ hash: 'B' }, { hash: 'A' }]).payment_count, 2);

  const rippleSeconds = iso => Math.floor(Date.parse(iso) / 1000) - 946684800;
  const fakeReader = {
    epoch: 1,
    stats: { requests: 0 },
    ledger: async () => ({ ledger: 999, close_ms: Date.parse('2026-09-22T00:00:00Z') }),
    floor: async ms => ms === Date.parse('2026-08-10T00:00:00Z')
      ? { ledger: 100, close_ms: ms - 4000 }
      : { ledger: 200, close_ms: ms - 4000 },
    lane: async () => ({ epoch: 1, endpoint: 'fake://xrpl' }),
    releaseLane: () => {},
    request: async command => ({
      validated: true,
      account: command.account,
      ledger_index_min: 101,
      ledger_index_max: 200,
      transactions: [{
        validated: true,
        ledger_index: 150,
        tx_json: {
          hash: 'DIRECT',
          TransactionType: 'Payment',
          Account: command.account,
          Destination: 'rOUT',
          Amount: '5000000',
          date: rippleSeconds('2026-08-20T12:00:00Z')
        },
        meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '5000000', TransactionIndex: 1 }
      }]
    })
  };

  const batch = await runBatch({
    cohort: 'exchange',
    start: '2026-08-10T00:00:00Z',
    end: '2026-08-28T00:00:00Z',
    offset: '0',
    limit: '1'
  }, {
    reader: fakeReader,
    release: () => {},
    roster: () => roster
  });
  assert.strictEqual(batch.mode, 'READ_ONLY_HISTORICAL_PRICE_REGIME_BACKFILL');
  assert.strictEqual(batch.writes_enabled, false);
  assert.strictEqual(batch.selected_wallets, 1);
  assert.strictEqual(batch.wallets_complete, 1);
  assert.strictEqual(batch.payment_count, 1);
  assert.strictEqual(batch.daily.length, 1);
  assert.strictEqual(batch.daily[0].exchange_outflow_xrp, 5);

  const previous = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = 'production';
  const response = {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
  await handler({ method: 'GET', query: {} }, response);
  if (previous === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = previous;
  assert.strictEqual(response.statusCode, 403);
  assert.strictEqual(response.body.error, 'RESEARCH_BACKFILL_DISABLED_IN_PRODUCTION');

  console.log('ALL RESEARCH HISTORY API CHECKS PASS');
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

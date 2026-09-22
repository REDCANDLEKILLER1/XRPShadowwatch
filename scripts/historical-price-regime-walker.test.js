#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { timeRange, resolveLedgerRange, proveLedgerRange, paymentLeader, scanBatch } = require('../research/price-regime/historical-walker');

async function main() {
  assert.deepStrictEqual(timeRange('2026-08-10T00:00:00Z', '2026-08-28T00:00:00Z'), {
    start_ms: Date.parse('2026-08-10T00:00:00Z'),
    end_ms: Date.parse('2026-08-28T00:00:00Z')
  });
  assert.throws(() => timeRange('2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z'), /EXCEEDS_31_DAYS/);

  const rippleSeconds = iso => Math.floor(Date.parse(iso) / 1000) - 946684800;
  const fake = {
    epoch: 1,
    stats: { requests: 0 },
    ledger: async () => ({ ledger: 999, close_ms: Date.parse('2026-09-22T00:00:00Z') }),
    floor: async ms => ms === Date.parse('2026-08-10T00:00:00Z')
      ? { ledger: 100, close_ms: ms - 4000 }
      : { ledger: 200, close_ms: ms - 4000 },
    lane: async () => ({ epoch: 1, endpoint: 'fake://xrpl' }),
    releaseLane: () => {},
    request: async command => {
      assert.strictEqual(command.command, 'account_tx');
      assert.strictEqual(command.ledger_index_min, 101);
      assert.strictEqual(command.ledger_index_max, 200);
      return {
        validated: true,
        account: command.account,
        ledger_index_min: 101,
        ledger_index_max: 200,
        transactions: [
          {
            validated: true, ledger_index: 150,
            tx_json: { hash: 'HIST_OK', TransactionType: 'Payment', Account: command.account,
              Destination: 'rDEST', Amount: '2500000', date: rippleSeconds('2026-08-20T12:00:00Z') },
            meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '2500000', TransactionIndex: 1 }
          },
          {
            validated: true, ledger_index: 151,
            tx_json: { hash: 'HIST_FAIL', TransactionType: 'Payment', Account: command.account,
              Destination: 'rDEST', Amount: '9000000000000', date: rippleSeconds('2026-08-20T12:01:00Z') },
            meta: { TransactionResult: 'tecPATH_DRY', TransactionIndex: 2 }
          },
          {
            validated: true, ledger_index: 152,
            tx_json: { hash: 'HIST_OFFER', TransactionType: 'OfferCreate', Account: command.account,
              TakerGets: '1000000', date: rippleSeconds('2026-08-20T12:02:00Z') },
            meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 3 }
          }
        ]
      };
    }
  };

  const range = await resolveLedgerRange(fake, '2026-08-10T00:00:00Z', '2026-08-28T00:00:00Z');
  assert.strictEqual(range.from_ledger, 101);
  assert.strictEqual(range.through_ledger, 200);
  assert.strictEqual(range.start_floor_ledger, 100);
  assert.strictEqual(range.end_floor_ledger, 200);

  const pinnedReader = {
    ledger: async index => {
      const headers = {
        100: { ledger: 100, close_ms: Date.parse('2026-08-09T23:59:52Z') },
        101: { ledger: 101, close_ms: Date.parse('2026-08-10T00:00:00Z') },
        200: { ledger: 200, close_ms: Date.parse('2026-08-27T23:59:52Z') },
        201: { ledger: 201, close_ms: Date.parse('2026-08-28T00:00:00Z') }
      };
      return headers[index];
    }
  };
  const pinned = await proveLedgerRange(pinnedReader, '2026-08-10T00:00:00Z', '2026-08-28T00:00:00Z', 101, 200);
  assert.strictEqual(pinned.from_ledger, 101);
  assert.strictEqual(pinned.through_ledger, 200);
  assert.strictEqual(pinned.proof, 'PINNED_LEDGER_BOUNDARIES_REVALIDATED');

  const selected = new Set(['rAAA', 'rBBB']);
  assert.strictEqual(paymentLeader({ from_account: 'rBBB', to_account: 'rAAA' }, selected), 'rAAA');
  assert.strictEqual(paymentLeader({ from_account: 'rBBB', to_account: 'rOUT' }, selected), 'rBBB');
  assert.strictEqual(paymentLeader({ from_account: 'rOUT', to_account: 'rOUT2' }, selected), null);

  const result = await scanBatch(fake, ['rTEST'], range);
  assert.strictEqual(result.wallets_complete, 1);
  assert.strictEqual(result.wallets_failed, 0);
  assert.strictEqual(result.payments.length, 1);
  assert.strictEqual(result.payments[0].hash, 'HIST_OK');
  assert.strictEqual(result.payments[0].amount_drops, '2500000');

  console.log('ALL HISTORICAL PRICE-REGIME WALKER CHECKS PASS');
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

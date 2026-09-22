'use strict';

const T = require('../../src/db/transactions');
const X = require('../../src/db/evidence-export');

const PAGE_LIMIT = 200;
const MAX_BATCH = 10;
const MAX_WINDOW_DAYS = 31;

function timeRange(startIso, endIso) {
  const start_ms = Date.parse(String(startIso || ''));
  const end_ms = Date.parse(String(endIso || ''));
  if (!Number.isFinite(start_ms) || !Number.isFinite(end_ms) || end_ms <= start_ms) {
    throw new Error('INVALID_HISTORICAL_TIME_RANGE');
  }
  if (end_ms - start_ms > MAX_WINDOW_DAYS * 86400000) {
    throw new Error('HISTORICAL_WINDOW_EXCEEDS_31_DAYS');
  }
  return { start_ms, end_ms };
}

async function resolveLedgerRange(reader, startIso, endIso) {
  if (!reader || typeof reader.ledger !== 'function' || typeof reader.floor !== 'function') {
    throw new Error('READ_ONLY_XRPL_READER_REQUIRED');
  }
  const t = timeRange(startIso, endIso);
  const tip = await reader.ledger('validated');
  const anchor = {
    ledger: tip.ledger,
    close_ms: tip.close_ms,
    close_iso: new Date(tip.close_ms).toISOString()
  };
  if (anchor.close_ms < t.end_ms) throw new Error('VALIDATED_TIP_BEFORE_RESEARCH_WINDOW');

  // Reader.floor(t) returns the last validated ledger strictly before t.
  // The research interval is [start, end), so the first candidate ledger is
  // one after floor(start), while floor(end) is the final candidate ledger.
  const beforeStart = await reader.floor(t.start_ms, anchor);
  const beforeEnd = await reader.floor(t.end_ms, anchor);
  const from_ledger = beforeStart.ledger + 1;
  const through_ledger = beforeEnd.ledger;
  if (through_ledger < from_ledger) throw new Error('EMPTY_HISTORICAL_LEDGER_RANGE');

  return {
    start_ms: t.start_ms,
    end_ms: t.end_ms,
    start_iso: new Date(t.start_ms).toISOString(),
    end_iso: new Date(t.end_ms).toISOString(),
    from_ledger,
    through_ledger,
    start_floor_ledger: beforeStart.ledger,
    start_floor_close: new Date(beforeStart.close_ms).toISOString(),
    end_floor_ledger: beforeEnd.ledger,
    end_floor_close: new Date(beforeEnd.close_ms).toISOString(),
    tip_ledger: anchor.ledger,
    tip_close: anchor.close_iso
  };
}

function compactPayment(row) {
  if (!row || row.validated !== true || row.tx_type !== 'Payment' ||
      row.tx_result !== 'tesSUCCESS' || row.currency !== 'XRP' ||
      row.amount_drops === null || row.amount_drops === undefined) return null;
  const event = X.eventOf({ ...row, close_time: row.close_time_iso });
  return {
    hash: event.hash,
    ledger_index: event.ledger_index,
    close_time: event.close_time,
    from_account: event.from_account,
    to_account: event.to_account,
    amount_drops: event.amount_drops,
    currency: 'XRP',
    tx_type: 'Payment',
    tx_result: 'tesSUCCESS',
    validated: true
  };
}

async function walkAddressOnce(reader, address, range, options) {
  const opts = options || {};
  const lane = typeof reader.lane === 'function' ? await reader.lane() : null;
  const ask = command => lane
    ? reader.request(command, lane.epoch, lane)
    : reader.request(command, reader.epoch);
  const release = () => {
    if (lane && typeof reader.releaseLane === 'function') reader.releaseLane(lane);
  };

  const payments = [];
  let marker = null;
  let pages = 0;
  let tx_rows = 0;
  try {
    do {
      const command = {
        command: 'account_tx',
        account: address,
        ledger_index_min: range.from_ledger,
        ledger_index_max: range.through_ledger,
        limit: PAGE_LIMIT,
        forward: true
      };
      if (marker) command.marker = marker;
      const result = await ask(command);
      if (result.validated !== true ||
          Number(result.ledger_index_min) !== range.from_ledger ||
          Number(result.ledger_index_max) !== range.through_ledger ||
          result.account !== address ||
          !Array.isArray(result.transactions)) {
        throw new Error('HISTORICAL_ACCOUNT_TX_RANGE_UNPROVEN');
      }

      for (const item of result.transactions) {
        const row = T.rowFromAccountTx(item, {
          observedVia: address,
          scanId: opts.scan_id || 'RESEARCH_HISTORICAL',
          rosterVersion: opts.roster_hash || 'RESEARCH'
        });
        tx_rows++;
        if (row.ledger_index === null ||
            row.ledger_index < range.from_ledger ||
            row.ledger_index > range.through_ledger ||
            row.validated !== true ||
            row.close_time_ms === null) {
          throw new Error('HISTORICAL_ROW_OUTSIDE_PROVEN_RANGE');
        }
        if (row.close_time_ms < range.start_ms || row.close_time_ms >= range.end_ms) continue;
        const payment = compactPayment(row);
        if (payment) payments.push(payment);
      }

      const next = result.marker || null;
      if (next && marker && JSON.stringify(next) === JSON.stringify(marker)) {
        throw new Error('HISTORICAL_ACCOUNT_TX_MARKER_NOT_ADVANCING');
      }
      marker = next;
      pages++;
      if (typeof opts.onPage === 'function') {
        opts.onPage({ address, pages, tx_rows, payment_rows: payments.length, more: !!marker });
      }
    } while (marker);

    return {
      address,
      status: 'COMPLETE',
      proof: {
        from_ledger: range.from_ledger,
        through_ledger: range.through_ledger,
        pages,
        endpoint: lane ? lane.endpoint : null
      },
      tx_rows,
      payments
    };
  } finally {
    release();
  }
}

async function walkAddress(reader, address, range, options) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await walkAddressOnce(reader, address, range, options);
      result.attempts = attempt;
      return result;
    } catch (e) {
      last = e;
      if (!(e && (e.laneSwitch || /XRPL_(LANE_COOLING|TRANSPORT_CHANGED|TRANSPORT_SILENT|CONNECTION_CLOSED)/.test(String(e.message || ''))))) {
        throw e;
      }
    }
  }
  throw last || new Error('HISTORICAL_WALK_RETRY_EXHAUSTED');
}


function paymentLeader(payment, selectedAddresses) {
  const selected = selectedAddresses instanceof Set ? selectedAddresses : new Set(selectedAddresses || []);
  const endpoints = [payment && payment.from_account, payment && payment.to_account]
    .filter(address => address && selected.has(address));
  const unique = [...new Set(endpoints)].sort();
  return unique.length ? unique[0] : null;
}

async function scanBatch(reader, addresses, range, options) {
  const list = Array.from(new Set(addresses || []));
  if (!list.length || list.length > MAX_BATCH) throw new Error('HISTORICAL_BATCH_SIZE_OUT_OF_RANGE');

  const concurrency = Math.min(2, list.length);
  const results = new Array(list.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= list.length) return;
      try {
        results[i] = await walkAddress(reader, list[i], range, options);
      } catch (e) {
        results[i] = {
          address: list[i],
          status: 'FAILED',
          error: String(e && e.message || e),
          tx_rows: 0,
          payments: []
        };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const byHash = new Map();
  const dedupeSet = options && options.dedupeSet
    ? (options.dedupeSet instanceof Set ? options.dedupeSet : new Set(options.dedupeSet))
    : null;
  for (const result of results) {
    for (const payment of result.payments || []) {
      if (dedupeSet && paymentLeader(payment, dedupeSet) !== result.address) continue;
      if (!byHash.has(payment.hash)) byHash.set(payment.hash, payment);
    }
  }
  const payments = [...byHash.values()].sort((a, b) =>
    a.ledger_index - b.ledger_index || String(a.hash).localeCompare(String(b.hash)));

  return {
    range,
    wallets_requested: list.length,
    wallets_complete: results.filter(r => r.status === 'COMPLETE').length,
    wallets_failed: results.filter(r => r.status !== 'COMPLETE').length,
    dedupe_mode: dedupeSet ? 'SELECTED_ENDPOINT_LEADER' : 'BATCH_HASH_ONLY',
    wallet_results: results.map(r => ({
      address: r.address,
      status: r.status,
      error: r.error || null,
      tx_rows: r.tx_rows || 0,
      payment_rows: (r.payments || []).length,
      proof: r.proof || null,
      attempts: r.attempts || 0
    })),
    payments
  };
}

module.exports = {
  PAGE_LIMIT,
  MAX_BATCH,
  MAX_WINDOW_DAYS,
  timeRange,
  resolveLedgerRange,
  compactPayment,
  paymentLeader,
  walkAddress,
  scanBatch
};

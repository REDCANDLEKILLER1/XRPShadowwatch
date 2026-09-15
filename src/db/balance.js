// XRPMAN Shadow Watch — balance as a CROSS-CHECK on acquired evidence.
// Server-side and browser-safe (dual export, like coverage.js). No database,
// no network: everything here is arithmetic over facts a caller already holds.
//
// ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
//
// It is NOT a trigger. Nothing in this module may be consulted to decide
// whether a wallet gets its edge query. Every watched wallet is walked from
// last_proven_ledger+1 to the run's anchor whether its balance moved or not,
// because a routing wallet can receive five million XRP and send five million
// XRP inside one day and show a net-zero balance at both ends. Gating the walk
// on a balance delta would build that wallet a hiding place, and that wallet
// is the reason this project exists.
//
// ── WHAT IT IS ─────────────────────────────────────────────────────────────
//
// Between two balances pinned to two known ledgers, the XRP delta is an exact
// identity, not an estimate:
//
//     balance(anchor) - balance(previous anchor)
//        == SUM of this account's AccountRoot balance deltas
//           across every transaction in (previous anchor .. anchor]
//
// Fees are included: a fee is an AccountRoot debit like any other. So the
// identity holds to the drop, and when it does not hold, exactly one thing has
// happened — a transaction that moved this account's XRP is NOT in the
// evidence. That is a contradiction, and a wallet with zero rows and an
// unexplained balance change must never be rendered as "quiet".
//
// ── WHY IT FAILS OPEN, NOT CLOSED ──────────────────────────────────────────
//
// Every precondition that is missing returns NOT_APPLICABLE, never
// CONTRADICTION. An inability to check is not a finding. This report is read
// aloud live; a cross-check that cries wolf on its first cold wallet would be
// switched off within a week, and then it would catch nothing at all. So the
// check speaks only when both endpoints are pinned, the walked range joins
// them with no gap, and the arithmetic is fully determined.
'use strict';

const STATUS = {
  RECONCILED:     'RECONCILED',
  CONTRADICTION:  'CONTRADICTION',
  NOT_APPLICABLE: 'NOT_APPLICABLE'
};

// A drops value is a decimal integer string. 1e17 drops is beyond the exact
// range of a double, so it never becomes a Number on the way to a comparison.
function _drops(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return /^-?[0-9]+$/.test(s) ? s : null;
}
function _ledger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function _no(reason, extra) {
  return Object.assign({ status: STATUS.NOT_APPLICABLE, reason: reason }, extra || {});
}

// This account's net XRP movement inside one transaction, from the balance
// deltas projected at ingest (transactions.js::_evidence). Those live in the
// `evidence` column, which survives payload expiry — so reconciliation still
// works on a slim event whose raw_tx and raw_meta are long gone.
//
// `null` means the row carries no AccountRoot projection at all. That is not
// "zero": every transaction in a ledger modifies at least the submitter's
// AccountRoot to pay its fee, so an absent projection means we cannot see what
// this row did, and the whole reconciliation stands down rather than counting
// it as no movement.
function rowDelta(row, address) {
  const deltas = row && row.evidence && row.evidence.balance_deltas;
  if (!Array.isArray(deltas) || !deltas.length) return null;
  let total = 0n, seen = false;
  for (const d of deltas) {
    if (!d || d.account !== address) continue;
    const prev = _drops(d.prev), final = _drops(d.final);
    if (prev === null || final === null) return null;
    total += BigInt(final) - BigInt(prev);
    seen = true;
  }
  // A transaction this wallet was merely a signer or issuer on moves none of
  // its XRP. The projection IS present, it simply does not name this account,
  // and zero is the honest contribution.
  return { drops: total.toString(), names_account: seen };
}

// input:
//   address    the wallet being reconciled
//   rows       every transaction acquired for it this run, or null if the edge
//              was not walked (which is itself a NOT_APPLICABLE, never a pass)
//   edge       { from_ledger, through_ledger } — the range actually PROVEN
//   previous   { drops, ledger } — the last pinned balance observation
//   current    { drops, ledger } — this run's pinned balance observation
function reconcile(input) {
  const inp = input || {};
  const address = inp.address;
  if (!address) return _no('NO_ADDRESS');

  const current = inp.current || {};
  const curDrops = _drops(current.drops), curLedger = _ledger(current.ledger);
  if (curDrops === null || curLedger === null) return _no('NO_CURRENT_BALANCE');

  const previous = inp.previous || {};
  const prevDrops = _drops(previous.drops), prevLedger = _ledger(previous.ledger);
  // The first time a wallet is seen there is nothing to compare against. That
  // is the cold bootstrap, not a defect.
  if (prevDrops === null || prevLedger === null) return _no('NO_PREVIOUS_BALANCE', { balance_ledger: curLedger });

  if (!Array.isArray(inp.rows)) return _no('EDGE_NOT_WALKED', { balance_ledger: curLedger });

  const edge = inp.edge || {};
  const from = _ledger(edge.from_ledger), through = _ledger(edge.through_ledger);
  if (from === null || through === null) return _no('EDGE_RANGE_UNPROVEN');
  // The proven range has to JOIN the two observations. If the walk began after
  // the previous balance's ledger, the ledgers in between were never read and
  // any difference could sit there legitimately.
  if (from > prevLedger + 1) {
    return _no('EDGE_LEAVES_GAP', { gap_from: prevLedger + 1, gap_through: from - 1 });
  }
  // And it has to reach the balance we are comparing against. Reconciling a
  // partial prefix against a balance read at the anchor would manufacture a
  // contradiction out of transactions we simply have not walked yet.
  if (through !== curLedger) {
    return _no('EDGE_DOES_NOT_REACH_BALANCE', { edge_through: through, balance_ledger: curLedger });
  }

  const considered = [], seen = new Set();
  for (const row of inp.rows) {
    const li = _ledger(row && row.ledger_index);
    if (li === null || li <= prevLedger || li > curLedger) continue;
    const hash = row.hash;
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);
    considered.push(row);
  }

  let explained = 0n, naming = 0;
  for (const row of considered) {
    const d = rowDelta(row, address);
    if (d === null) {
      return _no('BALANCE_DELTAS_UNAVAILABLE', { hash: row.hash, transactions_considered: considered.length });
    }
    explained += BigInt(d.drops);
    if (d.names_account) naming++;
  }

  const observed = BigInt(curDrops) - BigInt(prevDrops);
  const unexplained = observed - explained;
  const facts = {
    from_ledger: prevLedger + 1,
    through_ledger: curLedger,
    previous_balance_drops: prevDrops,
    balance_drops: curDrops,
    observed_delta_drops: observed.toString(),
    explained_delta_drops: explained.toString(),
    transactions_considered: considered.length,
    transactions_moving_balance: naming
  };
  if (unexplained === 0n) return Object.assign({ status: STATUS.RECONCILED, reason: 'BALANCE_EXPLAINED' }, facts);
  // An INTEGRITY CONTRADICTION, and deliberately not a diagnosis. The identity
  // did not hold; that is a fact. WHY it did not hold is a separate question
  // with more than one answer — a transaction missing from the walk, a node
  // that answered a partial range, a defect in the AccountRoot projection, or
  // an account that was deleted and recreated. Naming it
  // "missing XRPL transaction" would pick one of those before anyone looked.
  //
  // What the verdict licenses is narrow and firm: this wallet may not be
  // rendered as quiet, and this run may not seal. What caused it is for the
  // operator and the debug export to establish.
  return Object.assign({
    status: STATUS.CONTRADICTION,
    reason: considered.length ? 'BALANCE_UNEXPLAINED_PARTIAL' : 'BALANCE_UNEXPLAINED_NO_ROWS',
    contradiction: 'ANCHORED_BALANCE_DOES_NOT_MATCH_OBSERVED_DELTAS',
    unexplained_drops: unexplained.toString()
  }, facts);
}

const contradicted = verdict => !!verdict && verdict.status === STATUS.CONTRADICTION;

const API = { STATUS, reconcile, rowDelta, contradicted, _drops };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.SW_BALANCE = API;

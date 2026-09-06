// XRPMAN Shadow Watch — transaction evidence: ingest mapping and read helpers.
// Server-side only (Node/Vercel). Never loaded into a page; index.html and
// brief-console.html enumerate their scripts explicitly.
//
// ── The row we store is NOT the row the app keeps in memory ─────────────────
// state.txs rows (02-core.js:1218-1229) are a lossy projection of the
// account_tx response, built for one morning's arithmetic and then thrown
// away. They carry no ledger_index at all — which is why no ledger range can
// currently be proven or served — and they drop the issuer of an IOU, the
// Signers array, SendMax, the raw Amount that delivered_amount overrode, Fee,
// Sequence, Flags, Memos, SourceTag, EscrowFinish Owner/OfferSequence,
// Condition/Fulfillment, meta.TransactionIndex and every ModifiedNode delta.
//
// Storing that projection would bake today's questions into permanent
// evidence. A forensic index gets read by classifiers that do not exist yet.
//
// So every row keeps the COMPLETE payload — `raw_tx` and `raw_meta`, verbatim
// — alongside normalized columns for the fields the report queries on.
//
// An earlier version of this file claimed "nothing the response carried is
// discarded" while `_evidence()` copied out an ALLOWLIST of about eleven
// fields. That was simply untrue: an allowlist discards everything nobody
// thought to list, permanently, and the only way to get such a field back
// would be re-walking the history this index exists to stop re-walking. The
// claim is now structural rather than aspirational: raw_tx and raw_meta are
// NOT NULL, and the suite asserts a field absent from every normalized column
// and from the derived `evidence` object is still recoverable from raw.
//
// ── Amounts: why they are strings here ─────────────────────────────────────
// XRP is denominated in drops, and the 100,000,000,000 XRP supply is 1e17
// drops — larger than Number.MAX_SAFE_INTEGER (9.007e15). The app's `drops()`
// helper returns a JS float, so a large XRP amount can be rounded before it is
// printed. Evidence may not be rounded. Drops stay a decimal STRING all the
// way into a NUMERIC column, and IOU values (arbitrary precision by protocol)
// do too.
'use strict';

// Roles in `transaction_accounts`. `observed_via` is the one that does not
// exist in the current code and is the reason this table exists at all: when a
// watched wallet pays another watched wallet, the in-memory scan dedupes the
// two sightings and the second wallet's provenance is destroyed. Here both
// sightings are recorded, and the read path collapses them once, on purpose,
// where it can be tested.
const ROLE = {
  SUBMITTER:    'submitter',      // tx.Account — who signed, NOT always the source of funds
  DESTINATION:  'destination',    // tx.Destination
  ESCROW_OWNER: 'escrow_owner',   // the account whose escrow this is
  ESCROW_DEST:  'escrow_dest',    // the escrow object's Destination
  ISSUER:       'issuer',         // IOU issuer
  SIGNER:       'signer',         // an entry in tx.Signers
  OBSERVED_VIA: 'observed_via'    // the watched wallet whose account_tx returned this
};

const XRPL_EPOCH_OFFSET_MS = 946684800000;   // 2000-01-01T00:00:00Z, the ripple-epoch base

function _s(v) { return (v === null || v === undefined) ? null : String(v); }

// NULL is not zero, and here that is a forensic distinction rather than a
// tidiness one. `Number(null)` is 0, so a naive coercion would store an absent
// DestinationTag as tag 0 — and 0 is a real, meaningful tag that exchanges
// actually use. "No tag" and "tag 0" are different facts about a transaction,
// and conflating them would put a destination tag on a payment that never
// carried one. Same for SourceTag, Sequence and Flags.
function _intOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  if (typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// A drops value arrives as a decimal string. Keep it one. Reject anything that
// is not a non-negative integer literal rather than coercing it — a silent
// coercion here would fabricate a ledger value.
function _dropsString(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return /^[0-9]+$/.test(s) ? s : null;
}

function _ripToMs(rippleSeconds) {
  const n = Number(rippleSeconds);
  if (!Number.isFinite(n)) return null;
  return n * 1000 + XRPL_EPOCH_OFFSET_MS;
}

// ── Amount extraction ──────────────────────────────────────────────────────
// The partial-payment sentinel is real and has already bitten this project: a
// tfPartialPayment carries the MAXIMUM in `Amount` (often ~1e17 drops) while
// the amount that actually moved is in meta.delivered_amount. 02-core.js:1204
// prefers delivered_amount for exactly that reason. We do the same — and we
// keep the overridden raw Amount in `evidence`, because "this transaction
// claimed 100B and delivered 12" is itself a forensic signal.
function _amountFacts(txj, meta) {
  const out = {
    currency: 'XRP',
    issuer: null,
    amount_drops: null,      // XRP only, decimal string
    amount_value: null,      // issued currency only, decimal string
    delivered_used: false,
    raw_amount_overridden: null
  };
  const delivered = meta && meta.delivered_amount;
  let src = txj ? txj.Amount : null;
  if (delivered !== null && delivered !== undefined && delivered !== 'unavailable') {
    if (src !== null && src !== undefined && JSON.stringify(src) !== JSON.stringify(delivered)) {
      out.raw_amount_overridden = src;
    }
    src = delivered;
    out.delivered_used = true;
  }
  if (typeof src === 'string') {
    out.amount_drops = _dropsString(src);
  } else if (src && typeof src === 'object') {
    out.currency = _s(src.currency) || 'TOKEN';
    out.issuer = _s(src.issuer);
    out.amount_value = _s(src.value);
  }
  return out;
}

// ── Escrow facts ───────────────────────────────────────────────────────────
// The owner comes off the ledger node, never off the submitter. On an
// EscrowFinish the submitting account is whoever triggered the release, which
// is frequently not the source of the funds — conflating the two is the defect
// that printed Ripple's scheduled unlock as "500M XRP from a large private
// holder" three mornings running. When the node cannot be read, ownership is
// UNKNOWN and stays NULL. It is never guessed.
function _escrowFacts(txj, meta) {
  const out = { owner: null, destination: null, amount_drops: null, nodes_seen: 0 };
  const nodes = (meta && meta.AffectedNodes) || [];
  for (const nd of nodes) {
    const en = nd && (nd.DeletedNode || nd.CreatedNode || nd.ModifiedNode);
    if (!en || en.LedgerEntryType !== 'Escrow') continue;
    out.nodes_seen++;
    // Only the first Escrow node is promoted to columns; the count of the rest
    // is kept in `evidence`. 02-core.js:1217 breaks after the first, losing the
    // remainder of a multi-escrow transaction silently — recorded here so a
    // reader can tell that it happened.
    if (out.owner !== null || out.destination !== null || out.amount_drops !== null) continue;
    const ff = en.FinalFields || en.NewFields || en.PreviousFields || {};
    if (ff.Account) out.owner = _s(ff.Account);
    if (ff.Destination) out.destination = _s(ff.Destination);
    if (typeof ff.Amount === 'string') out.amount_drops = _dropsString(ff.Amount);
  }
  // An EscrowCreate is submitted by its own owner, so that one is safe to
  // attribute without reading the node. EscrowFinish and EscrowCancel are not.
  if (out.owner === null && txj && txj.TransactionType === 'EscrowCreate' && txj.Account) {
    out.owner = _s(txj.Account);
  }
  return out;
}

function _sigFacts(txj) {
  const signers = (txj && Array.isArray(txj.Signers)) ? txj.Signers : [];
  if (signers.length) {
    return {
      sig_mode: 'multisig',
      signer_count: signers.length,
      signer_accounts: signers
        .map(function (s) { return _s(s && s.Signer && s.Signer.Account); })
        .filter(Boolean)
    };
  }
  const single = txj && (txj.SigningPubKey || txj.TxnSignature);
  return {
    sig_mode: single ? 'single' : 'unknown',
    signer_count: single ? 1 : 0,
    signer_accounts: []
  };
}

// DERIVED facts only. This is not the evidence of record — `raw_tx` and
// `raw_meta` are, and they hold the complete payload verbatim.
//
// It used to be an allowlist of fields copied out of tx_json (SendMax, Paths,
// Memos, Signers, Owner, OfferSequence, Condition, Fulfillment, LimitAmount,
// TakerGets, TakerPays) while the header claimed "nothing the response carried
// is discarded". That claim was false: an allowlist discards by definition, and
// a classifier that does not exist yet would have needed a field nobody thought
// to list — with no way to recover it but rescanning history the index was
// built to stop rescanning. Those copies are gone; raw_tx carries them all.
//
// What stays here is what the raw payload does NOT say: conclusions this
// mapping reached, and compact projections the read path wants without
// digging through AffectedNodes.
function _evidence(txj, meta, amt, esc, sig) {
  const e = {};
  const put = function (k, v) {
    if (v === null || v === undefined) return;
    if (Array.isArray(v) && !v.length) return;
    e[k] = v;
  };
  put('raw_amount_overridden', amt.raw_amount_overridden);
  if (amt.delivered_used) e.delivered_amount_used = true;
  if (esc.nodes_seen > 1) e.escrow_nodes_seen = esc.nodes_seen;
  if (sig.signer_accounts.length) e.signer_accounts = sig.signer_accounts;
  // Balance deltas are the only independent check on a claimed amount, and
  // they are what keeps an unrecognised future transaction type forensically
  // useful rather than opaque. A PROJECTION of raw_meta.AffectedNodes, kept
  // because every read path wants it and none should re-walk the nodes.
  const mods = [];
  for (const nd of (meta.AffectedNodes || [])) {
    const mn = nd && nd.ModifiedNode;
    if (!mn || mn.LedgerEntryType !== 'AccountRoot') continue;
    const ff = mn.FinalFields || {}, pf = mn.PreviousFields || {};
    if (pf.Balance === undefined) continue;
    mods.push({ account: _s(ff.Account), prev: _s(pf.Balance), final: _s(ff.Balance) });
  }
  put('balance_deltas', mods);
  return e;
}

// ── The ingest mapping ─────────────────────────────────────────────────────
// One account_tx entry in, one storable row out. `observedVia` is the watched
// address whose walk produced this entry; `rosterVersion` stamps which roster
// was current, because labels and classifications are recomputed on read, not
// stored. Freezing a label forks an identity: saveBlackboxSnapshot persists
// sender_label verbatim (02-core.js:19473-19476) and detectCoordination keys
// pair-scoring on the frozen value (:19545), so a relabelled wallet splits
// into two coordination identities across 30 snapshots. Roster-derived facts
// are views, never columns.
function rowFromAccountTx(item, ctx) {
  const it = item || {};
  const txj = it.tx_json || it.tx || {};
  const meta = it.meta || it.metaData || {};

  const ledgerIndex = _intOrNull(
    it.ledger_index !== undefined ? it.ledger_index : txj.ledger_index
  );
  const closeMs = _ripToMs(txj.date);

  const amt = _amountFacts(txj, meta);
  const esc = _escrowFacts(txj, meta);
  const sig = _sigFacts(txj);

  // meta.TransactionResult is the difference between "this moved money" and
  // "this was rejected and cost a fee". Today it is read only in escrow
  // parsing (02-core.js:3201), so failed tec* transactions count as real
  // movement in tx_24h_count, in volume sums and in cluster scores. We STORE
  // it rather than dropping failures at ingest: the evidence stays complete
  // and the report filters on read.
  return {
    hash: _s(txj.hash || it.hash),
    ledger_index: ledgerIndex,
    close_time_ms: closeMs,
    close_time_iso: closeMs !== null ? new Date(closeMs).toISOString() : null,
    tx_type: _s(txj.TransactionType),
    tx_result: _s(meta.TransactionResult),
    validated: it.validated === true,
    from_account: _s(txj.Account),          // the SUBMITTER. Not "the source of funds".
    to_account: _s(txj.Destination),
    amount_drops: amt.amount_drops,
    amount_value: amt.amount_value,
    currency: amt.currency,
    issuer: amt.issuer,
    destination_tag: _intOrNull(txj.DestinationTag),
    source_tag: _intOrNull(txj.SourceTag),
    sig_mode: sig.sig_mode,
    signer_count: sig.signer_count,
    escrow_owner: esc.owner,
    escrow_destination: esc.destination,
    escrow_amount_drops: esc.amount_drops,
    fee_drops: _dropsString(txj.Fee),
    sequence: _intOrNull(txj.Sequence),
    tx_flags: _intOrNull(txj.Flags),
    transaction_index: _intOrNull(meta.TransactionIndex),
    roster_version: _s(ctx && ctx.rosterVersion),
    // ── The evidence of record ────────────────────────────────────────────
    // The complete public ledger payload, verbatim. The normalized columns
    // above exist for fast querying; THESE are the forensic source of truth,
    // and they are what lets the index answer a question nobody has asked yet
    // without rescanning the history it was built to stop rescanning.
    //
    // Public transaction evidence only — exactly what account_tx returns from
    // a validated ledger. No seed, no key, no signing material. TxnSignature
    // and SigningPubKey are public on-chain fields readable by anyone; they
    // are not credentials.
    raw_tx: txj,
    raw_meta: meta,
    // Derived conclusions and compact projections — NOT a second copy of the
    // payload. See _evidence.
    evidence: _evidence(txj, meta, amt, esc, sig),
    // Provenance, not a property of the transaction: which watched wallet's
    // walk saw this, and under which run.
    observed_via: _s(ctx && ctx.observedVia),
    scan_id: _s(ctx && ctx.scanId)
  };
}

// ── Participants ───────────────────────────────────────────────────────────
// Every address this transaction touched, with the role it played. Deduped per
// (address, role) pair; one address can legitimately hold several roles in one
// transaction and each of those is recorded.
function participantsOf(row) {
  const out = [];
  const seen = new Set();
  const add = function (address, role) {
    if (!address || !role) return;
    const k = address + ' ' + role;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ tx_hash: row.hash, address: address, role: role });
  };
  add(row.from_account, ROLE.SUBMITTER);
  add(row.to_account, ROLE.DESTINATION);
  add(row.escrow_owner, ROLE.ESCROW_OWNER);
  add(row.escrow_destination, ROLE.ESCROW_DEST);
  add(row.issuer, ROLE.ISSUER);
  // After mergeSightings this is an array: every wallet whose walk saw this
  // transaction, not just the first. Each becomes its own provenance row.
  for (const o of _observers(row)) add(o, ROLE.OBSERVED_VIA);
  const signers = (row.evidence && row.evidence.signer_accounts) || [];
  for (const s of signers) add(s, ROLE.SIGNER);
  return out;
}

// ── Exact arithmetic on drops ──────────────────────────────────────────────
// Drops are integers up to 1e17 (the XRP supply), which is beyond the exact
// range of a double. Any `Number()` on the way to a total silently rounds
// evidence, and any lexicographic sort of the strings orders "9" above "100".
// So totals and comparisons go through BigInt and come back as strings.
//
// These exist so that no caller ever has an excuse to reach for `Number()`.
function sumDrops(values) {
  let total = 0n;
  for (const v of (Array.isArray(values) ? values : [])) {
    const s = _dropsString(v);
    if (s === null) continue;      // absent or malformed contributes nothing
    total += BigInt(s);
  }
  return total.toString();
}

// -1 / 0 / 1, exact at any magnitude. A null sorts below every real value.
function dropsCompare(a, b) {
  const sa = _dropsString(a), sb = _dropsString(b);
  if (sa === null && sb === null) return 0;
  if (sa === null) return -1;
  if (sb === null) return 1;
  const ba = BigInt(sa), bb = BigInt(sb);
  return ba < bb ? -1 : (ba > bb ? 1 : 0);
}

// ── One transaction, counted once — WITHOUT losing a role ──────────────────
// A watched-to-watched transfer is returned by BOTH wallets' account_tx walks.
// The same hash can also arrive from three different fetch paths in one run:
// the Phase 2 wallet walk, escrowBackfill's own account_tx calls, and
// scanReceivers'. Each sighting is a separate observation of the same event.
//
// The rule, and it is not the same rule twice:
//
//   DEDUPLICATE TRANSACTIONS.  DO NOT DEDUPLICATE EVIDENCE ROLES.
//
// Counting one transfer twice inflates volume. But collapsing the sightings by
// keeping the first row and dropping the rest destroys the second wallet's
// provenance — which is the exact structural loss `transaction_accounts` was
// created to fix, reintroduced one layer higher. One transaction legitimately
// produces several evidence outputs at once: an escrow event, a destination
// movement, a discovery candidate. Those are different facts, not duplicates.
//
// So: one row per hash, and the UNION of every role every sighting observed.
function mergeSightings(rows) {
  const byHash = new Map();
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const h = r && r.hash;
    if (!h) continue;                       // a row with no hash is not evidence
    const prior = byHash.get(h);
    if (!prior) {
      const merged = Object.assign({}, r);
      merged.observed_via = _observers(r);
      merged.sightings = 1;
      merged.conflicts = [];
      byHash.set(h, merged);
      continue;
    }
    prior.sightings++;
    for (const o of _observers(r)) {
      if (prior.observed_via.indexOf(o) < 0) prior.observed_via.push(o);
    }
    // A later sighting may carry escrow facts the first one could not read —
    // escrowBackfill reads ledger nodes the wallet walk did not. Fill gaps;
    // never overwrite a value already established.
    for (const k of ['escrow_owner', 'escrow_destination', 'escrow_amount_drops',
                     'to_account', 'issuer', 'destination_tag', 'source_tag',
                     'ledger_index', 'close_time_ms', 'close_time_iso', 'tx_result']) {
      if ((prior[k] === null || prior[k] === undefined) &&
          r[k] !== null && r[k] !== undefined) prior[k] = r[k];
    }
    // Two sightings of one hash disagreeing on a core fact is not something to
    // resolve by picking one. It means a server returned inconsistent data, or
    // the mapping is wrong. Record it so a reader can see it happened.
    for (const k of ['tx_type', 'amount_drops', 'amount_value', 'currency',
                     'from_account', 'ledger_index', 'tx_result',
                     // Two sightings naming DIFFERENT escrow owners is the most
                     // forensically loaded disagreement there is — it decides
                     // whether a release is attributed to Ripple or to someone
                     // else. Never resolve it by picking one.
                     'escrow_owner', 'escrow_destination', 'escrow_amount_drops']) {
      const a = prior[k], b = r[k];
      if (a === null || a === undefined || b === null || b === undefined) continue;
      if (String(a) !== String(b)) {
        prior.conflicts.push({ field: k, kept: String(a), also_seen: String(b) });
      }
    }
    // The richer raw payload wins. escrowBackfill's walk reads ledger nodes
    // the Phase 2 wallet walk never asked for, so its meta can carry
    // AffectedNodes the first sighting's did not. Keeping the first sighting's
    // raw unconditionally would discard evidence a later one actually held —
    // the same loss this file was just fixed for, one level up.
    const priorNodes = ((prior.raw_meta && prior.raw_meta.AffectedNodes) || []).length;
    const theseNodes = ((r.raw_meta && r.raw_meta.AffectedNodes) || []).length;
    if (theseNodes > priorNodes) { prior.raw_meta = r.raw_meta; prior.raw_tx = r.raw_tx; }

    const sigs = (prior.evidence && prior.evidence.signer_accounts) || [];
    const more = (r.evidence && r.evidence.signer_accounts) || [];
    if (more.length) {
      prior.evidence = Object.assign({}, prior.evidence);
      prior.evidence.signer_accounts = sigs.concat(more.filter(s => sigs.indexOf(s) < 0));
    }
  }
  return Array.from(byHash.values());
}

function _observers(r) {
  const v = r && r.observed_via;
  if (Array.isArray(v)) return v.filter(Boolean).slice();
  return v ? [v] : [];
}

// Kept for callers that genuinely want only the distinct hashes and no role
// information at all — a COUNT, or a hash set to join on. It DISCARDS the
// extra sightings, so it must never be used to build evidence rows: use
// mergeSightings for that.
function dedupeByHash(rows) {
  const out = [];
  const seen = new Set();
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const h = r && r.hash;
    if (!h || seen.has(h)) continue;
    seen.add(h);
    out.push(r);
  }
  return out;
}

module.exports = {
  ROLE,
  XRPL_EPOCH_OFFSET_MS,
  rowFromAccountTx,
  participantsOf,
  mergeSightings,
  dedupeByHash,
  sumDrops,
  dropsCompare,
  // Exported for the suite. These are the points where a silent coercion would
  // fabricate a ledger value, so they are asserted directly rather than only
  // through a built row.
  _dropsString: _dropsString,
  _amountFacts: _amountFacts,
  _escrowFacts: _escrowFacts,
  _sigFacts: _sigFacts,
  _ripToMs: _ripToMs
};

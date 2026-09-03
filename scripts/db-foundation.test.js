#!/usr/bin/env node
/* ── THE INDEX MAY MAKE THE REPORT FASTER. IT MAY NOT MAKE IT LOOSER. ────────
   A Report currently re-walks all 251 watched wallet histories every morning:
   17-report-scan-tuning-20260816.js:332 blanks the balance snapshot so every
   wallet enters Phase 2, and every account_tx goes out with
   `ledger_index_min: -1` (02-core.js:1067) so the window boundary is found by
   reading PAST it. That is what buys the on-air claim "251/251 proved the
   transaction window", and it is also why a cold run takes 15-20 minutes.

   An evidence index makes that claim cheap instead of making it weaker: a
   wallet proven through ledger X only has to prove [X+1 .. this run's anchor].
   But every shortcut here is a chance to claim coverage nobody earned, and the
   Report is read aloud live on air and posted to X. So the decisions that
   decide what may be claimed are pure functions, and this suite is what
   exercises them.

   No database. No browser. No network. That is the point — a decision that
   needed a live Postgres to test would be tested by nobody, and "0 tests
   found, all passed" is the failure mode this project keeps hitting.

   Six groups:
     1. schema/migration parity     the reference and the executable cannot drift
     2. ingest                      non-lossy, and never fabricates a value
     3. one transaction, once       watched-to-watched dedupe
     4. servability                 when a window may come out of the index
     5. checkpoints                 when coverage may advance, and when it may not
     6. boundary                    no secrets stored, no null read as zero

   Run: node scripts/db-foundation.test.js
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};
const threw = (fn) => { try { fn(); return null; } catch (e) { return e.message || 'threw'; } };

const COV  = require(path.join(ROOT, 'src/db/coverage.js'));
const TX   = require(path.join(ROOT, 'src/db/transactions.js'));
const CONN = require(path.join(ROOT, 'src/db/connection.js'));

const SCHEMA_SQL    = fs.readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8');
const MIGRATION_DIR = path.join(ROOT, 'db/migrations');
const MIGRATIONS    = fs.readdirSync(MIGRATION_DIR).filter(f => f.endsWith('.sql')).sort();
const MIGRATION_SQL = MIGRATIONS.map(f => fs.readFileSync(path.join(MIGRATION_DIR, f), 'utf8')).join('\n');

// ── SQL surface extraction ─────────────────────────────────────────────────
// Deliberately crude: it reads the DDL text rather than a live catalogue,
// because there is no database in CI. Crude is fine for the job it does, which
// is proving the annotated reference and the executable migration describe the
// same tables. Comments are stripped first so a column named only inside a
// comment cannot satisfy the parity check.
function stripComments(sql) {
  return sql.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
}
function tableBodies(sql) {
  const out = {};
  const re = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/gi;
  let m;
  const src = stripComments(sql);
  while ((m = re.exec(src))) {
    const name = m[1];
    let depth = 1, i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    out[name] = src.slice(re.lastIndex, i - 1);
  }
  return out;
}
// A column definition is a top-level (paren-depth 0) clause whose first token
// is an identifier and is not a constraint keyword.
function columnsOf(body) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') { depth++; cur += ch; continue; }
    if (ch === ')') { depth--; cur += ch; continue; }
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => !/^(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|EXCLUDE)\b/i.test(s))
    .map(s => (s.match(/^"?(\w+)"?/) || [])[1])
    .filter(Boolean);
}
function namesOf(sql, re) {
  const out = new Set();
  let m; const src = stripComments(sql);
  const r = new RegExp(re.source, 'gi');
  while ((m = r.exec(src))) out.add(m[1]);
  return out;
}
const setEq = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
const missing = (a, b) => [...a].filter(x => !b.has(x));

// ════════════════════════════════════════════════════════════════════════════
console.log('\n1. the annotated reference and the executable migration cannot drift');
// db/schema.sql carries the reasoning; db/migrations/*.sql is what actually
// runs. Two files describing one schema is exactly the arrangement that rots
// silently, so the drift is a build failure rather than a surprise in
// production.
check('at least one migration exists', MIGRATIONS.length > 0, MIGRATIONS);

const schemaTables    = tableBodies(SCHEMA_SQL);
const migrationTables = tableBodies(MIGRATION_SQL);
check('the same tables are defined in both',
      setEq(new Set(Object.keys(schemaTables)), new Set(Object.keys(migrationTables))),
      { only_in_schema: missing(new Set(Object.keys(schemaTables)), new Set(Object.keys(migrationTables))),
        only_in_migrations: missing(new Set(Object.keys(migrationTables)), new Set(Object.keys(schemaTables))) });

let colDrift = [];
for (const t of Object.keys(schemaTables)) {
  if (!migrationTables[t]) continue;
  const a = new Set(columnsOf(schemaTables[t]));
  const b = new Set(columnsOf(migrationTables[t]));
  if (!setEq(a, b)) {
    colDrift.push({ table: t, only_in_schema: missing(a, b), only_in_migrations: missing(b, a) });
  }
}
check('every table has the same columns in both', colDrift.length === 0, colDrift);

const CONSTRAINT_RE = /CONSTRAINT\s+(\w+)/;
const INDEX_RE      = /CREATE INDEX IF NOT EXISTS\s+(\w+)/;
check('the same named constraints exist in both',
      setEq(namesOf(SCHEMA_SQL, CONSTRAINT_RE), namesOf(MIGRATION_SQL, CONSTRAINT_RE)),
      { only_in_schema: missing(namesOf(SCHEMA_SQL, CONSTRAINT_RE), namesOf(MIGRATION_SQL, CONSTRAINT_RE)),
        only_in_migrations: missing(namesOf(MIGRATION_SQL, CONSTRAINT_RE), namesOf(SCHEMA_SQL, CONSTRAINT_RE)) });
check('the same indexes exist in both',
      setEq(namesOf(SCHEMA_SQL, INDEX_RE), namesOf(MIGRATION_SQL, INDEX_RE)),
      { only_in_schema: missing(namesOf(SCHEMA_SQL, INDEX_RE), namesOf(MIGRATION_SQL, INDEX_RE)),
        only_in_migrations: missing(namesOf(MIGRATION_SQL, INDEX_RE), namesOf(SCHEMA_SQL, INDEX_RE)) });

// Structural sanity, since no Postgres is available to parse it for us.
const mParens = (MIGRATION_SQL.match(/\(/g) || []).length - (MIGRATION_SQL.match(/\)/g) || []).length;
check('migration parentheses balance', mParens === 0, mParens);
check('the migration is wrapped in a transaction',
      /^\s*BEGIN\s*;/mi.test(MIGRATION_SQL) && /^\s*COMMIT\s*;/mi.test(MIGRATION_SQL));
check('the migration records its own version',
      /INSERT INTO schema_migrations/i.test(MIGRATION_SQL));
check('the migration is idempotent — every create is guarded',
      !/CREATE TABLE(?! IF NOT EXISTS)/i.test(stripComments(MIGRATION_SQL)) &&
      !/CREATE INDEX(?! IF NOT EXISTS)/i.test(stripComments(MIGRATION_SQL)));

// ── ledger_index is the prerequisite, not a nice-to-have ──────────────────
// state.txs rows (02-core.js:1218-1229) carry no ledger index at all. Without
// one no ledger range can be proven or served, and a row admitted without one
// would let coverage claim ledgers nobody read.
check('transactions.ledger_index exists and is NOT NULL',
      /ledger_index\s+BIGINT\s+NOT NULL/i.test(stripComments(migrationTables.transactions || '')));
check('a checkpoint can never be moved backwards by an UPDATE',
      /may not decrease/i.test(MIGRATION_SQL) && /BEFORE UPDATE ON wallet_coverage/i.test(MIGRATION_SQL));
check('proof and retained evidence are separate columns',
      /scan_coverage_through/i.test(MIGRATION_SQL) && /evidence_retained_through/i.test(MIGRATION_SQL));
check('amounts are NUMERIC, never floating point',
      /amount_drops\s+NUMERIC/i.test(MIGRATION_SQL) &&
      !/\b(REAL|DOUBLE PRECISION|FLOAT)\b/i.test(stripComments(MIGRATION_SQL)));
// XRPL access is read-only and no signing material exists in this project.
const secretish = Object.keys(migrationTables)
  .flatMap(t => columnsOf(migrationTables[t]))
  .filter(c => CONN.SECRET_KEYS.test(c));
check('no column could hold key material', secretish.length === 0, secretish);
check('no migration destroys evidence',
      !/\bDROP\s+TABLE\b/i.test(stripComments(MIGRATION_SQL)) &&
      !/\bTRUNCATE\b/i.test(stripComments(MIGRATION_SQL)));

// ════════════════════════════════════════════════════════════════════════════
console.log('\n2. ingest is non-lossy, and never fabricates a ledger value');

// The partial-payment sentinel, which has already bitten this project: a
// tfPartialPayment carries the MAXIMUM in Amount (~1e17 drops, ~100B XRP)
// while the amount that actually moved is in meta.delivered_amount.
const PARTIAL = {
  ledger_index: 98765432, validated: true,
  tx_json: { TransactionType: 'Payment', hash: 'H_PARTIAL', Account: 'rFrom', Destination: 'rTo',
             Amount: '100000000000000000', Fee: '12', Sequence: 9, Flags: 131072,
             DestinationTag: 7, SourceTag: 4, date: 800000000 },
  meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '12000000', TransactionIndex: 3,
          AffectedNodes: [{ ModifiedNode: { LedgerEntryType: 'AccountRoot',
            FinalFields: { Account: 'rFrom', Balance: '5' }, PreviousFields: { Balance: '17' } } }] }
};
const partial = TX.rowFromAccountTx(PARTIAL, { observedVia: 'rTo', scanId: 's1', rosterVersion: 'v16.7.1' });
check('ledger_index is captured', partial.ledger_index === 98765432, partial.ledger_index);
// Hardcoded, NOT recomputed from the module's own constant. Asserting against
// `new Date(date*1000 + XRPL_EPOCH_OFFSET_MS)` would move both sides together
// if the epoch offset were wrong, and every stored close time in the database
// would be silently shifted while the check stayed green.
// ripple epoch 2000-01-01T00:00:00Z + 800,000,000s = 2025-05-08T06:13:20Z.
check('close time is derived from the ripple epoch',
      partial.close_time_iso === '2025-05-08T06:13:20.000Z',
      partial.close_time_iso);
check('the ripple epoch offset itself is the documented value',
      TX.XRPL_EPOCH_OFFSET_MS === Date.parse('2000-01-01T00:00:00Z'),
      TX.XRPL_EPOCH_OFFSET_MS);
check('the DELIVERED amount is stored, not the sentinel',
      partial.amount_drops === '12000000', partial.amount_drops);
check('the overridden sentinel is preserved as evidence',
      partial.evidence.raw_amount_overridden === '100000000000000000',
      partial.evidence.raw_amount_overridden);
check('the override is recorded as having happened',
      partial.evidence.delivered_amount_used === true);
check('balance deltas are kept — the only independent check on a claimed amount',
      Array.isArray(partial.evidence.balance_deltas) &&
      partial.evidence.balance_deltas[0].prev === '17' &&
      partial.evidence.balance_deltas[0].final === '5',
      partial.evidence.balance_deltas);
check('destination_tag and source_tag survive',
      partial.destination_tag === 7 && partial.source_tag === 4);
// "No tag" and "tag 0" are different facts, and 0 is a tag exchanges really
// use. Number(null) is 0, so a naive coercion would put a destination tag on a
// payment that never carried one.
const untagged = TX.rowFromAccountTx({
  ledger_index: 1, tx_json: { TransactionType: 'Payment', hash: 'H_NOTAG',
    Account: 'rA', Destination: 'rB', Amount: '1000000', date: 800000000 },
  meta: { TransactionResult: 'tesSUCCESS' } }, {});
check('an absent destination tag stays NULL, it does not become tag 0',
      untagged.destination_tag === null && untagged.source_tag === null,
      { d: untagged.destination_tag, s: untagged.source_tag });
check('an absent Sequence and Flags stay NULL too',
      untagged.sequence === null && untagged.tx_flags === null);
// The case an ABSENT field does not exercise. `Number(undefined)` is already
// NaN, so a naive coercion handles a missing key by accident; only an explicit
// null becomes 0. That is the shape a row round-tripped through Postgres, or
// arriving from any non-account_tx source, actually has — and the first
// version of this check tested only the absent case, so it passed whether the
// guard was there or not.
const explicitNulls = TX.rowFromAccountTx({
  ledger_index: 1, tx_json: { TransactionType: 'Payment', hash: 'H_NULLS',
    Account: 'rA', Destination: 'rB', Amount: '1000000', date: 800000000,
    DestinationTag: null, SourceTag: null, Sequence: null, Flags: null },
  meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: null } }, {});
check('an explicitly NULL tag stays NULL, it does not become tag 0',
      explicitNulls.destination_tag === null && explicitNulls.source_tag === null,
      { d: explicitNulls.destination_tag, s: explicitNulls.source_tag });
check('explicitly NULL Sequence, Flags and TransactionIndex stay NULL',
      explicitNulls.sequence === null && explicitNulls.tx_flags === null &&
      explicitNulls.transaction_index === null,
      { seq: explicitNulls.sequence, f: explicitNulls.tx_flags, ti: explicitNulls.transaction_index });
// ...while a real tag 0 must survive as 0, not be flattened back to null.
const tagZero = TX.rowFromAccountTx({
  ledger_index: 1, tx_json: { TransactionType: 'Payment', hash: 'H_TAG0',
    Account: 'rA', Destination: 'rB', Amount: '1000000',
    DestinationTag: 0, Flags: 0, date: 800000000 },
  meta: { TransactionResult: 'tesSUCCESS' } }, {});
check('an explicit destination tag of 0 is preserved as 0',
      tagZero.destination_tag === 0 && tagZero.tx_flags === 0,
      { d: tagZero.destination_tag, f: tagZero.tx_flags });
check('fee, sequence, flags and transaction_index survive',
      partial.fee_drops === '12' && partial.sequence === 9 &&
      partial.tx_flags === 131072 && partial.transaction_index === 3,
      { fee: partial.fee_drops, seq: partial.sequence, flags: partial.tx_flags, ti: partial.transaction_index });

// 1e17 drops exceeds Number.MAX_SAFE_INTEGER (9.007e15). A float round-trip
// would silently change an evidence value.
const BIG = '100000000000000001';
check('a drops value beyond MAX_SAFE_INTEGER survives exactly',
      TX._dropsString(BIG) === BIG && String(Number(BIG)) !== BIG, TX._dropsString(BIG));
check('a non-integer drops value is refused, not coerced',
      TX._dropsString('12.5') === null && TX._dropsString('abc') === null &&
      TX._dropsString('-1') === null && TX._dropsString('1e6') === null);

// tec* transactions cost a fee and move nothing. Today meta.TransactionResult
// is read only in escrow parsing (02-core.js:3201), so a failed transaction
// counts as real movement in tx_24h_count, in volume sums and in cluster
// scores. Store the result; filter on read.
const FAILED = {
  ledger_index: 98765433,
  tx_json: { TransactionType: 'Payment', hash: 'H_FAIL', Account: 'rA', Destination: 'rB',
             Amount: '5000000000', date: 800000100 },
  meta: { TransactionResult: 'tecUNFUNDED_PAYMENT', TransactionIndex: 1 }
};
const failedRow = TX.rowFromAccountTx(FAILED, { observedVia: 'rA' });
check('a failed transaction is STORED, not dropped at ingest', failedRow.hash === 'H_FAIL');
check('its result is recorded so the report can exclude it',
      failedRow.tx_result === 'tecUNFUNDED_PAYMENT', failedRow.tx_result);
check('a successful transaction is distinguishable from it',
      partial.tx_result === 'tesSUCCESS');

// Escrow ownership. On an EscrowFinish the submitter is whoever triggered the
// release, not the source of funds — the defect that printed Ripple's
// scheduled unlock as "500M XRP from a large private holder" three mornings.
const FINISH = {
  ledger_index: 98765434,
  tx_json: { TransactionType: 'EscrowFinish', hash: 'H_FIN', Account: 'rTriggerBot',
             Owner: 'rRippleOwner', OfferSequence: 42, Fulfillment: 'A0', date: 800000200 },
  meta: { TransactionResult: 'tesSUCCESS',
          AffectedNodes: [{ DeletedNode: { LedgerEntryType: 'Escrow',
            FinalFields: { Account: 'rRippleOwner', Destination: 'rRippleDest', Amount: '500000000000000' } } }] }
};
const fin = TX.rowFromAccountTx(FINISH, { observedVia: 'rRippleDest' });
check('an EscrowFinish owner comes off the ledger node',
      fin.escrow_owner === 'rRippleOwner', fin.escrow_owner);
check('the submitter is NOT promoted to owner',
      fin.escrow_owner !== 'rTriggerBot' && fin.from_account === 'rTriggerBot');
check('the escrow destination and amount come off the node',
      fin.escrow_destination === 'rRippleDest' && fin.escrow_amount_drops === '500000000000000');
check('EscrowFinish Owner and OfferSequence are preserved',
      fin.evidence.Owner === 'rRippleOwner' && fin.evidence.OfferSequence === 42);
check('the crypto-condition fulfillment is preserved', fin.evidence.Fulfillment === 'A0');

// Flagged, not identified: an unreadable node means ownership is UNKNOWN.
const FINISH_BLIND = {
  ledger_index: 98765435,
  tx_json: { TransactionType: 'EscrowFinish', hash: 'H_BLIND', Account: 'rTriggerBot', date: 800000300 },
  meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [] }
};
const blind = TX.rowFromAccountTx(FINISH_BLIND, { observedVia: 'rX' });
check('an unreadable escrow node leaves ownership NULL, never guessed',
      blind.escrow_owner === null, blind.escrow_owner);

// The one case where the submitter IS the owner, by protocol.
const CREATE = {
  ledger_index: 98765436,
  tx_json: { TransactionType: 'EscrowCreate', hash: 'H_CRE', Account: 'rOwnerSelf',
             Destination: 'rDest', Amount: '200000000000', Condition: 'BEEF', date: 800000400 },
  meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [] }
};
const cre = TX.rowFromAccountTx(CREATE, { observedVia: 'rOwnerSelf' });
check('an EscrowCreate is attributed to its submitter — the one safe case',
      cre.escrow_owner === 'rOwnerSelf', cre.escrow_owner);
check('its condition is preserved', cre.evidence.Condition === 'BEEF');

// A multi-escrow transaction: 02-core.js:1217 breaks after the first node and
// loses the rest silently. Record that it happened so a reader can tell.
const MULTI = {
  ledger_index: 98765437,
  tx_json: { TransactionType: 'EscrowFinish', hash: 'H_MULTI', Account: 'rBot', date: 800000500 },
  meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [
    { DeletedNode: { LedgerEntryType: 'Escrow', FinalFields: { Account: 'rO1', Amount: '1000000' } } },
    { DeletedNode: { LedgerEntryType: 'Escrow', FinalFields: { Account: 'rO2', Amount: '2000000' } } }
  ] }
};
check('a multi-escrow transaction records that more nodes existed',
      TX.rowFromAccountTx(MULTI, {}).evidence.escrow_nodes_seen === 2);

// Multisig and issued currency — both dropped by the in-memory row today.
const MSIG = {
  ledger_index: 98765438,
  tx_json: { TransactionType: 'Payment', hash: 'H_MSIG', Account: 'rVault', Destination: 'rOut',
             Amount: { currency: 'RLUSD', issuer: 'rIssuerCo', value: '12345.678901234567890123' },
             SendMax: { currency: 'RLUSD', issuer: 'rIssuerCo', value: '12400' },
             Memos: [{ Memo: { MemoData: 'AB' } }], date: 800000600,
             Signers: [{ Signer: { Account: 'rS1' } }, { Signer: { Account: 'rS2' } },
                       { Signer: { Account: 'rS3' } }] },
  meta: { TransactionResult: 'tesSUCCESS' }
};
const msig = TX.rowFromAccountTx(MSIG, { observedVia: 'rVault' });
check('multisig mode and signer count are recorded',
      msig.sig_mode === 'multisig' && msig.signer_count === 3);
check('the individual signers are preserved',
      JSON.stringify(msig.evidence.signer_accounts) === JSON.stringify(['rS1', 'rS2', 'rS3']));
check('an issued currency keeps its issuer — dropped by the in-memory row today',
      msig.currency === 'RLUSD' && msig.issuer === 'rIssuerCo');
check('an arbitrary-precision IOU value is not rounded',
      msig.amount_value === '12345.678901234567890123', msig.amount_value);
check('an IOU row carries no drops value (they are mutually exclusive)',
      msig.amount_drops === null);
check('SendMax and Memos are preserved',
      !!msig.evidence.SendMax && !!msig.evidence.Memos);

// Roster-derived fields are views, not columns. Freezing a label forks an
// identity: saveBlackboxSnapshot persists sender_label verbatim
// (02-core.js:19473-19476) and detectCoordination keys pair-scoring on the
// frozen value (:19545), so a relabelled wallet splits into two coordination
// identities across 30 snapshots.
check('the row stamps a roster version', partial.roster_version === 'v16.7.1');
check('the row stores no label, classification or category',
      !('label' in partial) && !('classification' in partial) && !('cat' in partial),
      Object.keys(partial).filter(k => /label|classif|^cat$/.test(k)));
const schemaCols = Object.keys(migrationTables).flatMap(t => columnsOf(migrationTables[t]));
check('no schema column freezes a roster label',
      !schemaCols.some(c => /^(label|sender_label|classification|cat|category)$/i.test(c)),
      schemaCols.filter(c => /label|classif|categ/i.test(c)));

// ════════════════════════════════════════════════════════════════════════════
console.log('\n3. one transaction, counted once');
// A watched-to-watched transfer is returned by BOTH wallets' account_tx walks.
// The in-memory scan keeps one sighting and destroys the second wallet's
// provenance; here both are recorded, and the read path collapses them once —
// where it can be tested. Getting this wrong inflates volume and transaction
// count, which is the opposite of the problem the index was built to fix.
const A2B = {
  ledger_index: 98765439,
  tx_json: { TransactionType: 'Payment', hash: 'H_A2B', Account: 'rWatchedA',
             Destination: 'rWatchedB', Amount: '900000000000', date: 800000700 },
  meta: { TransactionResult: 'tesSUCCESS' }
};
const seenByA = TX.rowFromAccountTx(A2B, { observedVia: 'rWatchedA' });
const seenByB = TX.rowFromAccountTx(A2B, { observedVia: 'rWatchedB' });
check('both wallets observe the same hash', seenByA.hash === seenByB.hash);
const pA = TX.participantsOf(seenByA), pB = TX.participantsOf(seenByB);
check('A\'s sighting records A as the observer',
      pA.some(p => p.address === 'rWatchedA' && p.role === 'observed_via'));
check('B\'s sighting records B as the observer — provenance kept, not destroyed',
      pB.some(p => p.address === 'rWatchedB' && p.role === 'observed_via'));
const deduped = TX.dedupeByHash([seenByA, seenByB]);
check('the two sightings collapse to ONE transaction', deduped.length === 1, deduped.length);
const total = deduped.reduce((a, r) => a + Number(r.amount_drops || 0), 0);
check('the amount is counted once, not twice', total === 900000000000, total);
check('dedupe is order-stable — first sighting wins',
      TX.dedupeByHash([seenByB, seenByA])[0].observed_via === 'rWatchedB');
check('a row with no hash is never counted',
      TX.dedupeByHash([{ hash: '' }, { hash: null }, seenByA]).length === 1);
check('three distinct transactions stay three',
      TX.dedupeByHash([partial, failedRow, fin]).length === 3);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n4. when a window may be served out of the index');
// The window arrives in TIME; the fetch has to go out in LEDGERS. The close
// times stored alongside the coverage bounds bridge the two — XRPL has no
// "which ledger was closing at this instant" lookup, and interpolating one
// would be inventing a ledger value.
const T = (iso) => new Date(iso).getTime();
const WIN_START = T('2026-09-02T00:00:00Z');
const WIN_END   = T('2026-09-03T00:00:00Z');
const ANCHOR    = 98800000;

const provenCov = {
  address: 'rQuiet',
  scan_coverage_from: 98000000, scan_coverage_through: 98790000,
  scan_coverage_from_close_ms: T('2026-08-01T00:00:00Z'),
  scan_coverage_through_close_ms: T('2026-09-02T23:00:00Z'),
  evidence_retained_from: 98000000, evidence_retained_through: 98790000,
  evidence_retained_from_close_ms: T('2026-08-01T00:00:00Z')
};

const edge = COV.windowServability({ coverage: provenCov, windowStartMs: WIN_START, windowEndMs: WIN_END, anchorLedger: ANCHOR });
check('the normal morning case is EDGE_ONLY', edge.reason === COV.REASON.EDGE_ONLY, edge.reason);
check('history comes from the index', edge.served_from_index === true);
check('only the un-proven edge is fetched', edge.fetch_from_ledger === 98790001, edge.fetch_from_ledger);
check('the fetch is capped at the run anchor', edge.fetch_to_ledger === ANCHOR);
check('the fetch is bounded in ledger space', edge.range_bound_proven === true);
check('the window is not complete until that edge is fetched',
      edge.complete_without_fetch === false);

// A server catch-up already proved past this run's anchor: nothing to fetch.
// This is the "second report takes seconds" case.
const ahead = COV.windowServability({
  coverage: Object.assign({}, provenCov, { scan_coverage_through: ANCHOR + 500, evidence_retained_through: ANCHOR + 500 }),
  windowStartMs: WIN_START, windowEndMs: WIN_END, anchorLedger: ANCHOR });
check('coverage past the anchor makes the window FULLY_SERVABLE',
      ahead.reason === COV.REASON.FULLY_SERVABLE, ahead.reason);
check('nothing is fetched in that case',
      ahead.fetch_from_ledger === null && ahead.complete_without_fetch === true);
check('the run still only reads up to ITS anchor', ahead.fetch_to_ledger === ANCHOR);

// A wallet that has never been scanned.
const cold = COV.windowServability({ coverage: null, windowStartMs: WIN_START, windowEndMs: WIN_END, anchorLedger: ANCHOR });
check('an unscanned wallet is NO_COVERAGE', cold.reason === COV.REASON.NO_COVERAGE);
check('nothing is served for it', cold.served_from_index === false);
check('it cannot be bounded in ledger space, so it falls back to a date walk',
      cold.fetch_from_ledger === null && cold.range_bound_proven === false);

// THE SHAPE A DATABASE ACTUALLY RETURNS. A never-scanned wallet is a row of
// NULL columns, not a missing row and not a row of undefined fields — and
// every "no coverage" fixture above uses one of those two instead, so none of
// them exercises this path.
//
// It matters because `Number(null)` is 0. With a naive coercion every unset
// column became ledger 0, hasProof() answered TRUE, proven_start compared
// `0 <= windowStart` and answered TRUE, and this returned EDGE_ONLY with
// served_from_index true and proven_start true for a wallet nothing had ever
// been read for. A coverage claim with no proof behind it, on the surface that
// gets read aloud.
const PG_NULL_ROW = {
  address: 'rNeverScanned',
  scan_coverage_from: null, scan_coverage_through: null,
  scan_coverage_from_close_ms: null, scan_coverage_through_close_ms: null,
  evidence_retained_from: null, evidence_retained_through: null,
  evidence_retained_from_close_ms: null, last_observed_tx_ledger: null
};
const nullRow = COV.normalizeCoverage(PG_NULL_ROW);
check('a NULL ledger column normalizes to null, never to ledger 0',
      nullRow.scan_coverage_through === null && nullRow.scan_coverage_from === null,
      nullRow);
check('a row of NULLs has no proof', COV.hasProof(nullRow) === false);
const coldPg = COV.windowServability({ coverage: PG_NULL_ROW, windowStartMs: WIN_START, windowEndMs: WIN_END, anchorLedger: ANCHOR });
check('a row of NULLs is NO_COVERAGE, not EDGE_ONLY',
      coldPg.reason === COV.REASON.NO_COVERAGE, coldPg.reason);
check('and claims nothing: not served, not proven at the start',
      coldPg.served_from_index === false && coldPg.proven_start === false &&
      coldPg.range_bound_proven === false, coldPg);
check('an empty-string column is also not ledger 0',
      COV.normalizeCoverage({ scan_coverage_through: '' }).scan_coverage_through === null);
check('a boolean is not a ledger index',
      COV.normalizeCoverage({ scan_coverage_through: true }).scan_coverage_through === null);
// A numeric string IS a real value — Postgres returns BIGINT as a string in
// several drivers, so rejecting those would break every real read.
check('a numeric string is still accepted — drivers return BIGINT as text',
      COV.normalizeCoverage({ scan_coverage_through: '98790000' }).scan_coverage_through === 98790000);

// The window reaches back before anything was proven.
const frontGap = COV.windowServability({
  coverage: Object.assign({}, provenCov, { scan_coverage_from_close_ms: T('2026-09-02T12:00:00Z') }),
  windowStartMs: WIN_START, windowEndMs: WIN_END, anchorLedger: ANCHOR });
check('a window starting before proven history is PROOF_GAP_AT_START',
      frontGap.reason === COV.REASON.PROOF_GAP_AT_START, frontGap.reason);
check('it is not served from the index', frontGap.served_from_index === false);
check('proven_start is reported as false', frontGap.proven_start === false);

// Proven, but the rows were pruned. THE trap: a naive query returns zero rows
// and reads as "nothing happened in the window".
const pruned = COV.windowServability({
  coverage: Object.assign({}, provenCov, {
    evidence_retained_from: 98500000,
    evidence_retained_from_close_ms: T('2026-09-02T18:00:00Z') }),
  windowStartMs: WIN_START, windowEndMs: WIN_END, anchorLedger: ANCHOR });
check('proven-but-pruned is EVIDENCE_PRUNED, not an empty result',
      pruned.reason === COV.REASON.EVIDENCE_PRUNED, pruned.reason);
check('the proof is still acknowledged', pruned.proven_start === true);
check('but the evidence is reported as not covering the start',
      pruned.evidence_covers_start === false);
check('and nothing is served from the index', pruned.served_from_index === false);

// THE CASE THE FIRST VERSION OF THIS SUITE HID. The fixture above prunes to
// 18:00, AFTER the window start, so a correct time test and a buggy ledger
// test both say "pruned" and agree for the wrong reason. Here retention has
// pruned to Aug 15 — well BEFORE a window starting Sep 2 — so the evidence
// genuinely covers the window while `evidence_retained_from` has still moved
// above `scan_coverage_from`.
//
// The original code also required `evidence_retained_from <=
// scan_coverage_from`, which contradicts the schema's own CHECK
// (`evidence_retained_from >= scan_coverage_from`). Only equality satisfied
// both, so the day retention first pruned ANYTHING, every window fell back to
// a full XRPL walk and the index stopped helping — the exact cost it exists to
// remove, and invisible because the report would still have been correct.
const prunedOldOnly = COV.windowServability({
  coverage: Object.assign({}, provenCov, {
    evidence_retained_from: 98500000,
    evidence_retained_from_close_ms: T('2026-08-15T00:00:00Z') }),
  windowStartMs: WIN_START, windowEndMs: WIN_END, anchorLedger: ANCHOR });
check('pruning OLDER than the window still serves the window',
      prunedOldOnly.reason === COV.REASON.EDGE_ONLY, prunedOldOnly.reason);
check('and the evidence is reported as covering the start',
      prunedOldOnly.evidence_covers_start === true);
check('and only the edge is still fetched',
      prunedOldOnly.fetch_from_ledger === 98790001);

// A hole between the retained evidence and the proof edge. Time-based
// retention prunes the old end, so this should not arise — but if it ever
// does, rows are missing from the middle of a range we call proven, and
// serving it would under-report.
const holed = COV.windowServability({
  coverage: Object.assign({}, provenCov, { evidence_retained_through: 98700000 }),
  windowStartMs: WIN_START, windowEndMs: WIN_END, anchorLedger: ANCHOR });
check('a hole below the proof edge is refused, not served',
      holed.reason === COV.REASON.EVIDENCE_PRUNED &&
      holed.evidence_covers_proof_edge === false, holed.reason);

// An anchor is not optional: without one, a concurrent catch-up advancing the
// shared index mid-run would let wallet 3 and wallet 200 describe different
// ledger states inside one Report.
check('a missing anchor is refused',
      /anchorLedger/.test(threw(() => COV.windowServability({ coverage: provenCov, windowStartMs: WIN_START, windowEndMs: WIN_END })) || ''));
check('an inverted window is refused',
      /window/i.test(threw(() => COV.windowServability({ coverage: provenCov, windowStartMs: WIN_END, windowEndMs: WIN_START, anchorLedger: ANCHOR })) || ''));

// ════════════════════════════════════════════════════════════════════════════
console.log('\n5. when coverage may advance — and when it may not');
// Refusing to advance costs one wallet one extra scan tomorrow. Advancing
// wrongly puts an unearned coverage claim on air. That asymmetry decides every
// rule here.
const base = { coverage: provenCov, anchorLedger: ANCHOR };
const okProof = { status: 'COMPLETE', from_ledger: 98790001, through_ledger: ANCHOR,
                  range_bound_proven: true, rows_stored: 14,
                  from_close_ms: T('2026-09-02T23:00:01Z'), through_close_ms: T('2026-09-03T00:00:00Z') };

const adv = COV.checkpointAdvance(Object.assign({}, base, { proof: okProof }));
check('a fully proven range advances the checkpoint', adv.advance === true, adv);
check('it advances to exactly what was proven', adv.next_through === ANCHOR);
check('it carries the compare-and-set predicate', adv.expected_prior === 98790000);
check('the original coverage start is preserved', adv.next_from === 98000000);

// An exhausted empty range is a PROOF. This is what makes quiet wallets cheap
// without weakening the claim — and the difference from skipping a wallet on
// an unchanged XRP balance, which proves nothing at all.
const empty = COV.checkpointAdvance(Object.assign({}, base, {
  proof: Object.assign({}, okProof, { rows_stored: 0 }) }));
check('an exhausted EMPTY range still advances coverage', empty.advance === true);
check('and says so, rather than looking like a range never walked',
      empty.reason === 'EMPTY_RANGE_EXHAUSTED', empty.reason);

// A safety ceiling is not a proof. TX_SAFETY_MAX_PAGES stopping the walk
// (17-report-scan-tuning-20260816.js:21) yields TRUNCATED.
const trunc = COV.checkpointAdvance(Object.assign({}, base, {
  proof: Object.assign({}, okProof, { status: 'TRUNCATED' }) }));
check('TRUNCATED never advances', trunc.advance === false && trunc.reason === 'PROOF_NOT_COMPLETE');
const failedAdv = COV.checkpointAdvance(Object.assign({}, base, {
  proof: Object.assign({}, okProof, { status: 'FAILED' }) }));
check('FAILED never advances', failedAdv.advance === false);
check('a refusal leaves the checkpoint exactly where it was',
      failedAdv.next_through === 98790000);

// A date-bounded fallback walk (the retention retry with ledger_index_min: -1)
// still yields usable evidence, but it cannot prove a ledger RANGE.
const dateBound = COV.checkpointAdvance(Object.assign({}, base, {
  proof: Object.assign({}, okProof, { range_bound_proven: false }) }));
check('a date-bounded fallback walk never advances a ledger checkpoint',
      dateBound.advance === false && dateBound.reason === 'RANGE_NOT_LEDGER_BOUND', dateBound.reason);

// A gap between the checkpoint and the proven range would claim coverage of
// ledgers this run never read.
const gap = COV.checkpointAdvance(Object.assign({}, base, {
  proof: Object.assign({}, okProof, { from_ledger: 98795000 }) }));
check('a non-contiguous range never advances',
      gap.advance === false && gap.reason === 'PROOF_RANGE_NOT_CONTIGUOUS', gap.reason);
check('a range starting exactly at the boundary IS contiguous',
      COV.checkpointAdvance(Object.assign({}, base, {
        proof: Object.assign({}, okProof, { from_ledger: 98790001 }) })).advance === true);
check('a range starting BEFORE the checkpoint is allowed (an overlap re-reads, it does not skip)',
      COV.checkpointAdvance(Object.assign({}, base, {
        proof: Object.assign({}, okProof, { from_ledger: 98700000 }) })).advance === true);

// A checkpoint past the anchor would let tomorrow's run skip unread ledgers.
const past = COV.checkpointAdvance(Object.assign({}, base, {
  proof: Object.assign({}, okProof, { through_ledger: ANCHOR + 1 }) }));
check('a proof reaching past the run anchor never advances',
      past.advance === false && past.reason === 'PROOF_EXCEEDS_ANCHOR', past.reason);

// A slower worker must not drag a shared checkpoint backwards.
const back = COV.checkpointAdvance(Object.assign({}, base, {
  proof: Object.assign({}, okProof, { from_ledger: 98700000, through_ledger: 98780000 }) }));
check('a proof behind the current checkpoint never advances',
      back.advance === false && back.reason === 'NO_FORWARD_PROGRESS', back.reason);
check('a proof exactly AT the current checkpoint is no progress either',
      COV.checkpointAdvance(Object.assign({}, base, {
        proof: Object.assign({}, okProof, { through_ledger: 98790000 }) })).advance === false);

// A first-ever wallet has no prior value, so the SQL predicate must compare
// with IS NULL rather than `= NULL`, which matches nothing in Postgres.
const first = COV.checkpointAdvance({ coverage: null, anchorLedger: ANCHOR,
  proof: Object.assign({}, okProof, { from_ledger: 98700000 }) });
check('a first-ever wallet advances', first.advance === true);
check('its compare-and-set predicate is NULL, not 0', first.expected_prior === null, first.expected_prior);
check('its coverage start comes from the proven range', first.next_from === 98700000);

// A malformed proof is refused rather than interpreted generously.
check('a malformed range is refused',
      COV.checkpointAdvance(Object.assign({}, base, {
        proof: Object.assign({}, okProof, { through_ledger: null }) })).reason === 'PROOF_RANGE_MALFORMED');
check('checkpointAdvance also requires an anchor',
      /anchorLedger/.test(threw(() => COV.checkpointAdvance({ coverage: provenCov, proof: okProof })) || ''));

// A checkpoint with no close times is one no window can ever be decided
// against: windowServability compares the window start against
// scan_coverage_from_close_ms, so a null there makes proven_start permanently
// false. Writing it would log an advance in coverage_advances that reads as
// progress while the wallet silently falls back to a full walk forever.
const noClose = COV.checkpointAdvance({ coverage: null, anchorLedger: ANCHOR,
  proof: { status: 'COMPLETE', from_ledger: 98700000, through_ledger: ANCHOR,
           range_bound_proven: true, rows_stored: 3 } });
check('a proof with no close times never advances',
      noClose.advance === false && noClose.reason === 'PROOF_MISSING_CLOSE_TIMES',
      noClose.reason);
check('a missing THROUGH close time alone is enough to refuse',
      COV.checkpointAdvance(Object.assign({}, base, {
        proof: Object.assign({}, okProof, { through_close_ms: null }) })).reason
        === 'PROOF_MISSING_CLOSE_TIMES');
// The round trip that matters: an advance must produce a checkpoint that the
// NEXT run can actually serve a window from. Asserting the fields exist is not
// the same as asserting they work, so feed the advance straight back in.
const roundTrip = COV.windowServability({
  coverage: {
    address: 'rRound',
    scan_coverage_from: adv.next_from, scan_coverage_through: adv.next_through,
    scan_coverage_from_close_ms: adv.next_from_close_ms,
    scan_coverage_through_close_ms: adv.next_through_close_ms,
    evidence_retained_from: adv.next_from, evidence_retained_through: adv.next_through,
    evidence_retained_from_close_ms: adv.next_from_close_ms
  },
  windowStartMs: WIN_START, windowEndMs: WIN_END, anchorLedger: ANCHOR });
check('a checkpoint an advance produced is servable by the next run',
      roundTrip.served_from_index === true &&
      roundTrip.reason === COV.REASON.FULLY_SERVABLE, roundTrip.reason);

// ── the seal gate ─────────────────────────────────────────────────────────
// coverageFrom (17-report-scan-tuning-20260816.js:199) computes the rendered
// claim from target/complete/failed/truncated. A run served from the index may
// not claim more than a run served from XRPL.
const W = (status, coversStart) => ({ status, covers_window_start: coversStart });
const allGood = COV.sealable([W('COMPLETE', true), W('COMPLETE', true), W('COMPLETE', true)]);
check('three fully proven wallets seal as complete', allGood.full_window_complete === true);
check('the denominator is the whole target', allGood.target_wallets === 3 && allGood.complete_wallets === 3);

// The tautology this guards: with a numeric lower bound the `oldest <= startMs`
// break can never fire, so a wallet would report COMPLETE for a run that read
// one hour of twenty-four.
const shortWindow = COV.sealable([W('COMPLETE', true), W('COMPLETE', false)]);
check('a wallet that answered without proving the window start does not count as complete',
      shortWindow.full_window_complete === false && shortWindow.unproven_start_wallets === 1,
      shortWindow);
check('and it is not silently counted as complete either',
      shortWindow.complete_wallets === 1, shortWindow.complete_wallets);
check('one truncated wallet blocks the seal',
      COV.sealable([W('COMPLETE', true), W('TRUNCATED', true)]).full_window_complete === false);
check('one failed wallet blocks the seal',
      COV.sealable([W('COMPLETE', true), W('FAILED', false)]).full_window_complete === false);
check('a failed wallet stays in the DENOMINATOR — dropping it would flatter the claim',
      COV.sealable([W('COMPLETE', true), W('FAILED', false)]).target_wallets === 2);
check('zero wallets is never "complete"',
      COV.sealable([]).full_window_complete === false);

// FAIL CLOSED on a status nobody recognises. The first version tested only for
// FAILED and TRUNCATED and let everything else fall through to be counted
// complete — so 'RUNNING', a typo, or a future fourth state would have been
// certified as proven and read on air. "Never claim what was not proven this
// run" has to survive an unrecognised input, not only the three we thought of.
const weird = COV.sealable([W('COMPLETE', true), W('RUNNING', true)]);
check('an unrecognised proof status is never counted as complete',
      weird.complete_wallets === 1 && weird.unknown_status_wallets === 1, weird);
check('and it blocks the seal', weird.full_window_complete === false);
check('a missing status is treated as FAILED, not as complete',
      COV.sealable([{ covers_window_start: true }]).failed_wallets === 1);
check('an empty-string status blocks the seal',
      COV.sealable([W('', true)]).full_window_complete === false);
check('lowercase "complete" is not COMPLETE',
      COV.sealable([W('complete', true)]).full_window_complete === false);

// A partial run keeps what it proved. Making it pay for that work again
// tomorrow is the exact behaviour this project exists to remove.
const partialRun = [];
for (let i = 0; i < 119; i++) partialRun.push(W('COMPLETE', true));
partialRun.push(W('FAILED', false));
for (let i = 0; i < 131; i++) partialRun.push(W('FAILED', false));
const dead = COV.sealable(partialRun);
check('a run that died at wallet 120 of 251 does not seal',
      dead.full_window_complete === false && dead.target_wallets === 251, dead);
check('but the 119 proven wallets are still counted as proven',
      dead.complete_wallets === 119, dead.complete_wallets);

// ════════════════════════════════════════════════════════════════════════════
// health() is the only async surface in the module set, so the last group runs
// inside an async tail rather than dragging in a test framework for two awaits.
async function connectionBoundary() {
console.log('\n6. the connection boundary');
const savedEnv = { a: process.env.SHADOWWATCH_DATABASE_URL, b: process.env.DATABASE_URL, c: process.env.POSTGRES_URL };
delete process.env.SHADOWWATCH_DATABASE_URL; delete process.env.DATABASE_URL; delete process.env.POSTGRES_URL;
CONN.setExecutor(null);
check('with no database configured, isConfigured() is false', CONN.isConfigured() === false);
// An unreachable index and an empty window are DIFFERENT facts. Returning null
// rather than an empty result set is what forces a caller to say so.
check('and getExecutor() returns null rather than an empty result set',
      CONN.getExecutor() === null);
check('the target reads as unconfigured', CONN.redactedTarget() === 'unconfigured');

process.env.DATABASE_URL = 'postgresql://sw_user:SUPERSECRET@ep-cool-db-123.eu-central-1.aws.neon.tech/shadowwatch?sslmode=require';
check('a configured database is detected', CONN.isConfigured() === true);
const target = CONN.redactedTarget();
check('the diagnostic names the host', /neon\.tech/.test(target), target);
check('and never the credential',
      !/SUPERSECRET/.test(target) && !/sw_user/.test(target), target);

let seenSql = null;
CONN.setExecutor(async (sql, params) => { seenSql = { sql, params }; return { rows: [{ ok: 1 }] }; });
const h = await CONN.health();
check('an injected executor is used', h.reachable === true && seenSql !== null);
check('health() reports the driver as injected', h.driver_present === 'injected');
check('health() still never leaks the credential',
      !JSON.stringify(h).includes('SUPERSECRET'), h.target);

CONN.setExecutor(async () => { throw new Error('connect ECONNREFUSED'); });
const bad = await CONN.health();
check('an unreachable database reports reachable=false, not an empty success',
      bad.reachable === false && /ECONNREFUSED/.test(bad.error || ''), bad);

// No signing material, ever. XRPL access is read-only.
check('a row carrying a seed is refused',
      /key material/.test(threw(() => CONN.assertNoSecretMaterial({ hash: 'X', seed: 'sn123' })) || ''));
check('a row carrying a private key is refused',
      /key material/.test(threw(() => CONN.assertNoSecretMaterial({ private_key: 'x' })) || ''));
check('a row carrying a signed blob is refused',
      /key material/.test(threw(() => CONN.assertNoSecretMaterial({ tx_blob: 'x' })) || ''));
check('an ordinary evidence row passes', CONN.assertNoSecretMaterial(partial) === partial);

// Nothing in the database layer may sign, submit, or mutate the ledger.
const dbSources = ['src/db/connection.js', 'src/db/transactions.js', 'src/db/coverage.js']
  .map(f => ({ f, src: fs.readFileSync(path.join(ROOT, f), 'utf8') }));
const mutators = dbSources.filter(x =>
  /\b(submit|sign|signAndSubmit|wallet\.sign|autofill|Wallet\.fromSeed)\s*\(/.test(x.src));
check('no database module calls a signing or submit path', mutators.length === 0, mutators.map(x => x.f));

CONN.setExecutor(null);
if (savedEnv.a === undefined) delete process.env.SHADOWWATCH_DATABASE_URL; else process.env.SHADOWWATCH_DATABASE_URL = savedEnv.a;
if (savedEnv.b === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedEnv.b;
if (savedEnv.c === undefined) delete process.env.POSTGRES_URL; else process.env.POSTGRES_URL = savedEnv.c;
}

connectionBoundary().then(() => {
  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
  process.exit(fail ? 1 : 0);
}, (e) => {
  // A throw here is a suite failure, not a pass with fewer checks. "0 tests
  // found, all passed" is the failure mode this whole exercise exists to stop.
  console.log('\n  FAIL  connection boundary threw  -> ' + (e && e.message));
  console.log('\n' + (fail + 1) + ' FAILED of ' + (pass + fail + 1));
  process.exit(1);
});

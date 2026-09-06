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
// name -> normalized declaration (type + NOT NULL + DEFAULT), whitespace
// collapsed. Comparing these is what makes a type change visible.
function columnDefsOf(body) {
  const out = {};
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') { depth++; cur += ch; continue; }
    if (ch === ')') { depth--; cur += ch; continue; }
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  for (const raw of parts) {
    const t = raw.trim();
    if (!t) continue;
    if (/^(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|EXCLUDE)\b/i.test(t)) continue;
    const m = t.match(/^"?(\w+)"?\s+([\s\S]+)$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/\s+/g, ' ').trim().toUpperCase();
  }
  return out;
}

// name -> the CHECK expression that follows it, whitespace collapsed.
function constraintExprs(sql) {
  const out = {};
  const src = stripComments(sql);
  const re = /CONSTRAINT\s+(\w+)\s+CHECK\s*\(/gi;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1, i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    out[m[1]] = src.slice(re.lastIndex, i - 1).replace(/\s+/g, ' ').trim().toUpperCase();
  }
  return out;
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

// Names alone are not parity. Comparing only names let `amount_drops FLOAT8`
// sit in the migration while the reference said NUMERIC(21,0) — the two files
// disagreeing about the most safety-critical type in the schema, with the
// drift check green. Compare the DECLARED DEFINITION: type, NOT NULL, DEFAULT.
let typeDrift = [];
for (const t of Object.keys(schemaTables)) {
  if (!migrationTables[t]) continue;
  const a = columnDefsOf(schemaTables[t]);
  const b = columnDefsOf(migrationTables[t]);
  for (const col of Object.keys(a)) {
    if (b[col] !== undefined && a[col] !== b[col]) {
      typeDrift.push({ table: t, column: col, schema: a[col], migration: b[col] });
    }
  }
}
check('every column has the same TYPE and nullability in both',
      typeDrift.length === 0, typeDrift);

// Same hole one level down: constraint parity compared NAMES, so two files
// could declare scan_runs_window_within_anchor with opposite operators and the
// suite called them identical.
const schemaCons = constraintExprs(SCHEMA_SQL), migCons = constraintExprs(MIGRATION_SQL);
let consDrift = [];
for (const name of Object.keys(schemaCons)) {
  if (migCons[name] !== undefined && schemaCons[name] !== migCons[name]) {
    consDrift.push({ constraint: name, schema: schemaCons[name], migration: migCons[name] });
  }
}
check('every named constraint has the same EXPRESSION in both',
      consDrift.length === 0, consDrift);

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
// The literal-only form matched neither `CREATE UNIQUE INDEX` (text between
// CREATE and INDEX defeats the lookahead) nor VIEW / SEQUENCE / TYPE, so an
// unguarded unique index would abort the whole transaction on re-run while
// this check stayed green — against a file whose header promises "safe to
// re-run". CREATE OR REPLACE FUNCTION and the DROP TRIGGER IF EXISTS + CREATE
// TRIGGER pair are idempotent by their own construction and are exempted.
check('the migration is idempotent — every create is guarded',
      !/CREATE\s+(?:UNIQUE\s+|MATERIALIZED\s+)?(TABLE|INDEX|VIEW|SEQUENCE|TYPE)\b(?!\s+IF NOT EXISTS)/i
        .test(stripComments(MIGRATION_SQL)));

// ── ledger_index is the prerequisite, not a nice-to-have ──────────────────
// state.txs rows (02-core.js:1218-1229) carry no ledger index at all. Without
// one no ledger range can be proven or served, and a row admitted without one
// would let coverage claim ledgers nobody read.
check('transactions.ledger_index exists and is NOT NULL',
      /ledger_index\s+BIGINT\s+NOT NULL/i.test(stripComments(migrationTables.transactions || '')));
// This used to match `/may not decrease/` against the RAW migration text, so
// the phrase appearing in an SQL COMMENT satisfied it — the guard could be
// deleted entirely, replaced by a comment saying it lives in the application,
// and the check stayed green. Assert the comparison EXPRESSION inside the
// function body, on comment-stripped text.
const _fnBody = (stripComments(MIGRATION_SQL)
  .split(/CREATE OR REPLACE FUNCTION wallet_coverage_monotonic\(\)/i)[1] || '')
  .split(/\$\$\s*LANGUAGE/i)[0] || '';
check('the monotonic guard is a real expression, not a comment about one',
      /NEW\.scan_coverage_through\s*<\s*OLD\.scan_coverage_through\s+THEN/i.test(_fnBody) &&
      /RAISE\s+EXCEPTION/i.test(_fnBody), _fnBody.slice(0, 120));
check('a checkpoint can never be moved backwards by an UPDATE',
      /BEFORE UPDATE ON wallet_coverage/i.test(stripComments(MIGRATION_SQL)));
// A text match can never prove plpgsql semantics. Saying so here rather than
// letting the check's name overclaim.
check('the clearing guard is also a real expression',
      /NEW\.scan_coverage_through\s+IS\s+NULL\s+THEN/i.test(_fnBody));
// The complete payload is the forensic source of truth, so it may not be
// optional. A nullable raw column is an allowlist with extra steps.
check('raw_tx and raw_meta are NOT NULL',
      /raw_tx\s+JSONB\s+NOT NULL/i.test(stripComments(migrationTables.transactions || '')) &&
      /raw_meta\s+JSONB\s+NOT NULL/i.test(stripComments(migrationTables.transactions || '')));
// Half an anchor is not an anchor: a ledger index with no close time cannot be
// compared against a report window at all.
check('scan_runs.anchor_close_time is NOT NULL',
      /anchor_close_time\s+TIMESTAMPTZ\s+NOT NULL/i.test(stripComments(migrationTables.scan_runs || '')));
// Without this a run can claim a window whose final seconds fall after its own
// anchor closed — asserting a period no ledger it read was inside.
// The unanchored form matched any CHECK merely BEGINNING with that comparison,
// so `window_end <= anchor_close_time + INTERVAL '1 day'` — a plausible "clock
// skew" edit letting a Report claim a full day its anchor never covered — kept
// it green. Assert the whole expression, scoped to the scan_runs body.
check('a run cannot claim time past its own anchor',
      /CONSTRAINT\s+scan_runs_window_within_anchor\s+CHECK\s*\(\s*window_end\s*<=\s*anchor_close_time\s*\)/i
        .test(stripComments(migrationTables.scan_runs || '')));
check('proof and retained evidence are separate columns',
      /scan_coverage_through/i.test(MIGRATION_SQL) && /evidence_retained_through/i.test(MIGRATION_SQL));
// Two holes in one line, both verified: `/amount_drops\s+NUMERIC/` matched the
// SUBSTRING inside `escrow_amount_drops NUMERIC(21,0)`, so amount_drops itself
// could be FLOAT8 and pass; and `\bFLOAT\b` never matches FLOAT8 because 8 is
// a word character. The single most safety-critical type in the schema could
// become an actual double with this green.
const _txBody = stripComments(migrationTables.transactions || '');
check('amounts are NUMERIC, never floating point',
      /(^|,|\s)amount_drops\s+NUMERIC\(21,0\)/im.test(_txBody) &&
      /(^|,|\s)escrow_amount_drops\s+NUMERIC\(21,0\)/im.test(_txBody) &&
      /(^|,|\s)fee_drops\s+NUMERIC\(21,0\)/im.test(_txBody) &&
      /(^|,|\s)amount_value\s+NUMERIC/im.test(_txBody) &&
      !/\b(REAL|DOUBLE\s+PRECISION|FLOAT\d*)\b/i.test(stripComments(MIGRATION_SQL)));
// XRPL access is read-only and no signing material exists in this project.
const secretish = Object.keys(migrationTables)
  .flatMap(t => columnsOf(migrationTables[t]))
  .filter(c => CONN.SECRET_KEYS.test(c));
check('no column could hold key material', secretish.length === 0, secretish);
// The name claimed a general property; the body forbade two spellings. The
// statements that actually destroy forensic rows in a migration are DELETE FROM
// and DROP COLUMN, and neither was mentioned — a "retention" DELETE would run on
// every re-application of an intentionally re-runnable migration. Retention
// belongs in application code, in the same transaction that narrows
// evidence_retained_*, never in a migration.
const _m = stripComments(MIGRATION_SQL);
check('no migration destroys evidence',
      !/\bDROP\s+TABLE\b/i.test(_m) && !/\bTRUNCATE\b/i.test(_m) &&
      !/\bDELETE\s+FROM\b/i.test(_m) && !/\bDROP\s+COLUMN\b/i.test(_m) &&
      !/\bALTER\s+TABLE\b[\s\S]{0,200}?\bDROP\b/i.test(_m));

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
      fin.raw_tx.Owner === 'rRippleOwner' && fin.raw_tx.OfferSequence === 42);
check('the crypto-condition fulfillment is preserved', fin.raw_tx.Fulfillment === 'A0');

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
check('its condition is preserved', cre.raw_tx.Condition === 'BEEF');

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
      !!msig.raw_tx.SendMax && !!msig.raw_tx.Memos);

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

// ── the evidence of record: the COMPLETE payload, not an allowlist ────────
// _evidence() used to copy out about eleven named fields while the header
// claimed "nothing the response carried is discarded". An allowlist discards
// by definition, and the only way to recover a field nobody listed would be
// re-walking the history this index exists to stop re-walking.
// These compared the stored payload against the SAME OBJECT it was taken from
// — rowFromAccountTx assigns raw_tx by reference, so the assertion reduced to
// JSON.stringify(x) === JSON.stringify(x), a tautology. An in-place redaction
// moved both sides together and stayed green while destroying SigningPubKey,
// TxnSignature and Paths permanently. Compare against a PRE-INGEST snapshot so
// the two sides cannot move together.
const PARTIAL_BEFORE = JSON.parse(JSON.stringify(PARTIAL));
check('the complete transaction payload is stored verbatim',
      JSON.stringify(partial.raw_tx) === JSON.stringify(PARTIAL_BEFORE.tx_json));
check('the complete metadata is stored verbatim',
      JSON.stringify(partial.raw_meta) === JSON.stringify(PARTIAL_BEFORE.meta));
// A key-set assertion catches ANY dropped field, not the handful someone
// thought to name — which is the whole difference between an allowlist and a
// complete payload.
check('raw_tx keeps every key the response carried',
      JSON.stringify(Object.keys(partial.raw_tx).sort()) ===
      JSON.stringify(Object.keys(PARTIAL_BEFORE.tx_json).sort()),
      Object.keys(partial.raw_tx).sort());
check('raw_meta keeps every key the response carried',
      JSON.stringify(Object.keys(partial.raw_meta).sort()) ===
      JSON.stringify(Object.keys(PARTIAL_BEFORE.meta).sort()));

// The real test of "non-lossy": a field that NO normalized column and NO
// derived evidence key carries must still be recoverable.
const EXOTIC = {
  ledger_index: 98765500,
  tx_json: { TransactionType: 'AMMDeposit', hash: 'H_EXOTIC', Account: 'rLP',
             date: 800001000,
             // None of these exist as a column or an evidence key. A classifier
             // written next month may need every one of them.
             Asset: { currency: 'XRP' },
             Asset2: { currency: 'TST', issuer: 'rIss' },
             TradingFee: 42,
             NetworkID: 1,
             TicketSequence: 77,
             SomeFutureAmendmentField: { nested: ['a', 'b'] } },
  meta: { TransactionResult: 'tesSUCCESS',
          AffectedNodes: [{ ModifiedNode: { LedgerEntryType: 'AMM',
            FinalFields: { TradingFee: 42, VoteSlots: [{ VoteEntry: { Account: 'rV' } }] } } }] }
};
const EXOTIC_BEFORE = JSON.parse(JSON.stringify(EXOTIC));
const exotic = TX.rowFromAccountTx(EXOTIC, { observedVia: 'rLP' });
const exoticCols = Object.keys(exotic).filter(k => k !== 'raw_tx' && k !== 'raw_meta');
const flatNoRaw = JSON.stringify(exoticCols.map(k => exotic[k]));
check('the exotic fields are genuinely absent from every column and from evidence',
      !/TradingFee|TicketSequence|SomeFutureAmendmentField|VoteSlots/.test(flatNoRaw));
// "every one of them" asserted four of the six planted fields; Asset and
// NetworkID were named nowhere in the suite, so a denylist dropping exactly
// those stayed green. Compare the WHOLE payload against a pre-ingest clone.
check('but every one of them is recoverable from raw_tx',
      JSON.stringify(exotic.raw_tx) === JSON.stringify(EXOTIC_BEFORE.tx_json) &&
      exotic.raw_tx.TradingFee === 42 && exotic.raw_tx.NetworkID === 1 &&
      !!exotic.raw_tx.Asset && exotic.raw_tx.TicketSequence === 77 &&
      exotic.raw_tx.SomeFutureAmendmentField.nested[1] === 'b');
check('and raw_meta survives whole too',
      JSON.stringify(exotic.raw_meta) === JSON.stringify(EXOTIC_BEFORE.meta));
check('and the untouched ledger nodes are recoverable from raw_meta',
      exotic.raw_meta.AffectedNodes[0].ModifiedNode.FinalFields.VoteSlots[0].VoteEntry.Account === 'rV');
check('an unrecognised transaction type is still stored, not dropped',
      exotic.hash === 'H_EXOTIC' && exotic.tx_type === 'AMMDeposit');
// The passthrough copies are gone — raw carries them, so duplicating them in
// `evidence` would store the same bytes twice.
check('evidence no longer duplicates what raw_tx already holds',
      !('SendMax' in msig.evidence) && !('Memos' in msig.evidence) &&
      !('Signers' in msig.evidence) && !('Owner' in fin.evidence),
      Object.keys(msig.evidence));
check('and those fields are still there, in raw_tx',
      !!msig.raw_tx.SendMax && !!msig.raw_tx.Memos && msig.raw_tx.Signers.length === 3 &&
      fin.raw_tx.Owner === 'rRippleOwner' && fin.raw_tx.OfferSequence === 42);
check('evidence keeps only DERIVED conclusions',
      partial.evidence.delivered_amount_used === true &&
      partial.evidence.raw_amount_overridden === '100000000000000000' &&
      Array.isArray(partial.evidence.balance_deltas));

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
// DEDUPLICATE TRANSACTIONS. DO NOT DEDUPLICATE EVIDENCE ROLES.
// Collapsing the sightings by keeping the first row and dropping the rest
// would destroy the second wallet's provenance — the exact structural loss
// transaction_accounts exists to fix, reintroduced one layer higher.
const merged = TX.mergeSightings([seenByA, seenByB]);
check('the two sightings collapse to ONE transaction', merged.length === 1, merged.length);
check('and the merge records that it saw two', merged[0].sightings === 2);
check('BOTH observers survive the merge — no role is deduplicated',
      merged[0].observed_via.length === 2 &&
      merged[0].observed_via.indexOf('rWatchedA') >= 0 &&
      merged[0].observed_via.indexOf('rWatchedB') >= 0, merged[0].observed_via);
const mp = TX.participantsOf(merged[0]);
const observers = mp.filter(p => p.role === 'observed_via').map(p => p.address).sort();
check('the merged row yields a provenance row per observer',
      JSON.stringify(observers) === JSON.stringify(['rWatchedA', 'rWatchedB']), observers);
check('merging is order-independent',
      JSON.stringify(TX.mergeSightings([seenByB, seenByA])[0].observed_via.slice().sort()) ===
      JSON.stringify(['rWatchedA', 'rWatchedB']));

// Totals go through BigInt, never Number. Asserting "counted once" via a float
// sum would verify the right fact through the exact path that must never touch
// drops — and it would keep passing right up until an amount got large enough
// to matter.
check('the amount is counted once, not twice',
      TX.sumDrops(merged.map(r => r.amount_drops)) === '900000000000',
      TX.sumDrops(merged.map(r => r.amount_drops)));
check('un-merged sightings would have DOUBLED it — the bug this prevents',
      TX.sumDrops([seenByA, seenByB].map(r => r.amount_drops)) === '1800000000000');

// The magnitude where a float total stops being evidence.
const HUGE = ['90000000000000000', '10000000000000001'];   // sums to 1.0000...01e17
check('a total beyond MAX_SAFE_INTEGER is exact',
      TX.sumDrops(HUGE) === '100000000000000001', TX.sumDrops(HUGE));
check('the float path would have got that wrong',
      String(HUGE.reduce((a, v) => a + Number(v), 0)) !== '100000000000000001');
check('sumDrops ignores absent and malformed values rather than coercing them',
      TX.sumDrops([null, undefined, '', 'abc', '12.5', '5']) === '5');

// Lexicographic ordering of drop strings puts "9" above "100".
check('dropsCompare orders by magnitude, not lexicographically',
      TX.dropsCompare('9', '100') === -1 && TX.dropsCompare('100', '9') === 1);
check('and is exact beyond MAX_SAFE_INTEGER',
      TX.dropsCompare('100000000000000001', '100000000000000000') === 1);
check('a naive string sort would have disagreed', '9' > '100');
check('equal values compare equal', TX.dropsCompare('42', '42') === 0);
check('an absent amount sorts below every real one',
      TX.dropsCompare(null, '0') === -1);

// A later sighting may carry escrow facts the wallet walk could not read —
// escrowBackfill reads ledger nodes Phase 2 never touched. Gaps fill; values
// already established are never overwritten.
const thin = TX.rowFromAccountTx({
  ledger_index: 98765440,
  tx_json: { TransactionType: 'EscrowFinish', hash: 'H_LATE', Account: 'rBot', date: 800000800 },
  meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [] }
}, { observedVia: 'rWalk' });
const rich = TX.rowFromAccountTx({
  ledger_index: 98765440,
  tx_json: { TransactionType: 'EscrowFinish', hash: 'H_LATE', Account: 'rBot', date: 800000800 },
  meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [{ DeletedNode: {
    LedgerEntryType: 'Escrow',
    FinalFields: { Account: 'rRealOwner', Destination: 'rRealDest', Amount: '7000000' } } }] }
}, { observedVia: 'rBackfill' });
check('the thin sighting genuinely has no owner (the gap being filled is real)',
      thin.escrow_owner === null);
const filled = TX.mergeSightings([thin, rich])[0];
check('a later sighting fills a gap the first could not read',
      filled.escrow_owner === 'rRealOwner' && filled.escrow_amount_drops === '7000000');
check('multi-object evidence is preserved, not deduplicated away',
      TX.participantsOf(filled).some(p => p.address === 'rRealDest' && p.role === 'escrow_dest'));
// This needs a second sighting carrying a DIFFERENT non-null owner. Asserting
// it against `thin` (whose owner is null) proves nothing: the null guard would
// block the overwrite even if the precedence rule were deleted. A sabotage
// caught exactly that — the fixture made the code correct by construction.
const rival = TX.rowFromAccountTx({
  ledger_index: 98765440,
  tx_json: { TransactionType: 'EscrowFinish', hash: 'H_LATE', Account: 'rBot', date: 800000800 },
  meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [{ DeletedNode: {
    LedgerEntryType: 'Escrow',
    FinalFields: { Account: 'rIMPOSTOR', Destination: 'rOtherDest', Amount: '9999999' } } }] }
}, { observedVia: 'rThird' });
check('the rival sighting really does carry a different owner (the fixture bites)',
      rival.escrow_owner === 'rIMPOSTOR' && rich.escrow_owner === 'rRealOwner');
const contested = TX.mergeSightings([rich, rival])[0];
check('an established escrow owner is never overwritten by a later sighting',
      contested.escrow_owner === 'rRealOwner', contested.escrow_owner);
// Attributing a release to the wrong owner is the difference between "Ripple
// released this" and naming an unrelated wallet on air. A disagreement here is
// never resolved by picking one.
check('and the disagreement about ownership is RECORDED',
      contested.conflicts.some(c => c.field === 'escrow_owner' &&
                                    c.kept === 'rRealOwner' && c.also_seen === 'rIMPOSTOR'),
      contested.conflicts);
check('the contested amount is recorded too',
      contested.conflicts.some(c => c.field === 'escrow_amount_drops'));
check('a still-null owner is filled rather than treated as a conflict',
      TX.mergeSightings([thin, rich])[0].conflicts.length === 0);

// Two sightings disagreeing on a core fact is a server inconsistency or a
// mapping bug. Recording it beats silently picking one.
const forkA = TX.rowFromAccountTx({ ledger_index: 1, tx_json: { TransactionType: 'Payment',
  hash: 'H_FORK', Account: 'rX', Amount: '100', date: 1 }, meta: { TransactionResult: 'tesSUCCESS' } }, {});
const forkB = TX.rowFromAccountTx({ ledger_index: 1, tx_json: { TransactionType: 'Payment',
  hash: 'H_FORK', Account: 'rX', Amount: '999', date: 1 }, meta: { TransactionResult: 'tesSUCCESS' } }, {});
const forked = TX.mergeSightings([forkA, forkB])[0];
check('conflicting sightings are recorded, not silently resolved',
      forked.conflicts.length === 1 && forked.conflicts[0].field === 'amount_drops',
      forked.conflicts);
check('agreeing sightings record no conflict', merged[0].conflicts.length === 0);

check('a row with no hash is never counted',
      TX.mergeSightings([{ hash: '' }, { hash: null }, seenByA]).length === 1);
check('three distinct transactions stay three',
      TX.mergeSightings([partial, failedRow, fin]).length === 3);
// dedupeByHash still exists for callers that want only a hash set. It DISCARDS
// sightings, so it is asserted to be the lossy one — a future reader reaching
// for it should see the difference stated.
check('dedupeByHash is the lossy variant and is documented as such',
      TX.dedupeByHash([seenByA, seenByB]).length === 1 &&
      TX.dedupeByHash([seenByA, seenByB])[0].observed_via === 'rWatchedA');

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
// An anchor close comfortably after the window end, so fixtures exercising
// coverage logic are not incidentally testing the cap. anchorCloseMs is
// mandatory now, so every call must carry one.
const ANCHOR_CLOSE_OK = T('2026-09-03T02:00:00Z');

const provenCov = {
  address: 'rQuiet',
  scan_coverage_from: 98000000, scan_coverage_through: 98790000,
  scan_coverage_from_close_ms: T('2026-08-01T00:00:00Z'),
  scan_coverage_through_close_ms: T('2026-09-02T23:00:00Z'),
  evidence_retained_from: 98000000, evidence_retained_through: 98790000,
  evidence_retained_from_close_ms: T('2026-08-01T00:00:00Z')
};

const edge = COV.windowServability({ coverage: provenCov, windowStartMs: WIN_START, windowEndMs: WIN_END, anchorLedger: ANCHOR, anchorCloseMs: ANCHOR_CLOSE_OK });
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
  windowStartMs: WIN_START, windowEndMs: WIN_END, anchorLedger: ANCHOR, anchorCloseMs: ANCHOR_CLOSE_OK });
check('coverage past the anchor makes the window FULLY_SERVABLE',
      ahead.reason === COV.REASON.FULLY_SERVABLE, ahead.reason);
check('nothing is fetched in that case',
      ahead.fetch_from_ledger === null && ahead.complete_without_fetch === true);
check('the run still only reads up to ITS anchor', ahead.fetch_to_ledger === ANCHOR);

// A wallet that has never been scanned.
const cold = COV.windowServability({ coverage: null, windowStartMs: WIN_START, windowEndMs: WIN_END, anchorLedger: ANCHOR, anchorCloseMs: ANCHOR_CLOSE_OK });
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
const coldPg = COV.windowServability({ coverage: PG_NULL_ROW, windowStartMs: WIN_START, windowEndMs: WIN_END, anchorLedger: ANCHOR, anchorCloseMs: ANCHOR_CLOSE_OK });
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
  windowStartMs: WIN_START, windowEndMs: WIN_END, anchorLedger: ANCHOR, anchorCloseMs: ANCHOR_CLOSE_OK });
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
  windowStartMs: WIN_START, windowEndMs: WIN_END, anchorLedger: ANCHOR, anchorCloseMs: ANCHOR_CLOSE_OK });
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
  windowStartMs: WIN_START, windowEndMs: WIN_END, anchorLedger: ANCHOR, anchorCloseMs: ANCHOR_CLOSE_OK });
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
  windowStartMs: WIN_START, windowEndMs: WIN_END, anchorLedger: ANCHOR, anchorCloseMs: ANCHOR_CLOSE_OK });
check('a hole below the proof edge is refused, not served',
      holed.reason === COV.REASON.EVIDENCE_PRUNED &&
      holed.evidence_covers_proof_edge === false, holed.reason);

// ── the window may not outrun the anchor ──────────────────────────────────
// The migration's CHECK (window_end <= anchor_close_time) only fires at
// INSERT — by then the narrative has already been built from the uncapped
// window. The window is frozen at page load (02-core.js:877-890) while the
// anchor is fetched at scan start, so an end past the anchor is routine, not
// exotic. Capping in the decision layer is what makes the constraint real.
const ANCHOR_CLOSE = T('2026-09-02T23:45:00Z');   // 15 min BEFORE the window end
const capped = COV.windowServability({
  coverage: provenCov, windowStartMs: WIN_START, windowEndMs: WIN_END,
  anchorLedger: ANCHOR, anchorCloseMs: ANCHOR_CLOSE });
check('a window reaching past the anchor is capped to it',
      capped.window_capped_to_anchor === true &&
      capped.window_end_ms === ANCHOR_CLOSE, capped.window_end_ms);
check('and the overshoot is surfaced, not swallowed',
      capped.claimed_beyond_anchor_ms === 15 * 60 * 1000, capped.claimed_beyond_anchor_ms);
const uncapped = COV.windowServability({
  coverage: provenCov, windowStartMs: WIN_START, windowEndMs: WIN_END,
  anchorLedger: ANCHOR, anchorCloseMs: T('2026-09-03T02:00:00Z') });
// Every cap assertion passed an EXPLICIT anchorCloseMs, so the DEFAULT path —
// the one every other fixture in this suite takes — was never asserted. A
// `Number(input.anchorCloseMs) || 0` coercion (the exact Number(null)===0 trap
// this module is written to prevent) collapsed every uncapped window to 1 Jan
// 1970 with the suite still green.
// This slot used to hold "a decision made with no anchor close time does not
// cap the window" — an assertion that the loophole was ACCEPTABLE. It
// contradicted the invariant stated in the same file (half an anchor is not an
// anchor) and enforced in capWindowToAnchor, and it blessed the path every
// other fixture in this suite took. Same shape as the bootstrap contradiction:
// a hole encoded as a guarantee. windowServability now refuses.
check('windowServability REFUSES a decision with no anchor close time',
      /half an anchor/.test(threw(() => COV.windowServability({
        coverage: provenCov, windowStartMs: WIN_START, windowEndMs: WIN_END,
        anchorLedger: ANCHOR })) || ''));
check('an uncapped window cannot be decided at all — no object is returned',
      threw(() => COV.windowServability({ coverage: null, windowStartMs: WIN_START,
        windowEndMs: WIN_END, anchorLedger: ANCHOR })) !== null);
check('a one-millisecond overshoot is still capped',
      COV.capWindowToAnchor({ windowEndMs: WIN_END, anchorCloseMs: WIN_END - 1 }).capped === true);
check('capWindowToAnchor refuses a missing window end',
      /windowEndMs/.test(threw(() => COV.capWindowToAnchor({ anchorCloseMs: WIN_END })) || ''));
check('a window inside the anchor is left alone',
      uncapped.window_capped_to_anchor === false &&
      uncapped.window_end_ms === WIN_END && uncapped.claimed_beyond_anchor_ms === 0);
check('capWindowToAnchor refuses a missing anchor close time',
      /half an anchor/.test(threw(() => COV.capWindowToAnchor({ windowEndMs: WIN_END })) || ''));
check('an exactly-equal end is not treated as an overshoot',
      COV.capWindowToAnchor({ windowEndMs: WIN_END, anchorCloseMs: WIN_END }).capped === false);

// An anchor is not optional: without one, a concurrent catch-up advancing the
// shared index mid-run would let wallet 3 and wallet 200 describe different
// ledger states inside one Report.
check('a missing anchor is refused',
      /anchorLedger/.test(threw(() => COV.windowServability({ coverage: provenCov, windowStartMs: WIN_START, windowEndMs: WIN_END })) || ''));
check('an inverted window is refused',
      /window/i.test(threw(() => COV.windowServability({ coverage: provenCov, windowStartMs: WIN_END, windowEndMs: WIN_START, anchorLedger: ANCHOR })) || ''));

// ════════════════════════════════════════════════════════════════════════════
console.log('\n4b. zero rows came back — what may be SAID about that');
// Every state below produces an EMPTY RESULT SET, and they do not mean the
// same thing. A caller holding an empty array cannot tell them apart, and the
// Report is read aloud on air. So the distinction is a tested function, not a
// rule in a comment somebody has to remember.
const fetched = (d) => Object.assign({}, d, { edge_fetch_complete: true });

// The one honest "nothing happened".
check('proven, retained, edge fetched, zero rows -> QUIET is allowed',
      COV.mayReportQuiet(fetched(edge), 0).quiet === true &&
      COV.mayReportQuiet(fetched(edge), 0).reason === 'PROVEN_QUIET');
check('a catch-up past the anchor needs no fetch and is quiet on zero rows',
      COV.mayReportQuiet(ahead, 0).quiet === true);

// Every lie, each refused by name.
check('never scanned + zero rows is NOT quiet',
      COV.mayReportQuiet(cold, 0).quiet === false &&
      COV.mayReportQuiet(cold, 0).reason === COV.REASON.NO_COVERAGE);
check('a Postgres row of NULLs + zero rows is NOT quiet',
      COV.mayReportQuiet(coldPg, 0).quiet === false);
check('proven-but-pruned + zero rows is NOT quiet',
      COV.mayReportQuiet(pruned, 0).quiet === false &&
      COV.mayReportQuiet(pruned, 0).reason === COV.REASON.EVIDENCE_PRUNED);
// ── A WINDOW ENTIRELY AFTER THE ANCHOR ───────────────────────────────────
// capWindowToAnchor lowers the END and says nothing about the START, so a
// window lying past the anchor survived the cap INVERTED — start greater than
// end. Every coverage test then passed vacuously, because a proof covering
// real history trivially covers an empty interval. Confirmed by execution
// before the fix: FULLY_SERVABLE, window_start_ms > window_end_ms, and
// mayReportQuiet -> { quiet: true, reason: 'PROVEN_QUIET' }. "Nothing
// happened", certified over an interval that cannot contain anything.
//
// Reachable from a clock running ahead of the ledger, a stale browser window,
// or an operator-chosen range. None of those is exotic.
{
  const ac = 1788393600000, A = 106799000;
  const proven = {
    address: 'rAFTER',
    scan_coverage_from: 32570, scan_coverage_through: A,
    scan_coverage_from_close_ms: 0, scan_coverage_through_close_ms: ac,
    evidence_retained_from: 32570, evidence_retained_through: A,
    evidence_retained_from_close_ms: 0
  };
  const after = COV.windowServability({
    coverage: proven, windowStartMs: ac + 3600000, windowEndMs: ac + 7200000,
    anchorLedger: A, anchorCloseMs: ac });

  check('THE REGRESSION — a window entirely after the anchor is refused',
        after.reason === COV.REASON.WINDOW_AFTER_ANCHOR, after.reason);
  check('and it is never servable from the index',
        after.served_from_index === false && after.complete_without_fetch === false, after);
  check('and zero rows in it may NOT be reported quiet',
        COV.mayReportQuiet(after, 0).quiet === false &&
        COV.mayReportQuiet(after, 0).reason === COV.REASON.WINDOW_AFTER_ANCHOR,
        COV.mayReportQuiet(after, 0));

  // CONTROL: the same coverage over a real window must still certify, or the
  // guard would be indistinguishable from breaking servability outright.
  const good = COV.windowServability({
    coverage: proven, windowStartMs: ac - 86400000, windowEndMs: ac,
    anchorLedger: A, anchorCloseMs: ac });
  check('CONTROL: the same proof over a REAL window is still fully servable',
        good.reason === COV.REASON.FULLY_SERVABLE &&
        COV.mayReportQuiet(good, 0).quiet === true, good.reason);

  // The boundary itself: a zero-width window ending exactly at the anchor
  // close is degenerate but not inverted, and must not be swept up.
  const edgeCase = COV.windowServability({
    coverage: proven, windowStartMs: ac, windowEndMs: ac,
    anchorLedger: A, anchorCloseMs: ac });
  check('a window starting exactly at the anchor close is not treated as inverted',
        edgeCase.reason !== COV.REASON.WINDOW_AFTER_ANCHOR, edgeCase.reason);
}

check('a window predating proven history + zero rows is NOT quiet',
      COV.mayReportQuiet(frontGap, 0).quiet === false);
check('history served but the EDGE not yet fetched is NOT quiet',
      COV.mayReportQuiet(edge, 0).quiet === false &&
      COV.mayReportQuiet(edge, 0).reason === 'EDGE_NOT_YET_PROVEN');
check('an unreachable index (no decision at all) is NOT quiet',
      COV.mayReportQuiet(null, 0).quiet === false);
check('an unknown row count is NOT quiet, even on perfect coverage',
      COV.mayReportQuiet(fetched(edge), null).quiet === false &&
      COV.mayReportQuiet(fetched(edge), undefined).reason === 'ROW_COUNT_UNKNOWN');
check('rows present is never "quiet", whatever the coverage says',
      COV.mayReportQuiet(fetched(edge), 3).quiet === false &&
      COV.mayReportQuiet(fetched(edge), 3).reason === 'ROWS_PRESENT');

// ── the rest of the auditor's required matrix ─────────────────────────────
// PARTIAL HISTORY: coverage that starts inside the window. The index owns none
// of it — a partial answer rendered as a whole one is the failure.
const partialHist = COV.windowServability({
  coverage: Object.assign({}, provenCov, {
    scan_coverage_from: 98700000,
    scan_coverage_from_close_ms: T('2026-09-02T06:00:00Z') }),   // 6h into a 24h window
  windowStartMs: WIN_START, windowEndMs: WIN_END, anchorLedger: ANCHOR, anchorCloseMs: ANCHOR_CLOSE_OK });
check('coverage starting INSIDE the window is not servable',
      partialHist.served_from_index === false &&
      partialHist.reason === COV.REASON.PROOF_GAP_AT_START, partialHist.reason);
check('and a partial window is never reported quiet',
      COV.mayReportQuiet(partialHist, 0).quiet === false);

// STALE CHECKPOINT: proven weeks ago. Still servable for history, but the edge
// is enormous and must be fetched — never silently treated as current.
const stale = COV.windowServability({
  coverage: Object.assign({}, provenCov, {
    scan_coverage_through: 98000500,
    scan_coverage_through_close_ms: T('2026-08-01T00:10:00Z') }),
  windowStartMs: WIN_START, windowEndMs: WIN_END, anchorLedger: ANCHOR, anchorCloseMs: ANCHOR_CLOSE_OK });
check('a stale checkpoint still yields EDGE_ONLY, not FULLY_SERVABLE',
      stale.reason === COV.REASON.EDGE_ONLY, stale.reason);
check('and the edge it demands spans the whole gap',
      stale.fetch_from_ledger === 98000501 && stale.fetch_to_ledger === ANCHOR,
      { from: stale.fetch_from_ledger, to: stale.fetch_to_ledger });
check('a stale checkpoint is not complete without that fetch',
      stale.complete_without_fetch === false &&
      COV.mayReportQuiet(stale, 0).quiet === false);
check('once its edge IS proven, it may be reported quiet',
      COV.mayReportQuiet(fetched(stale), 0).quiet === true);

// EMPTY HISTORY: a wallet proven over a range that genuinely contained
// nothing. This is the case the whole design exists to make cheap, and it must
// stay distinguishable from "never looked".
const emptyButProven = COV.checkpointAdvance({
  coverage: provenCov, anchorLedger: ANCHOR,
  proof: { status: 'COMPLETE', from_ledger: 98790001, through_ledger: ANCHOR,
           range_bound_proven: true, rows_stored: 0,
           from_close_ms: T('2026-09-02T23:00:01Z'),
           through_close_ms: T('2026-09-03T00:00:00Z') } });
check('an empty range that was walked to exhaustion still advances coverage',
      emptyButProven.advance === true &&
      emptyButProven.reason === 'EMPTY_RANGE_EXHAUSTED');
check('which is a DIFFERENT fact from never having scanned',
      COV.mayReportQuiet(cold, 0).reason !== COV.mayReportQuiet(fetched(edge), 0).reason);

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

// ── BOOTSTRAP: how a never-scanned wallet gets its FIRST checkpoint ────────
// This block replaces a check that used to read "a date-bounded fallback walk
// never advances a ledger checkpoint" and asserted it as correct. It was not a
// guard, it was the bug: a wallet with no checkpoint can only be walked by
// DATE (there is no ledger floor to bound it with), so a date walk that can
// never establish a checkpoint means a never-scanned wallet stays
// never-scanned and pays the full walk every morning, forever. The suite
// encoded the contradiction instead of catching it.
const WIN_START_L = 98700000;   // ledger roughly at the window start
const bootProof = {
  status: 'COMPLETE', range_bound_proven: false,
  boundary_reached: true, history_exhausted: false,
  oldest_ledger_index: WIN_START_L - 500,
  oldest_close_ms: T('2026-09-01T23:00:00Z'),   // older than the window start
  through_ledger: ANCHOR, through_close_ms: T('2026-09-03T00:00:00Z'),
  rows_stored: 9
};
const boot = COV.checkpointAdvance({ coverage: null, anchorLedger: ANCHOR, proof: bootProof });
check('a first-scan date walk that reached the boundary DOES establish coverage',
      boot.advance === true && boot.reason === 'BOOTSTRAP_BOUNDARY_REACHED', boot);
check('it is marked as a bootstrap, distinguishable from a ledger-bounded proof',
      boot.bootstrap === true);
check('its floor is the oldest ledger actually READ, not an interpolated one',
      boot.next_from === WIN_START_L - 500, boot.next_from);
// The CLOSE TIME must be pinned too. Nothing asserted it, and the acceptance
// test below could not tell an honest floor from a fabricated 0: both are
// <= the window start, so both yield proven_start=true and EDGE_ONLY. A
// bootstrap silently writing 0 would then report a January window as
// FULLY_SERVABLE and PROVEN_QUIET — eight months nobody ever scanned, asserted
// on air. That is the exact failure class this file exists to prevent.
check('a boundary bootstrap starts at the close time it actually READ',
      boot.next_from_close_ms === T('2026-09-01T23:00:00Z'), boot.next_from_close_ms);
check('its expected_prior is NULL — the SQL must compare with IS NULL',
      boot.expected_prior === null);

// The whole point: the SECOND run must not walk history again.
const afterBoot = COV.windowServability({
  coverage: { address: 'rBooted',
    scan_coverage_from: boot.next_from, scan_coverage_through: boot.next_through,
    scan_coverage_from_close_ms: boot.next_from_close_ms,
    scan_coverage_through_close_ms: boot.next_through_close_ms,
    evidence_retained_from: boot.next_from, evidence_retained_through: boot.next_through,
    evidence_retained_from_close_ms: boot.next_from_close_ms },
  windowStartMs: WIN_START, windowEndMs: WIN_END, anchorLedger: ANCHOR + 4000, anchorCloseMs: ANCHOR_CLOSE_OK });
check('THE ACCEPTANCE TEST — the second run is EDGE_ONLY, not another full walk',
      afterBoot.reason === COV.REASON.EDGE_ONLY, afterBoot.reason);
check('and it fetches only the edge past the bootstrapped checkpoint',
      afterBoot.fetch_from_ledger === ANCHOR + 1, afterBoot.fetch_from_ledger);
check('the second run is ledger-bounded, unlike the first',
      afterBoot.range_bound_proven === true);

// The round trip that actually distinguishes an honest floor from a fabricated
// one: a window starting BEFORE the ledger the bootstrap read. A boundary
// bootstrap proves coverage only back to what it saw, so this must refuse.
const bootedCov = {
  address: 'rBooted',
  scan_coverage_from: boot.next_from, scan_coverage_through: boot.next_through,
  scan_coverage_from_close_ms: boot.next_from_close_ms,
  scan_coverage_through_close_ms: boot.next_through_close_ms,
  evidence_retained_from: boot.next_from, evidence_retained_through: boot.next_through,
  evidence_retained_from_close_ms: boot.next_from_close_ms };
const beforeFloor = COV.windowServability({
  coverage: bootedCov, windowStartMs: T('2026-08-01T00:00:00Z'),
  windowEndMs: WIN_END, anchorLedger: ANCHOR, anchorCloseMs: ANCHOR_CLOSE_OK });
check('a window predating the bootstrap floor is NOT served from the index',
      beforeFloor.reason === COV.REASON.PROOF_GAP_AT_START &&
      beforeFloor.served_from_index === false, beforeFloor.reason);
check('and it may never be reported quiet',
      COV.mayReportQuiet(beforeFloor, 0).quiet === false);

// A bootstrap on a wallet that ALREADY has coverage — the retention-fallback
// case. Nothing exercised it, and there the existing row supplies fromClose
// while the proof supplies the floor, so only contiguity stands between it and
// a false claim.
const bootOnExisting = COV.checkpointAdvance({
  coverage: provenCov, anchorLedger: ANCHOR,
  proof: Object.assign({}, bootProof, { oldest_ledger_index: 98790001 }) });
check('a date walk on an ALREADY-covered wallet keeps the original floor',
      bootOnExisting.advance === true &&
      bootOnExisting.next_from === provenCov.scan_coverage_from &&
      bootOnExisting.next_from_close_ms === provenCov.scan_coverage_from_close_ms,
      { from: bootOnExisting.next_from, close: bootOnExisting.next_from_close_ms });
check('and a non-contiguous one on that wallet is still refused',
      COV.checkpointAdvance({ coverage: provenCov, anchorLedger: ANCHOR,
        proof: Object.assign({}, bootProof, { oldest_ledger_index: 98795000 })
      }).reason === 'PROOF_RANGE_NOT_CONTIGUOUS');

// Exhausting history bootstraps too, and reaches back past ANY window start:
// an account created yesterday whose whole history postdates the window is
// still fully covered. Recording its oldest close time instead would make
// proven_start false next run and send it back to a full walk.
const EXH_BASE_FOR_UNKNOWN = {
  status: 'COMPLETE', range_bound_proven: false,
  boundary_reached: false, history_exhausted: true,
  oldest_ledger_index: 98799000, oldest_close_ms: T('2026-09-02T22:00:00Z'),
  through_ledger: ANCHOR, through_close_ms: T('2026-09-03T00:00:00Z'), rows_stored: 2 };

// "No marker" is the SERVER running out of pages. On a partial-history server
// that is indistinguishable from an account with nothing older, so exhaustion
// must be PROVEN against the server's own retained range.
//
// And the range is an EXPRESSION, not a number. XRPL's documentation says
// complete_ledgers may be DISJOINT — "24900901-24900984,24901116-24901158" —
// so reducing it to its minimum loses exactly the fact it carries. The
// previous version did that, and read "32570-50000,90000000-98800000" as full
// history across a ninety-million-ledger hole.
const A_ANCHOR = ANCHOR;
const prove = (expr) => COV.proveHistoryExhaustion({ completeLedgers: expr, anchorLedger: A_ANCHOR });

check('1. contiguous from the earliest ledger to the anchor is PROVEN',
      prove('32570-98800000').proven === true &&
      prove('32570-98800000').reason === 'SERVER_HAS_FULL_HISTORY');
check('2. a range that does not reach back far enough proves nothing',
      prove('90000000-98800000').proven === false &&
      prove('90000000-98800000').reason === 'SERVER_HISTORY_PARTIAL');
check('3. THE DISJOINT CASE — a hole is not full history',
      prove('32570-50000,90000000-98800000').proven === false &&
      prove('32570-50000,90000000-98800000').reason === 'SERVER_HISTORY_DISJOINT',
      prove('32570-50000,90000000-98800000'));
check('   and the gap is reported, not swallowed',
      prove('32570-50000,90000000-98800000').gap_above === 50000);
// Cases 4 and 5 asserted only `.reason`, so a mutation flipping `proven` to
// true while keeping the label left them GREEN — the same "assert the label,
// not the verdict" slip caught twice before in this file. The VERDICT is the
// thing that decides whether coverage is claimed; assert it first.
check('4. "empty" proves nothing',
      prove('empty').proven === false && prove('empty').reason === 'SERVER_RANGE_EMPTY',
      prove('empty'));
check('5. malformed proves nothing',
      ['not-a-range', '32570-', '50000-32570', '32570,,98800000', '-98800000']
        .every(e => prove(e).proven === false &&
                    prove(e).reason === 'SERVER_RANGE_UNPARSEABLE'),
      ['not-a-range', '32570-', '50000-32570', '32570,,98800000', '-98800000']
        .map(e => [e, prove(e).proven, prove(e).reason]));
// Nothing that fails may carry a usable coverage bound either — a refusal that
// still hands back covers_through would be a refusal in name only.
check('   and a refused proof carries no coverage bound',
      ['empty', 'not-a-range', '90000000-98800000', '32570-50000,90000000-98800000']
        .every(e => prove(e).proven === false &&
                    (prove(e).covers_through === null ||
                     prove(e).covers_through < A_ANCHOR)),
      ['empty', 'not-a-range', '90000000-98800000', '32570-50000,90000000-98800000']
        .map(e => [e, prove(e).covers_through]));
check('   as does an absent range', prove(undefined).proven === false && prove(null).proven === false);
// Contiguity written in two touching pieces is still contiguity — refusing it
// would be as wrong as accepting a real gap.
check('touching ranges merge into contiguous coverage',
      prove('32570-50000,50001-98800000').proven === true);
check('overlapping ranges do too',
      prove('32570-60000,50000-98800000').proven === true);
// Reaching back far enough but stopping short of the anchor is still a hole.
check('coverage that stops one ledger short of the anchor is refused',
      prove('32570-98799999').proven === false &&
      prove('32570-98799999').reason === 'SERVER_HISTORY_DISJOINT');
check('a proof with no anchor is refused outright',
      COV.proveHistoryExhaustion({ completeLedgers: '32570-98800000' }).reason === 'ANCHOR_REQUIRED');
check('the parser is exposed and merges as expected',
      JSON.stringify(COV.parseCompleteLedgers('32570-50000,50001-98800000')) ===
      JSON.stringify([[32570, 98800000]]));

const proofFull    = prove('32570-98800000');
const proofPartial = prove('32570-50000,90000000-98800000');

const EXH_BASE = {
  status: 'COMPLETE', range_bound_proven: false,
  boundary_reached: false, history_exhausted: true,
  oldest_ledger_index: 98799000,
  oldest_close_ms: T('2026-09-02T22:00:00Z'),   // INSIDE the window — deliberately
  through_ledger: ANCHOR, through_close_ms: T('2026-09-03T00:00:00Z'),
  rows_stored: 2 };

const bootExh = COV.checkpointAdvance({ coverage: null, anchorLedger: ANCHOR,
  proof: Object.assign({}, EXH_BASE, { history_exhaustion_proof: proofFull }) });
check('PROVEN exhausted history bootstraps', bootExh.advance === true &&
      bootExh.reason === 'BOOTSTRAP_HISTORY_EXHAUSTED', bootExh.reason);

// THE AUDITOR'S NEGATIVE CASE. Non-empty recent rows, no marker, partial
// server history. The rows are real; the claim that nothing older exists is
// not. This must NOT establish a historical checkpoint.
const bootExhUnproven = COV.checkpointAdvance({ coverage: null, anchorLedger: ANCHOR,
  proof: Object.assign({}, EXH_BASE, { history_exhaustion_proof: proofPartial }) });
check('rows + no marker + PARTIAL server history establishes NOTHING',
      bootExhUnproven.advance === false &&
      bootExhUnproven.reason === 'HISTORY_EXHAUSTION_UNPROVEN', bootExhUnproven);
check('and it claims no coverage at all',
      bootExhUnproven.next_through === null && bootExhUnproven.next_through_close_ms === null,
      bootExhUnproven);
check('omitting the proof entirely is the same refusal',
      COV.checkpointAdvance({ coverage: null, anchorLedger: ANCHOR, proof: EXH_BASE
      }).reason === 'HISTORY_EXHAUSTION_UNPROVEN');
// A caller must not be able to manufacture the verdict. The proof is now the
// OBJECT the prover returned, and it has to name THIS run's anchor.
check('a bare history_exhausted_proven flag is NOT accepted',
      COV.checkpointAdvance({ coverage: null, anchorLedger: ANCHOR, proof:
        Object.assign({}, EXH_BASE, { history_exhausted_proven: true })
      }).reason === 'HISTORY_EXHAUSTION_UNPROVEN');
check('a hand-made proven:true object without the anchor is NOT accepted',
      COV.checkpointAdvance({ coverage: null, anchorLedger: ANCHOR, proof:
        Object.assign({}, EXH_BASE, { history_exhaustion_proof: { proven: true } })
      }).reason === 'HISTORY_EXHAUSTION_UNPROVEN');
check('a real proof for a DIFFERENT anchor is NOT accepted',
      COV.checkpointAdvance({ coverage: null, anchorLedger: ANCHOR, proof:
        Object.assign({}, EXH_BASE, { history_exhaustion_proof:
          COV.proveHistoryExhaustion({ completeLedgers: '32570-98800000', anchorLedger: 12345 }) })
      }).reason === 'HISTORY_EXHAUSTION_UNPROVEN');
// Boundary-reached remains independently valid — an unproven exhaustion claim
// alongside it must not poison a walk that DID read past the window start.
check('a boundary-reached walk still bootstraps despite unproven exhaustion',
      COV.checkpointAdvance({ coverage: null, anchorLedger: ANCHOR,
        proof: Object.assign({}, bootProof, { history_exhausted: true,
          history_exhaustion_proof: proofPartial })
      }).reason === 'BOOTSTRAP_BOUNDARY_REACHED');
check('and its coverage reaches back past any window start',
      bootExh.next_from_close_ms === 0, bootExh.next_from_close_ms);
const exhServ = COV.windowServability({
  coverage: { address: 'rNew',
    scan_coverage_from: bootExh.next_from, scan_coverage_through: bootExh.next_through,
    scan_coverage_from_close_ms: bootExh.next_from_close_ms,
    scan_coverage_through_close_ms: bootExh.next_through_close_ms,
    evidence_retained_from: bootExh.next_from, evidence_retained_through: bootExh.next_through,
    evidence_retained_from_close_ms: bootExh.next_from_close_ms },
  windowStartMs: WIN_START, windowEndMs: WIN_END, anchorLedger: ANCHOR, anchorCloseMs: ANCHOR_CLOSE_OK });
check('a young account on a full-history server is covered, not re-walked',
      exhServ.reason === COV.REASON.FULLY_SERVABLE, exhServ.reason);

// The bootstrap does NOT open a hole. Each refusal is its own reason.
check('a walk that stopped for no stated reason still never bootstraps',
      COV.checkpointAdvance({ coverage: null, anchorLedger: ANCHOR, proof:
        Object.assign({}, bootProof, { boundary_reached: false, history_exhausted: false })
      }).reason === 'RANGE_NOT_LEDGER_BOUND');
check('exhausting an EMPTY account claims no floor it never read',
      COV.checkpointAdvance({ coverage: null, anchorLedger: ANCHOR, proof:
        Object.assign({}, bootProof, { boundary_reached: false, history_exhausted: true,
          history_exhaustion_proof: proofFull, oldest_ledger_index: null, rows_stored: 0 })
      }).reason === 'NO_LEDGER_FLOOR_OBSERVED');
check('a TRUNCATED first scan never bootstraps',
      COV.checkpointAdvance({ coverage: null, anchorLedger: ANCHOR, proof:
        Object.assign({}, bootProof, { status: 'TRUNCATED' }) }).advance === false);
check('a FAILED first scan never bootstraps',
      COV.checkpointAdvance({ coverage: null, anchorLedger: ANCHOR, proof:
        Object.assign({}, bootProof, { status: 'FAILED' }) }).advance === false);
check('a bootstrap still may not reach past the run anchor',
      COV.checkpointAdvance({ coverage: null, anchorLedger: ANCHOR, proof:
        Object.assign({}, bootProof, { through_ledger: ANCHOR + 1 })
      }).reason === 'PROOF_EXCEEDS_ANCHOR');
check('a boundary-reached bootstrap with no close time is refused',
      COV.checkpointAdvance({ coverage: null, anchorLedger: ANCHOR, proof:
        Object.assign({}, bootProof, { oldest_close_ms: null })
      }).reason === 'PROOF_MISSING_CLOSE_TIMES');

// A date-bounded fallback walk (the retention retry with ledger_index_min: -1)
// still yields usable evidence, but it cannot prove a ledger RANGE.
const dateBound = COV.checkpointAdvance(Object.assign({}, base, {
  proof: Object.assign({}, okProof, { range_bound_proven: false }) }));
check('a date walk with NO floor evidence never advances a ledger checkpoint',
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
  windowStartMs: WIN_START, windowEndMs: WIN_END, anchorLedger: ANCHOR, anchorCloseMs: ANCHOR_CLOSE_OK });
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

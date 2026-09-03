// XRPMAN Shadow Watch — database connection boundary. Server-side only.
//
// ── Why this file has no driver dependency yet ──────────────────────────────
// This PR is the foundation: schema, migrations, and the decision logic that
// has to be right before any of it is wired to a live database. It deliberately
// adds no npm dependency, so `npm ci` and the Vercel build behave exactly as
// they do today and the existing report keeps working untouched. The Neon
// driver is required LAZILY, inside a try, and its absence is reported as
// "not configured" rather than thrown. The PR that actually reads and writes
// evidence adds the dependency.
//
// ── What lives in Neon, and what lives in git ─────────────────────────────
// Evidence — transactions, participants, coverage, scan runs — lives in Neon
// Postgres, which is server-owned. The git repository carries code, schema,
// migrations and small reference data (labels, config, bootstrap display
// values) and nothing else. A 72-hour window has been measured at 153,826
// rows; a week approaches a million. That does not belong in a repository, and more
// importantly:
//
//   NO VALUE COMMITTED TO THIS REPOSITORY MAY EVER ADVANCE A FORENSIC
//   COVERAGE FLOOR.
//
// That is not a style preference. A cursor committed to git becomes a floor
// that outranks the ledger under a `max` merge (SW-20260813-WS4WU,
// 02-core.js:2939-2952), so a wallet would claim coverage it never proved and
// the Report would say so on air. Coverage lives in one place: the server.
//
// ── The browser may request. It may not assert. ───────────────────────────
// A browser can ask the server to catch a wallet up. It can never say "trust
// me, wallet X is complete through ledger 105000". The server reads XRPL
// itself, stores the evidence, proves the range, and advances the checkpoint
// transactionally. This module is the boundary that makes that structural
// rather than a convention.
//
// ── XRPL stays read-only ──────────────────────────────────────────────────
// Nothing here signs, submits, trades, or handles a seed. The database holds
// observed ledger evidence. assertNoSecretMaterial() below is a cheap
// belt-and-braces check on the write path so key material cannot be persisted
// even by accident.
'use strict';

// This module must never end up in a page. index.html and brief-console.html
// enumerate their <script src> tags explicitly, so it cannot arrive by glob —
// but say it out loud, because a future bundler would not know.
if (typeof window !== 'undefined' && typeof module === 'undefined') {
  throw new Error('src/db/connection.js is server-side only');
}

// Vercel's Neon Marketplace integration provisions DATABASE_URL. POSTGRES_URL
// is accepted as an alias so a hand-configured project also works. Read at
// call time, not at module load, so a test can set and clear it.
function connectionString() {
  const env = (typeof process !== 'undefined' && process.env) || {};
  return env.SHADOWWATCH_DATABASE_URL || env.DATABASE_URL || env.POSTGRES_URL || '';
}

function isConfigured() {
  return connectionString().length > 0;
}

// The connection string carries a password. It is never logged, never returned,
// and never included in an error message. This exists so a diagnostic line can
// say WHICH host without saying the credential.
function redactedTarget() {
  const raw = connectionString();
  if (!raw) return 'unconfigured';
  try {
    const u = new URL(raw);
    return (u.hostname || 'unknown-host') + (u.pathname || '');
  } catch (_) {
    return 'unparseable';
  }
}

// ── Executor ───────────────────────────────────────────────────────────────
// One shape, injectable: `query(sql, params) -> Promise<{ rows: [] }>`.
// Everything above this line in the stack is testable with a fake, which is
// the point — the decision logic in coverage.js and the mapping in
// transactions.js are exercised in CI with no database, no network and no
// browser.
let _injected = null;

function setExecutor(fn) {
  if (fn !== null && typeof fn !== 'function') {
    throw new Error('setExecutor expects a function or null');
  }
  _injected = fn;
}

function _loadNeon() {
  try {
    // eslint-disable-next-line global-require
    const mod = require('@neondatabase/serverless');
    if (mod && typeof mod.neon === 'function') return mod.neon;
  } catch (_) { /* dependency not installed — reported as unconfigured */ }
  return null;
}

// Returns an executor, or null when there is nothing to talk to. Callers must
// handle null by falling back to XRPL or by declaring the window unavailable.
// They must NOT treat it as "no rows found": an unreachable index and an empty
// window are different facts, and rendering the first as the second is how a
// report ends up claiming silence it never observed.
function getExecutor() {
  if (_injected) return _injected;
  if (!isConfigured()) return null;
  const neon = _loadNeon();
  if (!neon) return null;
  const sql = neon(connectionString(), { fullResults: true });
  return async function query(text, params) {
    const res = await sql.query(text, params || []);
    return { rows: (res && res.rows) || [] };
  };
}

// ── Write-path guard ───────────────────────────────────────────────────────
// XRPL access is read-only and no signing material exists anywhere in this
// project. This makes that impossible to violate through the database by
// accident: a row carrying anything that looks like a secret is refused rather
// than stored. Cheap, and it removes a whole class of "how did that get in the
// database" incident.
const SECRET_KEYS = /^(seed|secret|master_seed|master_key|private_key|privatekey|passphrase|mnemonic|signing_key|tx_blob|txblob|x_?priv)$/i;

function assertNoSecretMaterial(row) {
  if (!row || typeof row !== 'object') return row;
  for (const k of Object.keys(row)) {
    if (SECRET_KEYS.test(k)) {
      throw new Error('refusing to persist key material: field "' + k + '"');
    }
  }
  return row;
}

// ── Health, for a diagnostics surface ─────────────────────────────────────
// Reports a fact, not a guess. `reachable` is only true when a query actually
// answered on this call.
async function health() {
  const out = {
    configured: isConfigured(),
    target: redactedTarget(),
    driver_present: _injected ? 'injected' : (_loadNeon() ? 'present' : 'absent'),
    reachable: false,
    error: null
  };
  const exec = getExecutor();
  if (!exec) return out;
  try {
    const res = await exec('select 1 as ok', []);
    out.reachable = !!(res && res.rows && res.rows.length);
  } catch (e) {
    out.error = (e && e.message) ? String(e.message) : 'query failed';
  }
  return out;
}

module.exports = {
  isConfigured,
  redactedTarget,
  getExecutor,
  setExecutor,
  assertNoSecretMaterial,
  health,
  SECRET_KEYS
};

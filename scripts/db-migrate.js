'use strict';
const fs = require('fs');
const path = require('path');
const db = require('../src/db/connection');
async function main() {
  const pool = db.getPool();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(9134001)');
    // Migration 005 reads these. They are session settings rather than
    // migration arguments because the runner applies each file as one
    // statement, and because a value that changes what a migration COPIES
    // belongs to the operator running it, not to the file.
    //
    // Unset means the safe thing: 005 copies no payloads and needs no
    // headroom. Setting SHADOWWATCH_RAW_BACKFILL_HOURS asks it to carry that
    // many hours of ledger payloads into transaction_raw, and it refuses the
    // whole migration — atomically, nothing partial — if that would not fit
    // under SHADOWWATCH_SIZE_LIMIT_MB (default 512).
    for (const [env, setting] of [['SHADOWWATCH_RAW_BACKFILL_HOURS', 'shadowwatch.raw_backfill_hours'],
                                  ['SHADOWWATCH_SIZE_LIMIT_MB', 'shadowwatch.size_limit_mb']]) {
      const value = process.env[env];
      if (value === undefined || String(value).trim() === '') continue;
      if (!/^\d+(\.\d+)?$/.test(String(value).trim())) throw new Error(env + ' must be a non-negative number');
      await client.query('SELECT set_config($1, $2, false)', [setting, String(value).trim()]);
      console.log('Migration setting ' + setting + ' = ' + String(value).trim());
    }
    const table = await client.query("SELECT to_regclass('public.schema_migrations') AS name");
    const applied = table.rows[0].name ? (await client.query('SELECT version FROM schema_migrations')).rows.map(r => r.version) : [];
    for (const name of fs.readdirSync(path.join(__dirname, '../db/migrations')).filter(n => n.endsWith('.sql')).sort()) {
      if (applied.includes(name.replace(/\.sql$/, ''))) continue;
      await client.query(fs.readFileSync(path.join(__dirname, '../db/migrations', name), 'utf8'));
      console.log('Applied ' + name);
    }
    console.log('Database migrations verified');
  } finally {
    await client.query('SELECT pg_advisory_unlock(9134001)');
    client.release(); await db.close();
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });

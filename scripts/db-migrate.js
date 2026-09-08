'use strict';
const fs = require('fs');
const path = require('path');
const db = require('../src/db/connection');
async function main() {
  const pool = db.getPool();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(9134001)');
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

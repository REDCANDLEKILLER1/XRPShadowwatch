#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { buildDailyResearchTable } = require('./daily-table');

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows) {
  const columns = [
    'date',
    'xrp_price_usd',
    'cohort_balance_xrp',
    'net_cohort_change_xrp',
    'exchange_inflow_xrp',
    'exchange_outflow_xrp',
    'whale_accumulation_xrp',
    'whale_distribution_xrp',
    'large_move_volume_xrp',
    'large_move_count',
    'active_wallets',
    'evidence_coverage',
    'balance_coverage'
  ];
  return [
    columns.join(','),
    ...rows.map(row => columns.map(c => csvCell(row[c])).join(','))
  ].join('\n') + '\n';
}

function main(argv) {
  const inputPath = argv[2];
  const outputPath = argv[3];
  if (!inputPath || !outputPath) {
    console.error('usage: node research/price-regime/build-daily.js INPUT.json OUTPUT.(json|csv)');
    return 2;
  }

  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const rows = buildDailyResearchTable(input);
  const ext = path.extname(outputPath).toLowerCase();
  if (ext === '.csv') fs.writeFileSync(outputPath, toCsv(rows));
  else if (ext === '.json') fs.writeFileSync(outputPath, JSON.stringify(rows, null, 2) + '\n');
  else throw new Error('output must end in .json or .csv');

  console.log('PRICE-REGIME DAILY TABLE: ' + rows.length + ' day(s) -> ' + outputPath);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv); }
  catch (err) {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  }
}

module.exports = { toCsv, main };

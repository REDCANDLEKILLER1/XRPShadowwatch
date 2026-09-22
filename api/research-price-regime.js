'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const Store = require('../src/db/github-store');
const Archive = require('../src/db/github-archive');

function dayOk(day) {
  return /^20\d{2}-\d{2}-\d{2}$/.test(String(day || ''));
}
function refOk(ref) {
  return /^[a-f0-9]{40}$/.test(String(ref || ''));
}

async function readKindAtRef(day, kind, ref, deps) {
  const d = deps || {};
  const target = Archive.evidenceTarget(d.env || process.env);
  const gh = d.gh || Archive.client(target.token, target.repo, d.fetch || fetch);
  const name = kind === 'participants' ? 'participants' : 'events';
  const base = 'evidence/' + day.replace(/-/g, '/');
  const suffixes = ['/' + name + '.ndjson.gz'];
  for (let i = 1; i <= 999; i++) suffixes.push('/' + name + '.' + String(i).padStart(3, '0') + '.ndjson.gz');

  const rows = [], files = [];
  let found = 0;
  for (const suffix of suffixes) {
    const path = base + suffix;
    const packed = await Store.readBytes(gh, target.branch, path, ref);
    if (packed === null) {
      if (suffix === '/' + name + '.ndjson.gz') continue;
      break;
    }
    const text = zlib.gunzipSync(packed).toString('utf8');
    for (const line of text.split('\n')) if (line) rows.push(JSON.parse(line));
    files.push(path);
    found++;
  }
  return { events: rows, files, missing: found ? [] : [day] };
}

function amountXrp(event) {
  if (!event || event.tx_type !== 'Payment' || event.currency !== 'XRP') return null;
  if (event.amount_drops === null || event.amount_drops === undefined || event.amount_drops === '') return null;
  const drops = Number(event.amount_drops);
  if (!Number.isFinite(drops) || drops < 0) return null;
  return drops / 1e6;
}

function digestHashes(events) {
  const h = crypto.createHash('sha256');
  const hashes = [...new Set((events || []).map(e => String(e.hash || '')).filter(Boolean))].sort();
  for (const hash of hashes) h.update(hash + '\n', 'utf8');
  return { distinct_hashes: hashes.length, hash_digest_sha256: h.digest('hex') };
}

function summarize(events) {
  let successXrp = 0;
  let largeXrp = 0;
  let largeCount = 0;
  let first = null;
  let last = null;
  const seen = new Set();

  for (const e of events || []) {
    if (!e || !e.hash || seen.has(e.hash)) continue;
    seen.add(e.hash);
    const t = Date.parse(e.close_time || '');
    if (Number.isFinite(t)) {
      if (first === null || t < first) first = t;
      if (last === null || t > last) last = t;
    }
    if (e.validated !== true || e.tx_result !== 'tesSUCCESS') continue;
    const xrp = amountXrp(e);
    if (xrp === null) continue;
    successXrp += xrp;
    if (xrp >= 1_000_000) {
      largeXrp += xrp;
      largeCount++;
    }
  }

  return {
    event_rows: (events || []).length,
    distinct_events: seen.size,
    successful_xrp_moved: successXrp,
    large_move_volume_xrp: largeXrp,
    large_move_count: largeCount,
    first_close_time: first === null ? null : new Date(first).toISOString(),
    last_close_time: last === null ? null : new Date(last).toISOString(),
    ...digestHashes(events)
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });

  const day = String((req.query || {}).day || '');
  const ref = String((req.query || {}).ref || '');
  if (!dayOk(day)) return res.status(400).json({ error: 'DAY_REQUIRED_YYYY_MM_DD' });
  if (ref && !refOk(ref)) return res.status(400).json({ error: 'REF_MUST_BE_FULL_COMMIT_SHA' });

  try {
    const events = ref ? await readKindAtRef(day, 'events', ref) : await Store.readDays([day], {}, 'events');
    const participants = ref ? await readKindAtRef(day, 'participants', ref) : await Store.readDays([day], {}, 'participants');
    return res.status(200).json({
      mode: 'READ_ONLY_RESEARCH_RECONCILIATION',
      day,
      evidence_ref: ref || 'main',
      events: summarize(events.events),
      event_files: events.files,
      missing_event_days: events.missing,
      participant_rows: participants.events.length,
      participant_files: participants.files,
      missing_participant_days: participants.missing
    });
  } catch (e) {
    return res.status(500).json({ error: 'RECONCILIATION_FAILED', detail: String(e && e.message || e) });
  }
};

module.exports._test = { amountXrp, digestHashes, summarize, dayOk, refOk };

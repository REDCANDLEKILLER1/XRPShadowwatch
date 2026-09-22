'use strict';

const crypto = require('crypto');
const Store = require('../src/db/github-store');

function dayOk(day) {
  return /^20\d{2}-\d{2}-\d{2}$/.test(String(day || ''));
}

function amountXrp(event) {
  if (!event || event.currency !== 'XRP') return null;
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
  if (!dayOk(day)) return res.status(400).json({ error: 'DAY_REQUIRED_YYYY_MM_DD' });

  try {
    const events = await Store.readDays([day], {}, 'events');
    const participants = await Store.readDays([day], {}, 'participants');
    return res.status(200).json({
      mode: 'READ_ONLY_RESEARCH_RECONCILIATION',
      day,
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

module.exports._test = { amountXrp, digestHashes, summarize };

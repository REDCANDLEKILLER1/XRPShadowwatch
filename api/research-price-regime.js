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
function rangeOf(query) {
  const fromRaw = String((query || {}).from || '');
  const toRaw = String((query || {}).to || '');
  if (!fromRaw && !toRaw) return null;
  if (!fromRaw || !toRaw) throw new Error('FROM_AND_TO_REQUIRED_TOGETHER');
  const from = Date.parse(fromRaw), to = Date.parse(toRaw);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new Error('INVALID_TIME_RANGE');
  if (to - from > 7 * 86400000) throw new Error('TIME_RANGE_EXCEEDS_7_DAYS');
  const days = [];
  for (let t = Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), new Date(from).getUTCDate());
       t <= to; t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
  return { from, to, days };
}

function solveWindow(events, toMs, targetCount) {
  const unique = new Map();
  for (const e of events || []) {
    if (!e || !e.hash) continue;
    const t = Date.parse(e.close_time || '');
    if (!Number.isFinite(t) || t > toMs) continue;
    if (!unique.has(e.hash)) unique.set(e.hash, e);
  }
  const ordered = [...unique.values()].sort((a, b) => {
    const dt = Date.parse(b.close_time) - Date.parse(a.close_time);
    return dt || String(a.hash).localeCompare(String(b.hash));
  });
  if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > ordered.length) {
    throw new Error('TARGET_COUNT_OUTSIDE_LOOKBACK');
  }
  const selected = ordered.slice(0, targetCount);
  const oldestMs = Date.parse(selected[selected.length - 1].close_time);
  const older = ordered[targetCount] || null;
  const olderMs = older ? Date.parse(older.close_time) : null;
  const byBoundary = ordered.filter(e => Date.parse(e.close_time) >= oldestMs);
  return {
    target_count: targetCount,
    exact_timestamp_boundary: byBoundary.length === targetCount,
    solved_start_at_or_before: new Date(oldestMs).toISOString(),
    prior_excluded_close_time: olderMs === null ? null : new Date(olderMs).toISOString(),
    boundary_event_count: byBoundary.length,
    selected_summary: summarize(selected),
    timestamp_boundary_summary: summarize(byBoundary)
  };
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

function nativeAmountAnyType(event) {
  if (!event || event.currency !== 'XRP') return null;
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
  let successfulNativeAnyType = 0;
  const byType = Object.create(null);
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
    const anyNative = nativeAmountAnyType(e);
    if (anyNative !== null) {
      successfulNativeAnyType += anyNative;
      const type = String(e.tx_type || 'UNKNOWN');
      if (!byType[type]) byType[type] = { events: 0, xrp: 0 };
      byType[type].events += 1;
      byType[type].xrp += anyNative;
    }
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
    successful_native_amount_any_type: successfulNativeAnyType,
    successful_native_amount_by_tx_type: Object.keys(byType).sort().reduce((out, key) => {
      out[key] = byType[key]; return out;
    }, {}),
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

  const query = req.query || {};
  const day = String(query.day || '');
  const ref = String(query.ref || '');
  const solveCountRaw = query.solve_count;
  const solveCount = solveCountRaw === undefined ? null : Number(solveCountRaw);
  let range = null;
  if (solveCount === null) {
    try { range = rangeOf(query); }
    catch (e) { return res.status(400).json({ error: String(e.message || e) }); }
  }
  const solveTo = String(query.to || '');
  const lookbackHours = query.lookback_hours === undefined ? 48 : Number(query.lookback_hours);

  if (solveCount !== null) {
    if (!Number.isInteger(solveCount) || solveCount < 1) return res.status(400).json({ error: 'SOLVE_COUNT_MUST_BE_POSITIVE_INTEGER' });
    if (!Number.isFinite(Date.parse(solveTo))) return res.status(400).json({ error: 'SOLVE_TO_REQUIRED' });
    if (!Number.isFinite(lookbackHours) || lookbackHours <= 0 || lookbackHours > 168) return res.status(400).json({ error: 'LOOKBACK_HOURS_OUT_OF_RANGE' });
  } else if (!range && !dayOk(day)) {
    return res.status(400).json({ error: 'DAY_REQUIRED_YYYY_MM_DD' });
  }
  if (ref && !refOk(ref)) return res.status(400).json({ error: 'REF_MUST_BE_FULL_COMMIT_SHA' });

  try {
    if (solveCount !== null) {
      const toMs = Date.parse(solveTo);
      const fromMs = toMs - lookbackHours * 3600000;
      const days = [];
      for (let t = Date.UTC(new Date(fromMs).getUTCFullYear(), new Date(fromMs).getUTCMonth(), new Date(fromMs).getUTCDate());
           t <= toMs; t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
      const all = [];
      const files = [], missing = [];
      for (const d of days) {
        const part = ref ? await readKindAtRef(d, 'events', ref) : await Store.readDays([d], {}, 'events');
        all.push(...part.events); files.push(...part.files); missing.push(...part.missing);
      }
      return res.status(200).json({
        mode: 'READ_ONLY_RESEARCH_WINDOW_SOLVER',
        evidence_ref: ref || 'main',
        to: new Date(toMs).toISOString(),
        lookback_hours: lookbackHours,
        days,
        solution: solveWindow(all, toMs, solveCount),
        event_files: [...new Set(files)],
        missing_event_days: [...new Set(missing)]
      });
    }
    if (range) {
      const combined = { events: [], files: [], missing: [] };
      for (const d of range.days) {
        const part = ref ? await readKindAtRef(d, 'events', ref) : await Store.readDays([d], {}, 'events');
        combined.events.push(...part.events);
        combined.files.push(...part.files);
        combined.missing.push(...part.missing);
      }
      const filtered = combined.events.filter(e => {
        const t = Date.parse(e && e.close_time || '');
        return Number.isFinite(t) && t >= range.from && t <= range.to;
      });
      return res.status(200).json({
        mode: 'READ_ONLY_RESEARCH_RECONCILIATION',
        range: { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString(), days: range.days },
        evidence_ref: ref || 'main',
        events: summarize(filtered),
        event_files: [...new Set(combined.files)],
        missing_event_days: [...new Set(combined.missing)]
      });
    }

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

module.exports._test = { amountXrp, nativeAmountAnyType, digestHashes, summarize, dayOk, refOk, rangeOf, solveWindow };

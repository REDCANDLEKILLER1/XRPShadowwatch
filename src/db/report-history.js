'use strict';
const A = require('./github-archive');
const Store = require('./github-store');
const ID = /^SW-(\d{4})(\d{2})(\d{2})-[A-Z0-9]{5}$/;
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value + 'T00:00:00Z')) ||
      new Date(value + 'T00:00:00Z').toISOString().slice(0,10) !== value) throw new Error('INVALID_REPORT_DATE');
  return value;
}
function reportDay(id) {
  const m = typeof id === 'string' && ID.exec(id);
  if (!m) throw new Error('INVALID_REPORT_ID');
  return day(m[1] + '-' + m[2] + '-' + m[3]);
}
async function history(query = {}, deps = {}) {
  const action = query.action || 'list';
  if (!['list','read'].includes(action)) throw new Error('INVALID_HISTORY_ACTION');
  if (query.date !== undefined) day(query.date);
  if (action === 'read') { reportDay(query.report_id); day(query.archive_day); }
  const offset = Number(query.offset || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new Error('INVALID_HISTORY_OFFSET');
  const target = A.archiveReadTarget(deps.env || process.env);
  const gh = deps.gh || A.client(target.token, target.repo, deps.fetch || fetch);
  // Read only: unlike archiveRef, this never creates an archive branch.
  const ref = await gh('GET', '/git/ref/heads/' + target.branch, undefined, true);
  const empty = {date:query.date || null,dates:[],reports:[],total:0,next_offset:null};
  if (!ref) {
    if (action === 'read') throw new Error('REPORT_NOT_FOUND');
    return empty;
  }
  const pinned = ref.object.sha;
  const read = path => Store.readFile(gh, target.branch, path, pinned);
  if (action === 'read') {
    const root = 'reports/' + query.archive_day.replace(/-/g,'/') + '/' + query.report_id;
    const [receiptText, text] = await Promise.all([read(root + '/receipt.json'), read(root + '/morning-report.txt')]);
    if (receiptText === null || text === null) throw new Error('REPORT_NOT_FOUND');
    let receipt;
    try { receipt = JSON.parse(receiptText); } catch (_) { throw new Error('REPORT_RECEIPT_INVALID'); }
    if (receipt.report_id !== query.report_id || !/^[a-f0-9]{64}$/.test(receipt.report_hash || '') ||
        A.sha(text) !== receipt.report_hash) throw new Error('REPORT_HASH_MISMATCH');
    return {report_id:query.report_id,report_day:reportDay(query.report_id),archive_day:query.archive_day,
      created_at:receipt.sealed_at || null,evidence_at:receipt.generated_at || null,
      coverage_complete:receipt.coverage_complete === true,report_hash:receipt.report_hash,text};
  }
  const tree = await gh('GET', '/git/trees/' + pinned);
  if (tree.truncated) throw new Error('REPORT_HISTORY_INDEX_TOO_LARGE');
  const reports = (tree.tree || []).find(e => e.path === 'reports' && e.type === 'tree');
  if (!reports) return empty;
  // Traverse only reports, not the much larger application/evidence tree.
  const catalog = await gh('GET', '/git/trees/' + reports.sha + '?recursive=1');
  if (catalog.truncated) throw new Error('REPORT_HISTORY_INDEX_TOO_LARGE');
  const paths = new Set((catalog.tree || []).filter(e => e.type === 'blob').map(e => e.path));
  const rows = [];
  for (const path of paths) {
    const m = /^(\d{4})\/(\d{2})\/(\d{2})\/(SW-\d{8}-[A-Z0-9]{5})\/morning-report\.txt$/.exec(path);
    if (!m || !paths.has(path.replace(/morning-report\.txt$/, 'receipt.json'))) continue;
    rows.push({report_id:m[4],report_day:reportDay(m[4]),archive_day:day(m[1]+'-'+m[2]+'-'+m[3])});
  }
  // The folder is dated by evidence. The report ID dates the actual report,
  // so a run after midnight still appears on its own day, even with an older checkpoint.
  const dates = [...new Set(rows.map(r => r.report_day))].sort().reverse();
  const selected = query.date || dates[0] || null;
  const matches = rows.filter(r => r.report_day === selected);
  const indexes = {};
  for (const d of new Set(matches.map(r => r.archive_day))) {
    const text = await read('reports/' + d.replace(/-/g,'/') + '/index.json');
    if (text !== null) {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('REPORT_HISTORY_INDEX_INVALID');
      for (const row of parsed) indexes[d + '/' + row.report_id] = row;
    }
  }
  for (const row of matches) {
    const meta = indexes[row.archive_day + '/' + row.report_id] || {};
    row.created_at = meta.sealed_at || null;
    row.evidence_at = meta.generated_at || null;
    row.report_hash = meta.report_hash || null;
  }
  matches.sort((a,b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || b.report_id.localeCompare(a.report_id));
  return {date:selected,dates,reports:matches.slice(offset,offset+50),total:matches.length,
    next_offset:offset+50 < matches.length ? offset+50 : null};
}
module.exports = {history,day,reportDay};

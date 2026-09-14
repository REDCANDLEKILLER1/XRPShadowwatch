'use strict';
const { promoteCandidates } = require('../src/db/github-roster');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'POST') return res.status(405).json({ status: 'FAILED', error: 'METHOD_NOT_ALLOWED' });
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin).host; }
    catch (_) { return res.status(403).json({ status: 'FAILED', error: 'INVALID_ORIGIN' }); }
    if (origin !== req.headers.host) return res.status(403).json({ status: 'FAILED', error: 'CROSS_ORIGIN_WRITE_REFUSED' });
  }
  try {
    return res.json(await promoteCandidates(req.body));
  } catch (e) {
    const message = String(e.message || 'ROSTER_PROMOTION_FAILED').slice(0, 300);
    const code = /INVALID_|NOT_ALLOWED|NOT_READY|REFUSED|REQUIRES_|MISMATCH|REQUIRED|PRODUCTION_ONLY|SIZE_|CAP_/.test(message) ? 400 : 503;
    return res.status(code).json({
      status: 'FAILED',
      report_id: req.body && req.body.report_id || null,
      error: message
    });
  }
};

'use strict';
const { promote } = require('../src/db/watchlist-promotions');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'POST') return res.status(405).json({ status: 'FAILED', error: 'METHOD_NOT_ALLOWED' });
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin).host; }
    catch (_) { return res.status(403).json({ status: 'FAILED', error: 'INVALID_ORIGIN' }); }
    if (origin !== req.headers.host) return res.status(403).json({ status: 'FAILED', error: 'CROSS_ORIGIN_WRITE_REFUSED' });
  }
  try { return res.json(await promote(req.body)); }
  catch (e) {
    const msg = String(e && e.message || 'WATCHLIST_PROMOTION_FAILED').slice(0, 300);
    const code = /INVALID_|FIELD_NOT_ALLOWED|TARGET_REFUSED|DEPLOYMENT_REFUSED|ROSTER_TOO_LARGE/.test(msg) ? 400 : 503;
    return res.status(code).json({ attempted: true, status: 'FAILED', error: msg });
  }
};

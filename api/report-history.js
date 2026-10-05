'use strict';
const {history} = require('../src/db/report-history');
module.exports = async function handler(req,res) {
  res.setHeader('Cache-Control','private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options','nosniff');
  if (req.method !== 'GET') return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
  try { return res.json(await history(req.query || {})); }
  catch (e) {
    const message = String(e.message || 'REPORT_HISTORY_UNAVAILABLE');
    const status = /^INVALID_/.test(message) ? 400 : message === 'REPORT_NOT_FOUND' ? 404 : 503;
    return res.status(status).json({error:message.slice(0,200)});
  }
};

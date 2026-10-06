'use strict';
// Same production/cron/enable gates and bounded read budget as collection.
// Odd-hour checks resume an unfinished journal; no journal means no XRPL reads.
const scheduler = require('./evidence-scheduler');
module.exports = function handler(req,res) {
  req._shadowwatchResumeOnly = true;
  return scheduler(req,res);
};

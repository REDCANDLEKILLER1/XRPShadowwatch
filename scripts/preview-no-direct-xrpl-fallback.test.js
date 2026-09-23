#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const delta = require('../api/delta');

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(k,v){ this.headers[k]=v; },
    status(code){ this.statusCode=code; return this; },
    json(value){ this.body=value; return this; },
    end(value){ this.body=value; return this; }
  };
}

(async () => {
  const savedEnv = process.env.VERCEL_ENV;
  const savedToken = process.env.SHADOWWATCH_EVIDENCE_TOKEN;
  try {
    // No evidence token on purpose. The preview guard must run before store
    // configuration, reader acquisition, or any XRPL request.
    process.env.VERCEL_ENV = 'preview';
    delete process.env.SHADOWWATCH_EVIDENCE_TOKEN;
    const res = response();
    await delta({
      method:'POST',
      headers:{},
      body:{ action:'run', report_id:'SW-20260923-ABCDE', stream:true }
    }, res);

    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body, {
      error:'PREVIEW_READ_ONLY_NO_ACQUISITION',
      preview_read_only:true,
      live_acquisition_disabled:true,
      evidence_reads_allowed:true
    });

    // The browser must treat the preview refusal as terminal rather than
    // dropping into the direct-XRPL anchor/account_tx branch.
    const core = fs.readFileSync(path.join(__dirname, '../src/brief/02-core.js'), 'utf8');
    const catchAt = core.indexOf("var _previewReadOnly=/PREVIEW_READ_ONLY_NO_ACQUISITION|EVIDENCE_WRITE_REFUSED_NON_PRODUCTION/");
    const throwAt = core.indexOf("throw _previewErr;", catchAt);
    const fallbackAt = core.indexOf("log('Evidence index unavailable — direct XRPL acquisition:", catchAt);
    const directAt = core.indexOf("state.anchorAttempts.push({ source:'DIRECT_XRPL'", catchAt);
    assert(catchAt > -1, 'preview terminal decision missing');
    assert(throwAt > catchAt, 'preview path must throw terminal incomplete error');
    assert(fallbackAt > throwAt, 'ordinary fallback must remain after preview terminal branch');
    assert(directAt > fallbackAt, 'direct XRPL path must be downstream of the terminal preview throw');
    assert(core.includes("no direct 418-wallet crawl was started"));

    // Production must not be blocked by the preview policy. An invalid report id
    // should reach the normal production validation and return its existing 400.
    process.env.VERCEL_ENV = 'production';
    const prod = response();
    await delta({
      method:'POST',
      headers:{},
      body:{ action:'run', report_id:'BAD-ID' }
    }, prod);
    assert.equal(prod.statusCode, 400);
    assert.equal(prod.body.error, 'INVALID_REPORT_ID');

    console.log('ALL PREVIEW NO-DIRECT-XRPL-FALLBACK CHECKS PASS');
  } finally {
    if (savedEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = savedEnv;
    if (savedToken === undefined) delete process.env.SHADOWWATCH_EVIDENCE_TOKEN;
    else process.env.SHADOWWATCH_EVIDENCE_TOKEN = savedToken;
  }
})().catch(e => { console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });

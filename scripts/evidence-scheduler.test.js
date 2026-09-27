#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const handler = require('../api/evidence-scheduler');
const S = handler._test;
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + ' -> ' + e.message); }
}

function fakeRes() {
  return {
    code: null, body: null, headers: {},
    setHeader(k,v){ this.headers[k]=v; },
    status(n){ this.code=n; return this; },
    json(v){ this.body=v; return this; }
  };
}

async function main() {
  const secret = '0123456789abcdef0123456789abcdef';

  check('cron auth accepts exact bearer secret', () => {
    assert.equal(S.authorized({headers:{authorization:'Bearer '+secret}}, {CRON_SECRET:secret}).ok, true);
  });
  check('cron auth refuses absent/short secret', () => {
    assert.equal(S.authorized({headers:{}}, {CRON_SECRET:'short'}).error, 'CRON_SECRET_NOT_CONFIGURED');
  });
  check('cron auth refuses wrong bearer', () => {
    assert.equal(S.authorized({headers:{authorization:'Bearer wrong'}}, {CRON_SECRET:secret}).error, 'UNAUTHORIZED');
  });
  check('scheduler is opt-in', () => {
    assert.equal(S.enabled({SHADOWWATCH_EVIDENCE_SCHEDULER_ENABLED:'true'}), true);
    assert.equal(S.enabled({SHADOWWATCH_EVIDENCE_SCHEDULER_ENABLED:'false'}), false);
    assert.equal(S.enabled({}), false);
  });
  check('scheduler run id is evidence-only and valid', () => {
    const id = S.schedulerReportId(Date.UTC(2026,8,23,18,0,0), () => Buffer.from([0xab,0xcd,0xef]));
    assert.equal(id, 'SW-20260923-EABCD');
    assert(/^SW-\d{8}-[A-Z0-9]{5}$/.test(id));
  });
  check('result classification preserves resumable incomplete work', () => {
    assert.deepEqual(S.classify({committed:true}), {status:'ADVANCED',httpStatus:200,ok:true});
    assert.deepEqual(S.classify({committed:false,reason:'ANCHOR_NOT_ADVANCED'}), {status:'CURRENT',httpStatus:200,ok:true});
    assert.deepEqual(S.classify({committed:false,reason:'RUN_INCOMPLETE'}), {status:'RESUMABLE_INCOMPLETE',httpStatus:202,ok:true});
    assert.deepEqual(S.classify({committed:false,reason:'RUN_CONTRADICTED'}), {status:'BLOCKED',httpStatus:503,ok:false});
  });
  check('scheduler retries only resumable or transient failures', () => {
    assert.equal(S.retryableResult({committed:false,reason:'RUN_INCOMPLETE'}), true);
    assert.equal(S.retryableResult({committed:false,reason:'RUN_CONTRADICTED'}), false);
    assert.equal(S.retryableError(new Error('XRPL connection timeout')), true);
    assert.equal(S.retryableError(new Error('EVIDENCE_STATE_MISSING')), false);
  });

  let released = false, called = null;
  const reader = { stats:{requests:7}, deadline:0 };
  const out = await S.runScheduledAcquisition({
    now: () => Date.UTC(2026,8,23,18,0,0),
    makeReportId: () => 'SW-20260923-EAAAA',
    selectRoster: () => ({accounts:['rAlice','rBob']}),
    acquireReader: () => reader,
    releaseReader: r => { assert.strictEqual(r, reader); released = true; },
    acquire: async (job, deps) => {
      called = {job,deps};
      deps.onPhase('plan',{wallets:2});
      return {committed:true,reason:'COMMITTED',anchor_ledger:107200000,anchor_close:'2026-09-23T18:00:00.000Z',
        state_version:40,target_wallets:2,complete_wallets:2,failed_wallets:0,transactions:12,xrpl_requests:7};
    },
    silent:true
  });
  check('scheduler calls existing acquisition core with committed roster', () => {
    assert.deepEqual(called.job.roster,['rAlice','rBob']);
    assert.equal(called.job.max_admissions,S.MAX_ADMISSIONS);
    assert.equal(called.job.window_start_ms,null);
    assert.equal(called.job.window_end_ms,null);
    assert.equal(called.deps.concurrency,S.CONCURRENCY);
  });
  check('scheduler gives acquisition the same bounded read budget', () => {
    assert.equal(reader.deadline, Date.UTC(2026,8,23,18,0,0)+S.READ_BUDGET_MS);
  });
  check('scheduler releases reader and returns compact advance status', () => {
    assert.equal(released,true);
    assert.equal(out.httpStatus,200);
    assert.equal(out.body.status,'ADVANCED');
    assert.equal(out.body.anchor_ledger,107200000);
    assert.equal(out.body.complete_wallets,2);
    assert(out.body.phases.some(p => p.phase === 'plan'));
  });

  released = false;
  const retryStart = Date.UTC(2026,8,23,19,0,0);
  let retryCalls = 0, retryReleases = 0;
  const retryJobs = [];
  const retryReaders = [
    {stats:{requests:3},deadline:0},
    {stats:{requests:2},deadline:0}
  ];
  const retried = await S.runScheduledAcquisition({
    now: () => retryStart,
    clockNow: () => retryStart + 60000,
    makeReportId: () => 'SW-20260923-EBBBB',
    selectRoster: () => ({accounts:['rAlice']}),
    acquireReader: () => retryReaders[retryCalls],
    releaseReader: () => { retryReleases++; },
    acquire: async (job, deps) => {
      retryJobs.push(job);
      retryCalls++;
      if (retryCalls === 1) {
        deps.onPhase('wallet',{address:'rAlice',status:'FAILED'});
        return {committed:false,reason:'RUN_INCOMPLETE',target_wallets:1,complete_wallets:0,
          failed_wallets:1,transactions:0,xrpl_requests:3,resumed:{adopted:false}};
      }
      deps.onPhase('journal',{adopted:true,wallets_already_walked:0});
      return {committed:true,reason:'COMMITTED',anchor_ledger:107200100,
        anchor_close:'2026-09-23T19:00:00.000Z',state_version:41,target_wallets:1,
        complete_wallets:1,failed_wallets:0,transactions:4,xrpl_requests:2,
        resumed:{adopted:true,report_id:'SW-20260923-EBBBB'}};
    },
    silent:true
  });
  check('incomplete scheduler run retries once and can advance', () => {
    assert.equal(retryCalls,2);
    assert.equal(retryReleases,2);
    assert.equal(retried.httpStatus,200);
    assert.equal(retried.body.status,'ADVANCED');
    assert.equal(retried.body.attempts,2);
    assert.equal(retried.body.retried,true);
    assert.equal(retried.body.retry_exhausted,false);
    assert.equal(retried.body.xrpl_requests,5);
    assert(retried.body.phases.some(p => p.phase === 'retry' && p.trigger === 'RUN_INCOMPLETE'));
  });
  check('retry preserves report id and one absolute read deadline', () => {
    assert.equal(retryJobs.length,2);
    assert.strictEqual(retryJobs[0],retryJobs[1]);
    assert.equal(retryJobs[0].report_id,'SW-20260923-EBBBB');
    assert.equal(retryReaders[0].deadline,retryStart+S.READ_BUDGET_MS);
    assert.equal(retryReaders[1].deadline,retryStart+S.READ_BUDGET_MS);
  });

  let budgetCalls = 0, budgetReleases = 0;
  const incomplete = await S.runScheduledAcquisition({
    now: () => retryStart,
    clockNow: () => retryStart + S.READ_BUDGET_MS - S.RETRY_MIN_REMAINING_MS + 1,
    makeReportId: () => 'SW-20260923-EDDDD',
    selectRoster: () => ({accounts:['rAlice']}),
    acquireReader: () => ({stats:{requests:3},deadline:0}),
    releaseReader: () => { budgetReleases++; },
    acquire: async () => {
      budgetCalls++;
      return {committed:false,reason:'RUN_INCOMPLETE',target_wallets:1,complete_wallets:0,
        failed_wallets:1,transactions:0,xrpl_requests:3,resumed:{adopted:true}};
    },
    silent:true
  });
  check('incomplete run stays resumable when there is not enough safe retry budget', () => {
    assert.equal(budgetCalls,1);
    assert.equal(budgetReleases,1);
    assert.equal(incomplete.httpStatus,202);
    assert.equal(incomplete.body.status,'RESUMABLE_INCOMPLETE');
    assert.equal(incomplete.body.committed,false);
    assert.equal(incomplete.body.attempts,1);
    assert.equal(incomplete.body.retried,false);
    assert.equal(incomplete.body.retry_skipped,'INSUFFICIENT_BUDGET');
  });

  released = false;
  let threw = false;
  try {
    await S.runScheduledAcquisition({
      now: () => 1,
      makeReportId: () => 'SW-20260923-ECCCC',
      selectRoster: () => ({accounts:['rAlice']}),
      acquireReader: () => ({stats:{requests:0}}),
      releaseReader: () => { released=true; },
      acquire: async () => { throw new Error('INJECTED'); },
      silent:true
    });
  } catch (e) { threw = /INJECTED/.test(e.message); }
  check('reader is released when acquisition throws', () => assert(threw && released));

  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT,'vercel.json'),'utf8'));
  check('Vercel registers 12 Hobby-safe two-hour production cron slots', () => {
    const c=(vercel.crons||[]).filter(x=>x.path==='/api/evidence-scheduler');
    assert.equal(c.length,12);
    assert.deepEqual(c.map(x=>x.schedule), [
      '5 0 * * *','5 2 * * *','5 4 * * *','5 6 * * *','5 8 * * *','5 10 * * *',
      '5 12 * * *','5 14 * * *','5 16 * * *','5 18 * * *','5 20 * * *','5 22 * * *'
    ]);
    assert(c.every(x => /^5 (?:[02468]|1[02468]|2[02]) \* \* \*$/.test(x.schedule)));
  });
  check('scheduler function keeps 300s function ceiling', () => {
    assert.equal(vercel.functions['api/evidence-scheduler.js'].maxDuration,300);
  });

  const oldEnv = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    CRON_SECRET: process.env.CRON_SECRET,
    SHADOWWATCH_EVIDENCE_SCHEDULER_ENABLED: process.env.SHADOWWATCH_EVIDENCE_SCHEDULER_ENABLED
  };
  try {
    process.env.VERCEL_ENV='preview'; process.env.CRON_SECRET=secret; process.env.SHADOWWATCH_EVIDENCE_SCHEDULER_ENABLED='true';
    let res=fakeRes(); await handler({method:'GET',headers:{authorization:'Bearer '+secret}},res);
    check('preview invocation is refused before acquisition', () => assert.equal(res.code,403));

    process.env.VERCEL_ENV='production'; process.env.CRON_SECRET=''; process.env.SHADOWWATCH_EVIDENCE_SCHEDULER_ENABLED='true';
    res=fakeRes(); await handler({method:'GET',headers:{}},res);
    check('production without CRON_SECRET fails closed', () => assert.equal(res.code,503));

    process.env.CRON_SECRET=secret; process.env.SHADOWWATCH_EVIDENCE_SCHEDULER_ENABLED='false';
    res=fakeRes(); await handler({method:'GET',headers:{authorization:'Bearer '+secret}},res);
    check('production scheduler remains disabled until explicit gate', () => {
      assert.equal(res.code,200); assert.equal(res.body.status,'DISABLED'); assert.equal(res.body.evidence_write_attempted,false);
    });
  } finally {
    for (const [k,v] of Object.entries(oldEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k]=v;
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });

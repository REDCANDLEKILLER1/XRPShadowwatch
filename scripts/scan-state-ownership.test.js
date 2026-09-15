#!/usr/bin/env node
/* ── NO LAYER MAY MANIPULATE ANOTHER LAYER'S STATE TO STEER IT ───────────────
   Two defects in 17-report-scan-tuning-20260816.js, both about one layer
   reaching into state it does not own.

   1. THE SAVED BALANCE BASELINE WAS OVERWRITTEN TO STEER THE SELECTOR.

      The legacy scanner sends a wallet to Phase 2 when it has no prior
      snapshot, so the wrapper wrote '{}' over the persistent baseline to make
      every wallet look new, held the real one in a page variable, and restored
      it in `finally`. For the length of a scan — twelve minutes on
      SW-20260915-D49XL — the only durable copy of the baseline was an empty
      object. A reload, a crash or an OS kill in that window leaves the device
      with no prior balances at all, which is the recurring "no prior balances
      on this device" report.

      Evidence is not a control channel. The selector now takes an explicit
      input and the committed baseline is never written until real readings
      replace it.

   2. THE STALE-PROOF RESET CLEARED NOTHING.

      `proofByAccount` is declared inside installCompleteAccountTxPagination
      (line 407, closing at 691). installEveryCheckedWalletPhase2 — a SIBLING
      function starting at 693 — opened its scan wrapper with

          try { for (var _k in proofByAccount) delete proofByAccount[_k]; } catch (_) {}

      which cannot see that variable. The ReferenceError went into the empty
      catch and the table was never cleared, so the very stale proof the
      comment describes was free to survive into the next run. The same
      function reads the table correctly nine lines later, through
      accountTxWindowDepth._proofByAccount.

   Run: node scripts/scan-state-ownership.test.js
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const L17  = fs.readFileSync(path.join(ROOT, 'src/brief/17-report-scan-tuning-20260816.js'), 'utf8');
const CORE = fs.readFileSync(path.join(ROOT, 'src/brief/02-core.js'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

console.log('SCAN STATE OWNERSHIP — EVIDENCE IS NOT A CONTROL CHANNEL\n');

// ══ 0. THE ARRANGEMENT THAT CAUSED IT IS STILL THE ARRANGEMENT ═══════════════
// If the two installers were ever merged, the scope bug would vanish on its own
// and these checks would pass while proving nothing. Pin the shape first.
console.log('0. the two installers are still separate functions');
const declAt   = L17.indexOf('var proofByAccount = Object.create(null);');
const instAAt  = L17.indexOf('function installCompleteAccountTxPagination()');
const instBAt  = L17.indexOf('function installEveryCheckedWalletPhase2()');
check('the proof table is declared inside the first installer',
      declAt > instAAt && declAt < instBAt, { declAt, instAAt, instBAt });
check('the scan wrapper lives in a later, separate function', instBAt > instAAt);
check('the table is published on the function object',
      /accountTxWindowDepth\._proofByAccount = proofByAccount;/.test(L17));

// ══ 1. THE RESET CLEARS THE TABLE THAT ACTUALLY EXISTS ═══════════════════════
console.log('\n1. the stale-proof reset clears the real table');
const wrapperBody = L17.slice(instBAt, instBAt + 2400);
check('no bare proofByAccount is referenced from the sibling',
      !/for \(var _k in proofByAccount\)/.test(L17),
      (/for \(var _k in proofByAccount\)[^\n]*/.exec(L17) || [])[0]);
// Order, not character offset: the reset must run before the wrapper reads
// anything, and a fixed slice just measures how long the comment above it is.
const resetAt = wrapperBody.indexOf('accountTxWindowDepth._proofByAccount');
const firstReadAt = wrapperBody.indexOf('readPreviousSnapshot()');
check('the reset goes through accountTxWindowDepth._proofByAccount', resetAt > -1, resetAt);
check('and it runs before the wrapper reads any state',
      resetAt > -1 && firstReadAt > -1 && resetAt < firstReadAt, { resetAt, firstReadAt });
check('the reset is not hidden behind an empty catch that swallows its own bug',
      !/try \{ for \(var _k in proofByAccount\) delete proofByAccount\[_k\]; \} catch \(_\) \{\}/.test(L17));


// ── THE HARNESS HOLDS THE SCAN OPEN ─────────────────────────────────────────
// An earlier version of this file started the wrapper with
// `wrapped().then(()=>{}).catch(()=>{})` and asserted immediately, so a check
// labelled "after the scan" was reading the same instant as the in-flight one
// and any rejection was swallowed. Every lifecycle below is awaited, and the
// inner scanner is held on a gate so "during" and "after" are genuinely
// different moments.
const vm = require('vm');
const KEY = 'shadowwatch_snapshot_v30';

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function driveLayer17() {
  const store = {};
  const seen = { tableAtInnerStart: null, innerCalls: 0 };
  const ctx = {
    console, Object, Array, JSON, Math, Date, Number, String, Boolean, RegExp,
    Error, Promise, isNaN, parseInt, parseFloat,
    setTimeout: f => { try { f(); } catch (_) {} return 0; },
    clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    document: { createElement: () => ({ setAttribute() {} }), body: { appendChild() {} },
                addEventListener() {}, readyState: 'complete', getElementById: () => null },
    state: { wallets: [], indexRun: null, effectiveWindow: null },
    log: () => {}, elog: () => {},
    accountTxWindowDepth: async function () { return []; },
    pageDepthFor: function () { return 1; },
    WATCHLIST: [], KNOWN: {}, n: v => Number(v) || 0
  };
  // The scanner layer 17 wraps. It reports what it saw of the proof table at
  // the moment it began — after the wrapper's reset, before anything else —
  // and writes ONLY the wallets it read, exactly as the legacy scanner does.
  ctx.scanWallets = async function () {
    seen.innerCalls++;
    const table = ctx.accountTxWindowDepth._proofByAccount || {};
    seen.tableAtInnerStart = Object.keys(table).length;
    if (ctx.__gate) await ctx.__gate.promise;
    ctx.state.wallets = [{ address: 'rAAA', status: 'CHECKED', balance_xrp: 111 }];
    store[KEY] = JSON.stringify({ rAAA: { balance_xrp: 111 } });   // rBBB not read
    return ctx.state.wallets;
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(L17, ctx, { filename: '17-report-scan-tuning.js' });
  return { ctx, store, seen };
}

const BASELINE = JSON.stringify({ rAAA: { balance_xrp: 100 }, rBBB: { balance_xrp: 200 } });

(async () => {

  // ══ 4. A SCAN THAT IS GENUINELY IN FLIGHT ══════════════════════════════════
  console.log('\n4. while the scan is actually running');
  {
    const d = driveLayer17();
    d.store[KEY] = BASELINE;
    d.ctx.__gate = deferred();
    const running = d.ctx.scanWallets();          // started, deliberately not awaited yet
    await Promise.resolve();                       // let it reach the gate
    check('the inner scanner really is in flight', d.seen.innerCalls === 1, d.seen.innerCalls);
    check('the committed baseline is untouched mid-scan', d.store[KEY] === BASELINE, d.store[KEY]);
    check('every wallet is still named in it',
          Object.keys(JSON.parse(d.store[KEY] || '{}')).length === 2);
    check('the selection request is set while the scan runs',
          d.ctx.state._proveEveryCheckedWallet === true);

    // ── now let it finish, and await it ──
    d.ctx.__gate.resolve();
    await running;
    const after = JSON.parse(d.store[KEY] || '{}');
    check('after completion, the fresh reading wins', after.rAAA && after.rAAA.balance_xrp === 111, after.rAAA);
    check('after completion, the unread wallet keeps its prior baseline',
          after.rBBB && after.rBBB.balance_xrp === 200, after.rBBB);
    check('no wallet was dropped from the baseline', Object.keys(after).length === 2, Object.keys(after));
    check('the selection request is cleared when the run ends',
          d.ctx.state._proveEveryCheckedWallet === false, d.ctx.state._proveEveryCheckedWallet);
  }

  // ══ 5. A SCAN THAT FAILS ═══════════════════════════════════════════════════
  // The window a reload or an OS kill lands in is also the window a throw lands
  // in. Nothing it wrote can be trusted, so the baseline goes back byte for byte.
  console.log('\n5. when the scan throws');
  {
    const d = driveLayer17();
    d.store[KEY] = BASELINE;
    d.ctx.__gate = deferred();
    const running = d.ctx.scanWallets();
    await Promise.resolve();
    check('the baseline is intact before the failure', d.store[KEY] === BASELINE);
    d.ctx.__gate.reject(new Error('XRPL link down'));
    let threw = null;
    try { await running; } catch (e) { threw = e; }
    check('the failure reaches the caller rather than being swallowed',
          threw && /XRPL link down/.test(threw.message), threw && threw.message);
    check('the baseline is restored byte for byte', d.store[KEY] === BASELINE, d.store[KEY]);
    check('the selection request is cleared on the failure path too',
          d.ctx.state._proveEveryCheckedWallet === false, d.ctx.state._proveEveryCheckedWallet);
  }

  // ══ 6. TWO RUNS, IN SEQUENCE ═══════════════════════════════════════════════
  // The ticket's own acceptance test: run A proves a wallet, run B does not,
  // and A's proof must not survive as B's.
  console.log('\n6. run A proves a wallet; run B must not inherit it');
  {
    const d = driveLayer17();
    d.store[KEY] = BASELINE;
    await d.ctx.scanWallets();                                     // run A, awaited
    const table = d.ctx.accountTxWindowDepth._proofByAccount;
    table['rPROVED_IN_A'] = { status: 'COMPLETE', source: 'RUN_A', run_id: 'A' };
    check('run A left a proof behind', Object.keys(table).length === 1, Object.keys(table));

    await d.ctx.scanWallets();                                     // run B, awaited
    check('run B began with an empty proof table',
          d.seen.tableAtInnerStart === 0, { atInnerStart: d.seen.tableAtInnerStart });
    check('A’s proof is gone, not merely shadowed',
          !d.ctx.accountTxWindowDepth._proofByAccount['rPROVED_IN_A']);
    check('the table object was not swapped out from under its writer',
          d.ctx.accountTxWindowDepth._proofByAccount === table);
    check('both runs really ran', d.seen.innerCalls === 2, d.seen.innerCalls);
  }

  console.log('\n7. the request is scan input, not stored evidence (source guard)');
  check('the flag is cleared when the scan ends', /_proveEveryCheckedWallet = false/.test(L17));
  check('the flag lives on run state, not in localStorage',
        !/localStorage[^\n]*_proveEveryCheckedWallet/.test(L17));

  console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASS' : pass + ' pass, ' + fail + ' FAIL'));
  process.exit(fail === 0 ? 0 : 1);

})().catch(e => {
  // An unexpected rejection is a failure, not a silent pass.
  console.error('\nHARNESS ERROR: ' + (e && e.stack || e));
  process.exit(1);
});

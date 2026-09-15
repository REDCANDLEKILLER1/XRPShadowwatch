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

// The behaviour the ticket asks for: run A proves a wallet, run B does not,
// and A's proof must not survive as B's. Driven through the real wrapper.
console.log('\n   run A proves a wallet; run B must not inherit it');
function driveLayer17() {
  const store = {};
  const ctx = {
    console,
    Object, Array, JSON, Math, Date, Number, String, Boolean, RegExp, Error, Promise, isNaN, parseInt, parseFloat,
    setTimeout: (f) => { try { f(); } catch (_) {} return 0; },
    clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    // Enough DOM for the tail of the file, which appends loader scripts.
    document: { createElement: () => ({ setAttribute() {} }), body: { appendChild() {} },
                addEventListener() {}, readyState: 'complete', getElementById: () => null },
    state: { wallets: [], indexRun: null, effectiveWindow: null },
    log: () => {}, elog: () => {},
    accountTxWindowDepth: async function () { return []; },
    scanWallets: async function () { return []; },
    pageDepthFor: function () { return 1; },
    WATCHLIST: [], KNOWN: {}, n: v => Number(v) || 0
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  const vm = require('vm');
  vm.createContext(ctx);
  vm.runInContext(L17, ctx, { filename: '17-report-scan-tuning.js' });
  return { ctx, store };
}

let drive = null;
try { drive = driveLayer17(); } catch (e) { console.log('     (harness error: ' + e.message + ')'); }
check('layer 17 loaded and wrapped the scanner',
      !!drive && typeof drive.ctx.scanWallets === 'function' &&
      drive.ctx.scanWallets._swTxCompleteness20260819 === true,
      drive && !!drive.ctx.scanWallets._swTxCompleteness20260819);
check('the proof table is reachable where the reset must look',
      !!drive && !!drive.ctx.accountTxWindowDepth._proofByAccount);

if (drive) {
  const table = drive.ctx.accountTxWindowDepth._proofByAccount;
  // Run A leaves a proof behind.
  table['rWALLET_PROVED_IN_RUN_A'] = { status: 'COMPLETE', source: 'RUN_A', run_id: 'A' };
  check('run A left a proof in the table', Object.keys(table).length === 1);
  // Run B starts.
  let duringB = null;
  drive.ctx.scanWallets.constructor === Function;
  const origInner = drive.ctx.scanWallets;
  return2(origInner);
  function return2(fn) {
    // Capture the table contents as the wrapped scanner begins its run.
    const inner = drive.ctx.accountTxWindowDepth._proofByAccount;
    fn().then(() => {}).catch(() => {});
    duringB = Object.keys(inner).length;
  }
  check('run B cleared the previous run\'s proof before doing anything',
        duringB === 0, { remaining: duringB });
  check('and the table object itself was not replaced out from under its writer',
        drive.ctx.accountTxWindowDepth._proofByAccount === table);
}

// ══ 2. THE COMMITTED BASELINE IS NEVER OVERWRITTEN TO STEER A SELECTOR ═══════
console.log('\n2. the saved balance baseline is left alone during a scan');
check('nothing writes an empty object over the snapshot',
      !/localStorage\.setItem\(SNAPSHOT_KEY, '\{\}'\)/.test(L17),
      (/localStorage\.setItem\(SNAPSHOT_KEY[^\n]*/.exec(L17) || [])[0]);
check('Phase-2 selection is requested explicitly instead',
      /_proveEveryCheckedWallet/.test(L17), 'layer 17 sets the flag');
check('the core selector honours that request',
      /_proveEveryCheckedWallet/.test(CORE) &&
      /row\._needsTx = firstScan \|\| balanceChanged \|\| isActive \|\| /.test(CORE),
      (/row\._needsTx = [^\n]*/.exec(CORE) || [])[0]);

if (drive) {
  const KEY = 'shadowwatch_snapshot_v30';
  const BASELINE = JSON.stringify({ rAAA: { balance_xrp: 100 }, rBBB: { balance_xrp: 200 } });
  drive.store[KEY] = BASELINE;
  let seenDuringScan = null;
  drive.ctx.scanWallets._swTxCompleteness20260819 && (function () {
    // Re-wrap the inner scanner so we can observe storage mid-scan, which is
    // exactly the window a reload or an OS kill lands in.
    const wrapped = drive.ctx.scanWallets;
    wrapped().then(() => {}).catch(() => {});
    seenDuringScan = drive.store[KEY];
  })();
  check('the committed baseline survives the whole in-flight scan',
        seenDuringScan === BASELINE, { during: seenDuringScan });
  check('it is still there after the scan', drive.store[KEY] === BASELINE, drive.store[KEY]);
}

console.log('\n3. the request is scan input, not stored evidence (source guard)');
check('the flag is cleared when the scan ends', /_proveEveryCheckedWallet = false/.test(L17));
check('the flag lives on run state, not in localStorage',
      !/localStorage[^\n]*_proveEveryCheckedWallet/.test(L17));

console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASS' : pass + ' pass, ' + fail + ' FAIL'));
process.exit(fail === 0 ? 0 : 1);

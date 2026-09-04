#!/usr/bin/env node
/* ── CANONICAL ESCROW MODEL ───────────────────────────────────────────────────
   One escrow truth layer. These are the acceptance tests the audit specified:

     - a Ripple EscrowFinish is attributed to its TRUE owner;
     - a third-party finisher does not change that owner;
     - non-Ripple escrow stays observed-only;
     - NO surface can render a total XRPL escrow number;
     - report / debug / UI read the same facts.

   Plus the rule that the four counts are never substituted for one another,
   and the rule that an event whose owner cannot be resolved is reported as
   unresolved rather than defaulted to either side.

   Run: node scripts/canonical-escrow-model.test.js
   Env: SW_TEST_PORT to override the port (default 8331).
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SW_TEST_PORT || 8331);
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
               '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png' };

function serve() {
  return http.createServer((q, r) => {
    let u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/') u = '/index.html';
    const f = path.join(ROOT, u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      r.writeHead(404); r.end('not found'); return;
    }
    r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(r);
  }).listen(PORT);
}
function chromium() {
  try { return require('playwright').chromium; }
  catch (_) { return require('/opt/node22/lib/node_modules/playwright').chromium; }
}

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

(async () => {
  const srv = serve();
  const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium().launch(
    fs.existsSync(exe) ? { executablePath: exe, args: ['--no-sandbox'] } : { args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.route('**/*', r =>
    r.request().url().startsWith('http://127.0.0.1:' + PORT) ? r.continue() : r.abort());
  await page.goto('http://127.0.0.1:' + PORT + '/brief-console.html', { waitUntil: 'domcontentloaded' });
  // The model is injected by 29's loader chain; wait for it rather than sleeping.
  await page.waitForFunction(() =>
    !!window.SW_ESCROW_MODEL && !!window.SW_RIPPLE_ESCROW_REGISTRY, null, { timeout: 60000 });

  console.log('CANONICAL ESCROW MODEL\n');

  const r = await page.evaluate(() => {
    const out = {};
    const M = window.SW_ESCROW_MODEL;
    const reg = window.SW_RIPPLE_ESCROW_REGISTRY;
    const RIPPLE_A = reg.addresses[0];
    const RIPPLE_B = reg.addresses[1];
    const OUTSIDER = 'rFlareCoreVaultZZZZZZZZZZZZZZZZZZZ';
    const FINISHER = 'rThirdPartyFinisherQQQQQQQQQQQQQQQ';
    const now = Date.now();

    out.registryLoaded = !!(reg && reg.addresses && reg.addresses.length);
    out.registrySize = reg.addresses.length;

    // ── OWNERSHIP IS REGISTRY-DERIVED, NEVER LABEL-DERIVED ─────────────
    out.rippleIsRipple   = M.isRippleOwner(RIPPLE_A) === true;
    out.outsiderNotRipple = M.isRippleOwner(OUTSIDER) === false;
    // a wallet merely LABELLED like Ripple's is not Ripple's
    out.labelIsNotIdentity = M.isRippleOwner('rNotInRegistryButNamedRIPPLEXXXXX') === false;

    // ── OWNER COMES FROM THE ESCROW LEDGER NODE, NOT THE SUBMITTER ─────
    out.ownerFromNode = M.ownerOf({ type: 'UNLOCK', owner: RIPPLE_A, from: FINISHER }) === RIPPLE_A;
    out.createOwnerIsSubmitter = M.ownerOf({ type: 'LOCK', from: OUTSIDER }) === OUTSIDER;
    out.unresolvedStaysNull = M.ownerOf({ type: 'UNLOCK', from: FINISHER }) === null;

    const realState = { escrow: state.escrow, pos: state.rippleEscrowPosition };
    try {
      // A sweep that answered every address: 3 objects across 2 owners.
      state.rippleEscrowPosition = {
        complete: true, status: 'COMPLETE',
        registry_addresses_checked: 20, rpc_responses_received: 20,
        expected_owners: 20, answered_owners: 20,
        active_objects: 3, active_escrow_owners: 2,
        locked_xrp: 31700000000, registry_version: 'test', ledger_index: 99
      };
      state.escrow = [
        // Ripple's escrow, finished by a stranger -> still Ripple's
        { hash: 'a'.repeat(64), type: 'UNLOCK', xrp: 500000000, owner: RIPPLE_A,
          from: FINISHER, ts: now - 1000 },
        // a Ripple address finishing a stranger's escrow -> NOT Ripple's
        { hash: 'b'.repeat(64), type: 'UNLOCK', xrp: 40000000, owner: OUTSIDER,
          from: RIPPLE_B, ts: now - 2000 },
        // a genuine Ripple lock
        { hash: 'c'.repeat(64), type: 'LOCK', xrp: 200000000, owner: RIPPLE_B, ts: now - 3000 },
        // an event whose owner could not be resolved
        { hash: 'd'.repeat(64), type: 'UNLOCK', xrp: 7000000, owner: null, ts: now - 4000 }
      ];
      const m = M.build();
      out.model = {
        rippleReleases: m.ripple.activity.releases,
        rippleReleasedXrp: m.ripple.activity.released_xrp,
        rippleLocks: m.ripple.activity.locks,
        otherReleases: m.other_observed.activity.releases,
        otherOwners: m.other_observed.owners_observed,
        unattributed: m.unattributed_events
      };
      // the stranger-finished Ripple release counts as Ripple's
      out.rippleKeepsOwnRelease = m.ripple.activity.releases === 1 &&
                                  m.ripple.activity.released_xrp === 500000000;
      // the Ripple-finished outsider release does NOT
      out.outsiderNotFolded = m.other_observed.activity.releases === 1 &&
                              m.other_observed.owners_observed === 1;
      // unresolved ownership is reported, not defaulted to either side
      out.unresolvedReported = m.unattributed_events === 1;
      out.unresolvedNotInOther = m.other_observed.activity.releases === 1;

      // ── FOUR NUMBERS, NEVER SUBSTITUTED ─────────────────────────────
      out.four = {
        checked: m.ripple.registry_addresses_checked,
        answered: m.ripple.rpc_responses_received,
        objects: m.ripple.active_escrow_objects,
        owners: m.ripple.active_escrow_owners
      };
      out.fourDistinct = m.ripple.registry_addresses_checked === 20 &&
                         m.ripple.rpc_responses_received === 20 &&
                         m.ripple.active_escrow_objects === 3 &&
                         m.ripple.active_escrow_owners === 2;

      // ── NO TOTAL XRPL ESCROW, ANYWHERE ──────────────────────────────
      out.otherIsNotTotal = m.other_observed.is_total === false &&
                            /observed in this scan/i.test(m.other_observed.scope);
      // no field on the model may combine the two sides
      const flat = JSON.stringify(m);
      out.noCombinedField = !/total_xrpl_escrow|all_escrow_total|xrpl_escrow_total/i.test(flat);
      const rippleLocked = m.ripple.locked_xrp;
      const otherXrp = m.other_observed.activity.locked_xrp + m.other_observed.activity.released_xrp;
      const forbiddenSum = String(rippleLocked + otherXrp);
      out.noSumRendered = flat.indexOf(forbiddenSum) === -1;

      // ── THE DIAGNOSTICS BLOCK ───────────────────────────────────────
      const lines = M.diagnosticsLines(m);
      out.diag = lines.slice();
      const joined = lines.join('\n');
      // The heading must carry SOURCE, SCOPE and COVERAGE — "Ripple escrow:
      // 31.70B" alone can be quoted as "all Ripple-controlled escrow".
      out.diagNamesRipple = /Ripple-associated escrow observed:/.test(joined);
      out.diagHasSource   = /source: validated-ledger account_objects over the published Ripple registry/.test(joined);
      out.diagHasObjects  = /3 active escrow objects \(ledger objects, not owner wallets\)/.test(joined);
      out.diagHasOwners   = /2 owner wallet\(s\) currently holding escrow/.test(joined);
      out.diagSeparatesChecked = /20\/20 public owner coverage \(registry addresses answered\)/.test(joined);
      out.diagOtherObserved = /Other XRPL escrow observed in this scan/.test(joined) &&
                              /not a sweep of XRPL escrow/.test(joined);
      out.diagNoGenericTotal = !/Total XRPL escrow/i.test(joined);
      // 31.70B must never appear without the word Ripple on the same line
      out.lockedAlwaysNamed = lines.every(l => !/31\.70B/.test(l) || /Ripple/.test(l));
      out.diagReportsUnresolved = /unresolved ownership: 1/.test(joined);

      // ── PARTIAL SWEEP WITHHOLDS, IT DOES NOT ESTIMATE ───────────────
      state.rippleEscrowPosition = Object.assign({}, state.rippleEscrowPosition,
        { complete: false, status: 'PARTIAL', rpc_responses_received: 12, locked_xrp: 31700000000 });
      const p = M.build();
      out.partialWithholds = p.ripple.locked_xrp === null;
      out.partialSaysWhy = /WITHHELD/.test(M.diagnosticsLines(p).join('\n'));
    } catch (e) { out.err = String(e && e.message); }
    finally {
      state.escrow = realState.escrow; state.rippleEscrowPosition = realState.pos;
      M.invalidate();
    }
    return out;
  });

  console.log('1. the cohort is registry-derived');
  console.log('     registry addresses: ' + r.registrySize);
  check('the real registry is loaded (not a vacuous pass)', r.registryLoaded, r.err);
  check('a registry address is Ripple', r.rippleIsRipple, r.err);
  check('a non-registry address is not Ripple', r.outsiderNotRipple, r.err);
  check('a Ripple-sounding LABEL does not confer Ripple identity', r.labelIsNotIdentity);

  console.log('\n2. ownership comes from the escrow ledger node');
  check('an UNLOCK owner is the node owner, not the finisher', r.ownerFromNode);
  check('a LOCK owner is its creator', r.createOwnerIsSubmitter);
  check('an unresolvable owner stays null, never the submitter', r.unresolvedStaysNull);

  console.log('\n3. attribution survives a third-party finisher');
  console.log('     ' + JSON.stringify(r.model));
  check('a stranger finishing Ripple’s escrow keeps it Ripple’s', r.rippleKeepsOwnRelease, r.model);
  check('a Ripple address finishing a stranger’s escrow does NOT fold it in',
        r.outsiderNotFolded, r.model);
  check('an unresolved event is reported as unresolved', r.unresolvedReported, r.model);
  check('and is not silently counted as non-Ripple', r.unresolvedNotInOther, r.model);

  console.log('\n4. four numbers, never substituted');
  console.log('     ' + JSON.stringify(r.four));
  check('checked / answered / objects / owners are all distinct facts',
        r.fourDistinct, r.four);

  console.log('\n5. there is no total XRPL escrow');
  check('the other side is flagged not-a-total, scope stated', r.otherIsNotTotal);
  check('no model field combines the two sides', r.noCombinedField);
  check('the forbidden sum appears nowhere in the model', r.noSumRendered);
  check('the diagnostics block never says "Total XRPL escrow"', r.diagNoGenericTotal);

  console.log('\n6. the diagnostics block, model-owned');
  (r.diag || []).forEach(l => console.log('     | ' + l));
  check('the heading says Ripple-ASSOCIATED and OBSERVED', r.diagNamesRipple, r.diag);
  check('the block states its source', r.diagHasSource, r.diag);
  check('the locked figure never appears unattributed to Ripple', r.lockedAlwaysNamed, r.diag);
  check('active escrow OBJECTS are shown', r.diagHasObjects, r.diag);
  check('active escrow OWNERS are shown, separately', r.diagHasOwners, r.diag);
  check('addresses checked and responses received are separated',
        r.diagSeparatesChecked, r.diag);
  check('other escrow is labelled observed-in-this-scan, not a sweep',
        r.diagOtherObserved, r.diag);
  check('unresolved ownership is surfaced', r.diagReportsUnresolved, r.diag);

  console.log('\n7. an incomplete sweep withholds rather than estimates');
  check('a partial sweep yields locked_xrp = null', r.partialWithholds);
  check('and the block says WITHHELD with the coverage', r.partialSaysWhy);

  check('no page errors', errs.length === 0, errs.slice(0, 3));

  await browser.close(); srv.close();
  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

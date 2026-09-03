/* ── CANONICAL ESCROW MODEL ───────────────────────────────────────────────────
   ONE escrow truth layer, upstream of report, risk and UI.

   The escrow fixes in #50 were correct but were applied surface by surface, and
   several parts of ShadowWatch still decided independently what escrow means.
   This is the single place that decides, so a surface may SELECT and FORMAT but
   never compute or contradict.

       RAW XRPL DATA
             ↓
       ESCROW CLASSIFICATION      (type, owner, amount semantics)
             ↓
       CANONICAL ESCROW MODEL     ← here
        ├─ Ripple cohort          registry-derived, ledger-measured
        ├─ Other observed escrow  explicitly a scan by-product
        ├─ create / finish / cancel
        ├─ owner attribution      Escrow ledger node only
        └─ evidence completeness
             ↓
       REPORT · RISK · UI · DEBUG

   ── THE RULES THIS MODULE EXISTS TO ENFORCE ────────────────────────────────

   1. OWNER COMES ONLY FROM ESCROW LEDGER DATA.
      Never tx.Account / t.from. Anyone may submit an EscrowFinish, so the
      submitter is not the owner — attributing by submitter filed a stranger's
      release under "Ripple escrow" and Ripple's under "other", in both
      directions. An EscrowCreate's submitter IS its owner; that case is the
      only one where they coincide.

   2. RIPPLE IS A DERIVED COHORT.
      Membership comes from the published registry (ownership metadata sourced
      from Ripple's xrp-ledger.toml). Every amount and count comes from a
      ledger read. No total, owner count or per-owner amount is ever hardcoded:
      a committed number cannot disagree with the ledger, which is exactly what
      makes it dangerous.

   3. THERE IS NO TOTAL XRPL ESCROW.
      escrowBackfill queries only the registry addresses, so non-Ripple escrow
      is whatever happened to appear in scanned wallets' transactions plus a
      shared-storage backlog. That is a biased sample, not a measurement.
      It is published as "observed in this scan" and is NEVER added to the
      Ripple total — a sum of a full sweep and a sample is a false number.

   4. FOUR NUMBERS, NEVER SUBSTITUTED FOR ONE ANOTHER.
        registry_addresses_checked   how many addresses we asked about
        rpc_responses_received       how many answered
        active_escrow_objects        escrow ledger entries holding XRP
        active_escrow_owners         DISTINCT owners holding >= 1 of them
      Rendering an RPC-success count with the noun "owners" is what this rule
      forbids; that is what the report did before.

   5. TERMINOLOGY IS OWNED HERE.
      The published wording used to be produced by a regex rewriting finished
      report text. If the upstream sentence changed, the rewrite silently
      stopped matching and the old wording came back. The report must not need
      a cleanup layer to be truthful.

   Read-only. Computes nothing from the network; consumes what the position
   sweep and the escrow history already read off the validated ledger.
──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.SW_ESCROW_MODEL) return;

  var VERSION = 'canonical-escrow-model-20260903';

  function stateRef() {
    try { return (typeof state !== 'undefined') ? state : null; } catch (_) { return null; }
  }
  function registry() {
    try { return window.SW_RIPPLE_ESCROW_REGISTRY || null; } catch (_) { return null; }
  }

  // RULE 2 — cohort membership is registry-derived, never label-derived.
  // A wallet LABELLED "RIPPLE_ESCROW_42" is behavioural naming; it does not
  // make the escrow Ripple's. Only the published registry does.
  function isRippleOwner(address) {
    var r = registry();
    return !!(address && r && r.by_address && r.by_address[address]);
  }

  var ESCROW_TYPES = { EscrowCreate: 'LOCK', EscrowFinish: 'RELEASE', EscrowCancel: 'CANCEL' };

  // RULE 1 — the owner of an escrow event, or null when it cannot be resolved.
  // `escrow_owner` is read off the Escrow ledger node at ingest. For a LOCK the
  // submitter is provably the owner. For anything else an absent node means
  // UNKNOWN, and unknown is reported as unknown — never guessed, and never
  // silently defaulted to the non-Ripple side.
  function ownerOf(ev) {
    if (!ev) return null;
    if (ev.owner) return ev.owner;
    if (ev.escrow_owner) return ev.escrow_owner;
    var ty = ev.type || ev.TransactionType;
    if (ty === 'EscrowCreate' || ty === 'LOCK') return ev.from || ev.Account || null;
    return null;
  }

  function kindOf(ev) {
    if (!ev) return null;
    var ty = ev.type || ev.TransactionType || '';
    if (ESCROW_TYPES[ty]) return ESCROW_TYPES[ty];
    if (ty === 'UNLOCK' || ty === 'RELEASE') return 'RELEASE';
    if (ty === 'LOCK') return 'LOCK';
    if (ty === 'CANCEL') return 'CANCEL';
    return null;
  }

  function lookbackMs() {
    try { if (typeof escrowLookbackMs === 'function') return Number(escrowLookbackMs()) || 0; } catch (_) {}
    try { if (typeof window.escrowLookbackMs === 'function') return Number(window.escrowLookbackMs()) || 0; } catch (_) {}
    return 36 * 3600000;
  }

  function emptyActivity() {
    return { releases: 0, locks: 0, cancels: 0, released_xrp: 0, locked_xrp: 0 };
  }
  function addEvent(acc, ev) {
    var k = kindOf(ev), xrp = Number(ev && ev.xrp || 0) || 0;
    if (k === 'RELEASE') { acc.releases++; acc.released_xrp += xrp; }
    else if (k === 'LOCK') { acc.locks++; acc.locked_xrp += xrp; }
    else if (k === 'CANCEL') { acc.cancels++; }
  }

  // ── THE MODEL ─────────────────────────────────────────────────────────────
  function build() {
    var s = stateRef();
    var pos = (s && s.rippleEscrowPosition) || null;
    var rows = (s && Array.isArray(s.escrow)) ? s.escrow : [];
    var windowMs = lookbackMs();
    var cutoff = Date.now() - windowMs;

    var rippleAct = emptyActivity();
    var otherAct = emptyActivity();
    var otherOwners = {};
    var unattributed = 0;

    rows.forEach(function (ev) {
      if (!ev || Number(ev.ts || 0) < cutoff) return;
      var owner = ownerOf(ev);
      if (!owner) {
        // RULE 1 — an event whose owner cannot be resolved is counted as
        // unattributed. It is NOT added to "other": that would assert it is
        // not Ripple's, which is precisely what we could not determine.
        unattributed++;
        return;
      }
      if (isRippleOwner(owner)) addEvent(rippleAct, ev);
      else { addEvent(otherAct, ev); otherOwners[String(owner)] = true; }
    });

    var complete = !!(pos && pos.complete);

    return {
      version: VERSION,
      generated_at: new Date().toISOString(),
      window_hours: Math.round(windowMs / 3600000),

      // ── RIPPLE COHORT — full registry sweep, ledger-measured ────────────
      ripple: {
        cohort: 'Ripple monthly-release escrow',
        cohort_source: 'Ripple-published xrp-ledger.toml account metadata (registry)',
        registry_version: pos ? (pos.registry_version || null) : null,
        // RULE 4 — four distinct numbers.
        registry_addresses_checked: pos ? (pos.registry_addresses_checked != null
          ? pos.registry_addresses_checked : pos.expected_owners) : null,
        rpc_responses_received: pos ? (pos.rpc_responses_received != null
          ? pos.rpc_responses_received : pos.answered_owners) : null,
        active_escrow_objects: pos ? pos.active_objects : null,
        active_escrow_owners: pos ? (pos.active_escrow_owners != null ? pos.active_escrow_owners : null) : null,
        // Withheld rather than partial: a partial sweep cannot produce a total.
        locked_xrp: complete && pos ? pos.locked_xrp : null,
        complete: complete,
        status: pos ? pos.status : 'UNAVAILABLE',
        ledger_index: pos ? pos.ledger_index : null,
        activity: rippleAct
      },

      // ── OTHER ESCROW — OBSERVED ONLY, NEVER A TOTAL ─────────────────────
      other_observed: {
        scope: 'observed in this scan only — non-Ripple escrow is not swept',
        is_total: false,
        owners_observed: Object.keys(otherOwners).length,
        activity: otherAct
      },

      unattributed_events: unattributed

      // RULE 3 — there is deliberately NO combined total field. Adding a full
      // registry sweep to a biased sample would produce a number that looks
      // authoritative and is not.
    };
  }

  var cached = null;
  function get(opts) {
    if (!cached || (opts && opts.rebuild)) cached = build();
    return cached;
  }
  function invalidate() { cached = null; }

  // ── RULE 5 — the model owns the words, not a downstream rewrite ───────────
  function compactXrp(v) {
    var n = Number(v || 0);
    if (!isFinite(n)) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
    return String(Math.round(n));
  }

  // The compact factual block. Every line names whose escrow it describes and
  // what each number counts. No line may be read as a total XRPL figure.
  function diagnosticsLines(model) {
    var m = model || get();
    var R = m.ripple, O = m.other_observed, L = [];
    L.push('ESCROW DIAGNOSTICS');
    L.push('Ripple monthly-release escrow locked: ' +
      (R.locked_xrp != null ? compactXrp(R.locked_xrp) + ' XRP'
        : 'WITHHELD — registry sweep incomplete (' + R.rpc_responses_received + '/' +
          R.registry_addresses_checked + ' addresses answered)'));
    L.push('Active Ripple escrow objects: ' + (R.active_escrow_objects != null ? R.active_escrow_objects : '—'));
    L.push('Active Ripple escrow owners: ' + (R.active_escrow_owners != null ? R.active_escrow_owners : '—'));
    L.push('Ripple registry addresses checked: ' + (R.registry_addresses_checked != null ? R.registry_addresses_checked : '—') +
      ' · responses received: ' + (R.rpc_responses_received != null ? R.rpc_responses_received : '—'));
    L.push('Ripple escrow activity, last ' + m.window_hours + 'h: ' +
      R.activity.releases + ' release' + (R.activity.releases === 1 ? '' : 's') + ' · ' +
      R.activity.locks + ' new lock' + (R.activity.locks === 1 ? '' : 's'));
    L.push('Other XRPL escrow observed in this scan: ' +
      O.activity.releases + ' release' + (O.activity.releases === 1 ? '' : 's') + ' · ' +
      O.activity.locks + ' new lock' + (O.activity.locks === 1 ? '' : 's') +
      ' across ' + O.owners_observed + ' owner' + (O.owners_observed === 1 ? '' : 's') +
      ' — not a sweep of XRPL escrow');
    if (m.unattributed_events) {
      L.push('Escrow events with unresolved ownership: ' + m.unattributed_events +
        ' (not attributed to either side)');
    }
    return L;
  }

  window.SW_ESCROW_MODEL = {
    version: VERSION,
    read_only: true,
    build: build,
    get: get,
    invalidate: invalidate,
    isRippleOwner: isRippleOwner,
    ownerOf: ownerOf,
    kindOf: kindOf,
    diagnosticsLines: diagnosticsLines,
    diagnosticsBlock: function (m) { return diagnosticsLines(m).join('\n'); },
    compactXrp: compactXrp
  };
})();

// XRPMAN Shadow Watch — retention policy, in ONE place.
//
// The payload retention window is enforced twice: once on the WRITE side,
// where evidence.js stamps `transaction_raw.expires_at`, and once on the
// DELETE side, where scripts/db-prune.js decides what has expired. Two copies
// of a number that must agree is exactly the arrangement that rots, and the
// failure is silent and asymmetric: a writer stamping 12 hours against a
// pruner refusing to go below 24 produces payloads that vanish inside the live
// report window while the prune's own floor test still passes.
//
// So the floor lives here and both sides import it.
'use strict';

// A report reads the last 24 hours, and the legacy per-wallet read path serves
// complete payloads for that window. Below this the window stops being
// servable — which readWindow reports honestly, but for a reason we caused.
const MIN_RAW_RETENTION_HOURS = 24;
// Twice the report window: yesterday's report is still fully re-derivable, and
// there is a full cycle of slack before anything an operator would ask for is
// gone.
const DEFAULT_RAW_RETENTION_HOURS = 48;

// Resolve the configured window from an environment. A bad value is REFUSED
// rather than clamped to the floor, and refusal means the default — the longer
// window, never the shorter one. Every failure mode of this function keeps
// evidence for longer than asked, because the alternative is an environment
// typo quietly deleting payloads inside the window the report reads.
//
// `Number(env) || 48` was the original, and it accepted -5 and 12 alike: -5
// would have made every INSERT fail the expires_at > stored_at CHECK, and 12
// would have stamped payloads to expire half a day inside the report window.
function rawRetention(env) {
  const raw = env && env.SHADOWWATCH_RAW_RETENTION_HOURS;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { hours: DEFAULT_RAW_RETENTION_HOURS, source: 'DEFAULT', requested: null, reason: null };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return { hours: DEFAULT_RAW_RETENTION_HOURS, source: 'ENV_REFUSED', requested: String(raw),
      reason: 'NOT_A_NUMBER' };
  }
  if (n < MIN_RAW_RETENTION_HOURS) {
    return { hours: DEFAULT_RAW_RETENTION_HOURS, source: 'ENV_REFUSED', requested: String(raw),
      reason: 'BELOW_MIN_RAW_RETENTION_HOURS' };
  }
  return { hours: n, source: 'ENV', requested: String(raw), reason: null };
}

module.exports = { MIN_RAW_RETENTION_HOURS, DEFAULT_RAW_RETENTION_HOURS, rawRetention };

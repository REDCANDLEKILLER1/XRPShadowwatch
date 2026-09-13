// XRPMAN Shadow Watch — the XRPL pacing clock, in process.
//
// ── WHY THIS MOVED OUT OF THE DATABASE ─────────────────────────────────────
//
// Admission used to be a row in Neon. Every XRPL request began with
//
//     UPDATE xrpl_admission SET next_at = ... RETURNING ...
//
// and ended with another write on success or refusal. Three database
// round-trips per request, before the request was even sent.
//
// That had one real benefit — several serverless instances shared one clock, so
// a cooldown observed by one applied to all — and one fatal cost: when the
// database stopped accepting writes, EVERY XRPL call stopped with it. Not the
// run, not the scan: every call. A wallet walk that needs nothing from the
// database could not make a single read-only request, because the rate limiter
// in front of it needed a write it could not do.
//
// It is also most of why a run took ten minutes. SW-20260909-CUK9R made 261
// requests and sealed in 10m 04s — about 2.3 seconds each, for calls that take
// tens of milliseconds. The waiting was not XRPL's.
//
// A rate limiter is not evidence. It does not need durability, it does not need
// a transaction, and it must never be able to take the read path down with it.
// So it lives here, in memory.
//
// ── WHAT IS TRADED ─────────────────────────────────────────────────────────
//
// The shared clock. Two function instances now pace independently, so the
// aggregate rate can briefly reach twice one instance's. That is a real loss
// and it is accepted deliberately: a limiter that is occasionally too generous
// is recoverable — the endpoint refuses and the cooldown widens — while a
// limiter that is unavailable is not. Concurrency is bounded per instance, so
// the aggregate stays bounded too.
'use strict';

// The same numbers the database clock used, so pacing behaviour is unchanged.
const MIN_GAP_MS = 250;
// ── WHY THESE MOVED ────────────────────────────────────────────────────────
//
// Measured on a live run against xrplcluster.com, which refused with
// "units quota (2000 per 10s) exhausted, retry in ~9891ms". One refusal
// doubled the gap, and with the ceiling at five seconds and easing needing
// thirty-one consecutive successes for a 20% cut, the run never recovered: it
// managed 75 requests in 238 seconds — one every three seconds — and then
// failed 240 wallets for want of budget.
//
// The endpoint's own retry-after is the backpressure signal, and it is honoured
// as a cooldown. Widening the steady-state gap on top of that is a second,
// slower brake, and it has to release on the timescale of a RUN — a few
// hundred requests — not a few thousand. So the ceiling is lower and the
// easing is faster. Neither change touches what the server asked for.
const MAX_GAP_MS = 2000;
const REFUSAL_FLOOR_MS = 1000;
const STREAK_BEFORE_EASING = 5;
const EASE_FACTOR = 0.7;

function createClock(options) {
  const opts = options || {};
  const now = opts.now || (() => Date.now());
  const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const state = { gapMs: opts.gapMs || MIN_GAP_MS, nextAt: 0, cooldownUntil: 0, successStreak: 0,
    admitted: 0, waitedMs: 0, refusals: 0, lastReason: null };

  return {
    stats() { return { ...state }; },
    gap() { return state.gapMs; },

    // Reserve the next slot. Returns how long the caller must wait — the
    // reservation is taken immediately, so concurrent callers queue behind each
    // other rather than all waking at the same instant.
    reserve() {
      const t = now();
      const start = Math.max(state.nextAt, state.cooldownUntil, t);
      state.nextAt = start + state.gapMs;
      state.admitted++;
      return Math.max(0, start - t);
    },

    // Reserve and wait. `budget` is an optional deadline: a caller that cannot
    // afford the wait is told so rather than sleeping past its own timeout.
    async admit(budget) {
      for (;;) {
        const wait = this.reserve();
        if (budget !== undefined && budget !== null && now() + wait > budget) {
          const e = new Error('XRPL_ADMISSION_BUDGET_EXCEEDED');
          e.retry_after_ms = wait; e.pending = true;
          throw e;
        }
        if (wait > 0) { state.waitedMs += wait; await sleep(wait); }
        // A cooldown may have been imposed by another caller while this one
        // slept. Re-check rather than proceeding on a stale reservation.
        const remaining = state.cooldownUntil - now();
        if (remaining <= 0) return;
        if (budget !== undefined && budget !== null && now() + remaining > budget) {
          const e = new Error('XRPL_ADMISSION_BUDGET_EXCEEDED');
          e.retry_after_ms = remaining; e.pending = true;
          throw e;
        }
        state.waitedMs += remaining;
        await sleep(remaining);
      }
    },

    // A run of successes earns a faster gap, never below the floor. Easing
    // gradually rather than resetting means one lucky request does not undo a
    // cooldown the endpoint asked for.
    succeeded() {
      state.successStreak++;
      if (state.successStreak >= STREAK_BEFORE_EASING) {
        state.gapMs = Math.max(MIN_GAP_MS, Math.floor(state.gapMs * EASE_FACTOR));
        state.successStreak = 0;
      }
    },

    // A refusal is the endpoint telling us the rate is wrong. Honour the
    // retry-after it gave, and widen the gap so the next attempt is not the
    // same mistake at the same speed.
    refused(retryAfterMs, reason) {
      const ms = Number(retryAfterMs);
      const wait = Number.isFinite(ms) && ms > 0 ? ms : REFUSAL_FLOOR_MS;
      state.cooldownUntil = Math.max(state.cooldownUntil, now() + wait);
      state.gapMs = Math.min(MAX_GAP_MS, Math.max(REFUSAL_FLOOR_MS, state.gapMs * 2));
      state.successStreak = 0;
      state.refusals++;
      state.lastReason = reason || null;
      return wait;
    },

    cooldownRemaining() { return Math.max(0, state.cooldownUntil - now()); }
  };
}

// One clock per process. Shared by every Reader so that two wallet walks in the
// same instance pace against each other rather than independently.
const shared = createClock();

// ── ONE CLOCK PER ENDPOINT, NOT ONE PER PROCESS ────────────────────────────
//
// A rate limit belongs to a SERVER. One global clock meant that when
// xrplcluster.com said "slow down", every request in the run slowed down —
// including the ones bound for three other servers that had said nothing. The
// cooldown from one endpoint became a cooldown on all of them, and a run that
// should have shifted its load sideways sat still instead.
//
// Keyed per process so two Readers in the same instance still pace against
// each other on the endpoint they share, which is the part the single clock
// got right.
const byEndpoint = new Map();
function sharedFor(endpoint) {
  const key = String(endpoint);
  if (!byEndpoint.has(key)) byEndpoint.set(key, createClock());
  return byEndpoint.get(key);
}

module.exports = { createClock, shared, sharedFor,
  MIN_GAP_MS, MAX_GAP_MS, REFUSAL_FLOOR_MS, STREAK_BEFORE_EASING, EASE_FACTOR };

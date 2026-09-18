(function () {
  'use strict';
  // ── THE MORNING RUN, BACKED BY GITHUB INSTEAD OF A DATABASE ───────────────
  //
  // A drop-in replacement for window.SW_EVIDENCE_INDEX. Layer 17 calls begin(),
  // proveWallet() per wallet, readRun() and finish() exactly as before — none of
  // that changes. What changes is where the answers come from.
  //
  // The old shape made 255 HTTP calls, one per wallet, each of which opened a
  // database transaction. The new one makes ONE call: the server reads the
  // checkpoint, pins an anchor, walks every wallet's bounded edge and commits
  // once. The per-wallet methods then hand back what that single run already
  // established, so the existing call sites keep working unmodified.
  //
  // If the run did not earn its checkpoint, proveWallet still returns the proof
  // for the wallets that DID complete, and throws only for the ones that did
  // not. 249 of 255 is not "nothing happened", and the report is entitled to
  // render what was actually proven with the rest stated honestly.
  var LEGACY = window.SW_EVIDENCE_INDEX;

  // ── THE EVENTS, UNPACKED ────────────────────────────────────────────────
  //
  // Large windows arrive as gzipped base64 inside the JSON rather than as a
  // gzipped response, so nothing depends on how the platform negotiates
  // Content-Encoding. See api/delta.js.
  function inflateEvents(result) {
    if (!result || !result.events_gz) return result;
    var raw = atob(result.events_gz);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('EVENTS_COMPRESSED_BUT_NO_DECOMPRESSOR');
    }
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')))
      .text().then(function (text) { result.events = JSON.parse(text); return result; });
  }

  // ── THE RUN SAYS WHAT IT IS DOING WHILE IT DOES IT ──────────────────────
  //
  // Measured on 2026-09-14: the evidence walk took 463 seconds across three
  // attempts and emitted NOTHING for any of it. The report came out correct at
  // the end — 408/408, checkpoint advanced — but for nearly eight minutes the
  // screen held one percentage and the only honest reading of it was "it
  // stopped". A run that cannot be told apart from a hang is a run nobody can
  // wait out.
  //
  // The server has emitted per-wallet lines, phase lines and a five-second
  // heartbeat since the streaming endpoint was written. This layer simply never
  // asked for them: it posted without `stream`, took the single JSON body, and
  // threw away the only progress that existed.
  //
  // So the run is streamed, every line is published to the gauges as it lands,
  // and the final line carries exactly what the plain response carried.
  // ── PROGRESS ONLY EVER GOES FORWARD ─────────────────────────────────────
  //
  // The server numbers a wallet by everything proven so far, journal
  // recoveries included, so its own count is monotonic across attempts. The
  // CLIENT was the one that could go backwards: a retry's `start` line carries
  // no wallets yet, and the five-second ticks report zero until the first
  // wallet of that attempt lands — which on a resumed run is a minute of the
  // gauge reading less than it did before.
  //
  // A bar that falls is worse than one that stalls: it reads as work being
  // lost, and on a resumed run the opposite is true — that work is exactly
  // what was saved. So the high-water mark is kept for the whole run.
  // Per RUN, not per page. A second report in the same session would otherwise
  // inherit the first one's floor and show its bar already part-full.
  var progressHigh = 0, progressTotal = 0;
  function resetProgress() { progressHigh = 0; progressTotal = 0; }
  function onProgress(kind, value) {
    if (value) {
      if (Number(value.total) > 0) progressTotal = Number(value.total);
      else if (progressTotal) value.total = progressTotal;
      // Every published event carries the floor, including the ones that have
      // no count of their own — an attempt starting, a phase changing. A gauge
      // told "nothing" is a gauge that decides for itself what to show, and
      // what it decided was zero.
      var done = Number(value.done);
      if (isFinite(done) && done > progressHigh) progressHigh = done;
      value.done = progressHigh;
    }
    try {
      if (typeof window.updateShadowEvidenceProgress === 'function') {
        window.updateShadowEvidenceProgress(value);
      }
    } catch (_) {}
    try {
      if (kind === 'phase' && typeof log === 'function' && value && value.phase) {
        log('Evidence: ' + value.phase +
          (value.wallets ? ' \u00b7 ' + value.wallets + ' wallets' : '') +
          (value.shards ? ' \u00b7 ' + value.shards + ' shards' : '') +
          (value.rows ? ' \u00b7 ' + value.rows.toLocaleString() + ' rows' : '') +
          (value.took_ms ? ' \u00b7 ' + Math.round(value.took_ms / 1000) + 's' : ''));
      }
    } catch (_) {}
  }

  // ── ABORT ON SILENCE, NOT ON DURATION ───────────────────────────────────
  //
  // The old timeout was a flat 290 seconds from the first byte, which cut a
  // run that was alive and working — the server had a 300-second ceiling and
  // was still inside it. A long run is not a broken one; a QUIET one is. So the
  // clock is reset by every byte that arrives, and firing means the connection
  // genuinely stopped speaking.
  var IDLE_LIMIT_MS = 45000;

  function post(action, body, onLine) {
    var controller = new AbortController();
    var timer = null;
    function idle() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { controller.abort(); }, IDLE_LIMIT_MS);
    }
    idle();
    var streaming = typeof onLine === 'function';
    return fetch('/api/delta', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify(Object.assign({ action: action, stream: streaming || undefined },
        body || {})), signal: controller.signal
    }).then(function (response) {
      if (streaming && response.ok && response.body && response.body.getReader) {
        return readNdjson(response, onLine, idle);
      }
      return plainBody(response);
    }).then(function (v) { if (timer) clearTimeout(timer); return v; },
            function (e) {
              if (timer) clearTimeout(timer);
              if (e && e.name === 'AbortError') {
                var t = new Error('DELTA_RUN_SILENT'); t.transport = true; throw t;
              }
              if (e && e.status === undefined && e.transport === undefined) e.transport = true;
              throw e;
            });
  }

  // One NDJSON line per event. The LAST line that carries `t: 'done'` or
  // `t: 'error'` is the result; everything before it is progress. A stream that
  // ends without one never finished, and is a transport failure rather than an
  // answer — which is the same distinction the plain path draws between a cut
  // body and an empty one.
  function readNdjson(response, onLine, idle) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffered = '', final = null;
    function take(text) {
      buffered += text;
      var parts = buffered.split('\n');
      buffered = parts.pop();
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        var value = null;
        try { value = JSON.parse(parts[i]); } catch (_) { continue; }
        if (value.t === 'done' || value.t === 'error') final = value;
        else onLine(value);
      }
    }
    function pump() {
      return reader.read().then(function (chunk) {
        idle();
        if (chunk.done) {
          if (buffered) take('\n');
          if (!final) {
            var cut = new Error('DELTA_STREAM_ENDED_WITHOUT_RESULT');
            cut.transport = true;
            throw cut;
          }
          // The streaming line names the per-wallet array `wallets_detail`,
          // because on that endpoint `wallets` was already a count. The rest of
          // this layer should not have to know which endpoint answered it, so
          // the two shapes are made one here and nowhere else.
          if (final.wallets === undefined && Array.isArray(final.wallets_detail)) {
            final.wallets = final.wallets_detail;
          }
          if (final.t === 'error') {
            // The server had an opinion. That is an answer, not a dropped
            // connection, and asking again gives the same answer more slowly.
            var e = new Error(final.error || 'DELTA_RUN_FAILED');
            e.status = 200; e.transport = false; e.runSummary = final;
            throw e;
          }
          return inflateEvents(final);
        }
        take(decoder.decode(chunk.value, { stream: true }));
        return pump();
      });
    }
    return pump();
  }

  function plainBody(response) {
    return Promise.resolve(response).then(function (response) {
      // Read the body as TEXT first. `response.json().catch(() => ({}))` turned
      // a truncated or corrupt body on an HTTP 200 into an empty object, and
      // the run then proceeded with an undefined anchor and no wallets — a cut
      // response silently becoming a successful empty one. A body that will not
      // parse is a body we did not receive.
      return response.text().then(function (text) {
        var data = null, parsed = false;
        try { data = JSON.parse(text); parsed = true; } catch (_) { parsed = false; }
        if (!response.ok) {
          // The server answered. Its status is the fact, and its own error
          // string if it managed to send one. Never retryable: an answer
          // retried three times is the same answer three times slower.
          var e = new Error((parsed && data && data.error) || ('DELTA_HTTP_' + response.status));
          e.status = response.status;
          e.transport = false;
          throw e;
        }
        if (!parsed) {
          var bad = new Error('DELTA_RESPONSE_UNPARSEABLE: ' + text.length + ' bytes');
          bad.transport = true;      // we did not receive it; asking again is right
          throw bad;
        }
        return data;
      });
    }).then(inflateEvents);
  }

  // ── A DROPPED REQUEST IS NOT A FAILED RUN ───────────────────────────────
  //
  // The acquisition takes minutes, and a phone that backgrounds the tab — to
  // take a screenshot, to save a file, because a notification arrived — kills
  // the in-flight fetch. Measured live: the request died 55 seconds in, long
  // before any response was due, with "Failed to fetch".
  //
  // The run on the server is not wasted when that happens: whatever it walked
  // is journalled, so a retry resumes rather than restarting. So a transport
  // failure is retried instead of collapsing the report into the direct-XRPL
  // fallback, which is the slow path this whole migration replaced.
  //
  // Only TRANSPORT failures. An answer from the server — a refusal, a bad
  // state, anything with an opinion — is returned as-is.
  function postWithRetry(action, body, attempts) {
    var tries = attempts || 3;
    var attempt = 0;
    // The floor belongs to this run. Retries below must NOT reset it — that is
    // the whole point — so it is cleared here, once, before the first attempt.
    resetProgress();
    function once() {
      attempt++;
      // The attempt number is part of the progress the operator needs: a run on
      // its third try looks identical to one on its first without it, and the
      // difference is exactly what tells a slow run from a looping one.
      onProgress('attempt', { attempt: attempt, waiting_on: 'connecting' });
      return post(action, body, function (value) {
        if (value.t === 'wallet') {
          onProgress('wallet', { done: value.n, total: value.total, attempt: attempt });
        } else if (value.t === 'tick') {
          onProgress('tick', { done: value.wallets_done, requests: value.xrpl_requests,
            waiting_on: value.waiting_on, attempt: attempt });
        } else if (value.t === 'start') {
          onProgress('start', { total: value.roster_wallets, done: 0, attempt: attempt,
            waiting_on: 'starting' });
        } else if (value.t === 'phase') {
          // A resumed run says up front how many wallets it inherited. Taking
          // it here means the bar shows the true floor immediately instead of
          // sitting at the previous attempt's number until the first fresh
          // wallet finishes.
          onProgress('phase', { waiting_on: value.phase, attempt: attempt,
            phase: value.phase, wallets: value.wallets, shards: value.shards,
            rows: value.rows, took_ms: value.took_ms,
            done: Number(value.wallets_already_walked) || undefined });
        }
      }).catch(function (e) {
        // Decided by a TAG set where the outcome is known, not by matching the
        // message. A server error whose body happens to contain the words
        // "Failed to fetch" has a status and an opinion; retrying it is three
        // identical refusals. Only something that never became an answer is
        // worth asking again.
        var transport = (e.transport === true) && (e.status === undefined);
        if (!transport || attempt >= tries) throw e;
        if (typeof log === 'function') {
          log('Evidence: the request was cut (' + e.message + ') — retrying ' +
            attempt + '/' + (tries - 1) + '. Work already walked is journalled and resumes.');
        }
        return new Promise(function (r) { setTimeout(r, 2000); }).then(once);
      });
    }
    return once();
  }

  // ── READING THE PAGE'S STATE ────────────────────────────────────────────
  //
  // `state` is declared `let state = {...}` at the top level of 02-core.js. A
  // top-level `let` in a classic script goes into the global LEXICAL scope, not
  // onto `window` — so `window.state` is undefined, forever, and every guard
  // written as `(window.state && state.x)` short-circuits to nothing.
  //
  // This layer did exactly that, so begin() threw DELTA_REPORT_ID_REQUIRED on
  // every report ever run through it, with a perfectly good report id sitting
  // in `state.reportId`. The lexical binding IS visible here — classic scripts
  // share it — it just has to be read as `state`, not as a property of window.
  function pageState() {
    try { return (typeof state !== 'undefined' && state) ? state : (window.state || null); }
    catch (_) { return window.state || null; }
  }

  var run = null;   // the single acquisition this page performed

  window.SW_EVIDENCE_INDEX = {
    // Everything happens here. The name is kept because layer 17 calls it.
    begin: function (windowRange, accounts) {
      var S = pageState();
      var reportId = (S && S.reportId) || (S && S.seal && S.seal.report_id) || null;
      if (!reportId) throw new Error('DELTA_REPORT_ID_REQUIRED');
      if (typeof log === 'function') log('Evidence: reading checkpoint and walking the delta (one server call)...');
      // The window travels with the request. Without it the server has no way
      // to know which days the report covers, and can only hand back this run's
      // delta — which on a second run of the same day is nearly empty while the
      // morning's transactions sit committed in the evidence repository.
      var w = windowRange || {};
      return postWithRetry('run', { report_id: reportId, scan_id: (S && S.scanId) || null,
        window_start_ms: w.startMs, window_end_ms: w.endMs })
        .then(function (result) {
          run = result;
          run.byAddress = Object.create(null);
          (result.wallets || []).forEach(function (w) { run.byAddress[w.address] = w; });
          if (typeof log === 'function') {
            log('Evidence: anchor ' + result.anchor_ledger + ' · ' + result.complete_wallets + '/' +
              result.target_wallets + ' proved · ' + (result.transactions || 0) + ' transactions · ' +
              (result.xrpl_requests || 0) + ' XRPL reads' +
              (result.window && result.window.in_window !== undefined
                ? ' · window ' + result.window.in_window + ' events (' +
                  result.window.from_stored + ' stored + ' + result.window.from_this_run + ' this run)' : '') +
              (result.committed ? ' · checkpoint advanced'
                : ' · checkpoint NOT advanced (' + result.reason + ')'));
            // WHY THE TWO DENOMINATORS DISAGREE, IN THE LOG, NOT ONLY THE JSON.
            //
            // The state keeps proving a wallet the roster no longer lists —
            // deliberately, because retiring a watched wallet is a decision and
            // a run does not infer one from a list it was handed. So the
            // evidence line can legitimately read 91/418 while the scan beside
            // it reads 90/408, and on 2026-09-16 it did: a preview had written
            // ten extra wallets into the shared checkpoint and production could
            // not tell why its own numbers no longer matched.
            //
            // The server has always reported this as watched_not_in_roster; it
            // reached the debug export and nowhere an operator was looking.
            var absent = result.watched_not_in_roster || [];
            if (absent.length) {
              log('Evidence: ' + absent.length + ' wallet(s) are in the checkpoint but not on ' +
                  'this build’s roster, so they are still walked and counted in the ' +
                  result.target_wallets + ' above — ' +
                  absent.slice(0, 3).map(function (a) { return a.slice(0, 6) + '…' + a.slice(-4); }).join(', ') +
                  (absent.length > 3 ? ' and ' + (absent.length - 3) + ' more' : ''));
            }
            // WHY, not just WHAT. The reason code alone said
            // JOURNAL_ROWS_UNREADABLE for two runs straight while the cause —
            // a manifest naming shards a discard had already deleted — was
            // only findable by reading the evidence repository by hand. The
            // server puts the cause in the response; this prints it.
            if (!result.committed) {
              if (result.journal_rows_unreadable) {
                log('Evidence: the resume journal could not be read back — ' +
                  result.journal_rows_unreadable +
                  (result.discard_error ? ' · discard FAILED: ' + result.discard_error
                    : ' · journal discarded, the next run walks these wallets again'));
              }
              if (result.resumed && result.resumed.adopted === false) {
                log('Evidence: resume journal refused (' + result.resumed.reason + ')' +
                  (result.resumed.missing_shards
                    ? ' · ' + result.resumed.missing_shards + ' row file(s) missing: ' +
                      (result.resumed.missing_shard_paths || []).join(', ') : '') +
                  (result.resumed.discard_error ? ' · discard FAILED: ' + result.resumed.discard_error
                    : ' · discard ' + (result.resumed.discard_status || 'attempted')));
              }
            }
            // ── SAY IT OUT LOUD WHEN ATTRIBUTION IS INFERRED ───────────
            // A window attributed on reconstructed rows is a weaker claim than
            // one whose provenance survived. It is still usable — that is the
            // point of repairing it — but the operator must not learn the
            // difference from a commit message.
            if (result.window && result.window.provenance === 'PARTIAL_RECONSTRUCTED') {
              log('Evidence: PROVENANCE PARTIALLY RECONSTRUCTED — ' +
                result.window.attributed_derived_only + ' of ' + result.window.in_window +
                ' events are attributed from the surviving transaction rather than from a ' +
                'recorded walk. Wallet attribution in this report is weaker than usual.');
            }
            if (result.window && result.window.error) {
              log('Evidence: REPORT WINDOW UNAVAILABLE — ' + result.window.error +
                '. The report cannot be assembled from this run alone.');
            }
          }
          return {
            scan_id: result.scan_id || ('gh-' + result.anchor_ledger),
            anchor_ledger: result.anchor_ledger,
            anchor_close_ms: Date.parse(result.anchor_close),
            accounts: (result.wallets || []).map(function (w) { return w.address; }),
            roster_hash: result.state_sha256 || 'github-state',
            committed: result.committed, freshness: result.freshness
          };
        });
    },

    metrics: function () {
      if (!run) return null;
      return { scan_id: run.scan_id, target_wallets: run.target_wallets, indexed_wallets: run.complete_wallets,
        requests: run.xrpl_requests, rows_fetched: run.transactions, errors: (run.failures || []),
        stored_transactions_loaded: (run.window && run.window.from_stored) || 0,
        report_window: run.window || null,
        // Surfaced in metrics so the coverage block and TOTAL_DEBUG carry it,
        // not only the live log.
        provenance: (run.window && run.window.provenance) || null,
        attributed_derived_only: (run.window && run.window.attributed_derived_only) || 0,
        balance_contradictions: run.balance_contradictions,
        balance_contradiction_addresses: run.balance_contradiction_addresses || [],
        checkpoint_advanced: !!run.committed, freshness: run.freshness };
    },

    // Per-wallet, served from the run that already happened. A wallet that did
    // not complete throws, exactly as the old path did, so layer 17's existing
    // failure accounting is unchanged.
    proveWallet: function (indexRun, address) {
      return Promise.resolve().then(function () {
        if (!run) throw new Error('DELTA_RUN_NOT_STARTED');
        var w = run.byAddress[address];
        if (!w) throw new Error('WALLET_NOT_IN_STATE: ' + address);
        // The SERVER decides whether a wallet is proven; this line only reads
        // its answer. It used to test w.status === 'COMPLETE', which silently
        // excluded 'RECOVERED' — a wallet walked against this same anchor and
        // recovered from the resume journal. On a resumed run every wallet is
        // RECOVERED, so the report refused all 408 while the server reported
        // 408/408 proved.
        //
        // A response with no `proven` field falls back to the status string,
        // but ONLY for 'COMPLETE' — a wallet this run walked itself, whose rows
        // came back with it. 'RECOVERED' never falls back, because that is
        // precisely the shape the incident arrived in: no explicit flag, the
        // label RECOVERED, and journal rows that could not be read. Inferring
        // proof from the label there would accept exactly the evidence that was
        // missing. A server that means it says so.
        var proven = (w.proven === undefined)
          ? (w.status === 'COMPLETE')
          : w.proven === true;
        if (!proven) throw new Error(w.error || w.status || 'WALLET_NOT_PROVEN');
        return { rows: [], proof: {
          status: 'COMPLETE', source: 'GITHUB_EVIDENCE_STORE', run_id: indexRun.scan_id,
          anchor_ledger: run.anchor_ledger, from_ledger: null, through_ledger: w.proven_through,
          range_bound_proven: true, range_exhausted: true, edge_fetch_complete: true,
          covers_window_start: true, request_bounded: true, transport_consistent: true,
          window_bounded_by_anchor: true, response_validated: true,
          response_ledger_index_max: run.anchor_ledger, pages_scanned: 0,
          attempts: w.attempts, reconciliation: w.reconciliation } };
      });
    },

    // THE REPORT WINDOW, assembled by the server: what is already committed for
    // the days this report covers, unioned with what this run just walked, each
    // transaction once. Not the run's delta — see begin().
    //
    // An absent window is refused rather than substituted. Rendering a day from
    // a delta that does not cover it is exactly the kind of quiet
    // understatement this project exists to prevent.
    readRun: function () {
      return Promise.resolve().then(function () {
        if (!run) throw new Error('DELTA_RUN_NOT_STARTED');
        if (!run.events) {
          throw new Error('REPORT_WINDOW_UNAVAILABLE: ' +
            ((run.window && run.window.error) || 'the server did not assemble the window'));
        }
        return run.events.map(function (e) {
          return {
            hash: e.hash, ledger_index: e.ledger_index, date: e.close_time,
            type: e.tx_type, tx_result: e.tx_result, validated: e.validated === true,
            from: e.from_account || '', to: e.escrow_destination || e.to_account || '',
            amount: e.amount_drops !== null && e.amount_drops !== undefined ? String(e.amount_drops)
                  : (e.amount_value !== null && e.amount_value !== undefined ? String(e.amount_value) : null),
            currency: e.currency || 'XRP', issuer: e.issuer || '',
            destination_tag: e.destination_tag, sig_mode: e.sig_mode || 'unknown',
            signer_count: Number(e.signer_count) || 0, escrow_owner: e.escrow_owner || '',
            escrow_amount_drops: e.escrow_amount_drops === null || e.escrow_amount_drops === undefined
              ? null : String(e.escrow_amount_drops),
            observed_via: Array.isArray(e.observed_via) ? e.observed_via : []
          };
        });
      });
    },

    finish: function () {
      return Promise.resolve().then(function () {
        if (!run) throw new Error('DELTA_RUN_NOT_STARTED');
        return { status: run.committed ? 'COMPLETE' : 'PARTIAL',
          complete_wallets: run.complete_wallets, target_wallets: run.target_wallets,
          requests: run.xrpl_requests, rows_fetched: run.transactions,
          balance_contradictions: run.balance_contradictions,
          balance_contradiction_addresses: run.balance_contradiction_addresses || [],
          checkpoint_advanced: !!run.committed, reason: run.reason || null };
      });
    },

    // Kept so a diagnostic can still reach the database-backed path on a build
    // that has one. Never used by the report.
    _legacy: LEGACY
  };

  window.SW_DELTA_EVIDENCE_20260911 = true;
})();

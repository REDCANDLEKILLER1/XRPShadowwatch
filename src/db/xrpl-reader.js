'use strict';
const WebSocket = require('ws');
const { randomUUID } = require('crypto');
const coverage = require('./coverage');
const admission = require('./xrpl-admission');
const ENDPOINTS = ['wss://xrplcluster.com', 'wss://xrpl.ws', 'wss://s1.ripple.com', 'wss://s2.ripple.com'];
const validatedHeaders = new Map();
const idleReaders = [];
function acquireReader() {
  const reader=idleReaders.pop()||new Reader();
  clearTimeout(reader.idleTimer);
  reader.deadline=Date.now()+240000;
  reader.stats={requests:0,retries:0,reconnects:0,waits_ms:0,events:[],preferred_endpoint:ENDPOINTS[0],
    actual_endpoint:(reader.lanes&&reader.lanes.find(l=>l.sock)||{}).endpoint||null,
    transport_epoch:reader.epoch};
  return reader;
}
function releaseReader(reader) {
  if(idleReaders.length>=2){reader.close();return;}
  idleReaders.push(reader);
  reader.idleTimer=setTimeout(()=>{
    const i=idleReaders.indexOf(reader);if(i>=0){idleReaders.splice(i,1);reader.close();}
  },120000);
  reader.idleTimer.unref();
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rippleMs = value => (Number(value) + 946684800) * 1000;
const refusal = error => /slowDown|tooBusy|placing too much load|server is too busy|quota|rate.?limit|too many requests|\b429\b/i.test([error.code, error.message].join(' '));
function retryMs(error) {
  const hint = Number(error.retry_after_ms);
  if (Number.isFinite(hint) && hint > 0) return hint;
  const text = String(error.message || '').match(/retry\s+in\s*~?\s*(\d+)\s*ms/i);
  return text ? Number(text[1]) : 60000;
}
// ── FOUR ENDPOINTS, FOUR LANES, NOT ONE SOCKET AND THREE SPARES ────────────
//
// The endpoint list has been four servers long from the beginning, but only
// one of them was ever carrying traffic: connect() returned the socket it
// already had, so every request in a run — twelve hundred of them on a
// four-day catch-up — went down a single WebSocket to xrplcluster.com. The
// other three were failover, reached only after the first one died or went
// silent three times in a row.
//
// That made a rate limit far worse than it had to be. A refusal did not move
// the work sideways; it waited on the same server that had just said no, and
// because the admission clock was global, the wait applied to every worker.
// With no retry-after hint the default wait is sixty seconds, so one refusal
// could stall the entire roster for a minute while three idle servers sat
// there willing to answer.
//
// So a Reader now holds a LANE per endpoint — its own socket, its own epoch,
// its own clock — and spreads the roster across all four. A lane that refuses
// cools alone.
//
// ── WHY A WALLET STAYS IN ONE LANE ─────────────────────────────────────────
//
// account_tx markers are the server's own bookmark into its own data. A marker
// from one server means nothing to another, so a paged walk must finish where
// it started. Lanes are therefore assigned PER WALLET, not per request: wallet
// 1 walks on xrplcluster, wallet 2 on xrpl.ws, and each one's pages stay put.
// A wallet whose lane fails restarts its walk on another lane rather than
// carrying a bookmark across, which the per-wallet retry already does.
class Lane {
  constructor(endpoint, clock) {
    this.endpoint = endpoint; this.sock = null; this.epoch = 0;
    this.clock = clock; this.inFlight = 0; this.requests = 0;
    this.retries = 0; this.reconnects = 0; this.refusals = 0; this.retired = false;
  }
  // How long before this lane could carry a request, and how loaded it is.
  // Used to choose between lanes: the one that can answer soonest wins.
  readyIn() { return this.retired ? Infinity : this.clock.cooldownRemaining(); }
}

class Reader {
  constructor(options = {}) {
    this.epoch = 0; this.endpointIndex = 0;
    // One lane per endpoint. Clocks are per-endpoint and shared across Readers
    // in this process, so two wallet walks pace against each other on the
    // server they share — and only on that server. Injectable so the suite can
    // drive them without real time.
    this.lanes = ENDPOINTS.map(e => new Lane(e,
      (options.clockFor && options.clockFor(e)) || options.clock || admission.sharedFor(e)));
    this.deadline = Date.now() + (options.budgetMs || 240000);
    this.stats = { requests: 0, retries: 0, reconnects: 0, waits_ms: 0, events: [], preferred_endpoint: ENDPOINTS[0] };
  }

  // Pick the lane that can carry a request soonest. Ties go to the least busy,
  // so four concurrent wallets land on four different servers rather than
  // queueing behind one.
  pickLane() {
    let best = null;
    for (const lane of this.lanes) {
      if (lane.retired) continue;
      if (!best) { best = lane; continue; }
      const a = lane.readyIn(), b = best.readyIn();
      if (a < b || (a === b && lane.inFlight < best.inFlight)) best = lane;
    }
    if (!best) throw new Error('XRPL_ALL_ENDPOINTS_RETIRED');
    return best;
  }

  // Connect ONE lane. Unlike the old connect(), this never silently returns a
  // different server's socket: a lane is its endpoint.
  async openLane(lane) {
    if (lane.sock && lane.sock.readyState === WebSocket.OPEN) return lane.sock;
    const sock = await new Promise((resolve, reject) => {
      const ws = new WebSocket(lane.endpoint, { handshakeTimeout: 8000 });
      ws.once('open', () => resolve(ws));
      ws.on('error', reject);
    });
    lane.sock = sock; lane.epoch++; this.epoch++;
    this.stats.actual_endpoint = lane.endpoint;
    this.stats.transport_epoch = this.epoch;
    this.event({ event: 'connected', endpoint: lane.endpoint, epoch: lane.epoch });
    return sock;
  }
  event(value) {
    if (this.stats.events.length < 100) this.stats.events.push({ at: new Date().toISOString(), ...value });
  }
  async wait(ms) {
    if (Date.now() + ms > this.deadline) {
      const e = new Error('XRPL_READ_PENDING: recovery budget reached; resume this wallet');
      e.retry_after_ms = ms; e.pending = true; throw e;
    }
    this.stats.waits_ms += ms; await sleep(ms);
  }
  // Any lane that will open. Used when the caller has no lane of its own —
  // a single ledger or account_info read, which carries no marker and so has
  // no reason to care which server answers it.
  async connect() {
    for (let attempt = 0; attempt < this.lanes.length; attempt++) {
      let lane;
      try { lane = this.pickLane(); } catch (_) { break; }
      try { await this.openLane(lane); return lane.sock; }
      catch (e) {
        lane.retired = true;
        this.event({ event: 'connect_failed', endpoint: lane.endpoint, reason: e.message });
      }
    }
    // Every lane refused to open. Un-retire them all: a run that cannot reach
    // any server now may reach one in a moment, and permanently retiring the
    // whole pool would make the Reader useless for the rest of its life.
    for (const lane of this.lanes) lane.retired = false;
    throw new Error('XRPL_CONNECTION_UNAVAILABLE');
  }

  // A lane reserved for one wallet's paged walk. Held for the whole walk so
  // its markers stay on the server that issued them.
  async lane() {
    for (let attempt = 0; attempt < this.lanes.length; attempt++) {
      let chosen;
      try { chosen = this.pickLane(); } catch (_) { break; }
      try { await this.openLane(chosen); return chosen; }
      catch (e) {
        chosen.retired = true;
        this.event({ event: 'connect_failed', endpoint: chosen.endpoint, reason: e.message });
      }
    }
    for (const l of this.lanes) l.retired = false;
    throw new Error('XRPL_CONNECTION_UNAVAILABLE');
  }
  // Pacing, from the in-process clock. This used to be three database writes
  // per request, which meant a database that could not accept writes blocked
  // every read-only XRPL call before it was sent — and cost about two seconds
  // of round-trips per request on the way. A rate limiter is not evidence: it
  // needs no durability and must never be able to take the read path down.
  async admission(lane) {
    await lane.clock.admit(this.deadline);
  }
  raw(sock, command) {
    return new Promise((resolve, reject) => {
      const id = randomUUID(); let settled = false;
      const done = (fn, arg) => {
        if (settled) return; settled = true; clearTimeout(timer);
        sock.off('message', message); sock.off('close', close); fn(arg);
      };
      const timer = setTimeout(() => {
        sock.silentReads = (sock.silentReads || 0) + 1;
        const e = new Error('XRPL_RESPONSE_TIMEOUT'); e.silent = true; done(reject, e);
      }, 15000);
      const message = data => {
        let body; try { body = JSON.parse(data.toString()); } catch (_) { return; }
        if (body.id !== id) return;
        sock.silentReads = 0;
        const result = body.result || body;
        if (body.status === 'success' && !result.error) return done(resolve, result);
        const e = new Error(result.error_message || body.error_message || result.error || body.error || 'XRPL error');
        e.code = result.error || body.error; e.retry_after_ms = result.retry_after_ms || body.retry_after_ms;
        done(reject, e);
      };
      const close = () => { const e = new Error('XRPL_CONNECTION_CLOSED'); e.closed = true; done(reject, e); };
      sock.on('message', message); sock.once('close', close);
      sock.send(JSON.stringify({ ...command, id }));
    });
  }
  // `pin` is the lane a paged walk is bound to. Without one, any lane may
  // answer — which is correct for a single read and wrong for a marker.
  async request(command, expectedEpoch, pin) {
    // Read-only methods, and only these four. account_info joined the list for
    // the balance cross-check (src/db/balance.js): it reads an AccountRoot at a
    // pinned ledger and cannot sign, submit or mutate anything.
    if (!['ledger', 'server_info', 'account_tx', 'account_info'].includes(command.command)) throw new Error('XRPL_METHOD_NOT_ALLOWED');
    for (let attempt = 0; attempt <= 12; attempt++) {
      const lane = pin || this.pickLane();
      await this.admission(lane);
      const sock = await this.openLane(lane);
      // A pinned walk must not silently continue on a reconnected socket: the
      // marker it holds belonged to the connection that is gone.
      if (expectedEpoch !== undefined && (pin ? lane.epoch : this.epoch) !== expectedEpoch) {
        throw new Error('XRPL_TRANSPORT_CHANGED');
      }
      lane.inFlight++;
      try {
        this.stats.requests++; lane.requests++;
        const result = await this.raw(sock, command);
        lane.clock.succeeded();
        return result;
      } catch (e) {
        if (!this.stats.first_failure) this.stats.first_failure = { at: new Date().toISOString(), reason: e.message, endpoint: sock.url };
        this.event({ event: 'retry', reason: e.message, code: e.code, command: command.command, account: command.account, endpoint: lane.endpoint, epoch: lane.epoch });
        if (refusal(e)) {
          // THIS lane cools, not the run. The other three said nothing and
          // have no reason to be punished for what this one asked for.
          const ms = lane.clock.refused(retryMs(e), e.message);
          lane.refusals++;
          this.event({ event: 'cooldown', retry_after_ms: ms, endpoint: lane.endpoint, gap_ms: lane.clock.gap() });
          // An unpinned read simply moves to whichever lane is free soonest —
          // often immediately, on a server that never refused. Only a pinned
          // walk has to wait, because its marker cannot travel.
          if (pin) await this.wait(ms);
        } else if (e.closed || (e.silent && sock.silentReads >= 3)) {
          this.closeLane(lane); lane.reconnects++; this.stats.reconnects++;
          if (lane.reconnects >= 3) {
            lane.retired = true;
            this.event({ event: 'lane_retired', endpoint: lane.endpoint, reason: 'silent' });
            if (this.lanes.every(l => l.retired)) throw new Error('XRPL_TRANSPORT_SILENT');
            if (pin) throw new Error('XRPL_TRANSPORT_SILENT');
          }
        } else if (!e.silent) throw e;
        this.stats.retries++; lane.retries++;
      } finally { lane.inFlight--; }
    }
    throw new Error('XRPL_RECOVERY_EXHAUSTED');
  }

  // What each server actually carried. Reported so a run that felt slow can be
  // shown to have been slow on ONE endpoint rather than everywhere.
  laneStats() {
    return this.lanes.map(l => ({ endpoint: l.endpoint, requests: l.requests,
      retries: l.retries, refusals: l.refusals, reconnects: l.reconnects,
      retired: l.retired, cooldown_ms: Math.round(l.readyIn()) || 0 }));
  }
  async ledger(index) {
    if (Number.isInteger(index) && validatedHeaders.has(index)) return validatedHeaders.get(index);
    const r = await this.request({ command: 'ledger', ledger_index: index, transactions: false, expand: false });
    const l = r.ledger || {}; const seq = Number(l.ledger_index || r.ledger_index);
    if (r.validated !== true || !Number.isInteger(seq) || l.close_time === undefined || l.close_time === null || !Number.isFinite(Number(l.close_time)) ||
        (index !== 'validated' && seq !== Number(index))) throw new Error('LEDGER_ANCHOR_UNPROVEN');
    const header = { ledger: seq, close_ms: rippleMs(l.close_time), hash: l.ledger_hash || r.ledger_hash || null };
    validatedHeaders.set(seq,header);
    if(validatedHeaders.size>2000)validatedHeaders.delete(validatedHeaders.keys().next().value);
    return header;
  }
  // The balance of one account AT one ledger. Pinned, never "latest": an
  // unpinned balance cannot be reconciled against a proven ledger range.
  //
  // Returns null rather than throwing when the account cannot be read. A
  // balance is a CROSS-CHECK on evidence, not evidence; failing a wallet's walk
  // because a supplementary read was refused would trade the thing that matters
  // for the thing that confirms it.
  async balance(address, ledgerIndex, pin) {
    const index = Number(ledgerIndex);
    if (!Number.isInteger(index) || index <= 0) throw new Error('BALANCE_LEDGER_UNPINNED');
    let r;
    try {
      // Pinned to the walk's lane when there is one, so a wallet's balance is
      // read from the same server that answered for its transactions. Not a
      // marker requirement — a consistency one.
      r = await this.request({ command: 'account_info', account: address, ledger_index: index, strict: true },
        pin ? pin.epoch : undefined, pin);
    } catch (e) {
      this.event({ event: 'balance_unavailable', account: address, ledger: index, reason: e.message, code: e.code });
      return null;
    }
    if (r.validated !== true || Number(r.ledger_index) !== index) return null;
    const drops = r.account_data && r.account_data.Balance;
    if (typeof drops !== 'string' || !/^[0-9]+$/.test(drops)) return null;
    return { drops, ledger: index };
  }
  async retainedRange(anchor = 0) {
    for(let attempt=0;attempt<4;attempt++){
      await this.connect();
      if(this.retention && this.retention.epoch===this.epoch && this.retention.ranges && this.retention.ranges.some(r=>r[1]>=anchor))return this.retention.ranges;
      const epoch=this.epoch;
      try{
        const info=await this.request({command:'server_info'},epoch);
        const ranges=coverage.parseCompleteLedgers(info.info && info.info.complete_ledgers);
        this.retention={epoch,ranges};return ranges;
      }catch(e){if(e.message==='XRPL_TRANSPORT_CHANGED'&&attempt<3)continue;throw e;}
    }
  }
  async floor(startMs, anchor) {
    const ranges = await this.retainedRange(anchor.ledger);
    const span = ranges && ranges.find(r => r[0] <= anchor.ledger && r[1] >= anchor.ledger);
    if (!span) throw new Error('SERVER_RETENTION_UNPROVEN');
    let low = await this.ledger(span[0]), high = anchor.ledger;
    if (low.close_ms > startMs) throw new Error('SERVER_RETENTION_DOES_NOT_COVER_WINDOW');
    while (high - low.ledger > 1) {
      const mid = await this.ledger(Math.floor((low.ledger + high) / 2));
      if (mid.close_ms < startMs) low = mid; else high = mid.ledger;
    }
    return low;
  }
  closeLane(lane) { if (lane.sock) { try { lane.sock.close(); } catch (_) {} lane.sock = null; } }
  close() { for (const lane of this.lanes) this.closeLane(lane); }
}
module.exports = { Reader, acquireReader, releaseReader, refusal, retryMs, rippleMs };

'use strict';
const WebSocket = require('ws');
const { randomUUID } = require('crypto');
const db = require('./connection');
const coverage = require('./coverage');
const ENDPOINTS = ['wss://xrplcluster.com', 'wss://xrpl.ws', 'wss://s1.ripple.com', 'wss://s2.ripple.com'];
const validatedHeaders = new Map();
const idleReaders = [];
function acquireReader() {
  const reader=idleReaders.pop()||new Reader();
  clearTimeout(reader.idleTimer);
  reader.deadline=Date.now()+240000;
  reader.stats={requests:0,retries:0,reconnects:0,waits_ms:0,events:[],preferred_endpoint:ENDPOINTS[0],
    actual_endpoint:reader.sock&&reader.sock.url,transport_epoch:reader.epoch};
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
class Reader {
  constructor(options = {}) {
    this.sock = null; this.epoch = 0; this.endpointIndex = 0;
    this.deadline = Date.now() + (options.budgetMs || 240000);
    this.stats = { requests: 0, retries: 0, reconnects: 0, waits_ms: 0, events: [], preferred_endpoint: ENDPOINTS[0] };
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
  async connect() {
    if (this.sock && this.sock.readyState === WebSocket.OPEN) return this.sock;
    for (let attempt = 0; attempt < ENDPOINTS.length; attempt++) {
      const endpoint = ENDPOINTS[this.endpointIndex++ % ENDPOINTS.length];
      try {
        const sock = await new Promise((resolve, reject) => {
          const ws = new WebSocket(endpoint, { handshakeTimeout: 8000 });
          ws.once('open', () => resolve(ws));
          ws.on('error', reject);
        });
        this.sock = sock; this.epoch++; this.stats.actual_endpoint = endpoint;
        this.stats.transport_epoch = this.epoch;
        this.event({ event: 'connected', endpoint, epoch: this.epoch }); return sock;
      } catch (e) { this.event({ event: 'connect_failed', endpoint, reason: e.message }); }
    }
    throw new Error('XRPL_CONNECTION_UNAVAILABLE');
  }
  async admission() {
    const q = db.getExecutor();
    while (true) {
      const reserved = (await q(`UPDATE xrpl_admission SET
        next_at = GREATEST(next_at, cooldown_until, clock_timestamp()) + gap_ms * interval '1 millisecond',
        updated_at = clock_timestamp() WHERE id=1
        RETURNING extract(epoch FROM next_at - gap_ms * interval '1 millisecond') * 1000 AS admit_ms`)).rows[0];
      const ms = Math.max(0, Number(reserved.admit_ms) - Date.now());
      if (ms) await this.wait(ms);
      const row = (await q('SELECT extract(epoch FROM cooldown_until)*1000 AS until_ms FROM xrpl_admission WHERE id=1')).rows[0];
      if (Number(row.until_ms) <= Date.now()) return;
      await this.wait(Number(row.until_ms) - Date.now());
    }
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
  async request(command, expectedEpoch) {
    // Read-only methods, and only these four. account_info joined the list for
    // the balance cross-check (src/db/balance.js): it reads an AccountRoot at a
    // pinned ledger and cannot sign, submit or mutate anything.
    if (!['ledger', 'server_info', 'account_tx', 'account_info'].includes(command.command)) throw new Error('XRPL_METHOD_NOT_ALLOWED');
    for (let attempt = 0; attempt <= 12; attempt++) {
      await this.admission(); const sock = await this.connect();
      if (expectedEpoch !== undefined && this.epoch !== expectedEpoch) throw new Error('XRPL_TRANSPORT_CHANGED');
      try {
        this.stats.requests++;
        const result=await this.raw(sock, command);
        await db.getExecutor()(`UPDATE xrpl_admission SET
          gap_ms=CASE WHEN success_streak>=31 THEN GREATEST(250,(gap_ms*0.8)::integer) ELSE gap_ms END,
          success_streak=CASE WHEN success_streak>=31 THEN 0 ELSE success_streak+1 END WHERE id=1`);
        return result;
      } catch (e) {
        if (!this.stats.first_failure) this.stats.first_failure = { at: new Date().toISOString(), reason: e.message, endpoint: sock.url };
        this.event({ event: 'retry', reason: e.message, code: e.code, command: command.command, account: command.account, epoch: this.epoch });
        if (refusal(e)) {
          const ms = retryMs(e);
          this.event({ event: 'cooldown', retry_after_ms: ms, endpoint: sock.url });
          await db.getExecutor()(`UPDATE xrpl_admission SET cooldown_until=GREATEST(cooldown_until, clock_timestamp()+$1*interval '1 millisecond'),
            gap_ms=LEAST(5000,GREATEST(1000,gap_ms*2)), success_streak=0,last_reason=$2 WHERE id=1`, [ms, e.message]);
          await this.wait(ms);
        } else if (e.closed || (e.silent && sock.silentReads >= 3)) {
          this.close(); this.stats.reconnects++;
          if (this.stats.reconnects >= 3) throw new Error('XRPL_TRANSPORT_SILENT');
        } else if (!e.silent) throw e;
        this.stats.retries++;
      }
    }
    throw new Error('XRPL_RECOVERY_EXHAUSTED');
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
  async balance(address, ledgerIndex) {
    const index = Number(ledgerIndex);
    if (!Number.isInteger(index) || index <= 0) throw new Error('BALANCE_LEDGER_UNPINNED');
    let r;
    try {
      r = await this.request({ command: 'account_info', account: address, ledger_index: index, strict: true });
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
  close() { if (this.sock) { this.sock.close(); this.sock = null; } }
}
module.exports = { Reader, acquireReader, releaseReader, refusal, retryMs, rippleMs };

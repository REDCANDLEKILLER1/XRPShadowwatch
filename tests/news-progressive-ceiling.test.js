const assert = require('assert');
const api = require('../src/brief/36-news-progressive-ceiling-20260820.js');

function abortableHang(ms = 10000) {
  return (signal) => new Promise((resolve) => {
    const t = setTimeout(() => resolve([]), ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve([]); }, { once: true });
  });
}

function success(label, wait, rows) {
  return async (signal, emit) => {
    await new Promise(r => setTimeout(r, wait));
    if (signal.aborted) return [];
    emit(rows, { label });
    return rows;
  };
}

(async () => {
  let r = await api.runDeadlineTasks([
    abortableHang(), success('rss:NewsBTC', 10, [{ title: 'verified-rss' }])
  ], 60, 80);
  assert.equal(r.deadline_hit, true);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].title, 'verified-rss');
  assert.equal(r.active_after_abort, 0);

  r = await api.runDeadlineTasks([
    abortableHang(), success('google_news', 10, [{ title: 'verified-google' }])
  ], 60, 80);
  assert.equal(r.items.some(x => x.title === 'verified-google'), true);
  assert.equal(r.labels.includes('google_news'), true);

  r = await api.runDeadlineTasks([
    async () => [], async () => { throw new Error('provider failed'); }
  ], 60, 80);
  assert.equal(r.items.length, 0);
  assert.equal(r.deadline_hit, false);

  const start = Date.now();
  r = await api.runDeadlineTasks([abortableHang(), abortableHang()], 50, 80);
  assert.equal(r.deadline_hit, true);
  assert.equal(r.active_after_abort, 0);
  assert(Date.now() - start < 250, 'abort did not quiesce promptly');

  const clean = api.sanitizeNewsIntelForDiagnostics({
    source_status: { all: 'FAILED', google_news: 'FAILED' }, items: []
  });
  assert.equal(Object.prototype.hasOwnProperty.call(clean.source_status, 'all'), false);
  assert.equal(clean.source_status.google_news, 'FAILED');

  console.log('PASS A partial verified RSS survives hanging peer');
  console.log('PASS B Google News contributes independently of RSS');
  console.log('PASS C all-source failure yields zero items (LEDGER_ONLY input)');
  console.log('PASS D deadline abort quiesces outstanding work; active_after_abort=0');
  console.log('PASS E diagnostics remove generic PROVIDER: all attribution');
})();

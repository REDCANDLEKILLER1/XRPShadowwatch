// Acceptance for audit finding B. Hermetic: globalThis.fetch is replaced so the
// allowlist logic runs against REAL allowlisted hostnames with no network.
const handler = require('/home/user/XRPShadowwatch/api/proxy.js');

function mkRes() {
  const r = { headers: {}, code: 0, body: null };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = c => { r.code = c; return r; };
  r.json = o => { r.body = o; return r; };
  r.send = b => { r.body = b; return r; };
  r.end = () => r;
  return r;
}
function resp({ status = 200, headers = {}, text = '', stream = null }) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const o = { status, headers: { get: k => (h.has(k.toLowerCase()) ? h.get(k.toLowerCase()) : null) } };
  if (stream) {
    let i = 0;
    o.body = { getReader: () => ({
      read: async () => (i < stream.length ? { done: false, value: stream[i++] } : { done: true }),
      cancel: async () => {}
    }) };
  } else {
    o.body = null;
    o.text = async () => text;
  }
  return o;
}
const call = url => { const r = mkRes(); return handler({ method: 'GET', query: { url } }, r).then(() => r); };

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + JSON.stringify(detail) : '')); }
}

(async () => {
  // 1 — allowed source works
  globalThis.fetch = async () => resp({ status: 200, headers: { 'content-type': 'application/rss+xml' }, text: '<rss>ok</rss>' });
  let r = await call('https://u.today/feed');
  check('allowed source works', r.code === 200 && r.body === '<rss>ok</rss>' && r.headers['Content-Type'] === 'application/rss+xml', r);

  // 2 — redirect to a DISALLOWED destination fails (the finding)
  globalThis.fetch = async (u) => u.indexOf('news.google.com') > -1
    ? resp({ status: 302, headers: { location: 'https://evil.example.com/steal' } })
    : resp({ status: 200, text: 'SHOULD-NEVER-BE-REACHED' });
  r = await call('https://news.google.com/rss/articles/abc');
  check('redirected disallowed destination fails', r.code === 403 && r.body && /redirect destination not allowlisted/.test(r.body.error), r);
  check('  ...and the blocked host is named', r.body && r.body.host === 'evil.example.com', r.body);
  check('  ...and the disallowed body is NOT returned', String(r.body && r.body.error || '').indexOf('SHOULD-NEVER') === -1, r.body);

  // 3 — a redirect to an ALLOWED destination still works (Google News RSS does this by design)
  globalThis.fetch = async (u) => u.indexOf('news.google.com') > -1
    ? resp({ status: 302, headers: { location: 'https://u.today/real-article' } })
    : resp({ status: 200, headers: { 'content-type': 'text/html' }, text: 'REAL ARTICLE' });
  r = await call('https://news.google.com/rss/articles/abc');
  check('allowed redirect still followed (no regression)', r.code === 200 && r.body === 'REAL ARTICLE', r);

  // 4 — relative redirect resolves against the current URL and is re-checked
  globalThis.fetch = async (u) => u === 'https://u.today/a'
    ? resp({ status: 301, headers: { location: '/b' } })
    : resp({ status: 200, text: 'RELATIVE-OK:' + u });
  r = await call('https://u.today/a');
  check('relative redirect resolves + revalidates', r.code === 200 && r.body === 'RELATIVE-OK:https://u.today/b', r);

  // 5 — scheme downgrade in a redirect is refused
  globalThis.fetch = async () => resp({ status: 302, headers: { location: 'file:///etc/passwd' } });
  r = await call('https://u.today/x');
  check('non-http(s) redirect refused', r.code === 403, r);

  // 6 — redirect chain is bounded
  globalThis.fetch = async (u) => resp({ status: 302, headers: { location: 'https://u.today/' + Math.random() } });
  r = await call('https://u.today/loop');
  check('redirect chain bounded', r.code === 502 && /too many redirects/.test(r.body.error), r);

  // 7 — oversized response fails (streamed, no content-length)
  const big = [Buffer.alloc(900 * 1024, 0x61), Buffer.alloc(900 * 1024, 0x61), Buffer.alloc(900 * 1024, 0x61)];
  globalThis.fetch = async () => resp({ status: 200, stream: big });
  r = await call('https://u.today/big');
  check('oversized response fails (streamed)', r.code === 502 && /too large/.test(r.body.error), r);

  // 8 — oversized declared via content-length is rejected before reading
  let readAttempted = false;
  globalThis.fetch = async () => {
    const o = resp({ status: 200, headers: { 'content-length': String(50 * 1024 * 1024) }, text: 'x' });
    o.text = async () => { readAttempted = true; return 'x'; };
    return o;
  };
  r = await call('https://u.today/huge');
  check('oversized content-length rejected early', r.code === 502 && /too large/.test(r.body.error) && !readAttempted, { r, readAttempted });

  // 9 — a body just under the cap still passes
  globalThis.fetch = async () => resp({ status: 200, stream: [Buffer.alloc(1024, 0x62)] });
  r = await call('https://u.today/small');
  check('under-cap body passes', r.code === 200 && r.body.length === 1024, r.code);

  // 10 — timeout fails safely
  globalThis.fetch = async () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; };
  r = await call('https://u.today/slow');
  check('timeout fails safely (504, no crash)', r.code === 504 && /timed out/.test(r.body.error), r);

  // 11 — allowlist itself unchanged: direct disallowed host still refused
  globalThis.fetch = async () => resp({ status: 200, text: 'nope' });
  r = await call('https://evil.example.com/x');
  check('direct disallowed host still 403', r.code === 403 && /not allowlisted/.test(r.body.error), r);

  // 12 — subdomain of an allowlisted host still permitted
  globalThis.fetch = async () => resp({ status: 200, text: 'sub-ok' });
  r = await call('https://cdn.u.today/x');
  check('allowlisted subdomain still permitted', r.code === 200 && r.body === 'sub-ok', r);

  // 13 — upstream status is passed through
  globalThis.fetch = async () => resp({ status: 404, text: 'not found' });
  r = await call('https://u.today/missing');
  check('upstream status passed through', r.code === 404, r.code);

  console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' ACCEPTANCE CHECKS PASS' : fail + ' FAILED of ' + (pass + fail)));
  process.exit(fail === 0 ? 0 : 1);
})();

// XRPMAN Shadow Watch — server-side read proxy (Vercel serverless function).
//
// The browser app was fetching news/DEX data through flaky free public CORS
// relays. This same-origin endpoint fetches those public GET URLs server-side
// (no CORS, no third-party relay), so news + DeFiLlama data are reliable.
//
// Read-only. Allowlisted hosts only — this is NOT an open proxy. No keys, no
// writes, no credentials forwarded.
//
// ── Audit finding B (2026-08-21) ────────────────────────────────────────────
// The allowlist used to be evaluated exactly once, against the URL supplied in
// the query string, and the fetch then ran with `redirect: 'follow'`. Standard
// fetch semantics follow redirects across hosts transparently, so the check
// bound the FIRST HOP while the effective destination was unconstrained. That
// was demonstrated, not theorised: an allowlisted host answering 302 to an
// unlisted one returned the unlisted host's body, while a direct request to the
// same host was correctly refused with 403.
//
// It needed no exotic open redirect to reach, either — news.google.com RSS
// article links redirect to publisher sites by design, so the door was already
// ajar. On Vercel there is no cloud metadata endpoint to steal, so the payoff
// was not credential theft: it was an anonymising relay running on this
// project's egress IP, plus arbitrary fill of the shared edge cache.
//
// Now every hop is validated before it is fetched, the chain is bounded, and the
// response body is size-capped. The allowlist itself is unchanged.
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  var target = (req.query && req.query.url) || '';
  if (Array.isArray(target)) target = target[0];
  if (!target || !/^https?:\/\//i.test(target)) {
    res.status(400).json({ error: 'missing or invalid url param' });
    return;
  }

  // Only the public read endpoints Shadow Watch actually uses.
  var ALLOW = [
    // market / DeFi
    'api.llama.fi', 'api.coingecko.com', 'api.coinbase.com', 'api.coincap.io',
    'api.coinpaprika.com', 'min-api.cryptocompare.com',
    // XRPL network stats (funded-account count — read-only, cross-checked)
    'api.xrpscan.com', 'bithomp.com',
    // news / signal
    'api.gdeltproject.org', 'news.google.com',
    'bitcoinist.com', 'newsbtc.com', 'u.today', 'cryptoslate.com', 'coingape.com',
    'beincrypto.com', 'coinpedia.org', 'cointelegraph.com', 'decrypt.co',
    'thedefiant.io', 'coindesk.com', 'cryptopanic.com'
  ];

  // Applied to EVERY hop, not just the one the caller named.
  function hostOf(u) {
    try {
      var parsed = new URL(u);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      return parsed.hostname.toLowerCase();
    } catch (e) { return null; }
  }
  function allowed(u) {
    var host = hostOf(u);
    if (!host) return false;
    return ALLOW.some(function (h) { return host === h || host.endsWith('.' + h); });
  }

  var MAX_REDIRECTS = 5;
  var MAX_BYTES     = 2 * 1024 * 1024;   // 2 MiB — these are RSS/JSON feeds
  var TIMEOUT_MS    = 12000;             // unchanged: one budget for the whole chain

  if (!allowed(target)) {
    res.status(403).json({ error: 'host not allowlisted', host: hostOf(target) });
    return;
  }

  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);

  try {
    var current = target;
    var upstream = null;
    var hops = 0;

    // Follow redirects by hand so each destination can be checked before it is
    // requested. `redirect: 'manual'` is what makes that possible at all.
    for (;;) {
      upstream = await fetch(current, {
        headers: { 'User-Agent': 'ShadowWatch/1.0 (+https://shadowwatch.xyz)', 'Accept': '*/*' },
        redirect: 'manual',
        signal: ctrl.signal
      });

      var st = upstream.status;
      var location = (st >= 300 && st < 400) ? upstream.headers.get('location') : null;
      if (!location) break;                      // final response

      if (++hops > MAX_REDIRECTS) {
        clearTimeout(timer);
        res.status(502).json({ error: 'too many redirects', hops: hops - 1 });
        return;
      }

      var next;
      try { next = new URL(location, current).toString(); }
      catch (e) {
        clearTimeout(timer);
        res.status(502).json({ error: 'unparseable redirect target' });
        return;
      }

      if (!allowed(next)) {
        clearTimeout(timer);
        res.status(403).json({
          error: 'redirect destination not allowlisted',
          host: hostOf(next),
          from: hostOf(current)
        });
        return;
      }
      current = next;
    }

    // Size cap. `await upstream.text()` on an arbitrary upstream had no bound at
    // all; content-length is a hint we can reject on early, but it is optional
    // and forgeable, so the stream is counted as it arrives.
    var declared = Number(upstream.headers.get('content-length') || 0);
    if (declared && declared > MAX_BYTES) {
      clearTimeout(timer);
      res.status(502).json({ error: 'upstream response too large', bytes: declared, limit: MAX_BYTES });
      return;
    }

    var body;
    if (upstream.body && typeof upstream.body.getReader === 'function') {
      var reader = upstream.body.getReader();
      var chunks = [], total = 0;
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        var buf = Buffer.from(chunk.value);
        total += buf.length;
        if (total > MAX_BYTES) {
          try { await reader.cancel(); } catch (_) {}
          clearTimeout(timer);
          res.status(502).json({ error: 'upstream response too large', limit: MAX_BYTES });
          return;
        }
        chunks.push(buf);
      }
      body = Buffer.concat(chunks).toString('utf8');
    } else {
      // Runtime without web streams on the response — fall back, then check.
      body = await upstream.text();
      if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) {
        clearTimeout(timer);
        res.status(502).json({ error: 'upstream response too large', limit: MAX_BYTES });
        return;
      }
    }

    clearTimeout(timer);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/plain; charset=utf-8');
    // Short shared cache so repeated scans in a window don't hammer upstreams.
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    res.status(upstream.status).send(body);
  } catch (e) {
    clearTimeout(timer);
    var aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
    res.status(aborted ? 504 : 502).json({
      error: aborted ? 'upstream fetch timed out' : 'upstream fetch failed',
      detail: String((e && e.message) || e)
    });
  }
};

// XRPMAN Shadow Watch — server-side read proxy (Vercel serverless function).
//
// The browser app was fetching news/DEX data through flaky free public CORS
// relays. This same-origin endpoint fetches those public GET URLs server-side
// (no CORS, no third-party relay), so news + DeFiLlama data are reliable.
//
// Read-only. Allowlisted hosts only — this is NOT an open proxy. No keys, no
// writes, no credentials forwarded.
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

  var host;
  try { host = new URL(target).hostname.toLowerCase(); }
  catch (e) { res.status(400).json({ error: 'unparseable url' }); return; }

  // Only the public read endpoints Shadow Watch actually uses.
  var ALLOW = [
    // market / DeFi
    'api.llama.fi', 'api.coingecko.com', 'api.coinbase.com', 'api.coincap.io',
    'api.coinpaprika.com', 'min-api.cryptocompare.com',
    // news / signal
    'api.gdeltproject.org', 'news.google.com',
    'bitcoinist.com', 'newsbtc.com', 'u.today', 'cryptoslate.com', 'coingape.com',
    'beincrypto.com', 'coinpedia.org', 'cointelegraph.com', 'decrypt.co',
    'thedefiant.io', 'coindesk.com', 'cryptopanic.com'
  ];
  var ok = ALLOW.some(function (h) { return host === h || host.endsWith('.' + h); });
  if (!ok) { res.status(403).json({ error: 'host not allowlisted', host: host }); return; }

  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 12000);
  try {
    var upstream = await fetch(target, {
      headers: { 'User-Agent': 'ShadowWatch/1.0 (+https://shadowwatch.xyz)', 'Accept': '*/*' },
      redirect: 'follow',
      signal: ctrl.signal
    });
    var body = await upstream.text();
    clearTimeout(timer);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/plain; charset=utf-8');
    // Short shared cache so repeated scans in a window don't hammer upstreams.
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    res.status(upstream.status).send(body);
  } catch (e) {
    clearTimeout(timer);
    res.status(502).json({ error: 'upstream fetch failed', detail: String((e && e.message) || e) });
  }
};

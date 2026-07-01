# External endpoints audit

Shadow Watch is two apps in one repo, so this audit is split by engine:
- **Part A — Outer Watcher** (`index.html` + `src/`)
- **Part B — Brief Console** (`brief-console.html`, loaded in the BRIEF tab)

All endpoints in both parts are **read-only** (ledger reads, market/news data,
static embeds, or links the user clicks). No private keys, no signing, no
`submit`/`submitAndWait`, no seed input, no API keys, no writes.

---

# Part A — Outer Watcher (`index.html` + `src/`)

## Live ledger (read-only, WebSocket)
- `wss://s1.ripple.com`, `wss://s2.ripple.com`, `wss://xrplcluster.com`, `wss://xrpl.ws`
  — subscribe + `account_info`, `account_tx`, `account_lines`, `gateway_balances`.
  Read-only public commands only.

## Market data (read-only, HTTPS GET)
- `https://api.binance.us/api/v3/ticker/price` — XRP price.
- `https://api.binance.us/api/v3/klines` — 365-day volume backfill.

## Embeds / media (read-only)
- `https://s.tradingview.com/widgetembed/` — chart iframe.
- `https://redcandlekiller1.github.io/Nexus-9/` — Nexus-9 iframe.
- `https://ipfs.filebase.io/ipfs/…` — boot power-button video.
- `https://xumm.app/avatar/…` — wallet avatars.

## CDNs / fonts (read-only)
- `https://cdn.tailwindcss.com`, `https://cdnjs.cloudflare.com/…/three.min.js`,
  `https://fonts.googleapis.com/…`.

## Explorer links (opened only on user click — navigation, not fetch)
- `https://xrpscan.com/account/…`, `/token/…`, `/tx/…`
- `https://bithomp.com/explorer/…`
- `https://dexscreener.com/xrpl/…` (built by `SW.token`, no keys)
- `https://docs.google.com/…` — operator manual.

## Intelligence helpers (`src/js/intel/*`)
Pure functions over data already fetched from the WS above. **They make no
network calls of their own** — `SW.token` only *builds* explorer URLs; nothing
is fetched until the user clicks. No API keys.

---

# Part B — Brief Console (`brief-console.html`)

The Brief Console is a separate application (v3.31) that generates a daily
report. It is **watchlist-scoped** and read-only. Its outbound calls:

## Live ledger (read-only, WebSocket)
- `wss://s1.ripple.com`, `wss://s2.ripple.com`, `wss://xrplcluster.com`
  — `account_info`, `account_tx`, `account_lines` for watched wallets.
- `https://api.xrpscan.com/…` — supplementary XRPL account/metrics reads (GET).

## Market / price data (read-only, HTTPS GET)
- `https://api.coingecko.com`, `https://api.coinbase.com`, `https://api.coincap.io`,
  `https://api.coinpaprika.com`, `https://min-api.cryptocompare.com`,
  `https://api.llama.fi` (DefiLlama).

## News / signal data (read-only, HTTPS GET)
- `https://api.gdeltproject.org` (GDELT), `https://news.google.com` (RSS), and
  headline sources referenced/fetched: coindesk.com, cointelegraph.com, decrypt.co,
  u.today, coingape.com, coinpedia.org, cryptoslate.com, newsbtc.com, bitcoinist.com,
  thedefiant.io, beincrypto.com, reuters.com, ripple.com.
- Social references: `twitter.com` / `x.com` (link references, not authenticated).

## Third-party CORS relays (read-only passthrough)
Used to fetch some of the public GET endpoints above from the browser:
`api.allorigins.win`, `api.codetabs.com`, `api.cors.lol`, `proxy.killcors.com`,
`thingproxy.freeboard.io` / `thingproxy.io`.
> Audit note: these are third-party relays — read requests (and their responses)
> transit those hosts. No credentials or private data are sent; only public
> market/news reads. Worth documenting for a privacy review.

---

## Escrow Watch backfill (both engines) — read-only
The Escrow Watch panel (main app) and the "ESCROW WATCH — COFFEE & CRYPTO"
report section (Brief Console) add **no new endpoints**. Their backfill reuses
the existing XRPL WebSocket with the read-only `account_tx` command for known
Ripple/escrow wallets; escrow amounts are parsed from transaction metadata
(`meta.AffectedNodes`). Results persist only to `localStorage`
(`XRPMAN_ESCROW_HISTORY_V1`). No writes, no new hosts, no keys.

## Deliberately NOT used (either engine)
Live trading, `Wallet.fromSeed`, `submitAndWait`, OpenClaw agents, X posting
automation, Resend email, Firebase, Docker/PM2, and any API-key-gated service.
Shadow Watch does not buy, sell, trade, sign, submit, or execute anything.

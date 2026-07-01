# External endpoints audit

Every external endpoint the **outer app** (`index.html` + `src/`) touches.
All are **read-only** (ledger reads, market data, static embeds, or links the
user clicks). No private keys, no signing, no `submit`/`submitAndWait`, no
seed input, no API keys.

## Live ledger (read-only, WebSocket)
- `wss://s1.ripple.com`, `wss://s2.ripple.com`, `wss://xrplcluster.com`, `wss://xrpl.ws`
  — transaction/ledger subscribe, `account_info`, `account_tx`, `account_lines`,
  `gateway_balances`. Used by the live feed, graph trace, chain-volume scan, and
  the Risk Assessment panel. Read-only public commands only.

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

## KOI intelligence helpers (`src/js/intel/*`)
Pure functions over data already fetched from the WS above. **They make no
network calls of their own** — `SW.token` only *builds* explorer URLs; nothing
is fetched until the user clicks. No API keys, no xrplmeta/DexScreener fetches
were imported (deliberately deferred per the ticket).

## Deliberately NOT imported from KOI
Live trading, `Wallet.fromSeed`, `submitAndWait`, OpenClaw agents, X posting,
Resend email, Firebase, Docker/PM2, and any API-key-gated service.

## Separate app: `brief-console.html`
The Brief Console (v3.31, loaded in the BRIEF tab iframe) is a **separate
application** with its own endpoints (xrplmeta, DexScreener, news feeds). It was
extracted verbatim from the former base64 blob and is **not** modified by the
KOI work here. Audit it separately before wiring KOI into it (Phase 3b).

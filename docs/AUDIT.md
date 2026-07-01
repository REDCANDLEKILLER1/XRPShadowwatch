# Shadow Watch — Change Summary for Audit

**Branch:** `shadowwatch-intel` (PR #4) · **Base:** `restructure/app-packaging` (PR #2) → `main`
**Scope:** all changes are to the **Shadow Watch** app. No third‑party application code
was added to the repo. Everything below is **read‑only** with respect to the XRP Ledger:
no key handling, no signing, no `submit`/`submitAndWait`, no seed input, no API keys.

> Shadow Watch is a **watchdog / classifier**. It does **not** buy, sell, trade, sign,
> submit, or execute anything on the ledger. Flow labels are neutral route descriptors,
> not trade signals.

> Provenance note: some scoring/classification **concepts** in `src/js/intel/` were
> re-implemented from a reference project ("KOI"). None of that project's files are in
> this repo; only ideas (formulas, tx-type maps) were adapted into new Shadow Watch code.

---

## 1. Before

- The entire app was a single `index.html` (~2.94 MB, ~4,022 lines) containing:
  - the **outer live watcher** (XRPMAN SHADOW WATCH v16.7.1), and
  - a **second complete app** (the Brief Console v3.31, ~1.72 MB) embedded as a
    base64 string `window.__BRIEF_CONSOLE_B64` and decoded to a Blob at runtime.
- `README.md` was two lines. No package.json, license, .gitignore, icons, or docs.

## 2. After (high level)

| Area | Before | After |
|---|---|---|
| Structure | one 2.94 MB `index.html` | `index.html` (~47 KB markup) + `src/css`, `src/js`, `src/assets`, `docs` |
| Brief Console | base64 blob in `index.html` | real file `brief-console.html` (byte‑identical) |
| Packaging | none | `README`, `package.json`, `LICENSE` (MIT), `.gitignore`, `docs/*` |
| Install | browser page | installable **PWA** (`manifest.webmanifest`, `sw.js`, icons) |
| Features added | — | Risk Assessment panel, intelligence helpers, escrow‑unlock detection |
| Injection safety | live token names → `innerHTML` unescaped | escaped via `SW.escapeHtml` |

---

## 3. Change-by-change (what & why)

### 3.1 Repository restructure — *no behavior change*
Split the monolith into files loaded via `<script>`/`<link>`. Scripts remain **classic**
(shared global scope), so all inline `onclick=` handlers and globals keep working.
**Proven lossless:** reconstructing the split pieces reproduces the pre‑split `index.html`
byte‑for‑byte.
- New: `src/css/styles.css`, `src/js/app.js`, `src/js/brief-fullscreen.js`,
  `src/js/boot-greeter.js`, `src/js/boot-scanner.js`.

### 3.2 Brief Console decoded to a real file
`window.__BRIEF_CONSOLE_B64` → `brief-console.html` (1,722,234 bytes; verified identical to
the decoded blob). Loader now sets `brief-frame.src='./brief-console.html'`; the former
base64→Blob path was removed. Lazy‑load and `exitBriefFullscreen` preserved.

### 3.3 Account / Issuer Risk Assessment (`src/js/risk.js`)
Menu → "RISK ASSESSMENT" (and the tx modal's "SCAN LEDGER" button). For an `r…` address it
issues read‑only `account_info`, `gateway_balances`, `account_lines`, `account_tx` and renders
a scored verdict (issuer/blackhole status, account flags, age, balance vs reserve, holder base).

### 3.4 Installable PWA
`manifest.webmanifest`, `sw.js` (app‑shell cache, stale‑while‑revalidate, versioned),
`src/js/pwa.js` (registration + install prompt), generated icons. The service worker
**caches static assets only**; it never intercepts the XRPL WebSocket.

### 3.5 Injection safety (Phase 2)
`src/js/intel/sw-util.js` adds `SW.escapeHtml`. The live feed previously interpolated a
**hex‑decoded issued‑currency name** (attacker‑controllable) straight into `innerHTML`
(`app.js` `handleTx`); it is now escaped. This is the primary hardening item.

### 3.6 Intelligence helpers (`src/js/intel/`, read‑only)
Pure functions; **no network calls of their own** (URL builders only, fetched on user click):
- `sw-token-intel.js` — currency decode (hex/ASCII) + explorer link builders.
- `sw-flow-intel.js` — per‑tx **neutral flow/route classification** (XRP transfer, token transfer, FLOW XRP→TOKEN / TOKEN→XRP, STABLE ROUTE, TOKEN ROUTE, DEX ROUTE). No buy/sell/trade semantics.
- `sw-wallet-score.js` — 8‑point wallet score (age/balance/activation/cancel‑ratio → green/yellow/red).
- `sw-watchdog-score.js` — burst / counterparty‑concentration / unique‑takers / reversal / token‑health.
- `sw-txn-counter.js` — tx‑family counter (Money/Markets/NFTs/Accounts).
Wired into `handleTx` (flow pill + family counts), the intel report, and the Risk panel.

### 3.7 Escrow‑unlock detection (both engines)
`EscrowFinish`/`EscrowCreate` release/lock amount is parsed from `meta.AffectedNodes`
(the created/deleted `Escrow` node's `Amount`), which the transaction body doesn't carry.
- Outer app (`app.js handleTx`): surfaces every unlock live from the full stream, tagged
  `ESCROW UNLOCK`; ≥100k routes to the whale report + Evidence Locker + alert.
- Brief Console (`brief-console.html` `txOne`): the amount now populates its existing escrow
  flag, large‑flow analysis, and `TREASURY_ROTATION_CLUSTER`.
- Verified against the real 500,000,000 XRP unlock metadata → both parse 500,000,000 XRP.

---

## 4. Explicitly NOT done (out of scope / excluded)
- No live trading, `Wallet.fromSeed`, `submitAndWait`, or any signing/submission.
- No OpenClaw agents, X posting, Resend email, Firebase, Docker/PM2, or API‑key services.
- No live `main` / shadowwatch.xyz change — all work is on branches pending review.
- Deferred: wiring watchdog scoring *inside* the Brief Console app; live token enrichment
  fetches (xrplmeta/DexScreener); an exhaustive `innerHTML` escaping sweep beyond the
  highest‑risk site.

---

## 5. External endpoints
See [`docs/ENDPOINTS.md`](ENDPOINTS.md). All are read‑only: XRPL WebSocket nodes, Binance
price/volume, static embeds (TradingView/Nexus/IPFS/fonts/CDNs), and explorer links opened
on user click. No secrets, no API keys.

## 6. How it was verified
- All JavaScript passes `node --check` (outer app + all Brief Console script blocks + helpers).
- Intelligence helpers unit‑tested in a Node shim (escape neutralizes injected markup;
  flow/wallet/watchdog outputs match expectations).
- Escrow parser tested against the real EscrowFinish metadata shape (→ 500,000,000 XRP).
- Restructure proven lossless by byte‑for‑byte reconstruction.
- Not yet exercised in a real browser (build sandbox blocks XRPL/IPFS) — validate on the
  Vercel preview for each PR.

## 7. Commit trail (branch `shadowwatch-intel`)
```
Restructure: split monolith index.html into src/ folders (no behavior change)
Add Account/Issuer Risk Assessment panel + installable PWA
Wire modal SCAN LEDGER button to in-app Risk Assessment
Phase 1: decode embedded Brief Console into a real file
Phase 2+3: safe HTML escaping + read-only intelligence helpers
Detect escrow unlocks (EscrowFinish) in both Shadow Watches
Rename src/js/koi -> src/js/intel (naming clarity)
```

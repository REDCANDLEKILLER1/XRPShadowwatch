# XRPShadowwatch

**XRPMAN Shadow Watch** — a real-time XRP Ledger forensic / whale-watching console.
Live at **[shadowwatch.xyz](https://shadowwatch.xyz)**.

Tracks the XRPL in real time over WebSocket, flags high-value transfers (HVTs),
maps wallet flows, scores activity, and backfills historical volume from both
exchange (Binance) and on-chain (account_tx over the main exchange wallets)
sources.

---

## Repository layout

Until now the whole app lived in a single ~2.9 MB `index.html`. It has been
split into folders for maintainability **without changing runtime behavior**
(see "Architecture notes" below for why this is safe):

```
.
├── index.html                  # markup only (~47 KB) — links the files below
├── src/
│   ├── css/
│   │   └── styles.css           # all app styles (was the inline <style> block)
│   ├── js/
│   │   ├── app.js               # main engine: WS, blackbox, views, graph, map…
│   │   ├── brief-fullscreen.js  # Daily Brief iframe loader
│   │   ├── boot-greeter.js      # splash greeter / XRPMAN transmission strip
│   │   └── boot-scanner.js      # boot "thumb scanner" → activates the app
│   └── assets/
│       └── brief-console.b64.js # base64 Daily Brief console (~2.3 MB blob)
├── docs/
│   └── MIGRATION.md             # staged plan to ES modules / Vite
├── package.json
├── LICENSE
└── .gitignore
```

External libraries (Tailwind, Three.js, fonts, TradingView) are still loaded
from their CDNs in `index.html`, exactly as before.

---

## Local development

No build step is required — it's static files.

```bash
# any static server works; e.g.
npm run dev          # npx serve on http://localhost:5173
# or
python3 -m http.server 5173
```

Then open http://localhost:5173. Note that the live ledger feed (XRPL
WebSocket) and Binance volume fetch require normal outbound internet; some
sandboxed networks block them.

Quick syntax check of the extracted scripts:

```bash
npm run check
```

---

## Deployment

Deployed on **Vercel** as a static site from the `main` branch → shadowwatch.xyz.
No special Vercel config is needed; Vercel serves `index.html` and `src/**`
as-is. Pushing to `main` triggers a production deploy; PRs get preview URLs.

---

## Architecture notes (read before refactoring)

The scripts are **classic scripts**, not ES modules. Classic scripts on a page
share one global scope, so splitting the old single `<script>` into separate
files is byte-safe: a `let socket` declared in one file is still visible to the
others, and the dozens of inline `onclick="..."` handlers in the markup keep
resolving against global functions. Load **order matters** and is preserved by
the order of the `<script>` tags in `index.html`.

This is the deliberate trade-off of the current packaging step: real folder
structure and a slim `index.html`, with zero behavior change and easy rollback.

## Roadmap

See [`docs/MIGRATION.md`](docs/MIGRATION.md) for the staged migration to ES
modules (and optionally Vite), done file-by-file so the live app never breaks.

### Included on this branch
- **Account / Issuer Risk Assessment** (`src/js/risk.js`) — Menu → "RISK
  ASSESSMENT". Pulls `account_info`, `gateway_balances`, `account_lines` and
  `account_tx` for any r-address over the live socket and renders a scored,
  heuristic verdict (issuer/blackhole status, flags, age, holder base, balance).
- **PWA / installable app** — `manifest.webmanifest` + `sw.js` (app-shell
  cache, stale-while-revalidate) + `src/js/pwa.js` (registration + an
  "INSTALL APP" prompt). Adds home-screen install with the power-button icon.

> SW note: bump `CACHE` in `sw.js` on each deploy so clients pick up new
> assets. To fully remove the service worker later, unregister it in the
> browser / ship a no-op SW.

Still candidate (not built): evidence export, persistent watchlist + alerts,
volume sparkline charts.

# Migration roadmap: classic scripts → ES modules

This is the **staged** plan referenced by the README. The goal is to reach a
modern, modular codebase (and optionally a Vite build) **without ever taking
the live app at shadowwatch.xyz offline**. Each step is small, independently
testable on a branch / Vercel preview, and reversible.

## Where we are now (Phase 1 — done)

- The single 2.9 MB `index.html` was split into `src/css`, `src/js`, and
  `src/assets`, byte-for-byte. Behavior is identical.
- Scripts are still **classic** (`<script src>`), sharing one global scope.
  Inline `onclick="..."` handlers still resolve against global functions.

## The core constraint

Everything risky lives in two facts:

1. **Globals**: `socket`, `blackbox`, `metrics`, `switchView`, `handleTx`,
   and dozens more are top-level in `src/js/app.js`.
2. **Inline handlers**: the markup calls those globals directly
   (`onclick="switchView('map')"`, `onclick="closeIntel()"`, …).

Converting a file to an ES module puts its declarations in module scope, so
they vanish from the global namespace and the inline handlers break. The
migration must therefore re-expose anything an inline handler needs.

## Phase 2 — carve `app.js` into modules (file-by-file)

`src/js/app.js` is ~414 KB. Split it along the seams that already exist in the
code, roughly:

- `ws.js`        — WebSocket connect/reconnect, `onmessage` routing
- `blackbox.js`  — localStorage persistence + history backfill + chain scan
- `views.js`     — `switchView`, tab/panel logic
- `graph.js`     — force-graph canvas
- `map.js`       — map canvas
- `feed.js`      — live transaction feed + HVT detection
- `wallets.js`   — KNOWN_WALLETS / PRELOADED_HVTS / resolveWallet
- `report.js`    — intel dashboard + whale flow report
- `ui.js`        — toast, modals, tutorial

For each module, during transition:

```js
// views.js
export function switchView(id) { /* … */ }

// main.js (the single type="module" entry)
import { switchView } from './views.js';
window.switchView = switchView;   // keep inline onclick working
```

Migrate **one module per PR**, verify on a preview, then move on. Only after a
function is fully on `window` via the entry should the old code be removed.

## Phase 3 — retire inline handlers (optional, later)

Replace `onclick="foo()"` in the markup with `addEventListener` wiring in the
modules. Once none remain, the `window.foo = foo` shims can be deleted.

## Phase 4 — Vite build (optional)

Introduce Vite with `index.html` as the entry and a single
`<script type="module" src="/src/js/main.js">`. This unlocks dev HMR,
minification, code-splitting, and dynamic `import()` (e.g. lazy-load Three.js
and the graph view to shrink first paint). The 2.3 MB base64 brief console
should be decoded to a real `.html` asset and fetched, rather than shipped as a
JS string.

> Do not start Phase 4 until Phase 2 is complete — bundling non-module classic
> scripts is exactly where a big-bang rewrite goes wrong.

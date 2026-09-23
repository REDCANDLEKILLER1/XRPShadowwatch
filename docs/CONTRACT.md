# Shadow Watch — live product contract

Status: proposed on branch `audit/memory-contract-guard`. Not yet the law on `main`.
Date: 2026-09-23
Owner: operator review required before merge.

This page is the control plane. New Brief hotfixes that violate it do not ship.

## Two engines

| Engine | Version plane | Job |
|---|---|---|
| Outer Watcher | `package.json` version (currently 16.7.1) | Live XRPL stream, HVT feed, Risk, Escrow panel, PWA |
| Brief Console / Coffee & Crypto | report `App Version` string (currently `v3.32a-helper-runtime-proof-lock`) | Watchlist scan → sealed Morning Story + Total Report |

They share evidence. They do not share one version number. Both numbers must appear on every sealed report.

## Shared storage — named keys only

If a key is not on this list, it is not a shared contract.

### Brief Console (scan history / coordination)

| Key | Role |
|---|---|
| `shadowwatch_blackbox_v34` | Brief scan snapshots (cap 30). **This** is what `detectCoordination` reads. |
| `SHADOW_WATCH_PATTERN_MEMORY_V1` | Derived pattern cache. Not evidence. |
| `XRPMAN_ESCROW_HISTORY_V1` | Escrow events, shared with Outer Watcher. Deduped by tx hash. |
| `shadowDiscoveryHistory` / `shadowDiscoveryInbox` | Suggested wallets. No auto-add. |
| `SW_BRIEF_ARCHIVE_V1` | Daily brief archive. |
| `SW_SHARED_HVT_HISTORY_V1` | Shared HVT history. |

### Outer Watcher (separate black box)

| Key | Role |
|---|---|
| `XRPMAN_BLACKBOX_V2` | Outer live-watcher box. **Not** the Brief coordination store. |
| `shadowwatch_snapshot_v30` | Legacy snapshot key. Read-only fallback. |

A Brief report that prints “Need 5+ snapshots. Current: 0” while `shadowwatch_blackbox_v34` already holds rows is a defect.

Brief coordination never imports Outer `XRPMAN_BLACKBOX_V2` or the legacy balance snapshot. Every v34 row must have a Brief snapshot shape; timestamp-only or mixed-shape arrays are refused without overwriting their stored bytes.

## Write rules

1. Never `removeItem` a contract key except the operator Clear Black Box path.
2. Never persist an empty array over a non-empty store.
3. `detectCoordination` must re-read `shadowwatch_blackbox_v34` if the in-memory history is empty.
4. Once transaction coverage passes, persist the compact Brief snapshot and resolve coordination from the saved v34 store before final rendering, sealing, and archiving. Every detector return includes `snapshots_analyzed`. Rendering never appends snapshots, and post-seal work never changes the finalized coordination object.
5. Pattern memory may drop self-directed `sender_receiver` keys. It may not wipe snapshots to prove a theory.

## Public report rules

1. Morning Story numbers must exist on the evidence capsule.
2. If news was fetched and the governor rejected it, print `governor rejected N headlines`, not “No external sources.”
3. Every lead metric carries two windows when both exist: canonical 24h and gap-since-last-scan.
4. Brand rollups (Binance, Bybit) may follow per-address lines. They must not replace them.

## What this branch implements

Patch 0: this contract.
Patch 1: Brief storage guard plus real core detector/renderer/save integration tests. Preview acquisition obtains a deployment policy from `GET /api/delta?action=policy` before the run. Preview or unknown policy failures stop incomplete at the scan boundary; only confirmed production may use ordinary direct fallback. No synthetic successful empty run is permitted.

Patches 2–4 (news governor object, dual window, entity lines) stay off this PR.

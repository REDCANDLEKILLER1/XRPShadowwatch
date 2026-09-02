# Genesis Lineage Hub

The Genesis Lineage Lab remains part of ShadowWatch.xyz while its canonical shared history is persisted on a dedicated GitHub data branch.

- Branch: `hub/genesis-lineage-data`
- Root: `data/genesis-lineage/`
- API: `/api/lineage-hub`
- App: `/genesis`

## Trust model

XRPL remains read-only. Browser clients do not receive a GitHub token and cannot submit canonical evidence. A public client may trigger incremental sync only for the fixed 136-account Genesis cohort. The serverless function independently queries XRPL, recomputes exact `AccountRoot` balance deltas and native-XRP routing records, then writes an append-only delta to the data branch.

The Hub GitHub token is server-only. Configure one of these Vercel environment variables:

- `SHADOWWATCH_HUB_GITHUB_TOKEN` (preferred)
- `GITHUB_TOKEN` (fallback)

For a fine-grained PAT, scope it only to `REDCANDLEKILLER1/XRPShadowwatch` with **Contents: Read and write** and **Metadata: Read**. Never place a PAT in HTML, browser JavaScript, localStorage, or the repository.

## Database layout

`manifest.json` records provenance, base-artifact hashes, coverage state, the fixed update boundary, the tracked 136-account class, and append-only delta metadata.

`SEED_INTEGRITY.json` records each stored checkpoint part's Git blob SHA-1 and whole-artifact SHA-256 values.

`base/checkpoint-01.b64` through `base/checkpoint-13.b64` contain the current canonical graph/history seed as ordered base64 text representing one gzip stream. The API reconstructs the gzip stream; the browser decompresses and validates the compact `shadowwatch.genesis-lineage-hub.visual.v2` object.

`deltas/YYYY-MM/*.json` are server-recomputed incremental XRPL updates. They are immutable after creation and are applied by clients in manifest order.

## Current seed state

The 2026-08-24 seed is physically stored in the repository and reconstructs:

- 1,258 graph nodes
- 2,072 graph edges
- gzip SHA-256 `0fefe7c684f522a8192258259caa09807fa169dd3991d2110498d6e4ef95bb84`
- uncompressed SHA-256 `2c8c7362331f0d863d336289da25514cf626d7d1471487fcdb6a71db0790765d`

Historical Every-Drop evidence is **2,446 / 2,448**, therefore the historical base is not sealed. The two missing intervals are listed explicitly in the manifest.

The full 7.66 MB exact Every-Drop source archive is registered by SHA-256 `5bbcb1d8f4c8531a7b1f09c3297ffe60123affb2700bc5619e4e85fb03383215` but is not represented as physically stored on the data branch. The repository-hosted graph/history seed is authoritative for shared visualization; local/imported Every-Drop evidence remains authoritative for exact historical effect bodies until a later archive migration.

For incremental updates, ledger `106,477,809` is the conservative fixed baseline. Later dynamic `ledger_index_max=-1` source evidence is retained for research but is not used as the canonical fixed update boundary.

## API behavior

`GET /api/lineage-hub` returns manifest/status and whether server-side GitHub access is configured. It never returns the token.

`GET /api/lineage-hub?asset=checkpoint` returns the reconstructed gzip checkpoint stream from the manifest-listed parts.

`GET /api/lineage-hub?delta=<manifest-listed-path>` returns only a delta already listed in the manifest.

`POST /api/lineage-hub` with `{ "action": "sync", "accounts": [...] }` triggers deterministic server-side sync. A requested target ledger may only reduce the server-validated target; it can never advance canonical history beyond the XRPL validated ledger reported by the server. Accounts must be members of the tracked 136-account cohort.

# ShadowWatch Genesis Lineage Database

Canonical shared-history data branch for the Genesis Lineage Lab inside ShadowWatch.xyz.

- Branch: `hub/genesis-lineage-data`
- Manifest: `data/genesis-lineage/manifest.json`
- Integrity record: `data/genesis-lineage/SEED_INTEGRITY.json`
- Canonical visual/history seed: `data/genesis-lineage/base/checkpoint-01.b64` through `checkpoint-13.b64`
- Encoding: gzip bytes represented as ordered base64 text parts
- XRPL access: read-only
- Update model: append-only server-recomputed deltas

The stored seed reconstructs `shadowwatch.genesis-lineage-hub.visual.v2` with 1,258 nodes and 2,072 edges. `SEED_INTEGRITY.json` records each part's Git blob SHA-1 plus whole-artifact SHA-256 values so reconstruction can be verified independently.

Historical Every-Drop coverage is explicitly **2,446 / 2,448**, not sealed. The two missing ranges remain listed in the manifest. The full exact Every-Drop source archive is registered by its SHA-256 but is not represented as physically stored on this branch; local/imported evidence remains authoritative for those exact effect bodies until a later archive migration.

The conservative fixed incremental boundary is ledger `106,477,809`. Public browser clients never write ledger evidence directly. They may trigger the ShadowWatch server-side sync endpoint; the server independently reads XRPL, recomputes evidence, and appends canonical deltas to this branch.

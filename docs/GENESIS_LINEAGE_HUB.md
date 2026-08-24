# Genesis Lineage Hub

The Genesis Lineage Lab keeps its canonical shared history in a dedicated GitHub data branch:

- Branch: `hub/genesis-lineage-data`
- Root: `data/genesis-lineage/`
- API: `/api/lineage-hub`
- App: `/genesis`

## Trust model

XRPL remains read-only. Browser clients do not receive a GitHub token and cannot submit canonical evidence. A public client may only trigger incremental sync for the fixed 136-account genesis cohort. The serverless function independently queries XRPL, recomputes exact AccountRoot balance deltas and native-XRP routing records, then writes an append-only delta to the data branch.

The hub's GitHub token is server-only. Configure one of these Vercel environment variables:

- `SHADOWWATCH_HUB_GITHUB_TOKEN` (preferred)
- `GITHUB_TOKEN` (fallback)

For a fine-grained GitHub PAT, scope it only to `REDCANDLEKILLER1/XRPShadowwatch` with **Contents: Read and write** and **Metadata: Read**. Do not place a PAT in HTML, JavaScript, localStorage, or the repository.

## Database layout

`manifest.json` records provenance, base artifact hashes, coverage state, per-account fixed ledger tips, and append-only delta metadata.

`base/checkpoint.json.gz.b64` is the current graph/checkpoint seed, gzip-compressed and base64 encoded. The API decodes it before returning JSON.

`base/evidence.json.gz` is reserved for the Every-Drop evidence archive used to hydrate IndexedDB on a new browser/device. The manifest can mark this archive unavailable while retaining its known source hash; the app then keeps local/imported evidence rather than pretending the hub has it.

`deltas/YYYY-MM/*.json` are server-recomputed incremental XRPL updates. They are immutable after creation and are applied by the browser in manifest order.

## Current seed state

The imported 2026-08-24 seed contains 1,258 graph nodes, 2,072 graph edges, and 2,446/2,448 Every-Drop evidence segments. Two historical segments remain unsealed and are listed explicitly in the manifest. The hub therefore must not describe the historical base as fully sealed yet.

For incremental updates, ledger 106,477,809 is the conservative fixed baseline. The later `ledger_index_max=-1` evidence in the source export is retained for research but is not used as the canonical fixed update boundary.

## API behavior

`GET /api/lineage-hub` returns manifest/status and whether server-side GitHub writes are configured. It never returns the token.

`GET /api/lineage-hub?asset=checkpoint|evidence|report|debug` returns one allowlisted base artifact.

`GET /api/lineage-hub?delta=<manifest-listed-path>` returns only a delta already listed in the manifest.

`POST /api/lineage-hub` with `{ "action": "sync", "accounts": [...], "to": <validated-ledger> }` triggers server-side deterministic sync. Accounts must be members of the 136-account tracked cohort. The function ignores client-supplied evidence because none is accepted.

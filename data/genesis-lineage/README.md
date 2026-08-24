# ShadowWatch Genesis Lineage Database

Canonical data branch for the Genesis Lineage Lab.

The browser treats this branch as a shared history hub. XRPL evidence remains read-only. Public clients may trigger server-side incremental sync, but canonical evidence is recomputed by the server from XRPL before any hub write.

Current base seed: 2026-08-24. The manifest explicitly records 2,446/2,448 Every-Drop segments as sealed and lists the two remaining historical gaps. The conservative fixed incremental boundary is ledger 106,477,809.

The visual checkpoint is stored as gzip bytes split into base64 text parts because the application API decodes it server-side before returning JSON. Exact Every-Drop evidence is registered by SHA-256 in the manifest but remains pending hub bootstrap migration; this is not represented as sealed hub evidence until those bytes are actually stored.

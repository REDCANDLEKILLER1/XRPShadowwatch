# Archive rotation preparation — offline experiment

ShadowWatch production keeps canonical, read-only XRPL evidence and complete checkpoint history. This module is an offline preparation experiment, not a production storage backend. No API, workflow or application imports it. It has no network client, publisher, delete command or cutover switch.

`seal([])` creates an empty catalog. Pin its SHA256 separately. `append(catalog, expectedHash, {id, first, last, primary, recovery})` verifies two local master-backup restores, closed UTC-day ownership, sequential non-overlapping day ranges, and checkpoint ancestry. It returns a new catalog without modifying the old one or any evidence. Exact replay is idempotent. Pin the returned hash only after separately authorized publication. The checksum is integrity protection, not a signature or trust root.

Each segment pins source commit, source tree, backup manifest SHA256, checkpoint version/hash and anchor time. Full canonical backup snapshots are retained: this first stage does not implement compact physical segments or reclaim Git history. The next snapshot must contain the prior segment's checkpoint in its verified ancestry. A segment owns at most 366 days. Days without the requested manifest fail closed rather than inventing zero activity.

`query(catalog, expectedHash, first, last, locations, kind)` routes each requested day to exactly one segment and uses the existing canonical manifest/shard readers. `locations` supplies ordered local restore roots per segment ID, outside the portable catalog. Every read verifies the whole snapshot and then requested bytes; corrupt/missing primary roots fall back to a pinned recovery copy. Any unrecoverable segment rejects the entire request. Events, participants and payloads are independently selectable. This is evidence retrieval, not proof that a production report UI has been integrated or that every wallet has complete coverage.

Local copies in these tests simulate independent recovery. Distinct directories do NOT establish independent providers. Before any real rotation: verify offsite provenance, immutable catalogs and recovery copies; integrate the application report reader; measure storage/restore costs; prove rollback and replay against real data; obtain separate merge and cutover approvals. Retain all old history. Automatic wallet admission stays disabled. No credentials, deletion, history rewriting, destination switching or production jobs are authorized by this experiment.

Test: `node scripts/run-tests.js --only archive-rotation`.

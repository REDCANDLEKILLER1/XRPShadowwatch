# ShadowWatch savepoint — 2026-10-06 08:34 Central

Classification: verified stable code checkpoint with a known iPad storage issue.

Repository: REDCANDLEKILLER1/XRPShadowwatch
Application revision: 56380e1793d9df5301651a801e924ec233cbd31a
Backup branch: backup/shadowwatch-20261006-0834-central
Production: shadowwatch.xyz, deployment dpl_Ewu7pyU1mffq7rUhCXR6AecojcN7 verified READY on this revision.

PRs #98, #99 and #100 are merged. #99 regression run 37468877182 and #100 run 37469644256 succeeded, including WebKit mobile checks. Combined local mobile RUN, viewer recovery and desktop/mobile navigation passed before merge. No uncommitted application changes at savepoint creation.

Protected behavior: read-only XRPL; watched transaction evidence comes from the verified GitHub checkpoint, no mobile account_tx recrawl; refuse publication without complete stored coverage; preserve exact sealed report text/hashes and original report history. XRPMan and XMΣMΣ branding stay intact. Keep all working report renderers and source provenance.

Known open issue: iPad export SW-20261006-2CGWI proves 423/423 wallets and seals, but discovery history IndexedDB transactions time out and phone report storage is unavailable; archive was PENDING at export. iPhone BMO83 completed and archived in 44 seconds. Checkpoint v218 through 2026-10-06T10:19:40Z is verified; freshness remains separately disclosed.

Active next work: investigate IndexedDB stalled/blocked behavior and sticky rejected connection promises in src/brief/48-saved-reports-20261005.js and 49-history-storage-20261006.js. Ensure local save failures cannot delay/cancel remote archiving, preserve old data before migration, provide truthful persistence state, and test unavailable/stalled/recovered storage plus exact report read-back. Relevant orchestration: archiveSealedReport in 02-core.js.

Next-chat instruction: Read this savepoint, verify current main and deployment before making changes, and finish the narrow iPad storage/save recovery repair while keeping the working stored-evidence report path intact. Do not automatically reset to this backup.

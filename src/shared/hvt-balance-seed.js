// ── HVT BALANCE SEED ─────────────────────────────────────────────────────────
// Cold baseline for the shared balance history (src/shared/hvt-history.js): the
// high-water mark and last reading for every tracked target.
//
// Starts empty on purpose. Every number in here has to have been read off the
// ledger by one of the apps — seeding it with invented balances would make the
// drain detector fire on numbers nobody ever observed, which is the one failure
// mode that would make the whole feature untrustworthy.
//
// To fill it: run either app, let the HVT scan complete, then EXPORT HISTORY on
// the HVT board (or SW_HVT_HISTORY.downloadSeed() in the console) and commit the
// downloaded file over this one. From then on every device — new phone, cleared
// cache, fresh browser — starts with the same peaks instead of blind.
window.SW_HVT_BALANCE_SEED = {
 "version": 1,
 "exported": null,
 "balances": {}
};

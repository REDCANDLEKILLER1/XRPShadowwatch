/* ════════════════════════════════════════════════════════════════════
   SW.txn — transaction-family counter (read-only)
   Ported from KOI txn-counter.ts FAMILY_MAP. In-memory rolling counts of
   every validated tx type seen on the live stream, grouped into families
   (Money / Markets / NFTs / Accounts). No SQLite/DB — session only.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var SW = (window.SW = window.SW || {});

  var FAMILY_MAP = {
    Payment: 'money_movement', EscrowCreate: 'money_movement', EscrowFinish: 'money_movement',
    EscrowCancel: 'money_movement', CheckCreate: 'money_movement', CheckCash: 'money_movement',
    CheckCancel: 'money_movement', PaymentChannelCreate: 'money_movement', PaymentChannelFund: 'money_movement',
    PaymentChannelClaim: 'money_movement',
    OfferCreate: 'markets', OfferCancel: 'markets', AMMDeposit: 'markets', AMMWithdraw: 'markets',
    AMMBid: 'markets', AMMVote: 'markets', AMMCreate: 'markets', AMMDelete: 'markets',
    NFTokenMint: 'nfts', NFTokenBurn: 'nfts', NFTokenCreateOffer: 'nfts', NFTokenAcceptOffer: 'nfts',
    NFTokenCancelOffer: 'nfts',
    TrustSet: 'accounts', AccountSet: 'accounts', SetRegularKey: 'accounts', SignerListSet: 'accounts',
    TicketCreate: 'accounts', DepositPreauth: 'accounts', Clawback: 'accounts', AccountDelete: 'accounts'
  };
  var FAMILY_NAMES = ['money_movement', 'markets', 'nfts', 'accounts'];
  var FAMILY_LABELS = { money_movement: 'Money', markets: 'Markets', nfts: 'NFTs', accounts: 'Accounts' };
  var FAMILY_COLORS = { money_movement: '#3fb950', markets: '#58a6ff', nfts: '#d29922', accounts: '#bc8cff' };

  var counts = {};

  function record(txType) { if (!txType) return; counts[txType] = (counts[txType] || 0) + 1; }
  function familyOf(txType) { return FAMILY_MAP[txType] || 'other'; }
  function reset() { counts = {}; }

  function snapshot() {
    var total = 0, fam = {};
    FAMILY_NAMES.forEach(function (f) { fam[f] = 0; });
    var other = 0;
    for (var t in counts) {
      if (!counts.hasOwnProperty(t)) continue;
      var f = FAMILY_MAP[t];
      if (f) fam[f] += counts[t]; else other += counts[t];
      total += counts[t];
    }
    var families = {};
    FAMILY_NAMES.forEach(function (f) {
      families[f] = { count: fam[f], label: FAMILY_LABELS[f], color: FAMILY_COLORS[f],
        pct: total > 0 ? Number((fam[f] / total * 100).toFixed(1)) : 0 };
    });
    return { families: families, other: other, total: total };
  }

  SW.txn = { record: record, familyOf: familyOf, snapshot: snapshot, reset: reset,
    FAMILY_MAP: FAMILY_MAP, FAMILY_NAMES: FAMILY_NAMES, FAMILY_LABELS: FAMILY_LABELS, FAMILY_COLORS: FAMILY_COLORS };
})();

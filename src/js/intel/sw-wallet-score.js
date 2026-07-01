/* ════════════════════════════════════════════════════════════════════
   SW.wallet — wallet scorer (read-only)
   Scores a wallet on
   account age, balance, activation source (known exchange), and offer
   cancel ratio → 0..8, rated green / yellow / red. Pure function over
   already-fetched ledger data — no network here.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var SW = (window.SW = window.SW || {});
  var MAX_SCORE = 8;

  // Known exchange activation wallets. If a
  // wallet's first funder is one of these, it's exchange-activated (+2).
  var KNOWN_EXCHANGES = {
    'rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv': 'Bitstamp', 'rUobSiUpYH2S97Mgb4E7b7HuzQj2uzZ3aD': 'Bitstamp',
    'rGFuMiw48HdbnrUbkRYuitXTmfrDBNTCnX': 'Bitstamp', 'rBMFF7vhe2pxYS5wo3dpXMDrbbRudB7hGf': 'Bitstamp',
    'rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh': 'Binance', 'rNxp4h8apvRis6mJf9Sh8C6iRxfrDWN7AV': 'Binance',
    'rLHzPsX6oXkzU2qL12kHCH8G8cnZv1rBJh': 'Kraken', 'rUeDDFNp2q7Ymvyv75hFGC8DAcygVyJbNF': 'Kraken',
    'rGZjPjMkfhAqmc1ssEiT753uAgyftHRo2m': 'Kraken', 'rp7TCczQuQo61dUo1oAgwdpRxLrA8vDaNV': 'Kraken',
    'rEvuKRoEbZSbM5k5Qe5eTD9BixZXsfkxHf': 'Kraken',
    'rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w': 'Coinbase', 'rw2ciyaNshpHe7bCHo4bRWq6pqqynnWKQg': 'Coinbase',
    'rUfghnh1VAWajpAmxgrzLPiCXJ7RwdJUgt': 'Coinbase', 'rwpTh9DDa52XkM9nTKp2QrJuCGV5d1mQVP': 'Coinbase',
    'rMrgNBrkE6FdCjWih5VAWkGMrmerrWpiZt': 'Bybit', 'rNFKfGBzMspdKfaZdpnEyhkFyw7C1mtQ8x': 'Bybit',
    'rLW9gnQo7BQhU6igk5keqYnH3TVrCxGRzm': 'Bitfinex', 'rE3hWEGquaixF2XwirNbA1ds4m55LxNZPk': 'Bitfinex',
    'rKNwXQh9GMjaU8uTqKLECsqyib47g5dMvo': 'Crypto.com', 'r4DymtkgUAh2wqRxVfdd3Xtswzim6eC6c5': 'Crypto.com',
    'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq': 'GateHub', 'rfkE1aSy9G8Upk4JssnwBxhEv5p4mn2KTy': 'Uphold'
  };

  function activationExchange(addr) { return KNOWN_EXCHANGES[addr] || null; }

  // raw: { balanceXrp, accountAgeYears, activationExchange, offerCreateCount, offerCancelCount, notFound }
  function score(raw) {
    raw = raw || {};
    if (raw.notFound) {
      return { score: 0, maxScore: MAX_SCORE, rating: 'red', cancelRatio: 0,
        breakdown: [['account', 'not found / unfunded → red']] };
    }
    var s = 0, br = [];
    var age = Number(raw.accountAgeYears) || 0;
    if (age > 2) { s += 2; br.push(['age', '+2 (> 2y)']); }
    else if (age > 0.5) { s += 1; br.push(['age', '+1 (6mo–2y)']); }
    else br.push(['age', '+0 (< 6mo)']);

    var bal = Number(raw.balanceXrp) || 0;
    if (bal > 100000) { s += 2; br.push(['balance', '+2 (> 100K)']); }
    else if (bal > 10000) { s += 1; br.push(['balance', '+1 (10K–100K)']); }
    else br.push(['balance', '+0 (< 10K)']);

    if (raw.activationExchange) { s += 2; br.push(['activation', '+2 (' + raw.activationExchange + ')']); }
    else br.push(['activation', '+0 (unknown funder)']);

    var oc = Number(raw.offerCreateCount) || 0, ox = Number(raw.offerCancelCount) || 0;
    var tot = oc + ox, cancelRatio = tot > 0 ? ox / tot : 0;
    if (tot > 0) {
      if (cancelRatio < 0.4) { s += 2; br.push(['offers', '+2 (cancel ' + (cancelRatio * 100).toFixed(0) + '%)']); }
      else if (cancelRatio < 0.7) { s += 1; br.push(['offers', '+1 (cancel ' + (cancelRatio * 100).toFixed(0) + '%)']); }
      else br.push(['offers', '+0 (cancel ' + (cancelRatio * 100).toFixed(0) + '% — spammy)']);
    } else { s += 1; br.push(['offers', '+1 (no offer history)']); }

    var rating = s >= 6 ? 'green' : s >= 3 ? 'yellow' : 'red';
    return { score: s, maxScore: MAX_SCORE, rating: rating, cancelRatio: cancelRatio, breakdown: br };
  }

  function ratingColor(r) { return { green: '#33dd66', yellow: '#ffd000', red: '#ff4444' }[r] || '#888'; }

  SW.wallet = { score: score, ratingColor: ratingColor, activationExchange: activationExchange, KNOWN_EXCHANGES: KNOWN_EXCHANGES, MAX_SCORE: MAX_SCORE };
})();

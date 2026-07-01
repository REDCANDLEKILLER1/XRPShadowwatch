/* ════════════════════════════════════════════════════════════════════
   SW.flow — flow / route classification for a single transaction (read-only)
   Ported concepts from KOI flow-detector.ts: parseAmount, KNOWN_CURRENCIES,
   isMemeRoute, isDirectXrpSwap, and cross-currency route shape. Returns a
   compact flow label; does not trade, sign, or submit anything.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var SW = (window.SW = window.SW || {});
  var norm = function (c) { return (SW.token && SW.token.normalizeCurrency) ? SW.token.normalizeCurrency(c) : String(c || '???'); };

  // Recognized currencies (stablecoins / major fiat / native). Anything else
  // is treated as a meme/unknown token. (from KOI KNOWN_CURRENCIES)
  var KNOWN = new Set([
    'RLUSD', 'USD', 'USDC', 'USDT',
    'EUR', 'GBP', 'JPY', 'CNY', 'KRW', 'BRL', 'BBRL',
    'AUD', 'CAD', 'CHF', 'SGD', 'HKD', 'MXN', 'INR',
    'NZD', 'SEK', 'NOK', 'DKK', 'ZAR', 'PHP', 'THB',
    'IDR', 'TRY', 'PLN', 'CZK', 'HUF', 'ILS', 'AED', 'XRP'
  ]);
  var STABLE = new Set(['RLUSD', 'USD', 'USDC', 'USDT']);

  // Extract {currency,label,issuer,value} from an XRPL amount field.
  function parseAmount(amount) {
    if (amount == null) return null;
    if (typeof amount === 'string') return { currency: 'XRP', label: 'XRP', issuer: '', value: Number(amount) / 1e6 };
    if (typeof amount === 'object' && amount.currency) {
      return { currency: amount.currency, label: norm(amount.currency), issuer: amount.issuer || '', value: Number(amount.value) || 0 };
    }
    return null;
  }

  function isMemeRoute(s, d) { return !KNOWN.has(s) || !KNOWN.has(d); }
  function isDirectXrpSwap(s, d) { return (s === 'XRP' && d === 'RLUSD') || (s === 'RLUSD' && d === 'XRP'); }

  // Classify a transaction into a compact flow descriptor.
  // Returns { family, kind, route, label, confidence } or null. Labels are
  // neutral flow/route descriptors only (no buy/sell — this is a watchdog).
  function classify(txData, meta) {
    if (!txData) return null;
    var type = txData.TransactionType;

    if (type === 'TrustSet') {
      var tc = txData.LimitAmount && norm(txData.LimitAmount.currency);
      return { family: 'accounts', kind: 'trustline', route: tc || '', label: 'TRUSTLINE' + (tc ? ' · ' + tc : ''), confidence: 'high' };
    }

    var source = null, dest = null;
    if (type === 'Payment') {
      source = parseAmount(txData.SendMax) || parseAmount(txData.Amount);
      dest = parseAmount((meta && meta.delivered_amount)) || parseAmount(txData.Amount);
    } else if (type === 'OfferCreate') {
      // XRPL OfferCreate semantics: TakerGets = currency being sold (source),
      // TakerPays = currency being bought (dest). Read-only classification only.
      source = parseAmount(txData.TakerGets);
      dest = parseAmount(txData.TakerPays);
    } else {
      return { family: (SW.txn ? SW.txn.familyOf(type) : 'other'), kind: 'other', route: '', label: (type || 'TX').toUpperCase(), confidence: 'low' };
    }
    if (!source || !dest) return null;

    var s = norm(source.currency), d = norm(dest.currency);
    var route = s + '→' + d;
    var crossCurrency = !(s === d && source.issuer === dest.issuer);
    var xrpSide = (s === 'XRP' || d === 'XRP');
    var stable = STABLE.has(s) || STABLE.has(d);
    var family = (type === 'OfferCreate') ? 'markets' : 'money_movement';

    // Neutral flow/route labels only — Shadow Watch classifies, it never trades.
    var kind, label, conf = 'med';
    if (type === 'OfferCreate') {
      kind = 'dex'; conf = 'high'; label = 'DEX ROUTE';
    } else if (!crossCurrency) {
      if (s === 'XRP') { kind = 'xrp-transfer'; label = 'XRP TRANSFER'; }
      else { kind = 'token-transfer'; label = 'TOKEN TRANSFER'; }
      conf = 'high';
    } else if (xrpSide) {
      kind = 'xrp-token'; conf = 'high';
      label = (s === 'XRP') ? 'FLOW XRP→TOKEN' : 'FLOW TOKEN→XRP';
    } else if (stable) {
      kind = 'stable-route'; label = 'STABLE ROUTE';
    } else {
      kind = 'token-route'; label = 'TOKEN ROUTE';
    }

    return { family: family, kind: kind, route: route, label: label, confidence: conf };
  }

  SW.flow = { classify: classify, parseAmount: parseAmount, isMemeRoute: isMemeRoute, isDirectXrpSwap: isDirectXrpSwap, KNOWN: KNOWN };
})();

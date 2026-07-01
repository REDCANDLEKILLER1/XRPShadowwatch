/* ════════════════════════════════════════════════════════════════════
   SW.token — token / currency identity (read-only)
   Ported concepts from KOI flow-detector.ts (HEX_CURRENCY_MAP,
   normalizeCurrency) + explorer link builders. No API keys, no network
   calls here — pure functions + link builders. Enrichment is optional and
   cached by the caller.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var SW = (window.SW = window.SW || {});

  // Known hex currency codes (from KOI flow-detector HEX_CURRENCY_MAP)
  var HEX_MAP = {
    '524C555344000000000000000000000000000000': 'RLUSD',
    '4555520000000000000000000000000000000000': 'EUR',
    '5553440000000000000000000000000000000000': 'USD',
    '5553444300000000000000000000000000000000': 'USDC',
    '5553445400000000000000000000000000000000': 'USDT',
    '434E590000000000000000000000000000000000': 'CNY',
    '4742500000000000000000000000000000000000': 'GBP',
    '4A50590000000000000000000000000000000000': 'JPY'
  };

  // Decode/normalize a currency code to a readable label.
  // 3-12 char alphanumeric codes pass through; hex is mapped or ASCII-decoded.
  function normalizeCurrency(code) {
    if (!code) return '???';
    code = String(code);
    if (code.length <= 12 && /^[A-Za-z0-9]+$/.test(code)) return code.toUpperCase();
    if (HEX_MAP[code.toUpperCase()]) return HEX_MAP[code.toUpperCase()];
    try {
      var ascii = code.replace(/(..)/g, function (m, p) { return String.fromCharCode(parseInt(p, 16)); })
        .replace(/\0/g, '').trim();
      if (ascii.length >= 2 && ascii.length <= 12 && /^[A-Za-z0-9]+$/.test(ascii)) return ascii.toUpperCase();
    } catch (e) { /* not hex */ }
    return code.substring(0, 6) + '…';
  }

  function toXrplHex(nameOrCode) {
    nameOrCode = String(nameOrCode || '');
    if (nameOrCode.length === 40 && /^[0-9A-Fa-f]+$/.test(nameOrCode)) return nameOrCode.toUpperCase();
    var hex = '';
    for (var i = 0; i < nameOrCode.length; i++) hex += nameOrCode.charCodeAt(i).toString(16).padStart(2, '0');
    return (hex.toUpperCase() + '0000000000000000000000000000000000000000').slice(0, 40);
  }

  // Read-only explorer link builders (no keys). Callers should escape output.
  function xrpscanAccount(a) { return 'https://xrpscan.com/account/' + encodeURIComponent(a); }
  function bithompAccount(a) { return 'https://bithomp.com/explorer/' + encodeURIComponent(a); }
  function xrpscanToken(cur, issuer) { return 'https://xrpscan.com/token/' + encodeURIComponent(issuer) + '/' + encodeURIComponent(cur); }
  // DexScreener uses the issuer address as the XRPL token identifier.
  function dexScreenerToken(issuer) { return issuer ? 'https://dexscreener.com/xrpl/' + encodeURIComponent(issuer) : null; }

  // Build a cached identity object for an issued currency (no network).
  function identify(currency, issuer) {
    var key = currency + ':' + (issuer || '');
    if (SW.tokenCache[key]) return SW.tokenCache[key];
    var label = normalizeCurrency(currency);
    var obj = {
      currency: currency, issuer: issuer || '', label: label,
      links: {
        xrpscan: issuer ? xrpscanToken(label, issuer) : null,
        dexscreener: dexScreenerToken(issuer),
        issuer: issuer ? xrpscanAccount(issuer) : null
      }
    };
    SW.tokenCache[key] = obj;
    return obj;
  }

  SW.token = {
    normalizeCurrency: normalizeCurrency,
    toXrplHex: toXrplHex,
    xrpscanAccount: xrpscanAccount,
    bithompAccount: bithompAccount,
    dexScreenerToken: dexScreenerToken,
    identify: identify
  };
})();

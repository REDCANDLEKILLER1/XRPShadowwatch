// ── SHARED HIGH-VALUE TARGET ROSTER ──────────────────────────────────────────
// The one list of wallets both apps consider high-value. Before this file the
// live wall watched 74 targets and the report console watched 170, and only
// 45 addresses were on both — so a wallet could be a headline in the morning
// brief and completely absent from the HVT board, or drain to nothing on the
// board without the report ever looking at it.
//
// Loaded by BOTH index.html and brief-console.html. They are separate documents
// with separate engines; a committed file is the only thing they can both read.
// Same pattern, and the same rules, as src/shared/wallet-identities.js:
//   · `label` is a NAME only when the identity registry establishes one
//     (`identified: true`). Otherwise it is the internal handle or the wall's
//     own label — a description, not a claim of ownership.
//   · `expected_xrp` is the size the label itself asserts ("20M Split 1",
//     "RIPPLE_1.3B"). It is what the balance watch measures a drain against:
//     a target labelled 100M holding 50 XRP is an event, not noise.
//   · `sources` records which app contributed the address, so neither side
//     silently loses its own targets when this file is regenerated.
//
// Regenerate with scripts/build-hvt-roster.js after adding wallets to either
// app. Do not hand-edit — the generator is the source of truth.
//
// 228 targets · 128 with a sourced identity · 32 carrying a size claim
window.SW_HVT_ROSTER = {
 "version": 1,
 "generated": "2026-08-13",
 "stats": {
  "total": 228,
  "identified": 128,
  "from_report_only": 94,
  "from_wall_only": 5,
  "from_registry_only": 29,
  "both": 45,
  "with_expected": 32,
  "rejected_invalid": 0
 },
 "targets": [
  {
   "address": "ragKXjY7cBTXUus32sYHZVfkY46Nt2Q829",
   "label": "ahbritto",
   "handle": "OKX_COLD",
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rEbKBkgKSQgm5x8PycZc5VjdCVTmqYfcY1",
   "label": "ahbritto",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "rG2eEaeiJou6cVQ3KtX7XMNwGhuW99xmHP",
   "label": "ahbritto",
   "handle": "ARTHUR_BRITTO_A",
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rJ5EJYsW6Vkeruj1LAmQYq3VP7QUQKBH1W",
   "label": "ahbritto",
   "handle": "ARTHUR_BRITTO_C",
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rQKZSMgmBJvv3FvWj1vuGjUXnegTqJc25z",
   "label": "ahbritto",
   "handle": "ARTHUR_BRITTO_E",
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rsF9cc6gniHLTR2Jng29ng21ez7L9PpmPt",
   "label": "ahbritto",
   "handle": "ARTHUR_BRITTO_B",
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rsXNUCJkXeyFuGHyfRnuWPita2ns32upBD",
   "label": "ahbritto",
   "handle": "ARTHUR_BRITTO_D",
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "r3bqvUfF9weyxZqwo6qumBV2Q5k8LzepjJ",
   "label": "Binance",
   "handle": "BINANCE_PEG_BRIDGE",
   "type": "EXCH",
   "identified": true,
   "confidence": "OPERATOR_ASSERTED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rarG6FaeYhnzSKSS5EEPofo4gFsPn2bZKk",
   "label": "Binance",
   "handle": "WHALE_RECV_rarG6F",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rBtttd61FExHC68vsZ8dqmS3DfjFEceA1A",
   "label": "Binance",
   "handle": "WHALE_RECV_rBtttd",
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rDAE53VfMvftPB4ogpWGWvzkQxfht6JPxr",
   "label": "Binance",
   "handle": "LARGE_RECV_rDAE53",
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rDecw8UhrZZUiaWc91e571b3TL41MUioh7",
   "label": "Binance",
   "handle": "BINANCE_HOT_2",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rDNuKeiwTHWRCyBrh1aQUthLPkCUTxhz2W",
   "label": "Binance",
   "handle": null,
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "rE5LDXksLZHsRgGUgqu7NiTSDd5zFz7rsW",
   "label": "Binance",
   "handle": "BINANCE_COLD_2",
   "type": "EXCH",
   "identified": true,
   "confidence": "OPERATOR_ASSERTED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh",
   "label": "Binance",
   "handle": "BINANCE_HOT",
   "type": "EXCH",
   "identified": true,
   "confidence": "OPERATOR_ASSERTED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rEbXa31msPbPDZgmLMKH7CaKaf7VipoLBo",
   "label": "Binance",
   "handle": null,
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "rfQ9EcLkU6WnNmkS3EwUkFeXeN47Rk8Cvi",
   "label": "Binance",
   "handle": "WHALE_RECV_rfQ9Ec",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rhWj9gaovwu2hZxYW7p388P8GRbuXFLQkK",
   "label": "Binance",
   "handle": "WHALE_RECV_rhWj9g",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rJpj1Mv21gJzsbsVnkp1U4nqchZbmZ9pM5",
   "label": "Binance",
   "handle": "BINANCE_325M",
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": 325000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rKuP5k67YtHzsCmSQp7votF7u4afp4uNcm",
   "label": "Binance",
   "handle": null,
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "rNU4eAowPuixS5ZCWaRL72UUeKgxcKExpK",
   "label": "Binance",
   "handle": "WHALE_RECV_rNU4eA",
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rP3mUZyCDzZkTSd1VHoBbFt8HGm8fyq8qV",
   "label": "Binance",
   "handle": "BINANCE_HC",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rPJ5GFpyDLv7gqeB1uZVUBwDwi41kaXN5A",
   "label": "Binance",
   "handle": null,
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "rpVu7CQHTGqWDvBzm3TB2drmZBmh6jGNz4",
   "label": "Binance",
   "handle": null,
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "rPz2qA93PeRCyHyFCqyNggnyycJR1N4iNf",
   "label": "Binance",
   "handle": "WHALE_RECV_BINANCE",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rs8ZPbYqgecRcDzQpJYAMhSxSi5htsjnza",
   "label": "Binance",
   "handle": "BINANCE_1.7B",
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": 1700000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rwkbXMJQLQhVhcjZnnHV4zu39N7WcQXQKX",
   "label": "Binance",
   "handle": null,
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "rwshjBngGqMRJgGYvEJXGMkg5DS2GX3U3q",
   "label": "Binance",
   "handle": "BINANCE_COLD_1",
   "type": "EXCH",
   "identified": true,
   "confidence": "OPERATOR_ASSERTED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "r3ZVNKgkkT3A7hbEZ8HxnNnLDCCmZiZECV",
   "label": "Binance US",
   "handle": null,
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "rB1kVfLSxpXCw7sLCBcm5LFZYzkS6xmwSK",
   "label": "bitbank",
   "handle": "BITBANK_COLD",
   "type": "EXCH",
   "identified": true,
   "confidence": "OPERATOR_ASSERTED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rw7m3CtVHwGSdhFjV4MyJozmZJv3DYQnsA",
   "label": "bitbank",
   "handle": "BITBANK_JP",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rE3hWEGquaixF2XwirNbA1ds4m55LxNZPk",
   "label": "Bitfinex",
   "handle": null,
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "rLW9gnQo7BQhU6igk5keqYnH3TVrCxGRzm",
   "label": "Bitfinex",
   "handle": null,
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "rhWVCsCXrkwTeLBg6DyDr7abDaHz3zAKmn",
   "label": "bitFlyer",
   "handle": "BITFLYER_COLD",
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rwTTsHVUDF8Ub2nzV2oAeWxfJzUvobXLEf",
   "label": "Bitget Global",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "rPyCQm8E5j78PDbrfKF24fRC7qUAk1kDMZ",
   "label": "Bithumb",
   "handle": "WHALE_1.8B",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 1800000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rw3fRcmn5PJyPKuvtAwHDSpEqoW2JKmKbu",
   "label": "Bithumb",
   "handle": "BITHUMB_HOT",
   "type": "EXCH",
   "identified": true,
   "confidence": "OPERATOR_ASSERTED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rE3Cc3i6163Qzo7oc6avFQAxQE4gyCWhGP",
   "label": "Bitkub",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "rfmMjAXq65hpAxEf1RLNQq6RgYTSVkQUW5",
   "label": "BITPoint",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "r4DbbWjsZQ2hCcxmjncr7MRjpXTBPckGa9",
   "label": "Bitrue Cold",
   "handle": null,
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "rNYW2bie6KwUSYhhtcnXWzRy5nLCa1UNCn",
   "label": "Bitrue Insurance Fund",
   "handle": null,
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "rLSn6Z3T8uCxbcd1oxwfGQN1Fdn5CyGujK",
   "label": "Bitso",
   "handle": "WHALE_RECV_rLSn6Z",
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv",
   "label": "Bitstamp",
   "handle": "SPLITTER_rDsbeo",
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rpQATJWPPdNMxVCTQDYcnRNwtFDnanT3nk",
   "label": "Bitunix",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "rKRYAqMFTTGMZ47eXJVRKcqLJgnPQbXisg",
   "label": "BTC Markets",
   "handle": "LARGE_RECV_rKRYAq",
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rZ6XrB8if1qB3hEW6KKVzvGH2cLtUeEcd",
   "label": "BTC Markets",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "raQxZLtqurEXvH5sgijrif7yXMNwvFRkJN",
   "label": "Bybit",
   "handle": null,
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "rJn2zAPdFA193sixJwuFixRkYDUtx3apQh",
   "label": "Bybit",
   "handle": "HIGHVAL_rJn2zA",
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rMvCasZ9cohYrSZRNYPTZfoaaSUQMfgQ8G",
   "label": "Bybit",
   "handle": "LARGE_RECV_rMvCas",
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rN1yT2hkfMt89CJVsXdvnKqRJbqm7TC8uo",
   "label": "Bybit",
   "handle": "BYBIT_CUSTODY",
   "type": "EXCH",
   "identified": true,
   "confidence": "OPERATOR_ASSERTED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rQUp2PKzH3vCtKs5H9tsPPE1rTsN6fhjqn",
   "label": "Ceffu",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "r44CNwMWyJf4MEA1eHVMLPTkZ1LSv4Bzrv",
   "label": "chrislarsen",
   "handle": "BITHUMB_COLD",
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "r476293LUcDqtjiSGJ5Dh44J1xBCDWeX3",
   "label": "chrislarsen",
   "handle": "RIPPLE_500M_F",
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 500000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rD6tdgGHG7hwGTA6P39aE7W89fbqxXRjzk",
   "label": "chrislarsen",
   "handle": "RIPPLE_500M_E",
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 500000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rDfrrrBJZshSQDvfT2kmL9oUBdish52unH",
   "label": "chrislarsen",
   "handle": "RIPPLE_500M_D",
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 500000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rhREXVHV938ToGkdJQ9NCYEY4x8kSEtjna",
   "label": "chrislarsen",
   "handle": "CHRIS_LARSEN",
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rPoJNiCk7XSFLR28nH2hAbkYqjtMC3hK2k",
   "label": "chrislarsen",
   "handle": "BITSTAMP_COLD",
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rU5ACGLKbhPQB92GZhT5UV22NHeVrEGuU6",
   "label": "Coinbase",
   "handle": null,
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "rw2ciyaNshpHe7bCHo4bRWq6pqqynnWKQg",
   "label": "Coinbase",
   "handle": "COINBASE_HOT",
   "type": "EXCH",
   "identified": true,
   "confidence": "OPERATOR_ASSERTED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rUf5QkXtwVr9XxCdVhn1pFN7ZyMwGhN5Ng",
   "label": "Coinbase cbXRP",
   "handle": null,
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "r99QSej32nAcjQAri65vE5ZXjw6xpUQ2Eh",
   "label": "Coincheck",
   "handle": "COINCHECK_TOP",
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rN3t4Epm69GXM1Bx42Ne1opfai7eUvmopY",
   "label": "Coincheck",
   "handle": "COINCHECK_COLD",
   "type": "EXCH",
   "identified": true,
   "confidence": "OPERATOR_ASSERTED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rLUpiBeLhUyEzVtBkYE4S9t4zhdybSSARw",
   "label": "CoinDCX",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "rQUmgHMWTXGpFqcVEo2qtHY7xvhk4V4Bua",
   "label": "CoinDCX",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "rPvKH3CoiKnne5wAYphhsWgqAEMf1tRAE7",
   "label": "CoinJar",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "rDKw32dPXHfoeGoD3kVtm76ia1WbxYtU7D",
   "label": "Coinone",
   "handle": "COINONE_KR",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rhuCPEoLFYbpbwyhXioSumPKrnfCi3AXJZ",
   "label": "Coinone",
   "handle": "WHALE_RECV_rhuCPE",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rCoinaUERUrXb1aA7dJu8qRcmvPNiKS3d",
   "label": "CoinPayments",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "rxXXXeMX8Gy5YvibvGLnQJ1XKKD7UswM1",
   "label": "Coreum Bridge",
   "handle": "COREUM_BRIDGE",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 200410,
   "expected_source": "published_source",
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rfXSfH2q4zhGWdw45nYcWfjvFN5ZfwE1U6",
   "label": "Coreum outflow — front A",
   "handle": "COREUM_INC_FRONT_A",
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rwt8PJhyXWgW8uwmTjmQ7Rw89tJHELFgb5",
   "label": "Coreum outflow — front B",
   "handle": "COREUM_INC_FRONT_B",
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rnaBRmXU6ZS7orU6Qj38wsBYQmqHPbrhA9",
   "label": "Coreum outflow — staging A",
   "handle": "COREUM_INC_STAGING_A",
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "r3jV8g599WMR9zeFi5m1rbvXyEwNWwYFXt",
   "label": "Coreum outflow — staging B",
   "handle": "COREUM_INC_STAGING_B",
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "r4DymtkgUAh2wqRxVfdd3Xtswzim6eC6c5",
   "label": "Crypto.com",
   "handle": "WHALE_RECV_r4Dymt",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rKNwXQh9GMjaU8uTqKLECsqyib47g5dMvo",
   "label": "Crypto.com",
   "handle": "CRYPTO_COM",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rprFy94qJB5riJpMmnPDp3ttmVKfcrFiuq",
   "label": "Doppler Finance",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "rEvwSpejhGTbdAXbxRTpGAzPBQkBRZxN5s",
   "label": "eToro",
   "handle": "ETORO_TOP",
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rKXXrAgpkHQN8m4HxAQCYmDCPPUByc9mVq",
   "label": "Evernorth",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "rsT3yYMkuicxW1hYsy787mg5XHhkz2uQRk",
   "label": "Evernorth",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "raJHqa1o57DwjtrLCZjdkMKRtfHnbrwSse",
   "label": "Firi",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "rfkXSaCZKTg1EZzec2rLDyrWHxRVJdtVXj",
   "label": "Flare Core Vault",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "rHcFoo6a9qT5NHiVn1THQRhsEGcxtYCV4d",
   "label": "Gate.io",
   "handle": null,
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "rLzxZuZuAHM7k3FzfmhGkXVwScM4QSxoY7",
   "label": "Gate.io",
   "handle": null,
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "rNnWmrc1EtNRe5SEQEs9pFibcjhpvAiVKF",
   "label": "Gate.io",
   "handle": null,
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "rNu9U5sSouNoFunHp9e9trsLV6pvsSf54z",
   "label": "Gate.io",
   "handle": null,
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "raBQUYdAhnnojJQ6Xi3eXztZ74ot24RDq1",
   "label": "Gemini",
   "handle": null,
   "type": "EXCH",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "rUYHZ71yXAS54ZQNvvooLX7rFtZydXjnP",
   "label": "Hata",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "rG6FZ31hDHN1K5Dkbma3PSB5uVCuVVRzfn",
   "label": "Huobi",
   "handle": "HUOBI_MAIN",
   "type": "EXCH",
   "identified": true,
   "confidence": "OPERATOR_ASSERTED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rEvuKRoEbZSbM5k5Qe5eTD9BixZXsfkxHf",
   "label": "Kraken",
   "handle": null,
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "rnJrjec2vrTJAAQUTMTjj7U6xdXrk9N4mT",
   "label": "Kraken",
   "handle": null,
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "r4eEexVBREc4bbYh7dEfQNMe86sDmhKSph",
   "label": "LBank",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "rsbfd5ZYWqy6XXf6hndPbRjDAzfmWc1CeQ",
   "label": "Luno",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "rPEPYN8sHU3cytBwVm69qPbVztaoj7wNf",
   "label": "Mercado Bitcoin",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "rs2dgzYeqYqsk8bvkQR5YPyqsXYcA24MP2",
   "label": "MEXC",
   "handle": "HIGHVAL_rs2dgz",
   "type": "HVT",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rLMAAuqJowC5yMccaPnappeLM8vDfdiDTg",
   "label": "Phemex",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "rLwTB2mgf7jzj7yBfddxN5DdTzRpnho42W",
   "label": "PulseX Sacrifice",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "rEiq1iAcpzP8WLjezP9MzAQEJ7jqKMLFSA",
   "label": "Revolut",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "r3F5NsyiGwVYs2Rs3cCcrVw4t5wZP2ZxRr",
   "label": "Ripple",
   "handle": null,
   "type": "RIPPLE",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "r9NpyVfLfUG8hatuCCHKzosyDtKnBdsEN3",
   "label": "Ripple",
   "handle": "RIPPLE_500M_B",
   "type": "RIPPLE",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 500000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rBg2FuZT91C52Nny68houguJ4vt5x1o91m",
   "label": "Ripple",
   "handle": "WHALE_RECV_rBg2Fu",
   "type": "RIPPLE",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 300000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rhtufNsYfrozs4GvSq4HMYcR9y3dg8FWdC",
   "label": "Ripple",
   "handle": "RIPPLE_OPS",
   "type": "RIPPLE",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rhyp1uMC9Xyj3Px8amUH3xVv6tbjYJkojs",
   "label": "Ripple",
   "handle": null,
   "type": "RIPPLE",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "rJqiMb94hyz41SBTNr2AyPNW8AzELa8nE",
   "label": "Ripple",
   "handle": "RIPPLE_305M_G",
   "type": "RIPPLE",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 305000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rKveEyR1SrkWbJX214xcfH43ZsoGMb3PEv",
   "label": "Ripple",
   "handle": "RIPPLE_845M",
   "type": "RIPPLE",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 845000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rMhkqz3DeU7GUUJKGZofusbrTwZe6bDyb1",
   "label": "Ripple",
   "handle": "RIPPLE_500M_A",
   "type": "RIPPLE",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 500000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rMQ98K56yXJbDGv49ZSmW51sLn94Xe1mu1",
   "label": "Ripple",
   "handle": "RIPPLE_1.3B",
   "type": "RIPPLE",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 1300000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rNRc2S2GSefSkTkAiyjE6LDzMonpeHp6jS",
   "label": "SBI VC Trade",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "razaE6HTEMUc9ogMYwmBT5GQk2b9qtbTnC",
   "label": "Stake",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "razLtrbzXVXYvViLqUKLh8YenGLJid9ZTW",
   "label": "Stake",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "rBndy89HdamJ3UHNekAS6ALjW9WoCE2W5s",
   "label": "Stake",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "r38a3PtqW3M7LRESgaR4dyHjg3AxAmiZCt",
   "label": "Upbit",
   "handle": "RIPPLE_500M_C",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 500000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "r4G689g4KePYLKkyyumM1iUppTP4nhZwVC",
   "label": "Upbit",
   "handle": "UPBIT_500M_A",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 500000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rDxJNbV23mu9xsWoQHoBqZQvc77YcbJXwb",
   "label": "Upbit",
   "handle": "UPBIT_1.2B",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 1200000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rfL1mn4VTCoHdhHhHMwqpShCFUaDBRk6Z5",
   "label": "Upbit",
   "handle": "UPBIT_500M_C",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 500000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rH5wodHpZzeXBAWE36nMoRXGqeEjSdbzWU",
   "label": "Upbit",
   "handle": "UPBIT_COLD",
   "type": "EXCH",
   "identified": true,
   "confidence": "OPERATOR_ASSERTED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rJo4m69u9Wd1F8fN2RbgAsJEF6a4hW1nSi",
   "label": "Upbit",
   "handle": "UPBIT_500M_F",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 500000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rJWbw1u3oDDRcYLFqiWFjhGWRKVcBAWdgp",
   "label": "Upbit",
   "handle": "UPBIT_500M_I",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 500000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rLgn612WAgRoZ285YmsQ4t7kb8Ui3csdoU",
   "label": "Upbit",
   "handle": "UPBIT_500M_G",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 500000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rMNUAfSz2spLEbaBwPnGtxTzZCajJifnzH",
   "label": "Upbit",
   "handle": "UPBIT_500M_B",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 500000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rNcAdhSLXBrJ3aZUq22HaNtNEPpB5fR8Ri",
   "label": "Upbit",
   "handle": "UPBIT_500M_E",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 500000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rs48xReB6gjKtTnTfii93iwUhjhTJsW78B",
   "label": "Upbit",
   "handle": "UPBIT_500M_H",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 500000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rwa7YXssGVAL9yPKw6QJtCen2UqZbRQqpM",
   "label": "Upbit",
   "handle": "UPBIT_500M_D",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 500000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rBEc94rUFfLfTDwwGN7rQGBHc883c2QHhx",
   "label": "Uphold",
   "handle": "UPHOLD_ACTIVE",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rErKXcbZj9BKEMih6eH6ExvBoHn9XLnTWe",
   "label": "Uphold",
   "handle": null,
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "wall"
   ]
  },
  {
   "address": "rpPcmcGQ5iTXDc5zF5owxwTifkTs1qYrA6",
   "label": "Uphold",
   "handle": "UPHOLD_CUSTODY",
   "type": "EXCH",
   "identified": true,
   "confidence": "OPERATOR_ASSERTED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry",
    "report"
   ]
  },
  {
   "address": "rsXT3AQqhHDusFs3nQQuwcA1yXRLZJAXKw",
   "label": "Uphold",
   "handle": "WHALE_1.5B",
   "type": "EXCH",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": 1500000000,
   "expected_source": "label_claim",
   "sources": [
    "registry",
    "report",
    "wall"
   ]
  },
  {
   "address": "rPBMDP7CGiKzMvPx6SsCGgeDsrsUyv1K1b",
   "label": "Yobit",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "CONFIRMED",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "r9FNc9txxrB98DizMkhQBj3hgKQCbF1bGA",
   "label": "ZebPay",
   "handle": null,
   "type": "HVT",
   "identified": true,
   "confidence": "PUBLIC_SOURCE",
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "registry"
   ]
  },
  {
   "address": "rfRms8V4gNsJDdg4VtWrjxsgrQPQ9ZF8n8",
   "label": "100M Outbound Receiver",
   "handle": "SPLITTER_rfRms8",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": 100000000,
   "expected_source": "label_claim",
   "sources": [
    "report",
    "wall"
   ]
  },
  {
   "address": "rwtzRvvadGpwEazxbsmXTRd2n1gzTmmrG9",
   "label": "20M Split 1",
   "handle": null,
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": 20000000,
   "expected_source": "label_claim",
   "sources": [
    "wall"
   ]
  },
  {
   "address": "raZ9f6d7y8WvUnbs2fjH26xZitMXSjdfCT",
   "label": "20M Split 2",
   "handle": null,
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": 20000000,
   "expected_source": "label_claim",
   "sources": [
    "wall"
   ]
  },
  {
   "address": "rLaGqBWs3e7S9qBNGYW22FziPc5bkduvcq",
   "label": "20M Split 3",
   "handle": null,
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": 20000000,
   "expected_source": "label_claim",
   "sources": [
    "wall"
   ]
  },
  {
   "address": "rDKARnQjP7D9oaFTjdvp33cBmZDjUV1ioc",
   "label": "20M Split 4",
   "handle": null,
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": 20000000,
   "expected_source": "label_claim",
   "sources": [
    "wall"
   ]
  },
  {
   "address": "rKNmnVCtm1CuN1YikiVhrdgEyqecGdKL94",
   "label": "20M Split 5",
   "handle": null,
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": 20000000,
   "expected_source": "label_claim",
   "sources": [
    "wall"
   ]
  },
  {
   "address": "rHjxBjzGcZKkPUwqrgaPYrk53PtLTXp23K",
   "label": "DORMANT_14",
   "handle": "DORMANT_14",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rH4nomQDy64MG5QGJngNS9cgGCdTFrGqLE",
   "label": "DORMANT_15",
   "handle": "DORMANT_15",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "r4sRyacXpbh4HbagmgfoQq8Q3j8ZJzbZ1J",
   "label": "EXOUT_RECV_r4sRya",
   "handle": "EXOUT_RECV_r4sRya",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rBgnUKAEiFhCRLPoYNPPe3JUWayRjP6Ayg",
   "label": "EXOUT_RECV_rBgnUK",
   "handle": "EXOUT_RECV_rBgnUK",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rLHzPsX6oXkzU2qL12kHCH8G8cnZv1rBJh",
   "label": "EXOUT_RECV_rLHzPs",
   "handle": "EXOUT_RECV_rLHzPs",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rMdG3ju8pgyVh29ELPWaDuA74CpWW6Fxns",
   "label": "EXOUT_RECV_rMdG3j",
   "handle": "EXOUT_RECV_rMdG3j",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rBntsdo3fAS5sb3pqe7LvvxTS8qngFYAe1",
   "label": "GENESIS_WHALE_8",
   "handle": "GENESIS_WHALE_8",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rP8GfS4Ku43STM9kHEoKeWVvhV1E525zfo",
   "label": "GENESIS_WHALE_9",
   "handle": "GENESIS_WHALE_9",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rBuZfn1m4tA6znziHsRp9AyC1M3qg6rgbF",
   "label": "HIGHVAL_rBuZfn",
   "handle": "HIGHVAL_rBuZfn",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rDxfhNRgCDNDckm45zT5ayhKDC4Ljm7UoP",
   "label": "HIGHVAL_rDxfhN",
   "handle": "HIGHVAL_rDxfhN",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rGDreBvnHrX1get7na3J4oowN19ny4GzFn",
   "label": "HIGHVAL_rGDreB",
   "handle": "HIGHVAL_rGDreB",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rNxp4h8apvRis6mJf9Sh8C6iRxfrDWN7AV",
   "label": "HIGHVAL_rNxp4h",
   "handle": "HIGHVAL_rNxp4h",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rpNF4938Y8zCrqFP2owDHjMUdpAxMs49JD",
   "label": "HIGHVAL_rpNF49",
   "handle": "HIGHVAL_rpNF49",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rwXnv8BfEHi7WmkLXZ6ChcWX9hMnSsTMNK",
   "label": "HIGHVAL_rwXnv8",
   "handle": "HIGHVAL_rwXnv8",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rYmTPYVPLv4EbhTN4Uw8nfvjyShLGESMV",
   "label": "HIGHVAL_rYmTPY",
   "handle": "HIGHVAL_rYmTPY",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rHJgQ4Cbg7vACGVuGusaKfmr2nheCRefBS",
   "label": "INST_CUSTODY_A",
   "handle": "INST_CUSTODY_A",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rBB8peCvJcSbkmuQSe6ct6cujqNzz465cB",
   "label": "INST_CUSTODY_B",
   "handle": "INST_CUSTODY_B",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rEq4b7nbL2ep44Fgk9bPwpynGRjyESpf5B",
   "label": "INST_CUSTODY_C",
   "handle": "INST_CUSTODY_C",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rsyDbFZwxUqXEzwknqzCvYxk2davoQCUDC",
   "label": "INST_MSIG_A",
   "handle": "INST_MSIG_A",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rG71mF18FKc6sWfCyfYiPHax1GwBNfqGFQ",
   "label": "INST_MSIG_B",
   "handle": "INST_MSIG_B",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rE84wNj2fKZtiH3KCF77mZeUg5fypjPasw",
   "label": "INST_MSIG_C",
   "handle": "INST_MSIG_C",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "r44AzNe4LSHQkB95qm6pQCauJ3Vz7Yx3iU",
   "label": "LARGE_RECV_r44AzN",
   "handle": "LARGE_RECV_r44AzN",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "r97KeayHuEsDwyU1yPBVtMLLoQr79QcRFe",
   "label": "LARGE_RECV_r97Kea",
   "handle": "LARGE_RECV_r97Kea",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "r9c6A65SmhhZALrkMTpqc9X3kGjv5gtNNk",
   "label": "LARGE_RECV_r9c6A6",
   "handle": "LARGE_RECV_r9c6A6",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "r9onszrkdqcSWeL4ti7sHJDGcrYmMyFHmM",
   "label": "LARGE_RECV_r9onsz",
   "handle": "LARGE_RECV_r9onsz",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "r9xzLk4bd2zWfeKnWsr49rVq2nK7yDkC8L",
   "label": "LARGE_RECV_r9xzLk",
   "handle": "LARGE_RECV_r9xzLk",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "ra8xqX4QhcogFfxpMxMByvFnXyxw9E8rzY",
   "label": "LARGE_RECV_ra8xqX",
   "handle": "LARGE_RECV_ra8xqX",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "ragnEuoM7mRMP7pVpWprZdJe9vNuVyCKKT",
   "label": "LARGE_RECV_ragnEu",
   "handle": "LARGE_RECV_ragnEu",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "raN2ev7xZCJei22Y6rJshVVmWCQKgpp9Jg",
   "label": "LARGE_RECV_raN2ev",
   "handle": "LARGE_RECV_raN2ev",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rfah8jhiJwPhcWEn2eQZehWqKKqAWGjxp1",
   "label": "LARGE_RECV_rfah8j",
   "handle": "LARGE_RECV_rfah8j",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rGsMk4nK4M8MtcjVbjUeaJBppjjKpXyJ7F",
   "label": "LARGE_RECV_rGsMk4",
   "handle": "LARGE_RECV_rGsMk4",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rHBXf41ccuT38r54gMUwtmqm9EtsJ5aLm1",
   "label": "LARGE_RECV_rHBXf4",
   "handle": "LARGE_RECV_rHBXf4",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rHfwtjakCgMA7z9AbugfNYV3UvdyugZMr2",
   "label": "LARGE_RECV_rHfwtj",
   "handle": "LARGE_RECV_rHfwtj",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rhuPtM6TGnYRf8tgoWJvLBTnrazRQXYcFE",
   "label": "LARGE_RECV_rhuPtM",
   "handle": "LARGE_RECV_rhuPtM",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rHwtsaA1X4mzVCEqcvEvk59uRLhVos9xnZ",
   "label": "LARGE_RECV_rHwtsa",
   "handle": "LARGE_RECV_rHwtsa",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rhyc2QxaHV5pVEtMSPNr27or475C2bQQNd",
   "label": "LARGE_RECV_rhyc2Q",
   "handle": "LARGE_RECV_rhyc2Q",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rhzZYHFopep75YksYPtb8KAJKoooqMZtV3",
   "label": "LARGE_RECV_rhzZYH",
   "handle": "LARGE_RECV_rhzZYH",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rLoD9U2ghXP2xUYbtML6G6v1p8LhM9mSnc",
   "label": "LARGE_RECV_rLoD9U",
   "handle": "LARGE_RECV_rLoD9U",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rMjtwnezA5oV6rxtqfRr54nngqR3Lng4wY",
   "label": "LARGE_RECV_rMjtwn",
   "handle": "LARGE_RECV_rMjtwn",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rn7d8bZhsdz9ecf586XsvbmVePfxYGrs34",
   "label": "LARGE_RECV_rn7d8b",
   "handle": "LARGE_RECV_rn7d8b",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rNQEMJA4PsoSrZRn9J6RajAYhcDzzhf8ok",
   "label": "LARGE_RECV_rNQEMJ",
   "handle": "LARGE_RECV_rNQEMJ",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rnWK3EpZNg73ovL4iPTVpYESN41rJkLyEb",
   "label": "LARGE_RECV_rnWK3E",
   "handle": "LARGE_RECV_rnWK3E",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rQDQgwpXdpQdVoaCXQHSYcWkHhgKspnzXn",
   "label": "LARGE_RECV_rQDQgw",
   "handle": "LARGE_RECV_rQDQgw",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rRmgo6NW1W7GHjC5qEpcpQnq8NE74ZS1P",
   "label": "LARGE_RECV_rRmgo6",
   "handle": "LARGE_RECV_rRmgo6",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rsSgDoNSuZeknxk3owx4Z7PJzoH5cthGEQ",
   "label": "LARGE_RECV_rsSgDo",
   "handle": "LARGE_RECV_rsSgDo",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rsZsiNLTJ3XLK4NP3HU7MPMvcFrtPKQNwd",
   "label": "LARGE_RECV_rsZsiN",
   "handle": "LARGE_RECV_rsZsiN",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rUjfTQpvBr6wsGGxMw6sRmRQGG76nvp8Ln",
   "label": "LARGE_RECV_rUjfTQ",
   "handle": "LARGE_RECV_rUjfTQ",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rwnYLUsoBQX3ECa1A5bSKLdbPoHKnqf63J",
   "label": "LARGE_RECV_rwnYLU",
   "handle": "LARGE_RECV_rwnYLU",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rwpTh9DDa52XkM9nTKp2QrJuCGV5d1mQVP",
   "label": "LARGE_RECV_rwpTh9",
   "handle": "LARGE_RECV_rwpTh9",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rL8db2YDnYvCrrJmi5wjuwLRBF5fC7n9VD",
   "label": "MM_01",
   "handle": "MM_01",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rwv782tjrgjP9uJELdqjKGv4vimG3S2xPC",
   "label": "OTC_WHALE_19",
   "handle": "OTC_WHALE_19",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rhZ3WttpasyespM1MLPwJ5SZ846btucomJ",
   "label": "OTC_WHALE_20",
   "handle": "OTC_WHALE_20",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rJ9Ey7HbscSECamgDRzvw5wrVbFUgaUDt7",
   "label": "RICHLIST_1.8B",
   "handle": "RICHLIST_1.8B",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": 1800000000,
   "expected_source": "label_claim",
   "sources": [
    "report"
   ]
  },
  {
   "address": "rP4X2hTa7A7udDbE6wczXvPz7XZ63sKxv3",
   "label": "ROUTING_SPLITTER",
   "handle": "ROUTING_SPLITTER",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "r3uGtWNmJ1UNp6PWWxrb3DW6zWfBFaaRCk",
   "label": "SPLITTER_r3uGtW",
   "handle": "SPLITTER_r3uGtW",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "r3zUhJWabAMMLT5n631r2wDh9RP3dN1bRy",
   "label": "SPLITTER_r3zUhJ",
   "handle": "SPLITTER_r3zUhJ",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "r4nydGjxDBn2VDMqmDxx2oZQGCcEWKPs8F",
   "label": "SPLITTER_r4nydG",
   "handle": "SPLITTER_r4nydG",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "r4wf7enWPxyHtbizyV7ZHiZi5XgwHh4Rzn",
   "label": "SPLITTER_r4wf7e",
   "handle": "SPLITTER_r4wf7e",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rBNCyNEwpaEbGP9nqkQeYcvwYAwwKkRzTR",
   "label": "SPLITTER_rBNCyN",
   "handle": "SPLITTER_rBNCyN",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rDSTYvUv4xqRypy3NMsuwheX6WcciEUE3c",
   "label": "SPLITTER_rDSTYv",
   "handle": "SPLITTER_rDSTYv",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rfumbc2NDjHaDCpgfJRLSafRJNKi6CuwVH",
   "label": "SPLITTER_rfumbc",
   "handle": "SPLITTER_rfumbc",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rh4WneLFo6FsAko8UvCApGHvBYUFkKMDw8",
   "label": "SPLITTER_rh4Wne",
   "handle": "SPLITTER_rh4Wne",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rhWt2bhRq3wiK9sQnYVmhhKb5Dr2SE32hk",
   "label": "SPLITTER_rhWt2b",
   "handle": "SPLITTER_rhWt2b",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rKwJaGmB5Hz24Qs2iyCaTdUuL1WsEXUWy5",
   "label": "SPLITTER_RIPPLE500",
   "handle": "SPLITTER_RIPPLE500",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rLuvSFafgVja7ZgEtoqa1SwSt1xNGaztLZ",
   "label": "SPLITTER_rLuvSF",
   "handle": "SPLITTER_rLuvSF",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rNASJdZjY9dToHnNURi3HAUku3duPwbtD1",
   "label": "SPLITTER_rNASJd",
   "handle": "SPLITTER_rNASJd",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rnPpiykzCFkievFjCdx7xLKb2KGA1is3ew",
   "label": "SPLITTER_rnPpiy",
   "handle": "SPLITTER_rnPpiy",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rnU65s4J4ffJF5VtTEuHtEdWMKc1m9AR5J",
   "label": "SPLITTER_rnU65s",
   "handle": "SPLITTER_rnU65s",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rsnrCWJMXkiTZLpEmKMBKKMkNyQAThCUxk",
   "label": "SPLITTER_rsnrCW",
   "handle": "SPLITTER_rsnrCW",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rUSYaUPUyXhEebdrQHXScFsKyUAjgPNbKf",
   "label": "SPLITTER_rUSYaU",
   "handle": "SPLITTER_rUSYaU",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rwRCtT6VZD8ce9smQYw4bgmUbgnJPvty48",
   "label": "SPLITTER_rwRCtT",
   "handle": "SPLITTER_rwRCtT",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rXzRVoohqvahY4zyUrfmznpVgkLJsDCtd",
   "label": "SPLITTER_rXzRVo",
   "handle": "SPLITTER_rXzRVo",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "r4jcgkWV5o9smpoUuSwSc7JBWAC7bke4GB",
   "label": "WHALE_PRIV_09",
   "handle": "WHALE_PRIV_09",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "r4AUYDBeV8YaLDZwuXG28CQgZ8XrThy8F2",
   "label": "WHALE_PRIV_12",
   "handle": "WHALE_PRIV_12",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rpLru1mHkBEgmE6zw2gXP2HcSyHg3hCt69",
   "label": "WHALE_PRIV_16",
   "handle": "WHALE_PRIV_16",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rstryhbE73v18SnJ3R8j1FSNYFWCSdELEd",
   "label": "WHALE_PRIV_17",
   "handle": "WHALE_PRIV_17",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rfCKgAfaY2GaRFyCrwoF6BAhsEyLuWp37N",
   "label": "WHALE_PRIV_18",
   "handle": "WHALE_PRIV_18",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rprAu33H7PLUc24EYiMcD3HKcZG18PFkzQ",
   "label": "WHALE_PRIV_19",
   "handle": "WHALE_PRIV_19",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rBWEYyxPZkDPgBZEj73vgxi8xrNY22pnM7",
   "label": "WHALE_PRIV_B",
   "handle": "WHALE_PRIV_B",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "raLybBkX8HMsFG4EJGnTsBiNhnJS1Lqwmn",
   "label": "WHALE_PRIV_C",
   "handle": "WHALE_PRIV_C",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rHecLk1MZPnTXGUeog3aSaGZ9fEDCo4bRv",
   "label": "WHALE_RECV_rHecLk",
   "handle": "WHALE_RECV_rHecLk",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rhuqpDZ2XNjWzvZ16wJhmJF5JDaU3NdvE7",
   "label": "WHALE_RECV_rhuqpD",
   "handle": "WHALE_RECV_rhuqpD",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "raRVLN1i5QFF6w8cwV3RovtTkjFj3qyNRf",
   "label": "WHALE_RECV_RIPPLE",
   "handle": "WHALE_RECV_RIPPLE",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rJdAkptufUtAscrxJq1ivjJDLHiAyD5eU7",
   "label": "WHALE_RECV_rJdAkp",
   "handle": "WHALE_RECV_rJdAkp",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rjqMerAJeP3XBc22CEAA9bkPZXfAETfkT",
   "label": "WHALE_RECV_rjqMer",
   "handle": "WHALE_RECV_rjqMer",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rKZxyrN6QG8zHigceKinzgrq9jVMHv6uGf",
   "label": "WHALE_RECV_rKZxyr",
   "handle": "WHALE_RECV_rKZxyr",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rLwSuYoPbDU3Y58tfXbuqFTq6Fmsx4f3KZ",
   "label": "WHALE_RECV_rLwSuY",
   "handle": "WHALE_RECV_rLwSuY",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rMLNvZR9dascY5jtCfCv3whAp8HdUSZAQ",
   "label": "WHALE_RECV_rMLNvZ",
   "handle": "WHALE_RECV_rMLNvZ",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rN4GiawFXbgMNtW12mVH4p7CWQDzXsRB5k",
   "label": "WHALE_RECV_rN4Gia",
   "handle": "WHALE_RECV_rN4Gia",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rNUnZ9NRnGdfeiQCWYkYXWkmF4A8iFgpg9",
   "label": "WHALE_RECV_rNUnZ9",
   "handle": "WHALE_RECV_rNUnZ9",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rQDYQ14B35Eby3TAW8sFpUJcyTqPTFtjpg",
   "label": "WHALE_RECV_rQDYQ1",
   "handle": "WHALE_RECV_rQDYQ1",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rQUUAjDPTLWTEHrpNtQvryUdvd1afc6TcB",
   "label": "WHALE_RECV_rQUUAj",
   "handle": "WHALE_RECV_rQUUAj",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rUrYCcn3UkgC2ZXDWDvWT1D8VmM2X5Yiws",
   "label": "WHALE_RECV_rUrYCc",
   "handle": "WHALE_RECV_rUrYCc",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  },
  {
   "address": "rUVtjZ5Kg4TJ4osZCJooq3hunjuACtNx4W",
   "label": "WHALE_RECV_rUVtjZ",
   "handle": "WHALE_RECV_rUVtjZ",
   "type": "HVT",
   "identified": false,
   "confidence": null,
   "expected_xrp": null,
   "expected_source": null,
   "sources": [
    "report"
   ]
  }
 ]
};

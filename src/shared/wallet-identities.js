// ── SHARED WALLET IDENTITY REGISTRY ──────────────────────────────────────────
// The real-world identity of an XRPL address, where a public source establishes
// one. Loaded by BOTH the main app (index.html) and the report console
// (brief-console.html) — they are separate documents, so a shared FILE is the
// only way both can see the same registry. This file is the single source of
// truth; do not re-declare these anywhere else.
//
// confidence, strongest first:
//   CONFIRMED         — corroborated across sources / verified by the operator
//   PUBLIC_SOURCE     — published by a public labeller (XRPScan, Bithomp, etc.)
//   OPERATOR_ASSERTED — the operator named it when adding it to the watch list
//                       (carries `source: watchlist_label:<LABEL>`). This is a
//                       CLAIM, not an external verification. It is weaker than the
//                       two above and is tracked separately on purpose: if any of
//                       these is ever contradicted by a public source, the public
//                       source wins and the entry should be corrected or dropped.
// type: EXCH (exchange) · RIPPLE (Ripple-controlled) · HVT (named high-value holder)
//
// An entry here is an IDENTITY CLAIM and is treated as such by the report: it is
// the only thing that lets the brief name a real entity. Everything NOT in here
// stays behavioural — flagged, not identified. Never add a guess.
window.SW_WALLET_IDENTITIES = {
 "rxXXXeMX8Gy5YvibvGLnQJ1XKKD7UswM1": {
  "name": "Coreum Bridge",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE",
  "source": "Coreum bridge XRPL operations account, per the published bridge specification (CoreumFoundation/coreumbridge-xrpl) and xrpl.to Insights 2026-08-11"
 },
 "rfXSfH2q4zhGWdw45nYcWfjvFN5ZfwE1U6": {
  "name": "Coreum outflow \u2014 front A",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE",
  "source": "Received ~107,397 XRP of the 2026-08-09 Coreum bridge outflow (xrpl.to Insights 2026-08-11, reproducible via account_tx over ledgers 106,183,346-842). Our own 2026-08-11 scan read 2.999993 XRP against the article's \"roughly 3 XRP\". This names what the wallet DID on the ledger, not who owns it."
 },
 "rwt8PJhyXWgW8uwmTjmQ7Rw89tJHELFgb5": {
  "name": "Coreum outflow \u2014 front B",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE",
  "source": "Received ~92,519 XRP of the 2026-08-09 Coreum bridge outflow (xrpl.to Insights 2026-08-11). Our own 2026-08-11 scan read 2.999993 XRP. Ledger behaviour, not ownership."
 },
 "rnaBRmXU6ZS7orU6Qj38wsBYQmqHPbrhA9": {
  "name": "Coreum outflow \u2014 staging A",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE",
  "source": "Second hop of the 2026-08-09 Coreum bridge outflow; created 2026-06-28, six weeks before the front wallets (xrpl.to Insights 2026-08-11). Our own 2026-08-11 scan read 90,960.97 XRP still held. Ledger behaviour, not ownership."
 },
 "r3jV8g599WMR9zeFi5m1rbvXyEwNWwYFXt": {
  "name": "Coreum outflow \u2014 staging B",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE",
  "source": "Second hop of the 2026-08-09 Coreum bridge outflow; created 2026-06-28. Our own 2026-08-11 scan read 48,999.69 XRP still held. Ledger behaviour, not ownership."
 },
 "rPyCQm8E5j78PDbrfKF24fRC7qUAk1kDMZ": {
  "name": "Bithumb",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rs8ZPbYqgecRcDzQpJYAMhSxSi5htsjnza": {
  "name": "Binance",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "rDxJNbV23mu9xsWoQHoBqZQvc77YcbJXwb": {
  "name": "Upbit",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rsXT3AQqhHDusFs3nQQuwcA1yXRLZJAXKw": {
  "name": "Uphold",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rMQ98K56yXJbDGv49ZSmW51sLn94Xe1mu1": {
  "name": "Ripple",
  "type": "RIPPLE",
  "confidence": "PUBLIC_SOURCE"
 },
 "rKveEyR1SrkWbJX214xcfH43ZsoGMb3PEv": {
  "name": "Ripple",
  "type": "RIPPLE",
  "confidence": "PUBLIC_SOURCE"
 },
 "rw7m3CtVHwGSdhFjV4MyJozmZJv3DYQnsA": {
  "name": "bitbank",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "r99QSej32nAcjQAri65vE5ZXjw6xpUQ2Eh": {
  "name": "Coincheck",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "r9NpyVfLfUG8hatuCCHKzosyDtKnBdsEN3": {
  "name": "Ripple",
  "type": "RIPPLE",
  "confidence": "PUBLIC_SOURCE"
 },
 "rMhkqz3DeU7GUUJKGZofusbrTwZe6bDyb1": {
  "name": "Ripple",
  "type": "RIPPLE",
  "confidence": "PUBLIC_SOURCE"
 },
 "rfL1mn4VTCoHdhHhHMwqpShCFUaDBRk6Z5": {
  "name": "Upbit",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rwa7YXssGVAL9yPKw6QJtCen2UqZbRQqpM": {
  "name": "Upbit",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rNcAdhSLXBrJ3aZUq22HaNtNEPpB5fR8Ri": {
  "name": "Upbit",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "r4G689g4KePYLKkyyumM1iUppTP4nhZwVC": {
  "name": "Upbit",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rJo4m69u9Wd1F8fN2RbgAsJEF6a4hW1nSi": {
  "name": "Upbit",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rLgn612WAgRoZ285YmsQ4t7kb8Ui3csdoU": {
  "name": "Upbit",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rs48xReB6gjKtTnTfii93iwUhjhTJsW78B": {
  "name": "Upbit",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rJWbw1u3oDDRcYLFqiWFjhGWRKVcBAWdgp": {
  "name": "Upbit",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rMNUAfSz2spLEbaBwPnGtxTzZCajJifnzH": {
  "name": "Upbit",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "r38a3PtqW3M7LRESgaR4dyHjg3AxAmiZCt": {
  "name": "Upbit",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rDfrrrBJZshSQDvfT2kmL9oUBdish52unH": {
  "name": "chrislarsen",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rD6tdgGHG7hwGTA6P39aE7W89fbqxXRjzk": {
  "name": "chrislarsen",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "r476293LUcDqtjiSGJ5Dh44J1xBCDWeX3": {
  "name": "chrislarsen",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rEvwSpejhGTbdAXbxRTpGAzPBQkBRZxN5s": {
  "name": "eToro",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "r44CNwMWyJf4MEA1eHVMLPTkZ1LSv4Bzrv": {
  "name": "chrislarsen",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rKNwXQh9GMjaU8uTqKLECsqyib47g5dMvo": {
  "name": "Crypto.com",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rJpj1Mv21gJzsbsVnkp1U4nqchZbmZ9pM5": {
  "name": "Binance",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "rDKw32dPXHfoeGoD3kVtm76ia1WbxYtU7D": {
  "name": "Coinone",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rPoJNiCk7XSFLR28nH2hAbkYqjtMC3hK2k": {
  "name": "chrislarsen",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rhREXVHV938ToGkdJQ9NCYEY4x8kSEtjna": {
  "name": "chrislarsen",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "ragKXjY7cBTXUus32sYHZVfkY46Nt2Q829": {
  "name": "ahbritto",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rG2eEaeiJou6cVQ3KtX7XMNwGhuW99xmHP": {
  "name": "ahbritto",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rsF9cc6gniHLTR2Jng29ng21ez7L9PpmPt": {
  "name": "ahbritto",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rJ5EJYsW6Vkeruj1LAmQYq3VP7QUQKBH1W": {
  "name": "ahbritto",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rsXNUCJkXeyFuGHyfRnuWPita2ns32upBD": {
  "name": "ahbritto",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rQKZSMgmBJvv3FvWj1vuGjUXnegTqJc25z": {
  "name": "ahbritto",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rhtufNsYfrozs4GvSq4HMYcR9y3dg8FWdC": {
  "name": "Ripple",
  "type": "RIPPLE",
  "confidence": "PUBLIC_SOURCE"
 },
 "rhWVCsCXrkwTeLBg6DyDr7abDaHz3zAKmn": {
  "name": "bitFlyer",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rP3mUZyCDzZkTSd1VHoBbFt8HGm8fyq8qV": {
  "name": "Binance",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rBEc94rUFfLfTDwwGN7rQGBHc883c2QHhx": {
  "name": "Uphold",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rEbXa31msPbPDZgmLMKH7CaKaf7VipoLBo": {
  "name": "Binance",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "rwTTsHVUDF8Ub2nzV2oAeWxfJzUvobXLEf": {
  "name": "Bitget Global",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rJqiMb94hyz41SBTNr2AyPNW8AzELa8nE": {
  "name": "Ripple",
  "type": "RIPPLE",
  "confidence": "PUBLIC_SOURCE"
 },
 "rEbKBkgKSQgm5x8PycZc5VjdCVTmqYfcY1": {
  "name": "ahbritto",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rU5ACGLKbhPQB92GZhT5UV22NHeVrEGuU6": {
  "name": "Coinbase",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "r4DbbWjsZQ2hCcxmjncr7MRjpXTBPckGa9": {
  "name": "Bitrue Cold",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rDecw8UhrZZUiaWc91e571b3TL41MUioh7": {
  "name": "Binance",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rNRc2S2GSefSkTkAiyjE6LDzMonpeHp6jS": {
  "name": "SBI VC Trade",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "raJHqa1o57DwjtrLCZjdkMKRtfHnbrwSse": {
  "name": "Firi",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "raQxZLtqurEXvH5sgijrif7yXMNwvFRkJN": {
  "name": "Bybit",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "rZ6XrB8if1qB3hEW6KKVzvGH2cLtUeEcd": {
  "name": "BTC Markets",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rpVu7CQHTGqWDvBzm3TB2drmZBmh6jGNz4": {
  "name": "Binance",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "rDAE53VfMvftPB4ogpWGWvzkQxfht6JPxr": {
  "name": "Binance",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "rsT3yYMkuicxW1hYsy787mg5XHhkz2uQRk": {
  "name": "Evernorth",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rnJrjec2vrTJAAQUTMTjj7U6xdXrk9N4mT": {
  "name": "Kraken",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rPJ5GFpyDLv7gqeB1uZVUBwDwi41kaXN5A": {
  "name": "Binance",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rEvuKRoEbZSbM5k5Qe5eTD9BixZXsfkxHf": {
  "name": "Kraken",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rKXXrAgpkHQN8m4HxAQCYmDCPPUByc9mVq": {
  "name": "Evernorth",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rE3hWEGquaixF2XwirNbA1ds4m55LxNZPk": {
  "name": "Bitfinex",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rKuP5k67YtHzsCmSQp7votF7u4afp4uNcm": {
  "name": "Binance",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "rPvKH3CoiKnne5wAYphhsWgqAEMf1tRAE7": {
  "name": "CoinJar",
  "type": "HVT",
  "confidence": "CONFIRMED"
 },
 "rhyp1uMC9Xyj3Px8amUH3xVv6tbjYJkojs": {
  "name": "Ripple",
  "type": "RIPPLE",
  "confidence": "PUBLIC_SOURCE"
 },
 "razaE6HTEMUc9ogMYwmBT5GQk2b9qtbTnC": {
  "name": "Stake",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rNYW2bie6KwUSYhhtcnXWzRy5nLCa1UNCn": {
  "name": "Bitrue Insurance Fund",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "rQUp2PKzH3vCtKs5H9tsPPE1rTsN6fhjqn": {
  "name": "Ceffu",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rPz2qA93PeRCyHyFCqyNggnyycJR1N4iNf": {
  "name": "Binance",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rLUpiBeLhUyEzVtBkYE4S9t4zhdybSSARw": {
  "name": "CoinDCX",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rMvCasZ9cohYrSZRNYPTZfoaaSUQMfgQ8G": {
  "name": "Bybit",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "rHcFoo6a9qT5NHiVn1THQRhsEGcxtYCV4d": {
  "name": "Gate.io",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "r3F5NsyiGwVYs2Rs3cCcrVw4t5wZP2ZxRr": {
  "name": "Ripple",
  "type": "RIPPLE",
  "confidence": "PUBLIC_SOURCE"
 },
 "rNu9U5sSouNoFunHp9e9trsLV6pvsSf54z": {
  "name": "Gate.io",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "rPEPYN8sHU3cytBwVm69qPbVztaoj7wNf": {
  "name": "Mercado Bitcoin",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rhuCPEoLFYbpbwyhXioSumPKrnfCi3AXJZ": {
  "name": "Coinone",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv": {
  "name": "Bitstamp",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "rDNuKeiwTHWRCyBrh1aQUthLPkCUTxhz2W": {
  "name": "Binance",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "r4DymtkgUAh2wqRxVfdd3Xtswzim6eC6c5": {
  "name": "Crypto.com",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rPBMDP7CGiKzMvPx6SsCGgeDsrsUyv1K1b": {
  "name": "Yobit",
  "type": "HVT",
  "confidence": "CONFIRMED"
 },
 "r3ZVNKgkkT3A7hbEZ8HxnNnLDCCmZiZECV": {
  "name": "Binance US",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rsbfd5ZYWqy6XXf6hndPbRjDAzfmWc1CeQ": {
  "name": "Luno",
  "type": "HVT",
  "confidence": "CONFIRMED"
 },
 "rLW9gnQo7BQhU6igk5keqYnH3TVrCxGRzm": {
  "name": "Bitfinex",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "rEiq1iAcpzP8WLjezP9MzAQEJ7jqKMLFSA": {
  "name": "Revolut",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rfmMjAXq65hpAxEf1RLNQq6RgYTSVkQUW5": {
  "name": "BITPoint",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rE3Cc3i6163Qzo7oc6avFQAxQE4gyCWhGP": {
  "name": "Bitkub",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rwkbXMJQLQhVhcjZnnHV4zu39N7WcQXQKX": {
  "name": "Binance",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "rUf5QkXtwVr9XxCdVhn1pFN7ZyMwGhN5Ng": {
  "name": "Coinbase cbXRP",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "rLMAAuqJowC5yMccaPnappeLM8vDfdiDTg": {
  "name": "Phemex",
  "type": "HVT",
  "confidence": "CONFIRMED"
 },
 "rfQ9EcLkU6WnNmkS3EwUkFeXeN47Rk8Cvi": {
  "name": "Binance",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rfkXSaCZKTg1EZzec2rLDyrWHxRVJdtVXj": {
  "name": "Flare Core Vault",
  "type": "HVT",
  "confidence": "CONFIRMED"
 },
 "rNnWmrc1EtNRe5SEQEs9pFibcjhpvAiVKF": {
  "name": "Gate.io",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "rLzxZuZuAHM7k3FzfmhGkXVwScM4QSxoY7": {
  "name": "Gate.io",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "r9FNc9txxrB98DizMkhQBj3hgKQCbF1bGA": {
  "name": "ZebPay",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "razLtrbzXVXYvViLqUKLh8YenGLJid9ZTW": {
  "name": "Stake",
  "type": "HVT",
  "confidence": "CONFIRMED"
 },
 "rCoinaUERUrXb1aA7dJu8qRcmvPNiKS3d": {
  "name": "CoinPayments",
  "type": "HVT",
  "confidence": "CONFIRMED"
 },
 "rBtttd61FExHC68vsZ8dqmS3DfjFEceA1A": {
  "name": "Binance",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "rNU4eAowPuixS5ZCWaRL72UUeKgxcKExpK": {
  "name": "Binance",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "rarG6FaeYhnzSKSS5EEPofo4gFsPn2bZKk": {
  "name": "Binance",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rs2dgzYeqYqsk8bvkQR5YPyqsXYcA24MP2": {
  "name": "MEXC",
  "type": "HVT",
  "confidence": "CONFIRMED"
 },
 "rErKXcbZj9BKEMih6eH6ExvBoHn9XLnTWe": {
  "name": "Uphold",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rhWj9gaovwu2hZxYW7p388P8GRbuXFLQkK": {
  "name": "Binance",
  "type": "EXCH",
  "confidence": "PUBLIC_SOURCE"
 },
 "rJn2zAPdFA193sixJwuFixRkYDUtx3apQh": {
  "name": "Bybit",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "rprFy94qJB5riJpMmnPDp3ttmVKfcrFiuq": {
  "name": "Doppler Finance",
  "type": "HVT",
  "confidence": "CONFIRMED"
 },
 "raBQUYdAhnnojJQ6Xi3eXztZ74ot24RDq1": {
  "name": "Gemini",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "rBg2FuZT91C52Nny68houguJ4vt5x1o91m": {
  "name": "Ripple",
  "type": "RIPPLE",
  "confidence": "PUBLIC_SOURCE"
 },
 "r4eEexVBREc4bbYh7dEfQNMe86sDmhKSph": {
  "name": "LBank",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rBndy89HdamJ3UHNekAS6ALjW9WoCE2W5s": {
  "name": "Stake",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rLwTB2mgf7jzj7yBfddxN5DdTzRpnho42W": {
  "name": "PulseX Sacrifice",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rLSn6Z3T8uCxbcd1oxwfGQN1Fdn5CyGujK": {
  "name": "Bitso",
  "type": "EXCH",
  "confidence": "CONFIRMED"
 },
 "rQUmgHMWTXGpFqcVEo2qtHY7xvhk4V4Bua": {
  "name": "CoinDCX",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rUYHZ71yXAS54ZQNvvooLX7rFtZydXjnP": {
  "name": "Hata",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rpQATJWPPdNMxVCTQDYcnRNwtFDnanT3nk": {
  "name": "Bitunix",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rKRYAqMFTTGMZ47eXJVRKcqLJgnPQbXisg": {
  "name": "BTC Markets",
  "type": "HVT",
  "confidence": "PUBLIC_SOURCE"
 },
 "rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh": {
  "name": "Binance",
  "type": "EXCH",
  "confidence": "OPERATOR_ASSERTED",
  "source": "watchlist_label:BINANCE_HOT"
 },
 "rwshjBngGqMRJgGYvEJXGMkg5DS2GX3U3q": {
  "name": "Binance",
  "type": "EXCH",
  "confidence": "OPERATOR_ASSERTED",
  "source": "watchlist_label:BINANCE_COLD_1"
 },
 "rE5LDXksLZHsRgGUgqu7NiTSDd5zFz7rsW": {
  "name": "Binance",
  "type": "EXCH",
  "confidence": "OPERATOR_ASSERTED",
  "source": "watchlist_label:BINANCE_COLD_2"
 },
 "r3bqvUfF9weyxZqwo6qumBV2Q5k8LzepjJ": {
  "name": "Binance",
  "type": "EXCH",
  "confidence": "OPERATOR_ASSERTED",
  "source": "watchlist_label:BINANCE_PEG_BRIDGE"
 },
 "rw2ciyaNshpHe7bCHo4bRWq6pqqynnWKQg": {
  "name": "Coinbase",
  "type": "EXCH",
  "confidence": "OPERATOR_ASSERTED",
  "source": "watchlist_label:COINBASE_HOT"
 },
 "rG6FZ31hDHN1K5Dkbma3PSB5uVCuVVRzfn": {
  "name": "Huobi",
  "type": "EXCH",
  "confidence": "OPERATOR_ASSERTED",
  "source": "watchlist_label:HUOBI_MAIN"
 },
 "rH5wodHpZzeXBAWE36nMoRXGqeEjSdbzWU": {
  "name": "Upbit",
  "type": "EXCH",
  "confidence": "OPERATOR_ASSERTED",
  "source": "watchlist_label:UPBIT_COLD"
 },
 "rpPcmcGQ5iTXDc5zF5owxwTifkTs1qYrA6": {
  "name": "Uphold",
  "type": "EXCH",
  "confidence": "OPERATOR_ASSERTED",
  "source": "watchlist_label:UPHOLD_CUSTODY"
 },
 "rB1kVfLSxpXCw7sLCBcm5LFZYzkS6xmwSK": {
  "name": "bitbank",
  "type": "EXCH",
  "confidence": "OPERATOR_ASSERTED",
  "source": "watchlist_label:BITBANK_COLD"
 },
 "rN3t4Epm69GXM1Bx42Ne1opfai7eUvmopY": {
  "name": "Coincheck",
  "type": "EXCH",
  "confidence": "OPERATOR_ASSERTED",
  "source": "watchlist_label:COINCHECK_COLD"
 },
 "rN1yT2hkfMt89CJVsXdvnKqRJbqm7TC8uo": {
  "name": "Bybit",
  "type": "EXCH",
  "confidence": "OPERATOR_ASSERTED",
  "source": "watchlist_label:BYBIT_CUSTODY"
 },
 "rw3fRcmn5PJyPKuvtAwHDSpEqoW2JKmKbu": {
  "name": "Bithumb",
  "type": "EXCH",
  "confidence": "OPERATOR_ASSERTED",
  "source": "watchlist_label:BITHUMB_HOT"
 }
};

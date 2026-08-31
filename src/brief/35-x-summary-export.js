/* ═══════════════════════════════════════════════════════════════════════════
   X SUMMARY EXPORT — presentation-only compressed public export

   Keeps full forensic/debug exports untouched. Builds a dedicated <=4,000
   character X/Twitter summary and binds it to the existing SHARE TO X surface.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = 'X_SUMMARY_EXPORT_v2';
  var HARD_LIMIT = 4000;
  var TARGET_BODY = 3820;

  function clean(text) {
    return String(text || '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function compact(text, max) {
    var s = clean(text);
    if (!max || s.length <= max) return s;

    var lines = s.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
    var out = [];
    var used = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (used + line.length + (out.length ? 1 : 0) <= max) {
        out.push(line);
        used += line.length + (out.length > 1 ? 1 : 0);
      } else {
        break;
      }
    }
    if (out.length) return out.join('\n');

    var words = s.split(/\s+/);
    var short = '';
    for (var j = 0; j < words.length; j++) {
      var next = short ? short + ' ' + words[j] : words[j];
      if (next.length > max) break;
      short = next;
    }
    return short || s;
  }

  function section(text, startRx, endRx) {
    var s = String(text || '');
    var m = startRx.exec(s);
    if (!m) return '';
    var start = m.index + m[0].length;
    var tail = s.slice(start);
    var e = endRx ? endRx.exec(tail) : null;
    var body = e ? tail.slice(0, e.index) : tail;
    body = body.replace(/^\s*[─━═_\-]{3,}\s*\n?/m, '');
    return clean(body);
  }

  // ── ONE FACT, ONE APPEARANCE ────────────────────────────────────────────
  // The X post is 4,000 characters and every section used to scrape the same
  // report text independently, so the same sentence landed in three of them.
  // On the 2026-08-31 run the Verdict paragraph printed under "Watched Wallets
  // / Shadow Volume", under "Verdict / Risk", and again under "Disclaimer" —
  // ~600 characters of one sentence — because stats() matched the words
  // "shadow volume" inside it and disclaimer() matched "not financial advice"
  // inside it. Sections now claim their sentences from a shared pool, so
  // whatever is printed first owns that fact and nothing repeats it.
  function normKey(x) {
    return String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function splitSentences(text) {
    // Not a bare /(?<=[.!?])\s+/ : that splits "tied to U.S. jobs" after
    // "U.S." and the section then ends on half a sentence. Require the period
    // to follow something longer than an initial — an uppercase letter before
    // the period means an abbreviation, not a sentence end.
    //
    // The digit in the lookahead is load-bearing for dedupe, not cosmetic:
    // ledger sentences routinely open with an amount ("25.29M XRP moved…").
    // Without it, "…off the Ledger. 25.29M XRP moved…" stayed one unit here
    // while largeMoves() split it in two; the keys never matched and the
    // Kraken transfer printed in both sections.
    return String(text || '')
      .split(/\n+|(?<=[a-z0-9)\]][.!?])\s+(?=[A-Z0-9\u201C\u2022])/)
      .map(function (x) { return x.trim(); })
      .filter(Boolean);
  }
  // Drops any sentence an earlier section already used, then records the rest.
  function claim(text, seen) {
    if (!seen) return clean(text);
    // Line structure is content: a bullet list collapsed into one paragraph
    // reads as a wall. Lines stay lines; sentences inside a line stay a line.
    var outLines = [];
    String(text || '').split('\n').forEach(function (line) {
      var kept = [];
      splitSentences(line).forEach(function (sent) {
        var k = normKey(sent);
        if (!k || k.length < 12) { kept.push(sent); return; }   // short connectives may repeat
        if (seen[k]) return;
        // seen.__events is the ledger index for this run; absent means no
        // event identity is available and only sentence-level dedupe applies.
        var fk = eventKey(sent, seen.__events);
        if (fk && seen[fk]) return;
        seen[k] = true;
        if (fk) seen[fk] = true;
        kept.push(sent);
      });
      if (kept.length) outLines.push(kept.join(' '));
    });
    return clean(outLines.join('\n'));
  }

  // Sentence keys catch a repeated sentence. They do NOT catch the same FACT
  // restated in different words, which is most of what "it says it too many
  // times" actually means:
  //
  //   Executive Summary  "The standout individual anomaly was 25.29M XRP moved
  //                        from a tracked receiving wallet to Kraken."
  //   Largest Movements  "25.29M XRP moved from a tracked receiving wallet to
  //                        Kraken overnight."
  //
  // The fact key is the amount plus the named counterparties. It is only built
  // when a sentence names at least one entity: an amount alone is too weak, and
  // merging on it would silently collapse three genuinely separate 10.00M
  // escrow locks to the same destination into one.
  // Named counterparties in a sentence: capitalised words that are not the
  // sentence opener, plus raw r-addresses. XRP/XRPL are the unit, not a party.
  function entityTokens(sent) {
    var s = String(sent || '');
    var ents = {};
    (s.match(/\br[1-9A-HJ-NP-Za-km-z]{24,34}\b/g) || []).forEach(function (a) { ents[a.toLowerCase()] = 1; });
    s.split(/\s+/).forEach(function (w, i) {
      // Internal dots are part of the name (Crypto.com, u.today); a trailing
      // one is the sentence ending. Keeping it made "Kraken." and "Kraken"
      // two different counterparties.
      var t = w.replace(/^[^A-Za-z0-9.]+|[^A-Za-z0-9.]+$/g, '').replace(/\.$/, '');
      if (i === 0 || !/^[A-Z]/.test(t) || t.length < 3) return;
      if (/^(XRP|XRPL|The|This|That|These|Those|A|An)$/i.test(t)) return;
      ents[t.toLowerCase()] = 1;
    });
    return Object.keys(ents);
  }

  function sentenceAmountXrp(sent) {
    var m = String(sent || '').match(/\b(\d[\d,]*(?:\.\d+)?)\s*([KMB])\b\s*XRP\b/i);
    if (!m) return 0;
    var mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] || 0;
    var v = parseFloat(m[1].replace(/,/g, '')) * mult;
    return isFinite(v) && v > 0 ? v : 0;
  }

  // ── EVENT IDENTITY ──────────────────────────────────────────────────────
  // The dedupe key was amount + named counterparty. That recognises the two
  // differently worded statements of one transfer, but it is NOT a transaction
  // identifier: a ledger holding
  //
  //     10M XRP → Kraken at 08:00
  //     10M XRP → Kraken at 12:00
  //
  // produces the same fingerprint for two genuine, separate transfers, and the
  // second would have been deleted as a restatement of the first. Silently
  // dropping a real transaction from a forensic summary is worse than printing
  // one twice.
  //
  // Identity now comes from the ledger: pack.large_transfers rows carry the
  // transaction `hash` (classify() spreads the tx, so hash/amount/from/to
  // survive onto the row). A sentence is only allowed to identify an event when
  // it matches EXACTLY ONE row. Ambiguous or unmatched → no key at all, and the
  // sentence is kept. This fails open by construction: repetition is a cosmetic
  // fault, deletion is an evidential one.
  function buildEventIndex(pack) {
    var rows = (pack && pack.large_transfers) || [];
    if (!Array.isArray(rows)) return [];
    var out = [];
    rows.forEach(function (t) {
      if (!t || !t.hash) return;                 // no hash → no identity → never used
      var amt = Number(t.amount) || 0;
      if (amt <= 0) return;
      var ents = [];
      ['sender_label', 'receiver_label', 'from', 'to', 'label'].forEach(function (k) {
        if (t[k]) ents.push(String(t[k]).toLowerCase());
      });
      out.push({ hash: String(t.hash), amount: amt, ents: ents });
    });
    return out;
  }

  function eventKey(sent, index) {
    if (!index || !index.length) return '';
    var val = sentenceAmountXrp(sent);
    if (!val) return '';
    var toks = entityTokens(sent);
    if (!toks.length) return '';
    var hits = index.filter(function (e) {
      // Prose rounds ("25.29M"); the row carries the exact drops-derived value.
      if (Math.abs(e.amount - val) / val > 0.005) return false;
      return toks.some(function (t) {
        return e.ents.some(function (x) { return x === t || x.indexOf(t) > -1 || t.indexOf(x) > -1; });
      });
    });
    // Exactly one, or this sentence does not identify a single event and must
    // not be used to delete anything.
    if (hits.length !== 1) return '';
    return 'evt:' + hits[0].hash;
  }

  // Cuts at a sentence boundary rather than mid-word. The old path ended a
  // section with "ledger-matched context: Ripple CLO says Clarity Act tied to
  // U.S." — a sentence chopped in half and posted.
  function compactSentences(text, max) {
    var s = clean(text);
    if (!max || s.length <= max) return s;
    var out = '';
    splitSentences(s).forEach(function (sent) {
      var next = out ? out + ' ' + sent : sent;
      if (next.length <= max) out = next;
    });
    return out || compact(s, max);
  }

  function branding(text) {
    var s = String(text || '');
    var cut = s.search(/\n(?:Executive Summary|1\.\s*EXECUTIVE SUMMARY)\s*\n/i);
    if (cut < 0) cut = Math.min(s.length, 500);
    // The export header and its rule line are plumbing, not content. They were
    // being posted to X as the first two lines of the brand block.
    var head = s.slice(0, cut)
      .replace(/^\s*=+\s*$/gm, '')
      .replace(/^\s*SECTION\s+\d+\s*[—-].*$/gim, '')
      .replace(/^\s*X EXPORT\s*$/gim, '');
    return compact(head, 300);
  }

  // ── NEWS ────────────────────────────────────────────────────────────────
  // Headline + publisher, never the URL. A Google News tracking link runs ~350
  // characters; five of them ate 1,373 characters of the 2026-08-31 report —
  // 34% of it — and told the reader nothing. The full report keeps every URL
  // in its own SOURCES block; this is the on-air/on-X read.
  function publisherOf(raw) {
    var t = String(raw || '').trim()
      .replace(/@[^@\s]+$/, '')       // drop the proxy tag: rss:u.today@codetabs
      .replace(/^rss:/i, '')
      .replace(/^gdelt$/i, 'GDELT')
      .replace(/^google_news$/i, 'Google News')
      .replace(/^cryptocompare:?/i, '');
    return t || 'source';
  }
  function newsHeadlines(text, pack, max) {
    max = max || 4;
    var rows = [];
    // Preferred: the pack, where title and publisher are separate fields.
    //
    // Ranked through the report's OWN source filter, never raw. top_headlines is
    // ordered newest-first, so taking it as-is led an XRP forensic post with
    // "Trump Announced the Biggest Oil Deal Ever" and "Top 10 S&P 500 Stocks of
    // the Past Decade" on the 2026-08-31 run. filterSourcesForReport is the
    // function the report's SOURCES block already uses: XRP/regulatory/exchange
    // first, memecoin and price-prediction hype never. One editorial policy for
    // both surfaces — this must not become a second, looser one.
    try {
      var ni = pack && pack.news_intel;
      var items = (ni && (ni.top_headlines || ni.items)) || [];
      if (items.length && typeof filterSourcesForReport === 'function') {
        var filtered = filterSourcesForReport(items, { cap: 8 });
        if (filtered && filtered.length) items = filtered;
      }
      items.forEach(function (it) {
        if (it && it.title) rows.push({ title: String(it.title), src: publisherOf(it.source) });
      });
    } catch (_) {}
    // Fallback: parse the rendered SOURCES block. Two shapes are emitted —
    //   [4] u.today — Title
    //   [1] Title — https://…
    if (!rows.length) {
      var i = String(text || '').search(/\n\s*Sources\s*\n/i);
      if (i >= 0) {
        String(text).slice(i).split('\n').forEach(function (line) {
          var m = /^\s*\[\d+\]\s*(.+?)\s*$/.exec(line);
          if (!m) return;
          var body = m[1].replace(/\s*—\s*https?:\/\/\S+\s*$/, '').trim();
          if (!body || /^https?:/i.test(body)) return;
          var parts = body.split(/\s+—\s+/);
          if (parts.length >= 2) rows.push({ src: publisherOf(parts[0]), title: parts.slice(1).join(' — ') });
          else rows.push({ src: '', title: body });
        });
      }
    }
    // One STORY, once — not one headline once. On 2026-08-31 the same Clarity
    // Act vote arrived from three publishers as three different sentences:
    //   "Ripple CLO says Clarity Act tied to U.S. jobs and economic growth…"
    //   "Ripple CLO: Clarity Act Vote Would Boost U.S. Jobs And Economic Growth"
    //   "Passing the CLARITY Act could create over 230,0…"
    // A prefix key treats those as three stories. Significant-word overlap
    // treats them as one, which is what a reader would say they are.
    var STOP = { the:1, a:1, an:1, and:1, or:1, of:1, to:1, in:1, on:1, for:1,
                 as:1, at:1, by:1, is:1, it:1, its:1, with:1, that:1, this:1,
                 says:1, could:1, would:1, over:1, more:1, us:1, u:1, s:1 };
    function keyTokens(t) {
      var seenTok = {}, toks = [];
      normKey(t).split(' ').forEach(function (w) {
        if (w.length < 3 || STOP[w] || seenTok[w]) return;
        seenTok[w] = true; toks.push(w);
      });
      return toks;
    }
    function bigrams(toks) {
      var out = [];
      for (var i = 0; i + 1 < toks.length; i++) out.push(toks[i] + ' ' + toks[i + 1]);
      return out;
    }
    function sameStory(aTok, bTok) {
      if (!aTok.length || !bTok.length) return false;
      var bSet = {}, hit = 0;
      bTok.forEach(function (w) { bSet[w] = true; });
      aTok.forEach(function (w) { if (bSet[w]) hit++; });
      var overlap = hit / Math.min(aTok.length, bTok.length);
      if (overlap >= 0.5) return true;
      // Word overlap alone missed two angles on one bill:
      //   "Ripple CLO says Clarity Act tied to U.S. jobs and economic growth…"
      //   "Passing the CLARITY Act could create over 230,000 US jobs"
      // Only 3 shared words out of 7 (0.43). But they share the named subject
      // "clarity act", and a reader hearing both read aloud hears the same
      // story twice. A shared distinctive phrase plus modest overlap is enough.
      var bBi = {};
      bigrams(bTok).forEach(function (g) { bBi[g] = true; });
      var sharedPhrase = bigrams(aTok).some(function (g) { return bBi[g]; });
      return sharedPhrase && overlap >= 0.3;
    }
    var kept = [], out = [];
    rows.forEach(function (r) {
      var t = String(r.title || '').replace(/\s*[-—–|]\s*[^-—–|]{1,40}$/, '').trim();
      if (!t) return;
      // The rendered SOURCES block truncates: "…September vot", "over 230,0...".
      // A half-headline is worse than no headline when it is read aloud.
      if (/\.\.\.$/.test(t)) return;
      if (/[,\d]$/.test(t) || /\s[a-z]{1,3}$/.test(t)) return;   // cut mid-word / mid-number
      var tok = keyTokens(t);
      if (kept.some(function (k) { return sameStory(tok, k); })) return;
      kept.push(tok);
      out.push('• ' + t + (r.src ? ' — ' + r.src : ''));
    });
    return compact(out.slice(0, max).join('\n'), 520);
  }

  function executive(text, seen) {
    return compactSentences(claim(section(text,
      /(?:^|\n)(?:Executive Summary|1\.\s*EXECUTIVE SUMMARY)\s*\n/i,
      /\n(?:What Mattered Most|ESCROWS|2\.\s*LEDGER DIAGNOSTICS|Evidence|Under the Surface)\s*\n/i), seen), 330);
  }

  function largeMoves(text, seen) {
    var direct = section(text,
      /(?:^|\n)(?:9\.\s*LARGE MOVES|LARGE MOVES|Largest XRP Movements)\s*\n/i,
      /\n(?:10\.|RECEIVER FOLLOWTHROUGH|11\.|COORDINATION MEMORY|Evidence|Verdict)\s*\n/i);
    if (direct) return compact(claim(direct, seen), 440);

    var evidence = section(text,
      /(?:^|\n)Evidence\s*\n/i,
      /\n(?:Under the Surface|How to Read It|What To Watch Next|Verdict|LEDGER DIAGNOSTICS)\s*\n/i);
    var candidates = (evidence || String(text || '')).split(/(?<=[.!?])\s+|\n+/).filter(function (x) {
      return /\b\d+(?:\.\d+)?\s*(?:K|M|B)?\s*XRP\b/i.test(x) &&
             /(moved|transfer|reached|→|sent|received)/i.test(x);
    }).slice(0, 4);
    return compact(claim(candidates.join('\n'), seen), 440);
  }

  function evidenceHighlights(text, seen) {
    var body = section(text,
      /(?:^|\n)Evidence\s*\n/i,
      /\n(?:Under the Surface|How to Read It|What To Watch Next|Verdict|LEDGER DIAGNOSTICS)\s*\n/i);
    // The Evidence paragraph ends by grafting the day's headlines back on
    // ("And out in the daylight world, ledger-matched context: …"). The NEWS
    // block at the top now carries those, in full and attributed, so this tail
    // is the same stories a third time — and it is what used to get cut in
    // half by the character budget.
    body = String(body || '')
      .replace(/\s*And out in the daylight world[\s\S]*$/i, '')
      .replace(/\s*ledger-matched context:[\s\S]*$/i, '')
      .trim();
    return compactSentences(claim(body, seen), 380);
  }

  // Only real diagnostic lines. The old filter matched the words "shadow
  // volume" wherever they appeared, and the Verdict prose says "large transfer
  // count, shadow volume, dust/tag flags" — so the whole Verdict paragraph was
  // printed under this heading. Anchored to the bullet lines that carry numbers.
  function stats(text, seen) {
    var lines = String(text || '').split('\n').map(function (x) { return x.trim(); });
    var keep = lines.filter(function (line) {
      if (!/^[•\-*]\s*/.test(line)) return false;
      if (!/^[•\-*]\s*(Watched wallets|Watched activity|Shadow volume|Net watched flow|XRP price|Market volume)\b/i.test(line)) return false;
      return /\d/.test(line);
    });
    return compact(claim(keep.slice(0, 5).join('\n'), seen), 330);
  }

  function verdict(text, seen) {
    var v = section(text,
      /(?:^|\n)(?:Verdict|6\.\s*THE VERDICT)\s*\n/i,
      /\n(?:LEDGER DIAGNOSTICS|7\.|LIMIT ORDER|🙏|MISSION DEBRIEF|Sources)\s*\n/i);
    // The old pattern matched "63/100)" out of the middle of the verdict prose
    // and printed that orphan fragment as the section's first line. Take the
    // score only when it stands as a risk reading, and print it as one.
    var m = String(text || '').match(/\b(\d{1,3})\s*\/\s*100\b/);
    var risk = m ? ('Risk: ' + m[1] + '/100') : '';
    // The Disclaimer section owns this sentence; leaving it here printed it
    // twice in a row, two lines apart.
    var body = claim(v, seen)
      .replace(/\s*Not financial advice\.\s*XRP-only forensic watch\.\s*/i, ' ')
      .trim();
    return compactSentences((risk ? risk + '\n' : '') + body, 310);
  }

  // Fixed text. Scraping for "not financial advice" pulled back the entire
  // Verdict paragraph a third time, then cut it mid-sentence at 110 chars.
  function disclaimer() {
    return 'Not financial advice. XRP-only forensic watch.';
  }

  function prayer(text) {
    return compact(section(text,
      /(?:^|\n)🙏\s*THE DAILY PRAYER\s*\n/i,
      /\n(?:📖\s*THE DAILY SCRIPTURE|Sources|Escrow Watch)\s*\n/i), 230);
  }

  function scripture(text) {
    return compact(section(text,
      /(?:^|\n)📖\s*THE DAILY SCRIPTURE\s*\n/i,
      /\n(?:Sources|Escrow Watch|⚠️|I'm XRPMan)\s*\n/i), 280);
  }

  // ── SUGGESTED WATCHLIST ADDITIONS ───────────────────────────────────────
  // The scan flags candidates every run and the full report exports all of
  // them; the X post never carried any. This prints the top few.
  //
  // Two rules it must not break:
  //   1. `classification` only — NEVER `suggested_label`. That label can be
  //      derived from richlist identity, and printing it would name a wallet's
  //      owner off a third-party list. Flagged, not identified.
  //   2. The safety line ships with the list, not as a footnote somewhere
  //      else. Nothing here is added to the watchlist automatically and the
  //      post has to say so.
  function xrpShort(v) {
    v = Number(v) || 0;
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
    return String(Math.round(v));
  }
  function suggestedWallets(pack, max) {
    max = max || 3;
    var list = [];
    try {
      if (window.AUTO_WALLET_FINDER &&
          typeof window.AUTO_WALLET_FINDER.buildSuggestedWatchlistAdditions === 'function') {
        list = window.AUTO_WALLET_FINDER.buildSuggestedWatchlistAdditions(pack || {}) || [];
      }
    } catch (_) { return ''; }
    if (!list.length) return '';

    // Found in THIS scan, not the standing backlog — the same split the
    // report's AUTO DISCOVERY section uses, so the two cannot disagree.
    var fresh = list;
    try {
      if (typeof _discoverySplit === 'function') {
        var sp = _discoverySplit(list);
        if (sp && sp.known) fresh = sp.fresh;
      }
    } catch (_) {}
    if (!fresh.length) return '';

    var rec = fresh.filter(function (c) {
      return c && (c.action_tier === 'CRITICAL_ADD_REVIEW' || c.action_tier === 'RECOMMEND_FOR_WATCH');
    });
    var show = (rec.length ? rec : fresh).slice().sort(function (a, b) {
      return (Number(b.score) || 0) - (Number(a.score) || 0);
    }).slice(0, max);
    if (!show.length) return '';

    var lines = [fresh.length + ' flagged this scan, ' + rec.length +
                 ' recommended for review. Nothing is added to the watchlist automatically.'];
    show.forEach(function (c) {
      var a = String(c.address || '');
      var bits = [a.length > 14 ? a.slice(0, 6) + '…' + a.slice(-4) : a];
      if (c.classification) bits.push(String(c.classification));
      if (Number(c.total_value_xrp) > 0) bits.push(xrpShort(c.total_value_xrp) + ' XRP');
      if (c.score != null) bits.push(c.score + '/200');
      // lifecycle_phase is deliberately NOT printed. Its DORMANT branch is
      // `!stillHolding && seen_count < 2`, and stillHolding is
      // `currentBalance != null && currentBalance > 0` — so a wallet whose
      // balance was never read is false there and gets rendered "dormant or
      // closed account". That is absence of data reported as a finding, and
      // this post is read aloud on air. classification, value and score are
      // each measured; the phase is not, so it stays out until the branch
      // distinguishes unread from zero.
      lines.push('• ' + bits.join(' · '));
    });
    lines.push('Behavioural evidence only — never ownership proof.');
    return compact(lines.join('\n'), 470);
  }

  function coverageWarning(text, pack) {
    var s = String(text || '');
    var m = s.match(/[^\n]*(?:TX WINDOW:\s*INCOMPLETE|Transaction-window coverage incomplete)[^\n]*/i);
    if (m) return compact(m[0], 180);

    var c = pack && pack.tx_scan_coverage;
    if (c && c.full_window_complete === false) {
      return compact('⚠️ TX WINDOW: INCOMPLETE — ' +
        Number(c.complete_wallets || 0) + '/' + Number(c.target_wallets || 0) +
        ' complete; ' + Number(c.failed_wallets || 0) + ' failed; ' +
        Number(c.truncated_wallets || 0) + ' truncated. Zero-result claims are not definitive.', 180);
    }
    return '';
  }

  function optionalEscrow(text) {
    return compact(section(text,
      /(?:^|\n)Escrow Watch\s*\n/i,
      /\nSources\s*\n/i), 260);
  }

  function pushSection(parts, heading, body) {
    body = clean(body);
    if (!body) return;
    parts.push(heading + '\n' + body);
  }

  function finalize(body) {
    var cleanBody = clean(body);
    var count = 0;
    for (var i = 0; i < 12; i++) {
      var out = 'X EXPORT\nCharacters: ' + count + ' / 4000\n\n' + cleanBody;
      var actual = out.length;
      if (actual === count) {
        if (actual > HARD_LIMIT) throw new Error('X_SUMMARY_EXPORT exceeds 4000 characters');
        return out;
      }
      count = actual;
    }
    throw new Error('X_SUMMARY_EXPORT counter did not stabilize');
  }

  function buildXSummaryExport(source, pack) {
    var s = clean(source);
    if (!s) throw new Error('X_SUMMARY_EXPORT requires report text');

    // CLAIM ORDER IS NOT PRINT ORDER, and the difference matters.
    //
    // Whichever section claims a fact first keeps it. Letting the Executive
    // Summary claim first left "Largest XRP Movements" reading "A second
    // transfer of 20M XRP reached a large XRP holder." — a second transfer with
    // no first, because the first had been claimed one section above.
    //
    // So the specific-movement section claims BEFORE the summary that merely
    // alludes to it: the transfers stay together and in order where they belong,
    // and the summary keeps its aggregate ("547.93M across 153 transfers")
    // without restating the standout a second time. Printing order below is
    // unchanged — summary first, then the detail.
    var seen = {};
    // Non-enumerable so it can never be mistaken for a claimed-sentence key.
    try {
      Object.defineProperty(seen, '__events', {
        value: buildEventIndex(pack), enumerable: false, writable: true
      });
    } catch (_) { seen.__events = buildEventIndex(pack); }
    var moves    = largeMoves(s, seen);            // claims the specific transfers
    var exec     = executive(s, seen);             // keeps the aggregate
    var evidence = evidenceHighlights(s, seen);
    var statsTxt = stats(s, seen);
    var verd     = verdict(s, seen);

    // ── ORDER ───────────────────────────────────────────────────────────
    // Read aloud, this is a script, so it runs as one: context, then what
    // happened, then the receipts, then the read, then what to watch, then the
    // bottom line, then the sign-off.
    //
    // Escrow Watch used to be appended dead last — AFTER the prayer, the
    // scripture AND the disclaimer — because it was handled as optional
    // content rather than positioned content. On air that meant closing with
    // "not financial advice" and then reading out Ripple's escrow balance. It
    // is ledger fact and now sits with the ledger.
    //
    // Coverage sits directly under the numbers it qualifies, not three
    // sections away from them.
    var required = [];
    pushSection(required, 'SHADOW WATCH', branding(s));
    // News stays at the top, where the operator has always had it.
    pushSection(required, 'NEWS', newsHeadlines(s, pack, 4));
    pushSection(required, 'Executive Summary', exec);
    pushSection(required, 'Largest XRP Movements', moves);
    var escrowAt = required.length;                    // escrow belongs here
    pushSection(required, 'Watched Wallets / Shadow Volume', statsTxt);
    pushSection(required, 'Coverage', coverageWarning(s, pack));
    pushSection(required, 'Evidence Highlights', evidence);
    pushSection(required, 'Suggested Watchlist Additions', suggestedWallets(pack, 3));
    pushSection(required, 'Verdict / Risk', verd);
    pushSection(required, '🙏 THE DAILY PRAYER', prayer(s));
    pushSection(required, '📖 THE DAILY SCRIPTURE', scripture(s));
    pushSection(required, 'Disclaimer', disclaimer());   // genuinely last

    // Priority 3 content (candidate lists, JSON, richlist, internal
    // diagnostics, repeated explanations) is intentionally not admitted here.
    // Escrow is priority 2: included only when everything required already
    // fits, but inserted in its proper place rather than tacked on the end.
    var body = '';
    var escrow = optionalEscrow(s);
    if (escrow) {
      var withEscrow = required.slice();
      withEscrow.splice(escrowAt, 0, 'Escrow Watch\n' + clean(escrow));
      var candidate = clean(withEscrow.join('\n\n'));
      try { if (finalize(candidate).length <= 3900) body = candidate; } catch (_) {}
    }
    if (!body) body = clean(required.join('\n\n'));

    // Section-level budget guard. Required sections have already been compacted
    // individually, so this should only reject pathological input rather than
    // blindly slicing required content.
    if (body.length > TARGET_BODY) {
      throw new Error('X_SUMMARY_EXPORT required sections exceed safe body budget');
    }

    return finalize(body);
  }

  function resolvePack() {
    try { return (typeof state !== 'undefined' && state && state.pack) ? state.pack : null; } catch (_) { return null; }
  }

  function resolveSource() {
    try {
      if (typeof state !== 'undefined' && state && state.morningStoryReport && String(state.morningStoryReport).length > 200) {
        return String(state.morningStoryReport);
      }
    } catch (_) {}
    try {
      var body = document.getElementById('cmdReportBody');
      var text = body && (body.textContent || body.innerText || '');
      if (text && text.length > 200) return text;
    } catch (_) {}
    try {
      if (window.SHADOW_EXPORTS && typeof window.SHADOW_EXPORTS.buildPublicTextReport === 'function') {
        return String(window.SHADOW_EXPORTS.buildPublicTextReport() || '');
      }
    } catch (_) {}
    return '';
  }

  function installExportSurface() {
    var api = window.SHADOW_EXPORTS || (window.SHADOW_EXPORTS = {});
    api.buildXSummaryText = function (source) {
      return buildXSummaryExport(source || resolveSource(), resolvePack());
    };
    api.exportXSummary = function (source) {
      var text = api.buildXSummaryText(source);
      try {
        if (typeof copySafe === 'function') copySafe(text, 'X Summary Export');
        else if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
      } catch (_) {}
      return { ok: true, text: text, characters: text.length, limit: HARD_LIMIT };
    };
    return true;
  }

  function populateShareModal() {
    var ta = document.getElementById('swsmText');
    if (!ta) return false;
    try {
      var text = buildXSummaryExport(resolveSource(), resolvePack());
      ta.value = text;
      var counter = document.getElementById('swsmCount');
      if (counter) counter.textContent = text.length + ' / 4000 chars';
      return true;
    } catch (e) {
      try { console.warn('[SW-' + VERSION + '] X summary build failed:', e.message); } catch (_) {}
      return false;
    }
  }

  function bindShareButton() {
    var btn = document.getElementById('cmdShareXBtn');
    if (!btn || btn._swXSummaryV2Bound) return !!btn;

    var clone = btn.cloneNode(true);
    btn.parentNode.replaceChild(clone, btn);
    btn = clone;
    btn._swXSummaryV2Bound = true;
    // Script 09 retries its legacy SHARE TO X binder for ~15 seconds. Mark
    // this final presentation handler as satisfying that binder so it cannot
    // clone the button back out from under the X-summary export path.
    btn._v333hHF3Bound = true;
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      if (window.SW_SHARE && typeof window.SW_SHARE.show === 'function') {
        try { window.SW_SHARE.show(); } catch (_) {}
        requestAnimationFrame(function () {
          requestAnimationFrame(populateShareModal);
        });
      } else {
        try {
          var result = window.SHADOW_EXPORTS.exportXSummary();
          if (result && result.ok && typeof log === 'function') log('X Summary copied (' + result.characters + '/4000 chars).');
        } catch (_) {}
      }
    });
    return true;
  }

  function install() {
    installExportSurface();
    bindShareButton();
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      installExportSurface();
      bindShareButton();
      if (tries >= 20) clearInterval(timer);
    }, 250);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();

  window.SW_X_SUMMARY_EXPORT = {
    version: VERSION,
    hard_limit: HARD_LIMIT,
    build: buildXSummaryExport,
    populateShareModal: populateShareModal,
    presentation_only: true,
    full_report_untouched: true,
    debug_export_untouched: true,
    scanner_untouched: true,
    evidence_engine_untouched: true,
    discovery_engine_untouched: true,
    read_only: true
  };
})();

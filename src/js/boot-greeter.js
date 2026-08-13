
    /* ════════════════════════════════════════════════════════════════
       XRPMan AI — assistant strip engine. Self-contained, offline.
       Types its lines out (typewriter), rotates idle chatter, and reacts
       to the Commander's actions. It always addresses XRPMan directly as
       "Commander" — it is his personal companion and never drops into a
       help-desk register, even when a stranger is driving the app.
       No external AI API. No network. No ownership claims. No signing.
       ════════════════════════════════════════════════════════════════ */
    (function () {
      "use strict";
      function $(id) { return document.getElementById(id); }

      // ── typewriter (per-element interval, textContent.slice keeps spaces) ──
      var _typers = {};
      function typeInto(id, text, speed) {
        var t = $(id);
        if (!t) return;
        if (_typers[id]) { clearInterval(_typers[id]); _typers[id] = null; }
        text = String(text == null ? '' : text);
        t.textContent = '';
        t.scrollTop = 0;
        var i = 0; speed = speed || 28;
        _typers[id] = setInterval(function () {
          i++; t.textContent = text.slice(0, i);
          t.scrollTop = t.scrollHeight;
          if (i >= text.length) { clearInterval(_typers[id]); _typers[id] = null; }
        }, speed);
      }
      function pick(list) { return (list && list.length) ? list[Math.floor(Math.random() * list.length)] : ''; }

      // ── time-of-day greeting (Commander-addressed) ──
      function greeting() {
        var h = new Date().getHours(), pool;
        if (h >= 5 && h < 12) pool = [
          "Morning, Commander. Rails are warming up — say the word and I'll scan.",
          "Sunrise on the ledger, Commander. Overnight flow is logged and waiting.",
          "Up early, Commander. Good. The whales don't wait and neither do we." ];
        else if (h >= 12 && h < 17) pool = [
          "Afternoon, Commander. Ledger heat is active — I'll separate signal from noise.",
          "Midday flow is heavy, Commander. Stay on the green, watch the gold.",
          "Back at it, Commander. I've been watching the rails while you were out." ];
        else if (h >= 17 && h < 22) pool = [
          "Evening, Commander. Quieter rails, louder anomalies. I'm watching.",
          "Night scan ready, Commander. Whale movement stands out in the dark.",
          "Sensors high, lights low, Commander. Let's read the ledger." ];
        else pool = [
          "Late shift, Commander. This is when the strange wallets move.",
          "Most are asleep, Commander. The ledger isn't. Neither am I.",
          "Quiet hours, Commander. Prime time for the flow nobody's meant to see." ];
        return pick(pool);
      }

      // ── idle chatter (Commander-addressed, forensics themed) ──
      var IDLE = [
        "Standing by, Commander. Point me at a wallet and I'll trace it.",
        "Watching the rails, Commander. Nothing heavy crosses without us logging it.",
        "Every move leaves a trail, Commander. We just have to read it.",
        "Links are relationships, Commander — never proof of ownership. We stay honest.",
        "Green is normal flow, gold is the heavy money. Trust your eyes, Commander.",
        "The banks think nobody's counting, Commander. We are.",
        "Run a scan when you're ready, Commander. I'll flag anything that doesn't fit.",
        "Unknown stays unknown until the evidence is real, Commander. No guesses.",
        "Receipts beat memory, Commander. Lock what matters before the stream moves on.",
        "I don't sign and I don't move funds, Commander. I watch and I report.",
        "The ShadowWatch Report is your readout, Commander — story, sources, and flow in one place.",
        "Whales leave wakes, Commander. Big bubble, big move."
      ];

      // ── reactions keyed to the Commander's actions ──
      var REACTIONS = {
        scan:      ["Scan running, Commander. Flagging anything heavy as it crosses.",
                    "Sensors live, Commander. Watching for size and anomalies."],
        trace:     ["Tracing connections, Commander. Links are relationships, not proof.",
                    "Following the trail, Commander. I map it — you call it."],
        brief:     ["ShadowWatch Report loaded, Commander. Read it top to bottom for the full picture.",
                    "Clean intelligence readout up, Commander. Story, sources, movement."],
        session:   ["Session export open, Commander. The raw scanner metrics, no spin.",
                    "Black-box readout, Commander. Straight data for the record."],
        resolver:  ["Resolver up, Commander. Identity comes from data, never a guess.",
                    "I can help label it, Commander — but unknown stays unknown until it's earned."],
        discovery: ["Discovery inbox, Commander. Candidates land here first — review before promoting.",
                    "New wallets queued, Commander. Nothing reaches the watchlist without your call."],
        alerts:    ["Alerts toggled, Commander. I'll keep the watch either way.",
                    "Noted, Commander. Eyes stay on the rails."],
        mute:      ["Audio toggled, Commander. The ledger doesn't need sound to be loud.",
                    "Quiet mode, Commander. Still watching."],
        menu:      ["Menu open, Commander. Every tool and control in one place.",
                    "Control board up, Commander. Pick a module."],
        'screen-home':   ["Mission Control, Commander. Every scanner branches from here.",
                          "Home base, Commander. Choose a tool and I'll brief you."],
        'screen-brief':  ["The ShadowWatch Report, Commander — the public-facing readout. Solid place to start.",
                          "Report's up, Commander. The clean story for Coffee and Crypto."],
        'screen-live':   ["Live ledger stream, Commander. Green flows, gold demands a look.",
                          "Raw transactions, real time, Commander. Watch the gold."],
        'screen-map':    ["Bubble map, Commander. Bigger bubble, bigger move.",
                          "Spatial view of flow, Commander. Large bubbles earn a tap."],
        'screen-graph':  ["Wallet graph, Commander. Drop an r-address and we map the links.",
                          "Trace view ready, Commander. Connections, not conclusions."],
        'screen-hvt':    ["Watchlist, Commander. Promote with discipline — bad labels poison the system.",
                          "High-value targets, Commander. Every entry earns its place."],
        'screen-case':   ["Evidence locker, Commander. Lock the anomalies that count.",
                          "Receipts vault, Commander. The ledger forgets fast — this doesn't."],
        'screen-report': ["Whale flow, Commander. Every heavy move, lined up for review.",
                          "The heavy-money log, Commander. Timestamped for the record."]
      };

      // ── idle rotation ──
      var queue = [];
      function refill() {
        queue = IDLE.slice();
        for (var i = queue.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = queue[i]; queue[i] = queue[j]; queue[j] = t; }
      }
      function nextIdle() { if (!queue.length) refill(); return queue.shift(); }

      var rotTimer = null, greetTimer = null, started = false;
      function armRotation() {
        if (rotTimer) clearInterval(rotTimer);
        rotTimer = setInterval(function () { typeInto('xrpman-text', nextIdle()); }, 10000);
      }

      function react(key) {
        var line = REACTIONS[key];
        if (!line) {
          if (/^screen-/.test(String(key))) line = ["On it, Commander. I'll brief you on what this screen sees."];
          else return;
        }
        typeInto('xrpman-text', pick(line));
        armRotation();
      }
      function nextMessage() { typeInto('xrpman-text', nextIdle()); armRotation(); }

      function start() {
        if (started) return;
        started = true;
        typeInto('xrpman-text', greeting());
        armRotation();
        if (greetTimer) clearInterval(greetTimer);
        greetTimer = setInterval(function () { typeInto('xrpman-text', greeting()); }, 600000);
      }

      function bootGreeter() {
        if (!$('boot-greeter-text')) return;
        typeInto('boot-greeter-text', pick([
          "Systems online, Commander. Thumb to the scanner and we're in.",
          "Ledger lens armed, Commander. Press your print to bring the watch up.",
          "Standing by, Commander. Hold your thumb — the scanner's waiting."
        ]), 30);
      }

      // ── expose ──
      window.xrpmanReact = react;
      window.xrpmanNextMessage = nextMessage;
      window.startXrpmanAssistant = start;

      // ── non-invasive wraps: react without touching business logic ──
      function wrap(name, key) {
        var orig = window[name];
        if (typeof orig === 'function' && !orig.__xrpStrip) {
          window[name] = function () { var r = orig.apply(this, arguments); try { react(key); } catch (e) {} return r; };
          window[name].__xrpStrip = true;
        }
      }
      wrap('startXRPL', 'scan');
      wrap('traceWallet', 'trace');
      wrap('manualGraphTrace', 'trace');
      wrap('loadBriefConsole', 'brief');
      wrap('openIntelDashboard', 'session');
      wrap('openWalletResolver', 'resolver');
      wrap('openDiscoveryInbox', 'discovery');

      // type the splash transmission now (or on DOM ready)
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootGreeter);
      else bootGreeter();

      // bring the strip up the moment the splash is dismissed; start() is idempotent
      var startWatch = setInterval(function () {
        var sp = $('splash-screen');
        if (!sp || sp.dataset.done === '1' || sp.style.display === 'none' || sp.classList.contains('fade-out')) {
          start(); clearInterval(startWatch);
        }
      }, 400);
    })();
    
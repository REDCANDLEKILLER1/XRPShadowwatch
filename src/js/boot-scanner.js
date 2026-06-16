
    /* ════ FAKE THUMB SCANNER — biometric boot (reads anyone's thumb) ════ */
    (function () {
      var pad = document.getElementById('thumb-scan');
      if (!pad) return;
      var vid = pad.querySelector('.ts-vid');
      // Muted autoplay is usually allowed, but kick it on first interaction as a fallback.
      function kickVid(){ try { if (vid && vid.paused) { var p = vid.play(); if (p && p.catch) p.catch(function(){}); } } catch (e) {} }
      if (vid) { kickVid(); document.addEventListener('pointerdown', kickVid, { once: true }); }
      var bar = pad.querySelector('.ts-prog-bar'),
          label = pad.querySelector('.ts-label');
      var R = 64, C = 2 * Math.PI * R;
      bar.style.strokeDasharray = C;
      bar.style.strokeDashoffset = C;
      var SCAN_MS = 1400, started = false, actx = null;
      function ensureAudio() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx && actx.state === 'suspended') actx.resume(); } catch (e) {} }
      function buzz(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} }
      function beep(freq, delay, dur) {
        if (!actx) return;
        try {
          var o = actx.createOscillator(), g = actx.createGain();
          o.type = 'square'; o.frequency.value = freq;
          o.connect(g); g.connect(actx.destination);
          var t = actx.currentTime + (delay || 0);
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.16, t + 0.012);
          g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.15));
          o.start(t); o.stop(t + (dur || 0.15) + 0.03);
        } catch (e) {}
      }
      function grant() {
        pad.classList.remove('scanning');
        pad.classList.add('granted');
        label.textContent = 'ACCESS GRANTED';
        buzz([0, 35, 45, 130]);
        beep(720, 0, 0.09); beep(1180, 0.12, 0.18);
        setTimeout(function () { if (typeof finishBoot === 'function') finishBoot(); }, 720);
      }
      function run() {
        if (started) return; started = true;
        ensureAudio();
        pad.classList.add('scanning');
        label.textContent = 'SCANNING';
        buzz(18);
        var t0 = performance.now();
        (function step(now) {
          var p = Math.min(1, (now - t0) / SCAN_MS);
          bar.style.strokeDashoffset = C * (1 - p);
          if (p < 1) requestAnimationFrame(step);
          else grant();
        })(t0);
      }
      pad.addEventListener('pointerdown', function (e) { e.preventDefault(); run(); });
      pad.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(); } });
    })();
    
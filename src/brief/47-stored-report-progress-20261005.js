/* Real stored-reader milestones. Elapsed time is local; server freshness only
   changes when a stream message actually arrives. No invented overall %. */
(function () {
  'use strict';
  var panel = document.getElementById('swReportMonitor');
  if (!panel) return;
  var title = document.getElementById('swMonitorTitle');
  var detail = document.getElementById('swMonitorDetail');
  var elapsed = document.getElementById('swMonitorElapsed');
  var signal = document.getElementById('swMonitorSignal');
  var bar = document.getElementById('swMonitorBar');
  var started = Date.now(), ended = null, active = false, sawScanning = false;
  var lastServer = null, phase = 'opening', facts = {}, failure = '';
  function appState() { try { return typeof state !== 'undefined' ? state : null; } catch (_) { return null; } }
  function count(n) { return Number(n || 0).toLocaleString('en-US'); }
  function text(node, value) { if (node.textContent !== value) node.textContent = value; }
  function start() {
    if (active) return;
    active = true; sawScanning = false; started = Date.now(); ended = null;
    lastServer = null; facts = {}; failure = ''; phase = 'starting';
  }
  function render() {
    // The dashboard adopts the legacy page after boot. Keep the monitor in
    // its visible reactor, not in the legacy content that adoption hides.
    var anchor = document.getElementById('swSegBar');
    if (anchor && anchor.parentNode && panel.parentNode !== anchor.parentNode) {
      anchor.parentNode.insertBefore(panel, anchor.nextSibling);
      panel.classList.remove('sw-legacy-hidden');
      document.body.classList.add('sw-stored-monitor-mounted');
    }
    var s = appState();
    if (s && s.scanning) { start(); sawScanning = true; }
    if (active && sawScanning && s && !s.scanning) {
      active = false; ended = Date.now(); phase = s.seal ? 'complete' : 'error';
    }
    if (!active && phase === 'opening' && document.readyState !== 'loading' &&
        typeof window.run === 'function' && window.SW_STORED_EVIDENCE_READER_20260927) {
      phase = 'ready'; ended = Date.now();
    }
    var label, description, fraction = null;
    switch (phase) {
      case 'opening': label = 'Opening Shadow Watch…'; description = 'Loading the report workspace'; break;
      case 'ready': label = 'Ready to build a report'; description = 'RUN reads saved XRPL evidence · snapshots collected every 2 hours'; break;
      case 'starting': label = 'Starting report'; description = 'Preparing the reporting window and market context'; break;
      case 'connecting': label = 'Opening saved snapshot'; description = 'Waiting for the snapshot service'; break;
      case 'checkpoint': label = 'Finding the latest snapshot'; description = 'Checking the saved evidence checkpoint'; break;
      case 'history': label = 'Checking snapshot history'; description = count(facts.states_walked) + ' checkpoints checked · ' + count(facts.days_found) + ' of ' + count(facts.days_total) + ' report days found'; break;
      case 'verifying': label = 'Verifying snapshot files'; description = count(facts.files_verified) + ' of ' + count(facts.files_total) + ' files verified'; if (facts.files_total > 0) fraction = facts.files_verified / facts.files_total; break;
      case 'assembling': label = 'Assembling verified transactions'; description = 'Matching wallet records and selecting the report window'; break;
      case 'receiving': label = 'Receiving verified transactions'; description = count(facts.events_received) + ' of ' + count(facts.events_total) + ' transactions received'; if (facts.events_total > 0) fraction = facts.events_received / facts.events_total; break;
      case 'snapshot-ready':
        label = s && s.githubArchive && s.githubArchive.status === 'PENDING' ? 'Saving report to archive' : 'Building report';
        description = count(facts.events_received) + ' stored transactions received · checking context and preparing the report';
        if (s && s.reportBuildStage) {
          label = s.reportBuildStage.message;
          description = count(facts.events_received) + ' verified transactions · this step ' +
            Math.max(0, Math.floor((Date.now() - Date.parse(s.reportBuildStage.started_at)) / 1000)) + 's';
        }
        break;
      case 'paused': label = 'Waiting for the app to return'; description = 'The snapshot read will resume when this screen is active'; break;
      case 'retry': label = 'Reconnecting to snapshot service'; description = 'The connection stopped responding · retrying shortly'; break;
      case 'complete':
        label = 'Report ready';
        description = s && s.githubArchive && /^(ARCHIVED|ALREADY_ARCHIVED)$/.test(s.githubArchive.status)
          ? 'Report sealed · archive saved' : s && s.githubArchive && /^(FAILED|ARCHIVE_CONFLICT)$/.test(s.githubArchive.status)
          ? 'Report sealed · archive save failed — check the run log' : 'Report sealed · archive save not confirmed'; break;
      default: label = 'Report stopped'; description = failure || 'The report did not finish. Check the run log, then try RUN again.';
    }
    if (active && facts.attempt > 1) description += ' · attempt ' + facts.attempt;
    panel.dataset.phase = phase;
    text(title, label); text(detail, description);
    var seconds = Math.max(0, Math.floor(((ended || Date.now()) - started) / 1000));
    text(elapsed, Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'));
    var reading = active && !/^(starting|snapshot-ready|error|paused|retry)$/.test(phase);
    var age = lastServer === null ? null : Math.max(0, Math.floor((Date.now() - lastServer) / 1000));
    text(signal, reading ? (age === null ? 'Awaiting first server update' :
      (age > 15 ? 'Waiting for next server update · last received ' : 'Last server update ') + age + 's ago') : '');
    if (fraction !== null) {
      var pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
      bar.dataset.measured = 'true'; bar.setAttribute('aria-valuenow', pct);
      bar.setAttribute('aria-valuetext', description); bar.firstElementChild.style.width = pct + '%';
    } else {
      delete bar.dataset.measured; bar.removeAttribute('aria-valuenow');
      bar.removeAttribute('aria-valuetext'); bar.firstElementChild.style.width = '';
    }
  }
  window.addEventListener('shadowwatch:stored-report-progress', function (event) {
    var value = event.detail || {};
    start();
    if (value.phase === 'connecting') { facts = {}; lastServer = null; failure = ''; }
    if (value.server_update) lastServer = Date.now();
    // A heartbeat proves liveness, not another verified file or transaction.
    if (value.t !== 'heartbeat') { phase = value.phase || phase; Object.assign(facts, value); }
    if (value.phase === 'error') failure = value.error || 'Snapshot unavailable';
    render();
  });
  document.addEventListener('click', function (event) {
    var button = event.target.closest && event.target.closest('#scanBtn, #swRunBtn');
    if (button && !button.disabled) { start(); render(); }
  }, true);
  setInterval(render, 250);
  render();
})();

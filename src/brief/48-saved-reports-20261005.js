(function () {
  'use strict';
  var dbPromise, dialog, selectedDay, selectedReport, serverRows = [], phoneRows = [], dates = [], nextOffset = null;
  var sequence = 0, retrying = false;
  var saved = function (status) { return /^(ARCHIVED|ALREADY_ARCHIVED)$/.test(status || ''); };
  function reportDay(id) { var m = /^SW-(\d{4})(\d{2})(\d{2})-[A-Z0-9]{5}$/.exec(id || ''); return m ? m[1]+'-'+m[2]+'-'+m[3] : null; }
  function today(offset) { var d = new Date(); d.setUTCDate(d.getUTCDate() + (offset || 0)); return d.toISOString().slice(0,10); }
  function el(id) { return document.getElementById(id); }
  function database() {
    if (!dbPromise) dbPromise = new Promise(function (resolve,reject) {
      var request = indexedDB.open('SW_SAVED_REPORTS_V1',1);
      var timer = setTimeout(function () { reject(new Error('PHONE_STORAGE_UNAVAILABLE')); },4000);
      request.onupgradeneeded = function () { request.result.createObjectStore('reports',{keyPath:'report_id'}); };
      request.onsuccess = function () { clearTimeout(timer); resolve(request.result); };
      request.onerror = function () { clearTimeout(timer); reject(request.error); };
      request.onblocked = function () { clearTimeout(timer); reject(new Error('PHONE_STORAGE_BLOCKED')); };
    });
    return dbPromise;
  }
  function storage(mode,operation) {
    return database().then(function (db) { return new Promise(function (resolve,reject) {
      var tx = db.transaction('reports',mode), value;
      var timer = setTimeout(function () {
        reject(new Error('PHONE_STORAGE_TIMEOUT'));
        try { tx.abort(); } catch (_) {}
      },4000);
      tx.oncomplete = function () { clearTimeout(timer); resolve(value); };
      tx.onerror = tx.onabort = function () { clearTimeout(timer); reject(tx.error || new Error('PHONE_SAVE_FAILED')); };
      var request = operation(tx.objectStore('reports'));
      request.onsuccess = function () { value = request.result; };
    }); });
  }
  async function capture(payload) {
    var date = reportDay(payload && payload.report_id);
    if (!date || !payload.morning_report || !/^[a-f0-9]{64}$/.test(payload.morning_hash || '')) throw new Error('INVALID_SAVED_REPORT');
    var previous = await storage('readonly',function (s) { return s.get(payload.report_id); });
    if (previous && previous.report_hash !== payload.morning_hash) throw new Error('PHONE_REPORT_CONFLICT');
    var row = {report_id:payload.report_id,report_day:date,created_at:payload.generated_at,
      text:payload.morning_report,report_hash:payload.morning_hash,payload:payload,
      archive_status:previous && previous.archive_status || 'PENDING',source:'phone'};
    await storage('readwrite',function (s) { return s.put(row); });
    return row;
  }
  async function mark(id,result) {
    var row = await storage('readonly',function (s) { return s.get(id); });
    if (!row) return;
    row.archive_status = result.status || 'FAILED'; row.archive_error = result.error || null;
    row.archive_day = result.archive_path ? result.archive_path.split('/').slice(1,4).join('-') : row.archive_day;
    await storage('readwrite',function (s) { return s.put(row); });
  }
  async function localReports() {
    var rows = [];
    try { rows = await storage('readonly',function (s) { return s.getAll(); }); } catch (_) {}
    // Preserve the older first-report-per-day phone archive without changing
    // its daily gate, rewriting its text, or claiming it was saved remotely.
    try {
      var old = JSON.parse(localStorage.getItem('SW_BRIEF_ARCHIVE_V1') || '{}');
      Object.keys(old).forEach(function (d) {
        var item = old[d];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !item || !item.text) return;
        if (rows.some(function (r) { return r.report_day === d && r.text === item.text; })) return;
        rows.push({report_id:'phone-'+d,report_day:d,created_at:new Date(item.savedAt || d).toISOString(),
          text:item.text,source:'phone',archive_status:'PHONE_ONLY'});
      });
    } catch (_) {}
    return rows;
  }
  async function api(params) {
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); },20000);
    try {
      var response = await fetch('/api/report-history?' + new URLSearchParams(params || {}),
        {cache:'no-store',credentials:'same-origin',signal:controller.signal});
      var data = await response.json();
      if (!response.ok) throw new Error(data.error || 'REPORT_HISTORY_UNAVAILABLE');
      return data;
    } finally { clearTimeout(timer); }
  }
  function notice(text) { el('swSavedNotice').textContent = text; }
  function dateLabel(date) {
    var label = date === today() ? 'Today' : date === today(-1) ? 'Yesterday' : '';
    return (label ? label + ' · ' : '') + date;
  }
  function renderList() {
    selectedReport = null;
    el('swSavedReader').hidden = true; el('swSavedBrowse').hidden = false;
    var select = el('swSavedDate'); select.replaceChildren();
    Array.from(new Set(dates.concat([selectedDay]))).filter(Boolean).sort().reverse().forEach(function (d) {
      var option = document.createElement('option'); option.value = d; option.textContent = dateLabel(d); select.appendChild(option);
    });
    select.value = selectedDay;
    var rows = new Map();
    phoneRows.filter(function (r) { return r.report_day === selectedDay; }).forEach(function (r) { rows.set(r.report_id,r); });
    serverRows.forEach(function (r) { rows.set(r.report_id,Object.assign({},r,{source:'archive'})); });
    var items = Array.from(rows.values()).sort(function (a,b) {
      return String(b.created_at || '').localeCompare(String(a.created_at || '')) || b.report_id.localeCompare(a.report_id);
    });
    var list = el('swSavedList'); list.replaceChildren();
    items.forEach(function (row) {
      var button = document.createElement('button'); button.type = 'button'; button.className = 'sw-saved-row';
      var title = document.createElement('strong'), meta = document.createElement('span');
      title.textContent = row.created_at && Number.isFinite(Date.parse(row.created_at))
        ? new Date(row.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',timeZone:'UTC'}) + ' UTC · Shadow Watch report'
        : 'Shadow Watch report';
      var status = row.source === 'archive' || saved(row.archive_status) ? 'Saved to archive' : row.payload ? 'Saved on this phone · archive pending' : 'Saved on this phone';
      meta.textContent = status + ' · ' + (row.report_id.indexOf('phone-') === 0 ? 'Earlier phone archive' : row.report_id);
      button.append(title,meta); button.addEventListener('click',function () { readReport(row); }); list.appendChild(button);
    });
    if (!items.length) { var empty = document.createElement('p'); empty.textContent = 'No saved reports for this day. Completed reports appear here automatically.'; list.appendChild(empty); }
    el('swSavedMore').hidden = nextOffset === null;
    el('swSavedRetry').hidden = !phoneRows.some(function (r) { return r.payload && !saved(r.archive_status); });
  }
  async function load(date,more) {
    var ticket = ++sequence;
    phoneRows = await localReports(); if (ticket !== sequence) return;
    if (!more) { serverRows = []; nextOffset = null; }
    selectedDay = date || phoneRows.map(function (r) { return r.report_day; }).sort().reverse()[0] || today();
    dates = Array.from(new Set(dates.concat(phoneRows.map(function (r) { return r.report_day; }))));
    renderList(); notice('Loading saved reports…');
    try {
      var params = date ? {date:date} : {};
      if (more) params.offset = nextOffset;
      var result = await api(params); if (ticket !== sequence) return;
      dates = Array.from(new Set(result.dates.concat(phoneRows.map(function (r) { return r.report_day; })))).sort().reverse();
      var chosen = date || dates[0] || today();
      if (chosen !== result.date && result.date !== null) { result = await api({date:chosen}); if (ticket !== sequence) return; }
      selectedDay = chosen; serverRows = more ? serverRows.concat(result.reports) : result.reports;
      nextOffset = result.next_offset; renderList(); notice('Report dates use UTC. Every completed run is kept separately.');
    } catch (_) {
      if (ticket !== sequence) return;
      renderList(); notice('Shared archive unavailable. Showing reports saved on this phone. Try Refresh when connected.');
    }
  }
  function showReport(row,message) {
    selectedReport = row;
    el('swSavedBrowse').hidden = true; el('swSavedReader').hidden = false;
    el('swSavedReportDate').textContent = dateLabel(row.report_day) + ' · ' + (row.report_id.indexOf('phone-') === 0 ? 'Earlier phone archive' : row.report_id);
    el('swSavedText').textContent = row.text;
    el('swSavedText').scrollTop = 0;
    notice(message);
  }
  async function readReport(row) {
    var ticket = ++sequence;
    if (row.source !== 'archive') { showReport(row,saved(row.archive_status) ? 'Original saved report · archived' : 'Original report saved on this phone'); return; }
    notice('Opening the saved report…');
    try {
      var data = await api({action:'read',report_id:row.report_id,archive_day:row.archive_day});
      if (ticket !== sequence) return;
      showReport(data,'Original saved report · archive integrity verified' + (data.evidence_at ? ' · evidence '+new Date(data.evidence_at).toLocaleString() : ''));
    } catch (_) {
      if (ticket !== sequence) return;
      var local = phoneRows.find(function (r) { return r.report_id === row.report_id; });
      if (local) showReport(local,'Archive unavailable. Showing the original copy saved on this phone.');
      else notice('This report could not be opened or verified. Try again when connected.');
    }
  }
  async function retryPending() {
    if (retrying || navigator.onLine === false) return;
    try { if (typeof state !== 'undefined' && state.scanning) return; } catch (_) {}
    retrying = true;
    try {
      var rows = (await localReports()).filter(function (r) { return r.payload && !saved(r.archive_status) && r.archive_status !== 'ARCHIVE_CONFLICT'; }).slice(0,3);
      for (var row of rows) {
        try {
          var response = await fetch('/api/report-archive',{method:'POST',credentials:'same-origin',cache:'no-store',
            headers:{'Content-Type':'application/json'},body:JSON.stringify(row.payload)});
          var result = await response.json();
          if (!response.ok && result.status !== 'ARCHIVE_CONFLICT') result.status = 'FAILED';
          await mark(row.report_id,result);
          if (!response.ok) break;
        } catch (_) { break; }
      }
    } finally {
      retrying = false;
      if (dialog && dialog.open && !selectedReport) load(selectedDay);
    }
  }
  function open() { build(); if (!dialog.open) dialog.showModal(); notice('Loading saved reports…'); load(); }
  function build() {
    if (dialog) return;
    dialog = document.createElement('dialog'); dialog.id = 'swSavedReportsDialog'; dialog.setAttribute('aria-labelledby','swSavedTitle');
    dialog.innerHTML = '<header><div><h2 id="swSavedTitle">Saved reports</h2><p>Coffee &amp; Crypto with Stone · Shadow Watch</p></div><button id="swSavedClose" type="button" aria-label="Close saved reports">Close</button></header>' +
      '<p id="swSavedNotice" role="status"></p><section id="swSavedBrowse"><div class="sw-saved-filters">' +
      '<button type="button" data-saved-day="0">Today</button><button type="button" data-saved-day="-1">Yesterday</button><button type="button" data-saved-day="-2">Day before</button>' +
      '<label>Report date <select id="swSavedDate"></select></label><button id="swSavedRefresh" type="button">Refresh</button></div>' +
      '<div id="swSavedList"></div><button id="swSavedMore" type="button" hidden>More reports</button><button id="swSavedRetry" type="button" hidden>Retry pending saves</button></section>' +
      '<section id="swSavedReader" hidden><div class="sw-saved-actions"><button id="swSavedBack" type="button">Back to dates</button><button id="swSavedCopy" type="button">Copy report</button><button id="swSavedDownload" type="button">Download</button></div>' +
      '<p id="swSavedReportDate"></p><pre id="swSavedText" tabindex="0"></pre></section>';
    document.body.appendChild(dialog);
    el('swSavedClose').onclick = function () { dialog.close(); };
    dialog.addEventListener('close',function () { sequence++; });
    dialog.querySelectorAll('[data-saved-day]').forEach(function (b) { b.onclick = function () { load(today(Number(b.dataset.savedDay))); }; });
    el('swSavedDate').onchange = function () { load(this.value); };
    el('swSavedRefresh').onclick = function () { load(selectedDay); };
    el('swSavedMore').onclick = function () { load(selectedDay,true); };
    el('swSavedBack').onclick = function () { sequence++; renderList(); notice('Choose a saved report. Report dates use UTC.'); };
    el('swSavedRetry').onclick = function () { notice('Retrying archive saves…'); retryPending(); };
    el('swSavedCopy').onclick = async function () {
      try { await navigator.clipboard.writeText(selectedReport.text); notice('Report copied.'); }
      catch (_) { notice('Copy unavailable. Use Download to keep the report.'); }
    };
    el('swSavedDownload').onclick = function () {
      if (!selectedReport) return;
      var url = URL.createObjectURL(new Blob([selectedReport.text],{type:'text/plain;charset=utf-8'}));
      var link = document.createElement('a'); link.href = url; link.download = 'MorningReport_'+selectedReport.report_id+'.txt'; link.click();
      setTimeout(function () { URL.revokeObjectURL(url); },1000);
    };
  }
  function mount() {
    var run = el('swRunBtn'); if (!run || el('swSavedReportsButton')) return !!run;
    var actions = document.createElement('div'); actions.className = 'sw-saved-run-actions';
    run.parentNode.insertBefore(actions,run); actions.appendChild(run);
    var button = document.createElement('button'); button.type = 'button'; button.id = 'swSavedReportsButton';
    button.textContent = 'Saved reports'; button.onclick = open; actions.appendChild(button); return true;
  }
  window.SW_SAVED_REPORTS = {capture:capture,mark:mark,list:localReports,open:open,retryPending:retryPending};
  if (!mount()) { var mounted = setInterval(function () { if (mount()) clearInterval(mounted); },500); }
  window.addEventListener('online',function () { retryPending(); });
  window.addEventListener('pageshow',function () { retryPending(); });
  document.addEventListener('visibilitychange',function () { if (!document.hidden) retryPending(); });
  setTimeout(function () { retryPending(); },10000);
})();

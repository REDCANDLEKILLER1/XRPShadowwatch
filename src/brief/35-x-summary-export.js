(function(){
  'use strict';

  function buildXSummaryExport(source){
    var s = String(source || '');
    var limit = 3900;

    var header = 'X EXPORT\nCharacters: 0000 / 4000\n\n';
    var out = header + s;

    var removable = [
      /LEDGER DIAGNOSTICS[\s\S]*?(?=Escrow Watch|Sources|$)/i,
      /Under the Surface[\s\S]*?(?=How to Read It|What To Watch Next|Verdict|$)/i,
      /Evidence[\s\S]*?(?=Under the Surface|How to Read It|$)/i,
      /\{[\s\S]*?\}/g
    ];

    removable.forEach(function(rx){
      if (out.length > limit) out = out.replace(rx, '');
    });

    if (out.length > limit) {
      out = out.slice(0, limit - 20) + '\n...[TRIMMED]';
    }

    out = out.replace(/Characters: \d{4}/, 'Characters: ' + out.length + ' / 4000');

    if (out.length > 4000) {
      throw new Error('X_SUMMARY_EXPORT exceeds 4000 characters');
    }

    return out;
  }

  window.SW_X_SUMMARY_EXPORT = {
    version: 'X_SUMMARY_EXPORT_v1',
    build: buildXSummaryExport
  };
})();

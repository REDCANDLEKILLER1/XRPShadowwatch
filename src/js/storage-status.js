(function(){'use strict';
 var $=function(id){return document.getElementById(id);};
 var size=function(n){return(Number(n)/Math.pow(1024,3)).toFixed(2)+' GiB';};
 async function read(url){var r=await fetch(url,{cache:'no-store'});if(!r.ok)throw Error('The check could not finish. Retry shortly.');return r.json();}
 $('refresh').onclick=async function(){this.disabled=true;$('status').textContent='Checking shared storage…';
  try{var h=await read('/api/storage-health');$('status').textContent=h.capacity_status+' — checkpoint '+(h.checkpoint.verified?'verified':'unverified');$('metrics').textContent='';
   [['Current files',String(h.current_files)],['Current file data',size(h.current_file_bytes)],['Repository size (approximate)',size(h.repository_bytes)],['Watched wallets',String(h.checkpoint.wallets)],['Checkpoint version',String(h.checkpoint.state_version)],['Automatic rollover',h.automatic_rollover_enabled?'Enabled':'Not enabled']].forEach(function(pair){var dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=pair[0];dd.textContent=pair[1];$('metrics').append(dt,dd);});
   $('backup').textContent=h.backup.independent_restore_verified?'Independent restore verified.':'Independent backup is not verified. Keep the source evidence intact.';
  }catch(e){$('status').textContent=e.message;}finally{this.disabled=false;}};
 $('qualify').onclick=async function(){this.disabled=true;$('qualification').textContent='Checking verified stored activity…';$('candidates').textContent='';
  try{var r=await read('/api/wallet-admission');$('qualification').textContent=r.candidates.length+' qualified candidates; preview only. '+r.apply_status;
   r.candidates.forEach(function(c){var li=document.createElement('li');li.textContent=c.address+' — '+c.transaction_count+' distinct large payments; '+c.total_xrp+' XRP observed. Ownership unknown.';$('candidates').append(li);});
  }catch(e){$('qualification').textContent=e.message;}finally{this.disabled=false;}};
})();

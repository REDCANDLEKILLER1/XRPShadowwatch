(function(){
  var v=document.getElementById('swBgVideo'); if(!v) return;
  v.muted=true; v.defaultMuted=true;
  function kick(){ try{ var p=v.play(); if(p&&p.catch) p.catch(function(){}); }catch(_){} }
  kick();
  window.addEventListener('load', kick);
  ['pointerdown','touchstart','click','visibilitychange'].forEach(function(ev){
    document.addEventListener(ev, kick, {passive:true});
  });
})();

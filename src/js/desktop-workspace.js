(function(){
  'use strict';
  function install(){
    if(document.getElementById('swDesktopNav'))return;
    var nav=document.createElement('nav');nav.id='swDesktopNav';nav.setAttribute('aria-label','Main navigation');
    var brand=document.createElement('span');brand.className='sw-desk-brand';brand.textContent='SHADOWWATCH';nav.appendChild(brand);
    [['home','Overview'],['live','Live activity'],['map','Map'],['graph','Connections'],['hvt','Watched wallets'],['brief','Morning report'],['menu','Menu']].forEach(function(item){
      var button=document.createElement('button');button.type='button';button.textContent=item[1];button.dataset.view=item[0];
      button.addEventListener('click',function(){
        if(item[0]==='menu'){document.getElementById('tab-btn-menu')?.click();return;}
        if(typeof window.switchView==='function')window.switchView(item[0]);
        if(item[0]==='brief'&&typeof window.loadBriefConsole==='function')window.loadBriefConsole();
        sync();
      });nav.appendChild(button);
    });
    function sync(){nav.querySelectorAll('button').forEach(function(button){
      var view=document.getElementById('view-'+button.dataset.view),active=view&&view.classList.contains('active');
      if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
    });}
    document.body.appendChild(nav);document.body.classList.add('sw-desktop-ready');
    var observer=new MutationObserver(sync);
    document.querySelectorAll('.view-panel').forEach(function(view){observer.observe(view,{attributes:true,attributeFilter:['class']});});
    sync();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();

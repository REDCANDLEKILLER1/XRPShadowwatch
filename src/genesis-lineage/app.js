(async function loadGenesisLineageRuntime(){
  'use strict';
  const parts=[
    '/src/genesis-lineage/app-parts/app-01.part',
    '/src/genesis-lineage/app-parts/app-02.part',
    '/src/genesis-lineage/app-parts/app-03.part',
    '/src/genesis-lineage/app-parts/app-04.part',
    '/src/genesis-lineage/runtime/tail-01.part',
    '/src/genesis-lineage/runtime/tail-02.part',
    '/src/genesis-lineage/runtime/tail-03.part',
    '/src/genesis-lineage/runtime/tail-04.part',
    '/src/genesis-lineage/runtime/tail-05.part',
    '/src/genesis-lineage/runtime/tail-06.part',
    '/src/genesis-lineage/runtime/tail-07.part',
    '/src/genesis-lineage/runtime/tail-08.part'
  ];
  let source='';
  for(const path of parts){
    const r=await fetch(path,{cache:'no-store'});
    if(!r.ok)throw new Error(`runtime part ${path} HTTP ${r.status}`);
    source+=await r.text();
  }
  (0,eval)(source);
})().catch(e=>{
  console.error('Genesis Lineage runtime failed:',e);
  const hud=document.querySelector('#graphHud');
  if(hud)hud.textContent='Runtime load failed: '+e.message;
});

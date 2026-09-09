'use strict';
const assert=require('assert/strict'),http=require('http'),fs=require('fs'),path=require('path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),port=Number(process.env.SW_TEST_PORT||8230);
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://local');let file=path.resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));
  const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png'};
  if(!file.startsWith(root+path.sep)||!mime[path.extname(file)]){res.writeHead(404);res.end();return;}
  fs.readFile(file,(err,data)=>{res.writeHead(err?404:200,{'Content-Type':mime[path.extname(file)]});res.end(err?'':data);});
});
async function main(){
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const browser=await chromium.launch({args:['--no-sandbox']});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    await page.route('**/*',r=>r.request().url().startsWith('http://127.0.0.1:'+port)?r.continue():r.abort());
    await page.routeWebSocket(/wss:\/\//,ws=>ws.close());
    await page.goto('http://127.0.0.1:'+port+'/brief-console.html');await page.waitForTimeout(5500);
    const sizes=await page.evaluate(()=>['swMarketPanel','swInstruments','swLogPanel','swFeed','swNetwork','swDownloads'].map(id=>({id,h:document.getElementById(id).getBoundingClientRect().height})));
    for(const p of sizes)assert.ok(p.h>80,p.id+' has usable height');
    await page.locator('#swDownloads').scrollIntoViewIfNeeded();
    assert.ok(await page.locator('#swDashRail').isVisible());
    assert.ok((await page.locator('#swDashRail').boundingBox()).y>=0,'section navigation remains in the viewport');
    assert.ok((await page.locator('#swDashHeader').boundingBox()).y>=0,'header remains in the viewport');
    console.log('PASS desktop panels scroll without collapsing and navigation remains reachable');
    await page.evaluate(()=>window.MORNING_REPORT_FLOAT.show('Layout fixture: report text.\n'.repeat(180)+'\nSources\nhttps://news.google.com/rss/articles/'+ 'a'.repeat(2000),[],{}));
    await page.getByRole('button',{name:'Center window',exact:true}).click();
    const box=await page.locator('#morningReportFloat').boundingBox();assert.ok(box.x>=0&&box.y>=0);
    assert.ok(box.x+box.width<=1440&&box.y+box.height<=900);
    assert.ok(await page.locator('#mrfBody').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'long source links wrap without horizontal scrolling');
    await page.getByRole('button',{name:'Fill screen',exact:true}).click();
    await page.keyboard.press('Escape');assert.equal(await page.locator('#morningReportFloat').isVisible(),false);
    console.log('PASS report actions are visible and Escape closes the reader');
    const firstFile=page.waitForEvent('download');
    await page.evaluate(()=>downloadTextFile('evidence-fixture.txt','Exact evidence\n255/255\n'));
    const firstDownload=await firstFile;
    assert.equal(fs.readFileSync(await firstDownload.path(),'utf8'),'Exact evidence\n255/255\n');
    await page.waitForTimeout(1100);
    const retryFile=page.waitForEvent('download');
    await page.getByRole('link',{name:'evidence-fixture.txt',exact:true}).click();
    assert.equal(fs.readFileSync(await (await retryFile).path(),'utf8'),'Exact evidence\n255/255\n');
    await page.getByRole('button',{name:'Dismiss prepared download',exact:true}).click();
    assert.equal(await page.locator('#swPreparedDownload').count(),0);
    console.log('PASS prepared file link retries a byte-identical browser download and can be dismissed');
    await page.evaluate(()=>{
      state.pack={wallets_checked:255,watchlist_total:255,wallets_failed:0,
        tx_scan_coverage:{target_wallets:255,complete_wallets:253,failed_wallets:2,full_window_complete:false}};
      window.SHADOW_EVENT_BUS.emit('shadow.report.sealed',{});
    });
    await page.waitForTimeout(1200);
    const incomplete=await page.evaluate(()=>({phase:window.XAI_SCAN_PROGRESS.phase,
      mission:document.getElementById('xaiMissionPct').textContent,
      reactor:document.getElementById('swReactorPct').textContent,
      runtime:document.getElementById('swPhaseRuntimeLabel').textContent,
      runtimePct:document.getElementById('swPhaseRuntimePct').textContent}));
    assert.equal(incomplete.phase,'INCOMPLETE');
    assert.equal(incomplete.mission,'—');assert.notEqual(incomplete.reactor,'100%');
    assert.match(incomplete.runtime,/incomplete acquisition/);assert.equal(incomplete.runtimePct,'—');
    await page.keyboard.press('Escape');
    console.log('PASS delayed report sealing preserves incomplete acquisition instead of announcing 100%');
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.locator('#swDashRail').isVisible(),false);
    assert.equal(await page.locator('#swDashBottomNav').isVisible(),true);
    assert.equal(await page.locator('#swGauges').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),2,'phone coverage counters have readable separate columns');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1));
    console.log('PASS phone navigation and viewport width are preserved');
    await page.setViewportSize({width:1440,height:900});
    await page.goto('http://127.0.0.1:'+port+'/');
    await page.getByRole('button',{name:'Hold thumb to activate Shadow Watch'}).click();
    await page.getByRole('button',{name:'SKIP',exact:true}).click({timeout:15000});
    await page.getByRole('button',{name:'Morning report',exact:true}).click();
    const iframe=page.frameLocator('#brief-frame');
    await iframe.getByRole('button',{name:'Report & downloads',exact:true}).click({timeout:15000});
    await iframe.getByRole('button',{name:'Scan overview',exact:true}).click();
    await page.waitForTimeout(600);
    const phaseBox=await iframe.locator('#swReactorPhase').boundingBox(),headerBox=await iframe.locator('#swDashHeader').boundingBox();
    assert.ok(phaseBox.y>=headerBox.y+headerBox.height,'section navigation never hides the scan heading behind the fixed header');
    assert.equal(await page.getByRole('button',{name:'Morning report',exact:true}).getAttribute('aria-current'),'page');
    await page.getByRole('button',{name:'Live activity',exact:true}).click();
    assert.equal(await page.locator('#view-live').isVisible(),true);
    await page.getByRole('button',{name:'Morning report',exact:true}).click();
    assert.equal(await iframe.locator('#swDownloads').isVisible(),true);
    await page.getByRole('button',{name:'Menu',exact:true}).click();
    assert.equal(await page.locator('#menu-modal').isVisible(),true);
    console.log('PASS navigation enters, leaves and returns to the report and opens the existing menu');
    console.log('ALL DESKTOP AND MOBILE NAVIGATION CHECKS PASS');
  }finally{await browser.close();server.close();}
}
main().catch(e=>{console.error(e.stack);server.close();process.exitCode=1;});

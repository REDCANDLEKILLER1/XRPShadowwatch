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
    assert.ok(await page.locator('#morningReportFloat').evaluate(el=>el.classList.contains('mrf-fullscreen')),'desktop reader opens at full usable height');
    assert.ok(await page.locator('#mrfBody').evaluate(el=>el.clientHeight>500),'desktop report has a tall reading area');
    assert.ok(await page.locator('#mrfBody').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'long source links wrap without horizontal scrolling');
    await page.getByRole('button',{name:'Next page',exact:true}).click();await page.waitForTimeout(500);
    assert.ok(await page.locator('#mrfBody').evaluate(el=>el.scrollTop>0),'Next page moves through the report');
    await page.getByRole('button',{name:'Previous page',exact:true}).click();
    await page.keyboard.press('Escape');assert.equal(await page.locator('#morningReportFloat').isVisible(),false);
    console.log('PASS full-height report reader scrolls by page and Escape closes it');
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
    await page.evaluate(()=>window.updateShadowTxProgress({target_wallets:255,indexed_wallets:42,rows_fetched:876,stored_transactions_loaded:12345}));
    await page.waitForTimeout(1200);
    assert.match(await page.locator('#xaiMissionStep').textContent(),/TRANSACTIONS 42\/255 · 876 NEW · 12,345 STORED/);
    assert.ok(parseInt(await page.locator('#xaiMissionPct').textContent(),10)<=58,'transaction phase cannot creep to 98% before its wallets finish');
    await page.evaluate(()=>window.MORNING_REPORT_FLOAT.showFailure('Transaction evidence incomplete: 253/255 wallets proved.',{}));
    assert.equal(await page.getByRole('heading',{name:'REPORT NOT CREATED'}).isVisible(),true);
    assert.equal(await page.getByRole('button',{name:'Rerun scan'}).isVisible(),true);
    assert.equal(await page.getByRole('button',{name:'Download report'}).isVisible(),false);
    assert.equal(await page.locator('#mrfBody').textContent().then(t=>t.includes('Layout fixture')),false);
    await page.keyboard.press('Escape');
    console.log('PASS transaction acquisition and stored-analysis progress are distinct; failures expose only rerun');
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.locator('#swDashRail').isVisible(),false);
    assert.equal(await page.locator('#swDashBottomNav').isVisible(),true);
    assert.match(await page.locator('#xaiMissionStep').textContent(),/876 NEW · 12,345 STORED/);
    assert.equal(await page.locator('#swGauges').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),2,'phone coverage counters have readable separate columns');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1));
    console.log('PASS phone navigation and viewport width are preserved');
    // ── THE PANEL YOU WATCH HAS TO BE ON THE SCREEN YOU ARE LOOKING AT ──────
    // On a phone every row of #swDashMain stacks, so the desktop "prime row-1
    // slot" put LIVE SCAN LOG at y=1013 on a 915px screen — below the fold,
    // under MARKET & NETWORK, LIVE SCAN INSTRUMENTS and the status strip.
    // Through a 17-minute scan the operator saw a bar creeping at the top and
    // never saw the one panel that says what is happening.
    //
    // Measured, not eyeballed: the log's top must be inside the first screen
    // and it must come before the three panels that are only glanced at.
    const phone=await page.evaluate(()=>{
      const box=sel=>{const e=document.querySelector(sel);if(!e)return null;
        const r=e.getBoundingClientRect();return {top:Math.round(r.top+window.scrollY),h:Math.round(r.height)};};
      const g=document.querySelector('.sw-gauge svg');
      return {vh:window.innerHeight,log:box('#swLogPanel'),market:box('#swMarketPanel'),
              instr:box('#swInstruments'),strip:box('.sw-statusstrip'),
              gauge:g?Math.round(g.getBoundingClientRect().width):null};
    });
    assert.ok(phone.log&&phone.market&&phone.instr&&phone.strip,'the phone panels exist to be ordered');
    assert.ok(phone.log.h>120,'the log is tall enough to read: '+phone.log.h);
    assert.ok(phone.log.top+120<phone.vh,
      'LIVE SCAN LOG starts within the first screen (top '+phone.log.top+' of '+phone.vh+')');
    assert.ok(phone.log.top<phone.market.top,'the log comes before MARKET & NETWORK');
    assert.ok(phone.log.top<phone.instr.top,'the log comes before LIVE SCAN INSTRUMENTS');
    assert.ok(phone.log.top<phone.strip.top,'the log comes before the status strip');
    assert.ok(phone.gauge&&phone.gauge<=92,'phone gauges stay small enough to leave room: '+phone.gauge);
    console.log('PASS the live scan log is above the fold on a phone (top '+phone.log.top+' of '+phone.vh+')');
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

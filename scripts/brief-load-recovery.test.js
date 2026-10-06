'use strict';
const assert=require('assert/strict'),fs=require('fs');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({args:['--no-sandbox']});
 try{
 const page=await browser.newPage({viewport:{width:390,height:844}});
 let fail=true,requests=[];
 await page.route('http://viewer.test/**',async route=>{
  const url=route.request().url();
  if(url.includes('/brief-console.html')){
   requests.push(url);
   if(fail)return route.abort('failed');
   return route.fulfill({contentType:'text/html',body:'<button class="sw-hbtn sw-exit">EXIT</button><h1>Report ready</h1>'});
  }
  return route.fulfill({contentType:'text/html',body:'<div><div id="view-brief"><button id="brief-exit">EXIT</button><iframe id="brief-frame"></iframe></div></div>'});
 });
 await page.goto('http://viewer.test/nested/');
 await page.evaluate(()=>{const real=Date.now;window.clockAdvance=0;Date.now=()=>real()+window.clockAdvance;});
 await page.addScriptTag({content:fs.readFileSync('src/js/brief-fullscreen.js','utf8')});
 await page.evaluate(()=>loadBriefConsole());
 await page.waitForTimeout(300);
 assert.equal(requests[0],'http://viewer.test/brief-console.html');
 await page.evaluate(()=>window.clockAdvance=21000);
 await page.getByRole('button',{name:'Retry report console'}).waitFor();
 assert.equal(await page.getByRole('link',{name:'Open report directly'}).getAttribute('href'),'/brief-console.html');
 assert.equal(await page.locator('#brief-exit').isVisible(),true);
 fail=false;
 await page.getByRole('button',{name:'Retry report console'}).click();
 await page.frameLocator('#brief-frame').getByRole('heading',{name:'Report ready'}).waitFor();
 await page.waitForTimeout(350);
 assert.equal(await page.locator('#brief-load-notice').count(),0);
 assert.equal(await page.locator('#brief-exit').isVisible(),false);
 const count=requests.length;
 await page.evaluate(()=>loadBriefConsole());await page.waitForTimeout(300);
 assert.equal(requests.length,count,'healthy report is retained when revisiting');
 console.log('PASS mobile failed frame recovery, direct link, nested route, retry, and healthy viewer retention');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});

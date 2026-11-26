'use strict';
const { spawn } = require('child_process');
const fs=require('fs'),os=require('os'),path=require('path');
const CDP=9377,W=1080,H=545,BASE='https://yugongdashi.cn';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const chrome=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(p=>fs.existsSync(p));
const cdp=async(p,m='GET')=>(await fetch(`http://127.0.0.1:${CDP}${p}`,{method:m})).json();
(async()=>{
  const proc=spawn(chrome,[`--remote-debugging-port=${CDP}`,'--headless=new','--disable-gpu','--no-first-run','--user-data-dir='+path.join(os.tmpdir(),'wb-f-'+Date.now()),`--window-size=${W},${H}`,'about:blank'],{stdio:'ignore'});
  for(let i=0;i<40;i++){try{await cdp('/json/version');break;}catch{await sleep(500);}}
  const t=await cdp('/json/new?about:blank','PUT');
  const ws=new WebSocket(t.webSocketDebuggerUrl);let seq=0;const pend=new Map();
  ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id);}};
  const send=(method,params)=>new Promise(res=>{const id=++seq;pend.set(id,res);ws.send(JSON.stringify({id,method,params:params||{}}));});
  await new Promise(r=>{ws.onopen=r;});
  await send('Page.enable');await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:W,height:H,deviceScaleFactor:1,mobile:false,screenWidth:1920,screenHeight:1080});
  await send('Page.navigate',{url:BASE+'/login'});await sleep(12000);
  await send('Runtime.evaluate',{expression:`(()=>{const ins=[...document.querySelectorAll('input')];const set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};set(ins[0],'admin');set(ins[1],'YgAdmin@2026');document.querySelector('.el-button.submit').click();})()`});
  await sleep(6000);
  await send('Page.navigate',{url:BASE+'/monitor_line'});await sleep(9000);
  const g=await send('Runtime.evaluate',{expression:`JSON.stringify((()=>{const r=e=>{if(!e)return null;const b=e.getBoundingClientRect();return{top:Math.round(b.top),bottom:Math.round(b.bottom),w:Math.round(b.width)}};return{stage:r(document.querySelector('.stage')),tab3:r(document.querySelector('.table-section3')),innerW:innerWidth,innerH:innerHeight,scrollW:document.body.scrollWidth};})())`,returnByValue:true});
  console.log('FINAL',g.result.value);
  const s=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(__dirname,'tmp-final.png'),Buffer.from(s.data,'base64'));
  try{await cdp('/json/close/'+t.id);}catch{} proc.kill(); process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});

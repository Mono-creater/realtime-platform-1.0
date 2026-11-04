// exp_miss_rate.js —— 缓变劣化检出概率（论文 §4.4 补强：漏报侧）
// 口径：σ=1.0 ℃、λ=0.2、W=60 s、rw=2 ℃·min⁻¹、confirmN=2、抑制 120 s；
//       温升从 40 ℃ 起、1 Hz、持续 20 min；prewarmMs=0（最快检出口径）。
// 统计：ROC 通道检出概率、任一通道检出概率、ROC 首警中位时延。
'use strict';
const { AlarmEngine } = require('../alarm-engine.js');
function rng(seed){let s=(seed>>>0)||1;return()=>{s=(Math.imul(s,1103515245)+12345)>>>0;return s/4294967296;};}
function gauss(r){let u=0,v=0;while(u===0)u=r();while(v===0)v=r();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}

const RATES=[1.0,1.5,2.0,2.5,3.0,4.0];
const N=500, DUR=20*60, DT=1000, SIGMA=1.0, T0=40.0;
console.log('温升速率  ROC检出率  任一通道检出率  ROC首警中位时延  ROC首警P90');
for(const rate of RATES){
  let rocHit=0, anyHit=0; const lat=[];
  for(let k=0;k<N;k++){
    const r=rng(70000+Math.round(rate*100)+k*13);
    const eng=new AlarmEngine({sigma:SIGMA,lambda:0.2,windowMin:1.0,confirmN:2,suppressMs:120000,prewarmMs:0,noiseCheck:false});
    let roc=false, any=false, rocT=null;
    for(let t=0;t<=DUR*1000;t+=DT){
      const x=T0+rate*(t/60000)+gauss(r)*SIGMA;
      const out=eng.push({t, temperature:x});
      for(const a of out){
        if(!any){any=true;}
        if(a.source==='roc' && !roc){roc=true; rocT=t/1000;}
      }
      if(roc && any) { /* keep looping to let threshold also fire? no need */ }
    }
    if(roc){rocHit++; lat.push(rocT);}
    if(any) anyHit++;
  }
  lat.sort((a,b)=>a-b);
  const pct=(n)=> lat.length? lat[Math.min(lat.length-1,Math.floor(n*lat.length))].toFixed(0):'—';
  console.log(`${rate.toFixed(1).padStart(4)}    ${(rocHit/N*100).toFixed(1)}%     ${(anyHit/N*100).toFixed(1)}%           ${pct(0.5)} s        ${pct(0.9)} s`);
}

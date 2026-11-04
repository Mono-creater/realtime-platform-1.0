// exp_rul_nonlinear.js —— RUL 线性外推在非线性退化下的误差（论文 §4.5 补强，回应评审）
// 三种退化模型（线性 / 二次加速 / 指数），从 40 ℃ 起、阈值 80 ℃，
// 在 T_obs=20 min 用 [10,20] min 滑窗最小二乘线性拟合估计 β，外推 RUL，与真值对比。
'use strict';
const { linreg } = require('../rul-predictor.js');

function degrade(model, t){ // t 单位 min
  if(model==='linear') return 40 + 0.8*t;
  if(model==='quad')   return 40 + 0.4*t + 0.02*t*t;
  if(model==='exp')    return 40 + 5*(Math.exp(0.06*t)-1);
}
// 真值：达到阈值 80 ℃ 的时刻（数值求根）
function trueT(model){
  let lo=0, hi=400; for(let i=0;i<200;i++){const m=(lo+hi)/2; if(degrade(model,m)<80) lo=m; else hi=m;}
  return (lo+hi)/2;
}
const T_OBS=20, WIN=10, THR=80;
for(const m of ['linear','quad','exp']){
  const ts=[],xs=[];
  for(let t=T_OBS-WIN;t<=T_OBS;t+=0.1){ts.push(t);xs.push(degrade(m,t));}
  const {beta}=linreg(ts,xs);
  const xNow=degrade(m,T_OBS);
  const rulPred=(THR-xNow)/beta;
  const rulTrue=trueT(m)-T_OBS;
  const err=(rulPred-rulTrue)/rulTrue*100;
  console.log(`${m.padEnd(7)} β_lin=${beta.toFixed(4)}  x(20)=${xNow.toFixed(2)}  RUL预测=${rulPred.toFixed(1)} min  真值=${rulTrue.toFixed(1)} min  误差=${err>=0?'+':''}${err.toFixed(1)}%`);
}

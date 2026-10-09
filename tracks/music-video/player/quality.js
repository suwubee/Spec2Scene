// Real-time policy. Capture never instantiates this controller.
export {programCount, programIdentitySet, createCompileMonitor, assertNoQualityRebuild, assertNoNewPrograms} from './compile-monitor.js';
export const PRESETS = Object.freeze({
  high: Object.freeze({scale:1, msaa:0, shadow:2048, particles:1, volumetric:true, reflections:true, dof:true, post:true}),
  medium: Object.freeze({scale:.65, msaa:0, shadow:1024, particles:.5, volumetric:false, reflections:false, dof:false, post:true}),
  low: Object.freeze({scale:.5, msaa:0, shadow:512, particles:.25, volumetric:false, reflections:false, dof:false, post:false}),
});
export function postForQuality(level) {
  const q=PRESETS[level];if(!q)throw new Error('Unknown quality');
  return {dof:{enabled:q.dof},...(!q.post?{grain:{amount:0},bloom:{strength:0},halation:{strength:0},streak:{strength:0}}:{})};
}
export function chooseStartMode(choice, warm) {
  if(choice==='a'||choice==='b')return choice;
  if(choice!=='auto')throw new Error('Unknown start mode');
  return !warm?.done && Number.isFinite(warm?.etaMs) && warm.etaMs<=20000 ? 'b' : 'a';
}
export function percentile(values, fraction=.9) {
  if (!values.length) return null;
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.max(0,Math.ceil(sorted.length*fraction)-1)];
}
export class AdaptiveQuality {
  constructor(choice='auto') { this.history=[]; this.select(choice); }
  select(choice) {
    if (choice!=='auto' && !PRESETS[choice]) throw new Error('Unknown real-time quality');
    this.choice=choice; this.level=choice==='auto'?'medium':choice;
    this.resetSampling(); this.coolUntil=0; this.blocked={};
    return this.level;
  }
  resetSampling() {this.samples=[];this.windowStart=null;this.fastSince=null;}
  sample(ms, now) {
    if (!(ms>0) || !Number.isFinite(ms) || !Number.isFinite(now)) return null;
    this.windowStart ??= now;
    this.samples.push(ms);
    if(now-this.windowStart<2000) return null;
    const p90=percentile(this.samples); this.samples=[]; this.windowStart=now;
    if(this.choice!=='auto' || now<this.coolUntil) return null;
    const levels=['low','medium','high'], index=levels.indexOf(this.level);
    let next=index;
    if(p90>50) { this.fastSince=null; next=Math.max(0,index-1); }
    else if(p90<22) {
      this.fastSince ??= now-2000;
      if(now-this.fastSince>=4000 && now>=(this.blocked[levels[index+1]]||0)) next=Math.min(2,index+1);
    } else this.fastSince=null;
    if(next===index) return null;
    const from=this.level; this.level=levels[next];
    if(next<index) this.blocked[from]=now+30000;
    this.fastSince=null; this.coolUntil=now+3000;
    const change={from,to:this.level,p90,at:now}; this.history.push(change);if(this.history.length>300)this.history.shift();
    return change;
  }
}

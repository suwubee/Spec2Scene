import {createEngine} from '../engine/core/index.js';
import {createClock} from '../engine/audio/index.js';
import {createScenes} from '../sample/scenes.js';
import {world} from './shots.js';
import {createCharacter} from '../character/index.js';
import * as THREE from '../engine/vendor/three.module.js';
const canvas=document.querySelector('canvas'),status=document.querySelector('#status'),slider=document.querySelector('#timeline');
try {
  const shots=await fetch('./sample/shots.json').then(r=>{if(!r.ok)throw new Error('镜头表读取失败');return r.json();});
  const params=new URLSearchParams(location.search),width=Number(params.get('w')||params.get('width'))||1280,height=Number(params.get('h')||params.get('height'))||720;
  if(width<160||width>4096||height<90||height>2160)throw new Error('预览尺寸超出范围');
  const scenes=createScenes();let model,studioState={action:'stand',time:0,angle:0};
  scenes.studio=()=>{const scene=new THREE.Scene();scene.background=new THREE.Color(.09,.09,.09);model=createCharacter({coat:params.get('anatomy')!=='1',scarf:false});scene.add(model.object);
    const floor=new THREE.Mesh(new THREE.PlaneGeometry(40,40),new THREE.MeshStandardMaterial({color:0x666666,roughness:.8}));floor.rotation.x=-Math.PI/2;floor.position.y=-.01;scene.add(floor);
    for(const [p,c,i] of [[[3,5,5],0xffe3c4,2],[[-3,3,3],0xc1d9f0,.5],[[2,4,-3],0xd4e6ff,1.5]]){const l=new THREE.DirectionalLight(c,i);l.position.fromArray(p);scene.add(l);}
    return {scene,update(){const {action,time,angle}=studioState;model.object.rotation.y=angle;model.update(action,time,{distance:action==='walk'||action==='windWalk'?time*.38:undefined});const p=model.rig.root.position;model.object.position.set(-p.z*Math.sin(angle),0,-p.z*Math.cos(angle));}};};
  const engine=await createEngine({canvas,shots,scenes,world,width,height,quality:params.get('quality')||'auto'}),originalSeek=engine.seek;
  engine.seek=async(t,o)=>{const s=await originalSeek(t,o);slider.value=s.t;status.textContent=`${s.t.toFixed(2)} / 60 秒 · ${s.t<30?'雪夜旷野':'雨夜站台'} · 静音预览`;return s;};
  window.__scene=engine;engine.engine=engine;engine.info=()=>engine.inspect();window.__mv=engine;
  const clock=createClock({duration:60});let frame=0,busy=false;
  const play=document.querySelector('#play');
  const tick=async now=>{if(clock.playing&&!busy){busy=true;try{await engine.seek(clock.time(now));}finally{busy=false;}if(clock.time(now)>=60){clock.pause(now);play.textContent='播放';}}frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);
  play.addEventListener('click',async()=>{if(clock.playing){clock.pause(performance.now());play.textContent='播放';}else{if(clock.time(performance.now())>=60)clock.seek(0,performance.now());await clock.play(performance.now());play.textContent='暂停';}});
  slider.addEventListener('input',()=>{clock.seek(Number(slider.value),performance.now());engine.seek(Number(slider.value));});
  document.querySelector('#restart').addEventListener('click',()=>{clock.seek(0,performance.now());engine.seek(0);});
  engine.characterFrame=async(action,t,angle=0)=>{clock.pause(performance.now());studioState={action,time:t,angle};const shot={id:'studio',set:'studio',start:0,end:60,t0:0,t1:60,position:[[0,[0,1.15,4.6]]],target:[[0,[0,.95,0]]],focal:[[0,20]],focus:[[0,4.6]],fstop:[[0,8]]};await engine.seek(t,{layers:[{shot,tLocal:t,weight:1,gain:1,fade:1}]});};
  await engine.seek(Number(params.get('t'))||0);window.addEventListener('pagehide',()=>{cancelAnimationFrame(frame);engine.dispose();});
} catch(error){status.textContent=`无法初始化三维画面：${error.message}`;console.error(error);window.__sceneError=error.stack;}

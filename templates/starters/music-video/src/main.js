import {createEngine} from '../engine/core/index.js';
import {createClock} from '../engine/audio/index.js';
import {createScenes} from '../sample/scenes.js';
import {world} from './shots.js';
import {createCharacter} from '../character/index.js';
import * as THREE from '../engine/vendor/three.module.js';
import {lightRig} from '../engine/materials/index.js';
const canvas=document.querySelector('canvas'),status=document.querySelector('#status'),slider=document.querySelector('#timeline');
try {
  const shots=await fetch('./sample/shots.json').then(r=>{if(!r.ok)throw new Error('镜头表读取失败');return r.json();});
  const params=new URLSearchParams(location.search), width=Number(params.get('width'))||1280,height=Number(params.get('height'))||720;
  if(width<160||width>1920||height<90||height>1080)throw new Error('预览尺寸超出范围');
  const scenes=createScenes(),engine=createEngine({canvas,shots,scenes,world,width,height});
  const originalSeek=engine.seek;
  engine.seek=t=>{const s=originalSeek(t);slider.value=s.t;status.textContent=`${s.t.toFixed(2)} / 60 秒 · ${s.t<30?'雪夜旷野':'雨夜站台'} · 静音时间轴`;return s;};
  window.__scene=engine;
  const clock=createClock({duration:60});let frame=0;
  const play=document.querySelector('#play');
  const tick=now=>{if(clock.playing){engine.seek(clock.time(now));if(clock.time(now)>=60){clock.pause(now);play.textContent='播放';}}frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);
  play.addEventListener('click',async()=>{if(clock.playing){clock.pause(performance.now());play.textContent='播放';}else{if(clock.time(performance.now())>=60)clock.seek(0,performance.now());await clock.play(performance.now());play.textContent='暂停';}});
  slider.addEventListener('input',()=>{clock.seek(Number(slider.value),performance.now());engine.seek(Number(slider.value));});
  document.querySelector('#restart').addEventListener('click',()=>{clock.seek(0,performance.now());engine.seek(0);});
  // Evidence mode renders the exact same rig and material library with a neutral three-light turntable.
  const studio=new THREE.Scene();studio.background=new THREE.Color(0x172733);studio.fog=new THREE.Fog(0x172733,8,20);
  const model=createCharacter({coat:params.get('anatomy')!=='1',scarf:false});studio.add(model.object);
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(40,40),new THREE.MeshStandardMaterial({color:0x46545e,roughness:.8}));floor.rotation.x=-Math.PI/2;floor.position.y=-.01;studio.add(floor);
  lightRig(studio,{position:[-3,5,5],intensity:3,fill:.8});const edge=new THREE.DirectionalLight(0x91c6e9,2);edge.position.set(2,4,-3);studio.add(edge);
  engine.characterFrame=(action,t,angle=0)=>{clock.pause(performance.now());model.object.rotation.y=angle;model.update(action,t,{distance:action==='walk'||action==='windWalk'?t*.38:undefined});
    const position=model.rig.root.position;model.object.position.z=-position.z*Math.cos(angle);model.object.position.x=-position.z*Math.sin(angle);
    engine.camera.position.set(0,1.15,4.6);engine.camera.lookAt(0,.95,0);engine.camera.fov=29;engine.camera.updateProjectionMatrix();
    engine.renderer.setRenderTarget(engine.post.a);engine.renderer.render(studio,engine.camera);engine.post.render({lens:{focal:46,focus:4.6,fstop:8},t});};
  engine.seek(0);window.addEventListener('pagehide',()=>{cancelAnimationFrame(frame);engine.dispose();});
} catch(error){status.textContent=`无法初始化三维画面：${error.message}`;console.error(error);}

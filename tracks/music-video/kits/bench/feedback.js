import * as THREE from '../../engine/vendor/three.module.js';
import {createApartment} from '../apartment.js';
import {createPottedPlant,createFoldedPaper} from '../close-props.js';
import {createGlassReflection} from '../../engine/glass.js';
import {continuousHeightfield} from '../heightfield.js';
import {footprintField} from '../../engine/traces/index.js';
import {createCharacter} from '../../character/index.js';
import {inspectRig} from '../../character/rig.js';
import {resolveQuality} from '../../engine/core/quality.js';
import {createLyrics} from '../../engine/lyrics.js';
import {box} from '../common.js';
const q=new URLSearchParams(location.search),mode=q.get('mode')||'apartment',canvas=document.querySelector('canvas'),W=+(q.get('w')||960),H=+(q.get('h')||640);
try{
 const renderer=new THREE.WebGLRenderer({canvas,antialias:true,preserveDrawingBuffer:true});renderer.setSize(W,H,false);renderer.setPixelRatio(1);renderer.setClearColor(0x182630);renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.25;renderer.shadowMap.enabled=true;
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(42,W/H,.02,2000),light=new THREE.DirectionalLight(0xc3e0ff,3.5);light.position.set(-3,8,5);scene.add(light,new THREE.HemisphereLight(0xbad4ed,0x4b4540,2));
 light.castShadow=true;light.shadow.normalBias=.012;light.shadow.bias=-.0001;light.shadow.mapSize.set(1024,1024);Object.assign(light.shadow.camera,{left:-10,right:10,top:15,bottom:-10});
 const floor=box([80,.1,80],new THREE.MeshStandardMaterial({color:0x405765,roughness:.8}),[0,-.06,0]);scene.add(floor);
 let update=()=>{},inspect=()=>({}),cleanup=()=>{},target=new THREE.Vector3(0,1,0);camera.position.set(3,2.5,5);
 if(mode==='apartment'){
  const kit=createApartment({floors:5,columns:4,windows:{'2:1':{offAt:6},'3:2':{offAt:8}}});scene.add(kit.object);camera.position.set(16,12,23);target.set(0,7,0);update=t=>kit.update(t);inspect=()=>({windows:kit.lights.length,brightness:kit.lights.find(l=>l.id==='2:1').pane.material.emissiveIntensity});cleanup=kit.dispose;
 }else if(mode==='props'){
  const plant=createPottedPlant({height:.48}),paper=createFoldedPaper({size:.34,waterHeight:()=>.04});plant.object.position.x=-.4;scene.add(plant.object,paper.object);
  const water=box([.9,.05,.65],new THREE.MeshPhysicalMaterial({color:0x4c7a8b,metalness:.45,roughness:.12,clearcoat:1}),[.4,0,0]);scene.add(water);
  camera.position.set(1.3,1.05,1.6);target.set(0,.32,0);update=t=>{plant.update(t,{growth:Math.min(1,.4+t*.1),unfurl:Math.min(1,t/4),wind:.2});paper.update(t,{fold:Math.min(1,t/4),x:.4});};inspect=()=>({leaves:plant.leafGroups.length});cleanup=()=>{plant.dispose();paper.dispose();};
 }else if(mode==='glass'){
  const glass=createGlassReflection({width:2.7,height:2,resolution:512,opacity:.65});glass.object.position.y=1.3;glass.object.rotation.y=.15;scene.add(glass.object);
  scene.add(box([3,.12,.14],new THREE.MeshStandardMaterial({color:0xa5b3bc}),[0,.23,0]),box([3,.12,.14],new THREE.MeshStandardMaterial({color:0xa5b3bc}),[0,2.37,0]));
  const ball=new THREE.Mesh(new THREE.SphereGeometry(.32,32,24),new THREE.MeshStandardMaterial({color:0xd35d35,roughness:.28}));ball.position.set(-.8,1.1,1.6);scene.add(ball);camera.position.set(3.1,2.1,5);target.set(0,1.1,.3);
  update=t=>{ball.position.x=-.8+Math.sin(t*.5)*.25;glass.update(renderer,scene,camera);};inspect=()=>({reflectionSize:glass.target.width});cleanup=glass.dispose;
 }else if(mode==='snow'){
  const field=footprintField({path:[[0,0,2],[.9,0,0],[-.7,0,-2],[.5,0,-5]],count:20,startTime:0,speed:.7,fillAfter:12,fillDuration:5});
  const surface=continuousHeightfield({x:{min:-15,max:15,nearMin:-2,nearMax:2,step:.035},z:{min:-30,max:15,nearMin:-6,nearMax:3,step:.04},height:(x,z,t)=>.05+.025*Math.sin(x*.8)*Math.cos(z*.6)+field.height(x,z,t)});
  const snow=new THREE.Mesh(surface.geometry,new THREE.MeshPhysicalMaterial({color:0xbbd4e5,roughness:.65,clearcoat:.2}));snow.receiveShadow=true;scene.add(snow);camera.position.set(3.4,5.5,4.5);target.set(0,0,-1.3);light.position.set(-4,2,-5);update=t=>surface.update(t);inspect=()=>({marks:field.marks.length});cleanup=()=>surface.geometry.dispose();
 }else if(mode==='character'){
  const action=q.get('action')||'sit',actor=createCharacter({body:'feminine',coatStyle:'short',scarf:false,hairStyle:'bun'});scene.add(actor.object);let pose;
  if(action==='sit')scene.add(box([.6,.44,.6],new THREE.MeshStandardMaterial({color:0x796c5c}),[0,.22,-.4]));
  if(action==='lie'){scene.add(box([.8,.1,2.1],new THREE.MeshStandardMaterial({color:0x647d89}),[0,.045,-.85]));camera.position.set(2,1.8,1.8);target.set(0,.35,-.95);}
  else if(action==='shout'){camera.position.set(0,1.59,1.05);target.set(0,1.53,0);}
  else{camera.position.set(0,1.5,3.5);target.set(0,.85,0);}
  if(q.get('view')==='side'){const d=camera.position.distanceTo(target);camera.position.copy(target).add(new THREE.Vector3(d,.12,0));}
  update=t=>{const options={jawOpen:action==='shout'?Math.sin(t*.7)**2*.95:0};if(action==='contact')options.handTargets={L:[.25,1.08,.37]};pose=actor.update(['shout','contact'].includes(action)?'stand':action,t,options);};inspect=()=>({action,anatomy:inspectRig(actor.rig,pose),ik:pose.ik||[]});
 }else if(mode==='lyrics'){
  const alignment={lines:[{id:'1',text:'la le li lo',start:1,end:4,locked:true,words:[0,1,2,3].map(i=>({text:['la','le','li','lo'][i],offset:i*3,length:2,start:1+i*.65,end:1+(i+1)*.65}))},{id:'2',text:'hidden candidate',start:6,end:9,locked:false,words:[]}]};
  const layer=createLyrics({width:W,height:H,pictureHeight:H,song:alignment,config:{fontFamily:'serif',lead:0,direction:q.get('direction')||'horizontal',bottom:{place:'picture',size:70},vertical:{x:.85,y:.16,size:60}}});
  layer.canvas.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none';document.body.append(layer.canvas);let box;
  update=t=>{box=layer.draw(t);};inspect=()=>({box,alphaPixels:layer.canvas.getContext('2d').getImageData(0,0,W,H).data.reduce((s,v,i)=>s+(i%4===3&&v>0?1:0),0)});cleanup=()=>layer.dispose();
 }
 camera.lookAt(target);camera.updateMatrixWorld(true);
 const quality=resolveQuality(q.get('quality')||'high',renderer.getContext());
 async function seek(t){if(!Number.isFinite(t))throw new Error('finite time required');update(t);renderer.render(scene,camera);return inspect();}
 window.__scene={ready:true,canvas,seek,inspect:()=>({...inspect(),quality}),capture:()=>canvas.toDataURL('image/png')};await seek(4);
 document.querySelector('output').textContent=`${mode} · 通用构件复验`;window.addEventListener('pagehide',()=>{cleanup();renderer.dispose();});
}catch(e){window.__sceneError=e.stack;console.error(e);document.querySelector('output').textContent=e.message;}

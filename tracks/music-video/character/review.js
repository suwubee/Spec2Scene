import * as THREE from '../engine/vendor/three.module.js';
import {createCharacter} from './index.js';
import {actions} from './motion.js';
import {inspectRig} from './rig.js';
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
renderer.setPixelRatio(1);renderer.setSize(600,800);renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
document.body.append(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color(0x858585);
const camera=new THREE.PerspectiveCamera(32,600/800,.01,80),ambient=new THREE.HemisphereLight(0xffffff,0x57524e,1.0);scene.add(ambient);
const studioLights=[];
for(const [color,intensity,position] of [[0xffeadb,3,[3,4,5]],[0xdbeaff,1.4,[-4,2,3]],[0xffffff,2,[-2,4,-4]]]){
 const light=new THREE.DirectionalLight(color,intensity);light.position.set(...position);scene.add(light,light.target);studioLights.push({light,position,intensity});
 if(position[0]===3){light.castShadow=true;light.shadow.mapSize.set(1024,1024);Object.assign(light.shadow.camera,{left:-3,right:3,top:3,bottom:-3,near:.1,far:20});light.shadow.normalBias=.003;}
}
const floor=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshStandardMaterial({color:0x858585,roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.y=-.002;floor.receiveShadow=true;scene.add(floor);
const drifts=new THREE.Group();scene.add(drifts);
for(let i=0;i<9;i++){const drift=new THREE.Mesh(new THREE.SphereGeometry(1,32,12),new THREE.MeshStandardMaterial({color:0xd5e0e6,roughness:1}));drift.scale.set(1.3+i*.12,.07+(i%3)*.035,.45);drift.position.set((i%3-1)*2.8,.008,-1.4-Math.floor(i/3)*1.8);drift.receiveShadow=true;drifts.add(drift);}
const actors=new Map();let current,playing=false,start=0;
function frame({action='stand',t=1,angle=0,coat=true,body='feminine',coatStyle='long',hairStyle=body==='feminine'?'shoulder':'short',prop='none',detail='body',handPose,handView='palm',stage='studio',distance:shotDistance='medium',wind=.22,width=600,height=800}={}){
 for(const a of actors.values())a.object.visible=false;
 const key=`${body}-${coat}-${coatStyle}-${hairStyle}`;
 if(!actors.has(key)){
  // Audit stays bounded: only three complete actor geometries live at once.
  if(actors.size>=3){const [oldKey,old]=actors.entries().next().value;old.object.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});scene.remove(old.object);actors.delete(oldKey);}
  const a=createCharacter({coat,scarf:coat,body,coatStyle,hairStyle});scene.add(a.object);actors.set(key,a);
 }
 const actor=actors.get(key);current=actor;actor.object.visible=true;actor.object.position.set(0,0,0);actor.object.rotation.y=angle;
 const actionProp={lanternWalk:'lantern',bagWalk:'bag',holdCup:'cup',phone:'phone'}[action];
 const pose=actor.update(action,t,{handPose,prop:prop==='none'&&actionProp?actionProp:prop,wind});
 if(detail==='hand'){actor.rig.limbs.Larm.upper.rotation.z=.78;actor.rig.root.updateMatrixWorld(true);}
 const offset=actor.rig.root.position.clone().multiplyScalar(actor.object.scale.x).applyAxisAngle(new THREE.Vector3(0,1,0),angle);actor.object.position.sub(offset);actor.object.updateMatrixWorld(true);actor.skeleton.update();
 const snow=stage==='snow';scene.background.set(snow?0xa8bdcf:0x858585);floor.material.color.set(snow?0xd4dfe7:0x858585);floor.material.emissive.set(snow?0x687683:0);floor.material.emissiveIntensity=snow?.8:0;drifts.visible=snow;ambient.intensity=snow?.13:1;
 let target=new THREE.Vector3(0,.87,0),distance=3.75;
 if(detail==='face'){target=actor.head.getWorldPosition(new THREE.Vector3());target.y-=.015;distance=.68;}
 if(detail==='hand'){target=actor.rig.limbs.Larm.tip.localToWorld(new THREE.Vector3(0,-.072,0));distance=.36;}
 if(detail==='shoe'){target=actor.rig.limbs.Lleg.tip.localToWorld(new THREE.Vector3(0,.020,.045));distance=.95;}
 if(snow){distance=shotDistance==='far'?7.6:4.6;target.y=.79;}
 renderer.setSize(width,height);camera.aspect=width/height;camera.fov=32;
 camera.position.copy(target).add(new THREE.Vector3(0,snow?-.55:detail==='body'?.08:0,distance));
 if(detail==='hand'){const q=actor.rig.limbs.Larm.tip.getWorldQuaternion(new THREE.Quaternion());camera.position.copy(target).add(new THREE.Vector3(handView==='side'?1:0,0,handView==='side'?0:1).applyQuaternion(q).multiplyScalar(distance));camera.up.set(0,1,0).applyQuaternion(q);}else camera.up.set(0,1,0);
 camera.lookAt(target);camera.updateProjectionMatrix();
 for(const [i,{light,position,intensity}] of studioLights.entries()){
  light.intensity=snow?[4,.20,.65][i]:intensity;
  light.position.copy(snow?new THREE.Vector3(...[[-3,1.5,-6],[4,2,0],[-5,.9,-1]][i]):new THREE.Vector3(...position).applyQuaternion(camera.quaternion).add(target));light.target.position.copy(target);
 }
 renderer.info.reset();renderer.render(scene,camera);
 return {anatomy:inspectRig(actor.rig,pose),calls:renderer.info.render.calls,triangles:renderer.info.render.triangles};
}
const controls={};for(const id of ['action','time','view','coat','body','hair','prop','stage'])controls[id]=document.querySelector('#'+id);
for(const name of actions){const option=document.createElement('option');option.value=option.textContent=name;controls.action.append(option);}
const options=()=>({action:controls.action.value,t:Number(controls.time.value),angle:Number(controls.view.value),coat:controls.coat.value!=='none',coatStyle:controls.coat.value==='none'?'long':controls.coat.value,body:controls.body.value,hairStyle:controls.hair.value,prop:controls.prop.value,stage:controls.stage.value});
for(const el of Object.values(controls))el.addEventListener('input',()=>{playing=false;frame(options());});
document.querySelector('#play').onclick=()=>{playing=!playing;start=performance.now()-Number(controls.time.value)*1000;if(playing)requestAnimationFrame(tick);};
function tick(now){if(!playing)return;controls.time.value=((now-start)/1000)%8;frame(options());requestAnimationFrame(tick);}
window.__characterReview={ready:true,frame,capture:()=>renderer.domElement.toDataURL('image/png'),renderer,scene,get actor(){return current;}};frame();

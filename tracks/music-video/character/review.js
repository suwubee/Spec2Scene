import * as THREE from '../engine/vendor/three.module.js';
import {createCharacter} from './index.js';
import {actions} from './motion.js';
import {inspectRig} from './rig.js';
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
renderer.setPixelRatio(1);renderer.setSize(600,800);renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
document.body.append(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color(0x858585);
const camera=new THREE.PerspectiveCamera(32,600/800,.01,50);
scene.add(new THREE.HemisphereLight(0xffffff,0x57524e,1.0));
const studioLights=[];
for(const [color,intensity,position] of [[0xffeadb,3,[3,4,5]],[0xdbeaff,1.4,[-4,2,3]],[0xffffff,2,[-2,4,-4]]]){
 const light=new THREE.DirectionalLight(color,intensity);light.position.set(...position);scene.add(light,light.target);studioLights.push({light,position});
 if(position[0]===3){light.castShadow=true;light.shadow.mapSize.set(1024,1024);Object.assign(light.shadow.camera,{left:-2,right:2,top:3,bottom:-1,near:.1,far:12});light.shadow.normalBias=.003;}
}
const floor=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshStandardMaterial({color:0x858585,roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.y=-.002;floor.receiveShadow=true;scene.add(floor);
const actors=new Map();let current,playing=false,start=0;
function frame({action='stand',t=1,angle=0,coat=true,body='masculine',detail='body',handPose,handView='palm',width=600,height=800}={}){
 for(const a of actors.values())a.object.visible=false;
 const key=`${body}-${coat}`;if(!actors.has(key)){const a=createCharacter({coat,scarf:coat,body});scene.add(a.object);actors.set(key,a);}
 const actor=actors.get(key);current=actor;actor.object.visible=true;actor.object.position.set(0,0,0);actor.object.rotation.y=angle;
 const pose=actor.update(action,t,{handPose});
 if(detail==='hand'){actor.rig.limbs.Larm.upper.rotation.z=.78;actor.rig.root.updateMatrixWorld(true);}
 const offset=actor.rig.root.position.clone().multiplyScalar(actor.object.scale.x).applyAxisAngle(new THREE.Vector3(0,1,0),angle);actor.object.position.sub(offset);actor.object.updateMatrixWorld(true);actor.skeleton.update();
 let target=new THREE.Vector3(0,.91,0),distance=3.75;
 if(detail==='face'){target=actor.head.getWorldPosition(new THREE.Vector3());target.y+=.005;distance=.66;}
 if(detail==='hand'){target=actor.rig.limbs.Larm.tip.localToWorld(new THREE.Vector3(0,-.075,0));distance=.43;}
 renderer.setSize(width,height);camera.aspect=width/height;camera.fov=32;camera.position.copy(target).add(new THREE.Vector3(0,detail==='body'?.08:0,distance));if(detail==='hand'){const q=actor.rig.limbs.Larm.tip.getWorldQuaternion(new THREE.Quaternion());camera.position.copy(target).add(new THREE.Vector3(handView==='side'?1:0,0,handView==='side'?0:1).applyQuaternion(q).multiplyScalar(distance));camera.up.set(0,1,0).applyQuaternion(q);}else camera.up.set(0,1,0);camera.lookAt(target);camera.updateProjectionMatrix();
 for(const {light,position} of studioLights){light.position.copy(new THREE.Vector3(...position).applyQuaternion(camera.quaternion).add(target));light.target.position.copy(target);}
 renderer.info.reset();renderer.render(scene,camera);
 return {anatomy:inspectRig(actor.rig,pose),calls:renderer.info.render.calls,triangles:renderer.info.render.triangles};
}
const action=document.querySelector('#action'),time=document.querySelector('#time'),view=document.querySelector('#view'),coat=document.querySelector('#coat');
for(const name of actions){const option=document.createElement('option');option.value=option.textContent=name;action.append(option);}
const controls=()=>({action:action.value,t:Number(time.value),angle:Number(view.value),coat:coat.checked});
for(const el of [action,time,view,coat])el.addEventListener('input',()=>{playing=false;frame(controls());});
document.querySelector('#play').onclick=()=>{playing=!playing;start=performance.now()-Number(time.value)*1000;if(playing)requestAnimationFrame(tick);};
function tick(now){if(!playing)return;time.value=((now-start)/1000)%8;frame(controls());requestAnimationFrame(tick);}
window.__characterReview={ready:true,frame,capture:()=>renderer.domElement.toDataURL('image/png'),renderer,scene,get actor(){return current;}};frame();

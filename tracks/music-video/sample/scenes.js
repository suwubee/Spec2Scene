import * as THREE from '../engine/vendor/three.module.js';
import {terrain,box,skyline,vegetation} from '../engine/landscape/index.js';
import {material,lightRig,windowLight} from '../engine/materials/index.js';
import {sky,precipitation,lightVolume} from '../engine/atmos/index.js';
import {footprints} from '../engine/traces/index.js';
import {hash} from '../engine/core/math.js';
import {createCharacter} from '../character/index.js';
function snowHeight(x,z){
  const ridge=6+Math.pow(Math.sin(x*.023+.7),2)*15+Math.pow(Math.sin(x*.059),2)*7;
  const envelope=Math.exp(-Math.pow((z+100+Math.sin(x*.025)*18)/23,2));
  const far=Math.exp(-Math.pow((z+164)/31,2))*(9+Math.pow(Math.sin(x*.032+2),2)*23);
  const detail=Math.sin(x*.37+z*.13)*Math.sin(z*.23)*.7;
  const edges=Math.min(1,Math.max(0,Math.abs(x)-3)/10);
  return envelope*(ridge+detail)+far+edges*(Math.sin(x*.18+z*.055)*.65+Math.sin(z*.2)*.2)-.02;
}
function snowScene(){
  const scene=new THREE.Scene();scene.fog=new THREE.FogExp2(0x294252,.010);scene.add(sky());
  const ground=terrain({size:380,segments:240,height:snowHeight});scene.add(ground);
  const traces=footprints({count:84,step:.45,start:[0,-.02,16],birth:i=>(i*.45-24)/.14});scene.add(traces.object);
  const character=createCharacter({scarf:true,hat:true});scene.add(character.object);character.object.position.set(-.55,0,-8);character.object.rotation.y=Math.PI;
  const key=lightRig(scene,{position:[-30,38,-35],intensity:1.2,fill:.38});
  const rim=new THREE.DirectionalLight(0x9dbddd,.18);rim.position.set(8,3,12);scene.add(rim);
  const snow=precipitation({count:700,spread:75,height:20});scene.add(snow.object);

  scene.traverse(o=>{if(o.isMesh&&!o.material.transparent){o.castShadow=true;o.receiveShadow=true;}});
  return {scene,character,update(t,w){scene.fog.density=w.fog;key.intensity=1.2*w.light;character.update('walk',t,{speed:.14});traces.update(t);snow.update(t,w.wind*.3);}};
}
function stationScene(){
  const scene=new THREE.Scene();scene.background=new THREE.Color(0x07101c);scene.fog=new THREE.FogExp2(0x152a36,.025);
  const wet=material('stone',{color:0x263b44,roughness:.24,metalness:.55});
  scene.add(terrain({size:130,segments:1,height:()=>-.04,mat:wet}));scene.add(skyline({seed:43}));
  const concrete=material('stone',{color:0x283b43,roughness:.8}),metal=material('metal',{color:0x273a42});
  box(scene,[4.7,.16,32],[-2.9,.015,-7],concrete);
  box(scene,[.11,.016,32],[-.46,.108,-7],material('stone',{color:0x9e8450}));
  // Receding rails and tactile edge give the space a readable vanishing point.
  for(const x of [2.4,3.8])box(scene,[.06,.07,90],[x,-.005,-23],metal);
  for(let i=0;i<48;i++)box(scene,[2,.04,.20],[3.1,-.023,12-i*1.2],concrete);
  for(let i=0;i<30;i++){box(scene,[4.5,.006,.022],[-2.8,.1,7-i],metal);}
  box(scene,[5.7,.16,31],[-3.05,4.25,-6.8],metal);
  for(let i=0;i<5;i++){
    const z=5-i*6;box(scene,[.16,4.25,.18],[-4.65,2.12,z],metal);box(scene,[4.8,.12,.13],[-2.8,4.04,z],metal);
    const lamp=new THREE.Mesh(new THREE.BoxGeometry(.8,.035,.18),new THREE.MeshBasicMaterial({color:new THREE.Color(3.8,2.35,1.1)}));lamp.position.set(-2.4,4.06,z-1);scene.add(lamp);
    windowLight(scene,[-2.4,3.85,z-1],0xffc381,30);
    scene.add(lightVolume({position:[-2.4,4,z-1],height:3.9,radius:2.1,density:.095,color:0xffba74}));
    // Procedural wet reflection, interrupted by ripples. No texture or environment image.
    const reflection=new THREE.Mesh(new THREE.PlaneGeometry(2.2,4.5),new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
      uniforms:{seed:{value:i}},vertexShader:'varying vec2 p;void main(){p=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader:'varying vec2 p;uniform float seed;void main(){float x=(p.x-.5)*2.;float s=pow(max(0.,1.-abs(x)),5.)*sin(p.y*110.+sin(p.x*80.+seed)*3.);float a=max(0.,s)*sin(p.y*3.14159)*.22;gl_FragColor=vec4(vec3(.9,.5,.18)*a,a);}' }));reflection.rotation.x=-Math.PI/2;reflection.position.set(-2.4,.112,z-.1);scene.add(reflection);
  }
  // Empty seat is the recurring absence motif; character need not mime an emotion.
  const wood=material('wood',{color:0x5c4b3a});
  for(let i=0;i<4;i++)box(scene,[1.9,.055,.09],[-3.5,.56,-.8+i*.12],wood);
  for(let i=0;i<3;i++)box(scene,[1.9,.08,.055],[-3.5,.83+i*.12,-.91],wood);
  for(const x of [-4.15,-2.85])box(scene,[.055,.56,.55],[x,.29,-.6],metal);
  const glass=material('glass',{opacity:.07,transmission:0,metalness:.1});box(scene,[.035,2.8,4.5],[-4.8,1.5,-3.5],glass);
  const character=createCharacter({scarf:true,backpack:false,hat:true});character.object.position.set(-1.18,.105,.2);scene.add(character.object);
  const key=lightRig(scene,{position:[6,9,-12],color:0x85bfe3,intensity:1.1,fill:.45});windowLight(scene,[1,2.3,3.8],0x7ca3b4,1.7);
  const rain=precipitation({kind:'rain',count:2400,spread:48,height:15,wind:.5});scene.add(rain.object);
  const ripples=new THREE.Group();const ringMat=new THREE.MeshBasicMaterial({color:0x7696a7,transparent:true,opacity:.12,depthWrite:false});
  for(let i=0;i<60;i++){const ring=new THREE.Mesh(new THREE.RingGeometry(.15,.16,24),ringMat);ring.rotation.x=-Math.PI/2;ring.position.set(hash(i*2,6)*15-6,.113,hash(i*2+1,6)*22-8);ripples.add(ring);}scene.add(ripples);
  scene.traverse(o=>{if(o.isMesh&&!o.material.transparent){o.castShadow=true;o.receiveShadow=true;}});
  return {scene,character,update(t,w){scene.fog.density=w.fog;key.intensity=1.1*w.light;const local=t-30;character.update(local<12?'stand':'turn',Math.max(0,local-12),{yaw:-1.35});rain.update(t,w.wind);ripples.children.forEach((m,i)=>m.scale.setScalar(((t*.7+i*.137)%1)*2+.05));}};
}
export function createScenes(){return {snow:snowScene(),station:stationScene()};}

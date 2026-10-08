import * as THREE from '../vendor/three.module.js';
import {smooth} from '../core/math.js';
import {pathFootsteps} from './path.js';
export {pathFootsteps} from './path.js';
export function footprintState(time,birth,fade=240){return {visible:time>=birth,strength:smooth((time-birth)/.5)*(1-smooth((time-birth-fade)/20))};}
export function footprints({count=52,step=.45,start=[0,0,15],direction=-1,surface='snow',birth=i=>i*.75-35,path=null,speed=.38,fillAfter=240}={}) {
  const group=new THREE.Group(),marks=[];
  const dark=new THREE.MeshStandardMaterial({color:surface==='sand'?0x6c6250:0x60869c,roughness:.85});
  const steps=pathFootsteps({path,count,step,start,speed,birth});
  for(let i=0;i<steps.length;i++) {
    const m=steps[i],mark=new THREE.Group();
    mark.position.set(m.x,m.y+.013,path?m.z:start[2]+direction*(start[2]-m.z));mark.rotation.y=m.yaw;
    const rim=new THREE.Mesh(new THREE.RingGeometry(.080,.108,18),dark);rim.rotation.x=-Math.PI/2;rim.scale.set(1,1.65,1);mark.add(rim);
    const bowl=new THREE.Mesh(new THREE.SphereGeometry(.081,24,10,0,Math.PI*2,Math.PI/2,Math.PI/2),new THREE.MeshStandardMaterial({color:0x91b6d7,emissive:0x6fabe3,emissiveIntensity:.5,roughness:.16,metalness:.35,side:THREE.BackSide}));
    bowl.scale.set(1,.13,1.65);bowl.position.y=0;mark.add(bowl);
    const heel=new THREE.Mesh(new THREE.SphereGeometry(.05,12,8),dark);heel.scale.set(.8,.04,.9);heel.position.set(0,-.004,-.13);mark.add(heel);
    group.add(mark);marks.push({mark,bowl,birth:m.birth});
  }
  return {object:group,update(t){for(const {mark,bowl,birth} of marks){const s=footprintState(t,birth,fillAfter);mark.visible=s.visible&&s.strength>0;mark.scale.y=Math.max(.001,s.strength);bowl.material.emissiveIntensity=s.strength*.45;}}};
}
export function afterglow(t,extinguished,halfLife=2){return Math.pow(.5,Math.max(0,t-extinguished)/halfLife);}
export function vapor({count=12}={}) {
  const group=new THREE.Group(),mat=new THREE.MeshBasicMaterial({color:0xc3d5df,transparent:true,opacity:.025,depthWrite:false});
  for(let i=0;i<count;i++)group.add(new THREE.Mesh(new THREE.SphereGeometry(.1,8,6),mat));
  return {object:group,update(t){group.children.forEach((m,i)=>{const u=((t*.3+i/count)%1+1)%1;m.position.set(Math.sin(i+t)*u*.12,u*.6,0);m.scale.setScalar(.4+u*2);});}};
}

/** Ground-space footprint field. Negative centre + raised, irregular lip; no emissive decal. */
export function footprintField({depth=.085,width=.105,length=.19,fillAfter=240,fillDuration=20,...pathOptions}={}) {
  if(![depth,width,length,fillAfter,fillDuration].every(Number.isFinite)||depth<=0||width<=0||length<=0||fillAfter<0||fillDuration<=0)throw new Error('invalid footprint field');
  const marks=pathFootsteps(pathOptions),bins=new Map(),cell=Math.max(width,length)*4;
  const key=(x,z)=>`${Math.floor(x/cell)},${Math.floor(z/cell)}`;
  marks.forEach(m=>{const k=key(m.x,m.z);if(!bins.has(k))bins.set(k,[]);bins.get(k).push(m);});
  const strength=(m,t)=>t<m.birth?0:smooth((t-m.birth)/.12)*(1-smooth((t-m.birth-fillAfter)/fillDuration));
  return {marks,depth,strength,height(x,z,t=0){let h=0;
    const ix=Math.floor(x/cell),iz=Math.floor(z/cell);
    for(let j=iz-1;j<=iz+1;j++)for(let i=ix-1;i<=ix+1;i++)for(const m of bins.get(`${i},${j}`)||[]){
      const amount=strength(m,t);if(!amount)continue;
      const dx=x-m.x,dz=z-m.z,c=Math.cos(m.yaw),s=Math.sin(m.yaw),u=(dx*c-dz*s)/width,v=(dx*s+dz*c)/length;
      // Rounded forefoot, narrow waist, distinct heel; normals and physical snow receive moonlight.
      const fore=Math.hypot(u/(.82+.13*Math.max(0,v)),(v-.28)/.73),heel=Math.hypot(u/.67,(v+.72)/.32),r=Math.min(fore,heel);
      if(r<1.6){const bowl=-depth*Math.pow(Math.max(0,1-Math.min(r,1)**4),.6),rim=depth*.19*Math.exp(-(((r-1.1)/.21)**2));h+=amount*(bowl+rim);}
    }return h;}};
}

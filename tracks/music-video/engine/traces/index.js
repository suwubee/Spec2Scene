import * as THREE from '../vendor/three.module.js';
import {smooth} from '../core/math.js';
export function footprintState(time,birth,fade=240){return {visible:time>=birth,strength:smooth((time-birth)/.5)*(1-smooth((time-birth-fade)/20))};}
export function footprints({count=52,step=.45,start=[0,0,15],direction=-1,surface='snow',birth=i=>i*.75-35}={}) {
  const group=new THREE.Group(),marks=[];
  const dark=new THREE.MeshStandardMaterial({color:surface==='sand'?0x6c6250:0x60869c,roughness:.85});
  for(let i=0;i<count;i++) {
    const mark=new THREE.Group(), z=start[2]+direction*i*step,x=start[0]+Math.sin(i*.065)*1.6+(i%2?.13:-.13);
    mark.position.set(x,start[1]+.013,z); mark.rotation.y=Math.sin(i*.065)*.13;
    const rim=new THREE.Mesh(new THREE.RingGeometry(.080,.108,18),dark);rim.rotation.x=-Math.PI/2;rim.scale.set(1,1.65,1);mark.add(rim);
    const bowl=new THREE.Mesh(new THREE.SphereGeometry(.081,24,10,0,Math.PI*2,Math.PI/2,Math.PI/2),new THREE.MeshStandardMaterial({color:0x91b6d7,emissive:0x6fabe3,emissiveIntensity:.5,roughness:.16,metalness:.35,side:THREE.BackSide}));
    bowl.scale.set(1,.13,1.65);bowl.position.y=0;mark.add(bowl);
    const heel=new THREE.Mesh(new THREE.SphereGeometry(.05,12,8),dark);heel.scale.set(.8,.04,.9);heel.position.set(0,-.004,-.13);mark.add(heel);
    group.add(mark);marks.push({mark,bowl,birth:birth(i)});
  }
  return {object:group,update(t){for(const {mark,bowl,birth} of marks){const s=footprintState(t,birth);mark.visible=s.visible;bowl.material.emissiveIntensity=s.strength*.45;}}};
}
export function afterglow(t,extinguished,halfLife=2){return Math.pow(.5,Math.max(0,t-extinguished)/halfLife);}
export function vapor({count=12}={}) {
  const group=new THREE.Group(),mat=new THREE.MeshBasicMaterial({color:0xc3d5df,transparent:true,opacity:.025,depthWrite:false});
  for(let i=0;i<count;i++)group.add(new THREE.Mesh(new THREE.SphereGeometry(.1,8,6),mat));
  return {object:group,update(t){group.children.forEach((m,i)=>{const u=((t*.3+i/count)%1+1)%1;m.position.set(Math.sin(i+t)*u*.12,u*.6,0);m.scale.setScalar(.4+u*2);});}};
}

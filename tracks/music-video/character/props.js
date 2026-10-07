import * as THREE from '../engine/vendor/three.module.js';
import {material} from './materials.js';
import {ellipsoid,stroke,sweep} from './geometry.js';
import {twoBone,limit} from './rig.js';

export const propNames=['none','lantern','bag','cup','phone'];
export function poseForProp(rig,pose,prop){
  if(prop==='lantern'){pose.handPoseBySide={L:'carry',R:'relaxed'};pose.occupiedArms=['L'];pose.limbs.Larm.x=-.02;pose.limbs.Larm.z=.24;pose.limbs.Larm.bend=.13;}
  if(prop==='bag'){pose.limbs.Rarm.z=-.21;}
  if(prop==='cup'||prop==='phone'){
    pose.occupiedArms=prop==='cup'?['L','R']:['L'];pose.handPoseBySide=prop==='cup'?{L:'carry',R:'carry'}:{L:'carry',R:'touch'};
    pose.headPitch=prop==='phone'?.45:.20;
    for(const side of pose.occupiedArms){
      const l=rig.limbs[side+'arm'],sign=side==='L'?1:-1,target=new THREE.Vector3(sign*(prop==='cup'?.104:.12),prop==='cup'?-.012:.035,prop==='cup'?.32:.34).sub(l.upper.position),y=-Math.hypot(target.x,target.y),ik=twoBone(y,target.z,l.a,l.b,'elbow');
      pose.limbs[side+'arm']={x:ik.root,z:limit('shoulderZ',Math.atan2(target.x,-target.y)),bend:ik.bend,wrist:prop==='cup'?.12:.26,forearmTwist:-sign*Math.PI*.5};
    }
  }
}
export function makeProps(rig){
  const group=new THREE.Group();group.name='props';rig.root.add(group);
  const metal=material('metal',{color:0x292e2c,metalness:.65,roughness:.4}),fabric=material('cloth',{color:0xa09075}),ceramic=material('cloth',{color:0xb6bbb6,roughness:.35});
  const lantern=new THREE.Group();lantern.name='lantern';group.add(lantern);
  const handle=stroke(lantern,[[-.061,-.107,0],[-.053,-.035,0],[0,0,0],[.053,-.035,0],[.061,-.107,0]],.006,metal);handle.name='lantern-handle';
  const warm=new THREE.MeshStandardMaterial({color:0xffc570,emissive:0xffa63d,emissiveIntensity:2.3,roughness:.35});
  ellipsoid(lantern,.061,[.83,1.14,.83],[0,-.197,0],warm,'lantern-glow');
  for(const y of [-.121,-.273]){const m=new THREE.Mesh(new THREE.CylinderGeometry(.073,.078,.025,24),metal);m.position.y=y;lantern.add(m);}
  for(let i=0;i<4;i++){const a=Math.PI/4+i*Math.PI/2;stroke(lantern,[[Math.sin(a)*.057,-.13,Math.cos(a)*.057],[Math.sin(a)*.068,-.20,Math.cos(a)*.068],[Math.sin(a)*.057,-.265,Math.cos(a)*.057]],.004,metal);}
  const glow=new THREE.PointLight(0xffb35a,.7,1.5,2);glow.position.y=-.20;lantern.add(glow);
  const bag=new THREE.Group();bag.name='shoulder-bag';rig.chest.add(bag);
  const pouch=new THREE.Mesh(new THREE.BoxGeometry(.16,.25,.19,3,5,3),fabric);pouch.position.set(-.29,-.40,-.005);bag.add(pouch);
  // Strap wraps the shoulder's exterior and reaches both bag seams.
  const strap=new THREE.Mesh(sweep([[-.29,-.29,.09],[-.234,-.08,.086],[-.204,.13,.077],[-.199,.189,.003],[-.216,.13,-.077],[-.237,-.08,-.095],[-.29,-.29,-.09]],{width:.016,depth:.0035}),fabric);strap.name='bag-strap';bag.add(strap);
  stroke(bag,[[-.374,-.49,.092],[-.374,-.3,.092],[-.206,-.3,.092],[-.206,-.49,.092]],.0015,material('cloth',{color:0x625940}));
  const cup=new THREE.Group();cup.name='cup';group.add(cup);
  const cupMesh=new THREE.Mesh(new THREE.CylinderGeometry(.050,.040,.095,40,1,true),ceramic);cup.add(cupMesh);
  const coffee=new THREE.Mesh(new THREE.CircleGeometry(.045,40),material('cloth',{color:0x392b20,roughness:.3}));coffee.rotation.x=-Math.PI/2;coffee.position.y=.044;cup.add(coffee);
  const rim=new THREE.Mesh(new THREE.TorusGeometry(.048,.003,8,40),ceramic);rim.rotation.x=Math.PI/2;rim.position.y=.047;cup.add(rim);
  const phone=new THREE.Group();phone.name='phone';group.add(phone);
  const shell=new THREE.Mesh(new THREE.BoxGeometry(.066,.132,.009),metal);phone.add(shell);
  const screenMat=new THREE.MeshStandardMaterial({color:0x9dbada,emissive:0x9dbada,emissiveIntensity:.8,roughness:.25});
  const screen=new THREE.Mesh(new THREE.PlaneGeometry(.058,.115),screenMat);screen.position.z=.005;screen.name='phone-screen';phone.add(screen);
  const screenLight=new THREE.SpotLight(0xb6d4ff,.45,1.2,.9,.65,2);screenLight.position.set(0,.035,.025);phone.add(screenLight,screenLight.target);screenLight.target.position.set(0,.35,.15);
  const objects={lantern,bag,cup,phone};
  return {objects,update(prop,t){
    for(const [key,o] of Object.entries(objects))o.visible=key===prop;
    const grip=side=>{const f=rig.fingers.find(f=>f.side===side&&f.index===2),scale=f.length/.073;return rig.root.worldToLocal(rig.limbs[side+'arm'].tip.localToWorld(new THREE.Vector3(0,-.078*scale,.022*scale)));};
    const palm=side=>rig.root.worldToLocal(rig.limbs[side+'arm'].tip.localToWorld(new THREE.Vector3(0,-.107,.028)));
    if(prop==='lantern'){
      lantern.position.copy(grip('L'));lantern.rotation.set(Math.sin(t*2.65)*.11,0,Math.sin(t*1.9)*.065);
    }else if(prop==='cup'){
      cup.position.copy(palm('L').add(palm('R')).multiplyScalar(.5));cup.position.y-=.01;cup.rotation.set(0,0,0);
    }else if(prop==='phone'){
      phone.position.copy(grip('L'));phone.position.y+=.026;phone.rotation.set(-.48,Math.PI,0);
    }
  }};
}

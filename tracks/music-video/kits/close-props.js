import * as THREE from '../engine/vendor/three.module.js';
import {mesh,disposeObject} from './common.js';
import {makeRng} from '../engine/noise.js';
const clamp=THREE.MathUtils.clamp;
/** Two leaf surfaces, centre veins and small transmissive droplets; growth/unfurl are 0..1. */
export function createPottedPlant({seed=11,leaves=10,height=.45,potRadius=.10}={}){
  if(!Number.isInteger(leaves)||leaves<2||leaves>80||height<=0||potRadius<=0)throw new Error('invalid plant');
  const object=new THREE.Group(),rng=makeRng(seed),leafGroups=[];
  const clay=new THREE.MeshStandardMaterial({color:0x92735c,roughness:.8}),soil=new THREE.MeshStandardMaterial({color:0x2e2920,roughness:1});
  object.add(mesh(new THREE.CylinderGeometry(potRadius,potRadius*.73,.15,28,1,true),clay,[0,.075,0]),mesh(new THREE.CylinderGeometry(potRadius*.93,potRadius*.93,.015,28),soil,[0,.135,0]));
  const stemMat=new THREE.MeshStandardMaterial({color:0x476442,roughness:.7});
  object.add(mesh(new THREE.CylinderGeometry(.004,.007,height,8),stemMat,[0,.14+height/2,0]));
  const leafMat=new THREE.MeshPhysicalMaterial({color:0x3b7946,roughness:.5,side:THREE.DoubleSide,transmission:.16,thickness:.0005,ior:1.4});
  const under=leafMat.clone();under.color.set(0x76a05a);under.transmission=.25;
  const dew=new THREE.MeshPhysicalMaterial({color:0xd5eeee,roughness:.06,transmission:.8,ior:1.33,thickness:.002});
  for(let i=0;i<leaves;i++){
    const group=new THREE.Group(),angle=i*2.4+rng()*.25,level=.16+height*(i+.5)/leaves,L=.10+rng()*.08,W=L*.4;
    group.position.y=level;group.rotation.y=angle;object.add(group);
    const pos=[],idx=[];
    for(let j=0;j<=12;j++){const u=j/12,w=Math.sin(Math.PI*u)*W;pos.push(-w,.024*Math.sin(u*Math.PI)-.007,u*L,0,.024*Math.sin(u*Math.PI),u*L,w,.024*Math.sin(u*Math.PI)-.007,u*L);if(j<12){const k=j*3;idx.push(k,k+3,k+1,k+1,k+3,k+4,k+1,k+4,k+2,k+2,k+4,k+5);}}
    const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));geo.setIndex(idx);geo.computeVertexNormals();group.add(mesh(geo,leafMat));
    const underside=mesh(geo,under,[0,-.0015,0]);group.add(underside);
    const line=new THREE.CatmullRomCurve3(Array.from({length:9},(_,j)=>new THREE.Vector3(0,.024*Math.sin(j/8*Math.PI)+.001,j/8*L)));
    group.add(mesh(new THREE.TubeGeometry(line,16,.0009,4,false),stemMat));
    for(let j=1;j<=4;j++)for(const sign of [-1,1]){const u=j/6,curve=new THREE.LineCurve3(new THREE.Vector3(0,.024*Math.sin(u*Math.PI)+.001,u*L),new THREE.Vector3(sign*Math.sin((u+.15)*Math.PI)*W*.85,.024*Math.sin((u+.15)*Math.PI)-.004,(u+.15)*L));group.add(mesh(new THREE.TubeGeometry(curve,1,.00035,3),stemMat));}
    for(let j=0;j<2;j++){const u=.25+rng()*.45;group.add(mesh(new THREE.SphereGeometry(.002+rng()*.002,8,6),dew,[(rng()-.5)*W*.6,.024*Math.sin(u*Math.PI)+.003,u*L]));}
    leafGroups.push({group,phase:i/leaves});
  }
  return {object,leafGroups,update(t,{growth=1,unfurl=1,wind=0}={}){for(const {group,phase} of leafGroups){const g=clamp(growth*1.5-phase*.5,.02,1);group.scale.setScalar(g);group.rotation.x=-(1-clamp(unfurl,0,1))*1.35+Math.sin(t*1.3+phase*5)*wind*.08;}},dispose(){disposeObject(object);}};
}
/** Fold envelope morphs a triangulated sheet into a boat; time is used only for water motion. */
export function createFoldedPaper({size=.5,kind='boat',color=0xe1d7bd,waterHeight=()=>0}={}){
  if(!['boat','paper'].includes(kind)||!Number.isFinite(size)||size<=0)throw new Error('invalid folded paper');
  const object=new THREE.Group(),flat=[[-1,0,-.5],[0,0,-.5],[1,0,-.5],[-1,0,.5],[0,0,.5],[1,0,.5],[0,0,0]],boat=[[-1,.4,0],[0,.3,-.42],[1,.4,0],[-1,.4,0],[0,.3,.42],[1,.4,0],[0,0,0]];
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(flat.flat().map(v=>v*size),3));geo.setIndex([0,1,6,1,2,6,2,5,6,5,4,6,4,3,6,3,0,6]);geo.computeVertexNormals();
  object.add(mesh(geo,new THREE.MeshPhysicalMaterial({color,roughness:.82,side:THREE.DoubleSide,transmission:.05,thickness:.0003})));
  const edges=new THREE.LineSegments(new THREE.EdgesGeometry(geo,1),new THREE.LineBasicMaterial({color:0xa49b85}));object.add(edges);
  const ridgeGeo=new THREE.BufferGeometry();ridgeGeo.setAttribute('position',new THREE.Float32BufferAttribute([-.65,.1,0,0,.62,0,.65,.1,0].map(v=>v*size),3));ridgeGeo.computeVertexNormals();const ridge=mesh(ridgeGeo,new THREE.MeshStandardMaterial({color,roughness:.9,side:THREE.DoubleSide}));object.add(ridge);
  return {object,geometry:geo,update(t,{fold=1,float=true,x=0,z=0}={}){const f=clamp(fold,0,1),ease=f*f*(3-2*f),p=geo.attributes.position;ridge.visible=kind==='boat'&&f>.001;ridge.scale.y=ease;for(let i=0;i<flat.length;i++){const a=flat[i],b=kind==='boat'?boat[i]:[a[0],Math.abs(a[0])*Math.sin(ease*Math.PI*.85),a[2]];p.setXYZ(i,(a[0]*(1-ease)+b[0]*ease)*size,(a[1]*(1-ease)+b[1]*ease)*size,(a[2]*(1-ease)+b[2]*ease)*size);}p.needsUpdate=true;geo.computeVertexNormals();geo.computeBoundingSphere();edges.geometry.dispose();edges.geometry=new THREE.EdgesGeometry(geo,1);object.position.set(x,float?waterHeight(x,z,t)+.009+Math.sin(t*1.7)*.006:0,z);object.rotation.set(float?Math.sin(t*1.1)*.025:0,0,float?Math.sin(t*.9)*.04:0);},dispose(){disposeObject(object);}};
}

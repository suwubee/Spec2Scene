import * as THREE from '../engine/vendor/three.module.js';
/** Smooth, seeded multi-frequency erosion; physical rough stone, without downloaded textures. */
export function createRock({radius=1,detail=5,seed=1,scale=[1,.72,.86],color=0x656764,roughness=.92}={}){
  if(!(radius>0)||!Number.isInteger(detail)||detail<1||detail>6||!Number.isFinite(seed))throw new Error('invalid rock budget');
  const geometry=new THREE.IcosahedronGeometry(radius,detail),p=geometry.attributes.position;
  for(let i=0;i<p.count;i++){
    const x=p.getX(i)/radius,y=p.getY(i)/radius,z=p.getZ(i)/radius;
    const n=.10*Math.sin(x*5+seed)*Math.sin(y*4-1)*Math.cos(z*6)+.025*Math.sin(x*19+z*11)*Math.cos(y*17+seed);
    p.setXYZ(i,x*radius*(1+n)*scale[0],y*radius*(1+n)*scale[1],z*radius*(1+n)*scale[2]);
  }
  // Weld duplicate faces before computing normals; no faceted triangular highlights.
  const normals=new Map(),keys=[];geometry.computeVertexNormals();const normal=geometry.attributes.normal;
  for(let i=0;i<p.count;i++){const k=[p.getX(i),p.getY(i),p.getZ(i)].map(v=>v.toFixed(5)).join(',');keys.push(k);const v=normals.get(k)||new THREE.Vector3();v.add(new THREE.Vector3().fromBufferAttribute(normal,i));normals.set(k,v);}
  for(const v of normals.values())v.normalize();for(let i=0;i<p.count;i++){const v=normals.get(keys[i]);normal.setXYZ(i,v.x,v.y,v.z);}
  const material=new THREE.MeshPhysicalMaterial({color,roughness,specularIntensity:.28});
  material.onBeforeCompile=s=>{s.vertexShader=s.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 rockPoint;').replace('#include <begin_vertex>','#include <begin_vertex>\nrockPoint=position;');s.fragmentShader=s.fragmentShader.replace('#include <common>','#include <common>\nvarying vec3 rockPoint;').replace('#include <color_fragment>','#include <color_fragment>\nfloat fleck=sin(rockPoint.x*83.)*sin(rockPoint.y*91.)*sin(rockPoint.z*79.); diffuseColor.rgb*=.91+.09*fleck;');};
  material.customProgramCacheKey=()=> 'procedural-rock-v1';
  const object=new THREE.Mesh(geometry,material);object.castShadow=object.receiveShadow=true;
  return {object,dispose(){geometry.dispose();material.dispose();}};
}

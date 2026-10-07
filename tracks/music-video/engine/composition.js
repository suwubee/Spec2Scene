import * as THREE from './vendor/three.module.js';
const visible=(o,ignore)=>{for(let p=o;p;p=p.parent)if(!p.visible||ignore.has(p)||p.userData.compositionIgnore)return false;return true;};
/** Screen-grid ray visibility, including foreground occlusion. An estimate, not a raster mask. */
export function measureComposition({scene,camera,characters=[],columns=64,rows=36,ignore=[]}={}){
  if(!Number.isInteger(columns)||!Number.isInteger(rows)||columns<4||rows<4||columns*rows>65536)throw new Error('invalid composition sampling budget');
  scene.updateMatrixWorld(true);camera.updateMatrixWorld(true);
  const ignored=new Set(ignore),subjects=new Set(),occluders=[];
  for(const root of characters)root.traverse(o=>{if(o.isMesh)subjects.add(o);});
  scene.traverse(o=>{if(o.isMesh&&visible(o,ignored)&&o.layers.test(camera.layers)){
    const mats=Array.isArray(o.material)?o.material:[o.material];
    if(mats.some(m=>m.visible!==false&&m.depthTest!==false&&(!m.transparent||m.opacity>=.15)))occluders.push(o);
  }});
  const actorMeshes=occluders.filter(o=>subjects.has(o)),ray=new THREE.Raycaster();ray.near=camera.near;ray.far=camera.far;
  let actorPixels=0,projectedPixels=0,occupiedPixels=0;
  for(let y=0;y<rows;y++)for(let x=0;x<columns;x++){
    ray.setFromCamera(new THREE.Vector2((x+.5)/columns*2-1,1-(y+.5)/rows*2),camera);
    const subject=ray.intersectObjects(actorMeshes,false)[0],hit=ray.intersectObjects(occluders,false)[0];
    if(subject)projectedPixels++;
    if(hit){occupiedPixels++;if(subject&&subject.distance<=hit.distance+1e-5)actorPixels++;}
  }
  const total=columns*rows;
  return {characterAreaFraction:actorPixels/total,projectedCharacterAreaFraction:projectedPixels/total,
    visibleFraction:projectedPixels?actorPixels/projectedPixels:0,occludedFraction:projectedPixels?1-actorPixels/projectedPixels:0,
    negativeSpaceFraction:1-occupiedPixels/total,nonCharacterFraction:1-actorPixels/total,samples:total,
    method:'screen-grid mesh rays; transparent surfaces use opacity >= 0.15; ignores shader displacement/alpha maps',resolution:[columns,rows]};
}

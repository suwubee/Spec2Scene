import * as THREE from './vendor/three.module.js';
const visible=(o,ignore)=>{for(let p=o;p;p=p.parent)if(!p.visible||ignore.has(p)||p.userData.compositionIgnore)return false;return true;};
/** Conservative normalized picture-space bounds, top-left origin; no occlusion claim. */
export function characterBounds(camera,characters=[]){
  camera.updateMatrixWorld(true);const result=[];
  for(const actor of characters){if(!visible(actor,new Set()))continue;actor.updateWorldMatrix(true,true);const box=new THREE.Box3().setFromObject(actor),points=[];
    if(box.isEmpty())continue;
    for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){const v=new THREE.Vector3(x,y,z).applyMatrix4(camera.matrixWorldInverse);if(v.z< -camera.near)points.push(v.applyMatrix4(camera.projectionMatrix));}
    if(!points.length)continue;
    const x0=Math.max(0,Math.min(...points.map(v=>(v.x+1)/2))),x1=Math.min(1,Math.max(...points.map(v=>(v.x+1)/2))),y0=Math.max(0,Math.min(...points.map(v=>(1-v.y)/2))),y1=Math.min(1,Math.max(...points.map(v=>(1-v.y)/2)));
    if(x1>x0&&y1>y0)result.push({x0,y0,x1,y1});
  }return result;
}

/** Move text above a subject or to a free side. Report unresolved crowding explicitly. */
export function placeSubtitle(box,subjects,{width=1,height=1,margin=.025}={}){
  const w=box.x1-box.x0,h=box.y1-box.y0;
  const fit=b=>{const x=Math.max(0,Math.min(width-w,b.x0)),y=Math.max(0,Math.min(height-h,b.y0));return {x0:x,y0:y,x1:x+w,y1:y+h};};
  const candidates=[fit(box)];
  for(const a of subjects)candidates.push(fit({...box,y0:a.y0-margin-h}),fit({...box,x0:a.x0-margin-w}),fit({...box,x0:a.x1+margin}));
  const overlap=b=>subjects.reduce((sum,a)=>sum+Math.max(0,Math.min(b.x1,a.x1+margin)-Math.max(b.x0,a.x0-margin))*Math.max(0,Math.min(b.y1,a.y1+margin)-Math.max(b.y0,a.y0-margin)),0);
  candidates.sort((a,b)=>overlap(a)-overlap(b)||Math.hypot(a.x0-box.x0,a.y0-box.y0)-Math.hypot(b.x0-box.x0,b.y0-box.y0));
  return {...candidates[0],overlap:overlap(candidates[0]),resolved:overlap(candidates[0])<1e-10&&w<=width&&h<=height};
}
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
  return {characterBounds:characterBounds(camera,characters),characterAreaFraction:actorPixels/total,projectedCharacterAreaFraction:projectedPixels/total,
    visibleFraction:projectedPixels?actorPixels/projectedPixels:0,occludedFraction:projectedPixels?1-actorPixels/projectedPixels:0,
    negativeSpaceFraction:1-occupiedPixels/total,nonCharacterFraction:1-actorPixels/total,samples:total,
    method:'screen-grid mesh rays; transparent surfaces use opacity >= 0.15; ignores shader displacement/alpha maps',resolution:[columns,rows]};
}

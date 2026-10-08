import * as THREE from '../engine/vendor/three.module.js';
/** Monotonic dense centre / geometric outer spacing; one connected mesh and one height function. */
export function sampleAxis({min=-2000,max=2000,nearMin=-3,nearMax=3,step=.04,growth=1.18,maxStep=Infinity}={}) {
  if(![min,max,nearMin,nearMax,step,growth].every(Number.isFinite)||!(min<nearMin&&nearMin<nearMax&&nearMax<max)||step<=0||growth<=1)throw new Error('invalid heightfield axis');
  if((nearMax-nearMin)/step>10000)throw new Error('heightfield axis exceeds budget');
  const middle=Array.from({length:Math.ceil((nearMax-nearMin)/step)+1},(_,i)=>Math.min(nearMax,nearMin+i*step));
  const left=[],right=[];
  if(!(maxStep>=step)||(max-min)/maxStep>10000)throw new Error('invalid far subdivision budget');
  for(let x=nearMin,d=step;x>min;){d=Math.min(maxStep,d*growth);x=Math.max(min,x-d);left.push(x);}
  for(let x=nearMax,d=step;x<max;){d=Math.min(maxStep,d*growth);x=Math.min(max,x+d);right.push(x);}
  return [...left.reverse(),...middle,...right];
}

/** Focal-length-aware subdivision in metres, bounded by a caller-owned vertex budget. */
export function telephotoMaxStep({distance,focal=100,sensorWidth=24.89,width=1920,pixels=8}={}){
  if(![distance,focal,sensorWidth,width,pixels].every(v=>Number.isFinite(v)&&v>0))throw new Error('invalid lens sampling');
  return distance*sensorWidth/focal/width*pixels;
}
export function createMountainLOD({height,bounds=[-500,-1000,500,-200],material,maxSegments=256,pixels=8}={}){
  if(typeof height!=='function'||!Number.isInteger(maxSegments)||maxSegments<8||maxSegments>512||bounds.length!==4||!bounds.every(Number.isFinite)||bounds[2]<=bounds[0]||bounds[3]<=bounds[1])throw new Error('invalid mountain LOD');
  const own=!material,mat=material||new THREE.MeshStandardMaterial({color:0x55616a,roughness:1}),object=new THREE.Mesh(new THREE.BufferGeometry(),mat);let key='';
  return {object,update(camera,{width=1920,t=0}={}){
    const cx=(bounds[0]+bounds[2])/2,cz=(bounds[1]+bounds[3])/2,distance=Math.max(1,Math.hypot(camera.position.x-cx,camera.position.z-cz));
    const step=telephotoMaxStep({distance,focal:camera.getFocalLength(),sensorWidth:camera.getFilmWidth(),width,pixels});
    const requested=Math.ceil(Math.max(bounds[2]-bounds[0],bounds[3]-bounds[1])/step),segments=Math.min(maxSegments,Math.max(8,2**Math.ceil(Math.log2(requested))));
    const next=`${segments}:${t}`;if(next!==key){const g=new THREE.PlaneGeometry(bounds[2]-bounds[0],bounds[3]-bounds[1],segments,segments);g.rotateX(-Math.PI/2);g.translate(cx,0,cz);const p=g.attributes.position;for(let i=0;i<p.count;i++)p.setY(i,height(p.getX(i),p.getZ(i),t));g.computeVertexNormals();g.computeBoundingSphere();object.geometry.dispose();object.geometry=g;key=next;}
    return {segments,requested,budgetLimited:requested>maxSegments,maxStep:step};
  },dispose(){object.geometry.dispose();if(own)mat.dispose();}};
}
export function continuousHeightfield({x={},z={nearMin:-35,nearMax:14,step:.08},height=()=>0,maxVertices=400000}={}) {
  const xs=sampleAxis(x),zs=sampleAxis(z);
  if(xs.length*zs.length>maxVertices)throw new Error('heightfield vertex budget exceeded');
  const positions=[],uv=[],indices=[];
  for(const zz of zs)for(const xx of xs){positions.push(xx,height(xx,zz,0),zz);uv.push(xx/500,zz/500);}
  for(let j=0;j<zs.length-1;j++)for(let i=0;i<xs.length-1;i++){const a=j*xs.length+i;indices.push(a,a+xs.length,a+1,a+1,a+xs.length,a+xs.length+1);}
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));geometry.setIndex(indices);geometry.computeVertexNormals();
  return {geometry,xs,zs,update(t){const p=geometry.attributes.position;let dirty=false;for(let i=0;i<p.count;i++){const h=Math.fround(height(p.getX(i),p.getZ(i),t));if(h!==p.getY(i)){p.setY(i,h);dirty=true;}}if(dirty){p.needsUpdate=true;geometry.computeVertexNormals();geometry.computeBoundingSphere();}return dirty;}};
}

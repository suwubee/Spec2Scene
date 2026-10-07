import * as THREE from '../engine/vendor/three.module.js';
// Cross-section lofts blended before polygonisation: a single connected surface at
// shoulders and hips, rather than intersecting cylinders. Shared edge indices weld it.
export function loftField(rings,x,y,z){
  let i=1;while(i<rings.length-1&&rings[i][0]<y)i++;
  const a=rings[i-1],b=rings[i],t=Math.max(0,Math.min(1,(y-a[0])/(b[0]-a[0])));
  const radius=axis=>{
    const prev=rings[Math.max(0,i-2)],next=rings[Math.min(rings.length-1,i+1)];
    const m0=(b[axis]-prev[axis])/(b[0]-prev[0]),m1=(next[axis]-a[axis])/(next[0]-a[0]),h=b[0]-a[0];
    return Math.max(.001,(2*t**3-3*t*t+1)*a[axis]+(t**3-2*t*t+t)*h*m0+(-2*t**3+3*t*t)*b[axis]+(t**3-t*t)*h*m1);
  };
  const rx=radius(1),rz=radius(2),radial=(Math.hypot(x/rx,z/rz)-1)*Math.min(rx,rz);
  const cap=Math.max(rings[0][0]-y,y-rings.at(-1)[0]);
  return Math.hypot(Math.max(radial,0),Math.max(cap,0))+Math.min(Math.max(radial,cap),0);
}
export function union(a,b,k=.045){const h=Math.max(k-Math.abs(a-b),0)/k;return Math.min(a,b)-h*h*k*.25;}
export function isoSurface(field,min,max,step=.017){
  const dims=min.map((v,i)=>Math.ceil((max[i]-v)/step)+1),[nx,ny,nz]=dims;
  const idx=(x,y,z)=>(y*nz+z)*nx+x, values=new Float32Array(nx*ny*nz);
  const at=id=>{const x=id%nx,z=Math.floor(id/nx)%nz,y=Math.floor(id/(nx*nz));return [min[0]+x*step,min[1]+y*step,min[2]+z*step];};
  for(let id=0;id<values.length;id++)values[id]=field(...at(id));
  const points=[],indices=[],cache=new Map();
  const edge=(a,b)=>{const key=Math.min(a,b)*values.length+Math.max(a,b);if(cache.has(key))return cache.get(key);
    const p=at(a),q=at(b),t=values[a]/(values[a]-values[b]),id=points.length/3;points.push(...p.map((v,i)=>v+(q[i]-v)*t));cache.set(key,id);return id;};
  const triangle=(a,b,c)=>{const p=new THREE.Vector3().fromArray(points,a*3),q=new THREE.Vector3().fromArray(points,b*3),r=new THREE.Vector3().fromArray(points,c*3);
    const n=q.clone().sub(p).cross(r.clone().sub(p)),m=p.clone().add(q).add(r).multiplyScalar(1/3),e=.001;
    const grad=new THREE.Vector3(field(m.x+e,m.y,m.z)-field(m.x-e,m.y,m.z),field(m.x,m.y+e,m.z)-field(m.x,m.y-e,m.z),field(m.x,m.y,m.z+e)-field(m.x,m.y,m.z-e));
    indices.push(...(n.dot(grad)>0?[a,b,c]:[a,c,b]));};
  const tetra=[[0,5,1,6],[0,1,2,6],[0,2,3,6],[0,3,7,6],[0,7,4,6],[0,4,5,6]];
  for(let y=0;y<ny-1;y++)for(let z=0;z<nz-1;z++)for(let x=0;x<nx-1;x++){
    const ids=[idx(x,y,z),idx(x+1,y,z),idx(x+1,y,z+1),idx(x,y,z+1),idx(x,y+1,z),idx(x+1,y+1,z),idx(x+1,y+1,z+1),idx(x,y+1,z+1)];
    if(ids.every(i=>values[i]>0)||ids.every(i=>values[i]<=0))continue;
    for(const t of tetra){const inside=t.map(i=>ids[i]).filter(i=>values[i]<=0),outside=t.map(i=>ids[i]).filter(i=>values[i]>0);
      if(inside.length===1||inside.length===3){const a=inside.length===1?inside:outside,b=inside.length===1?outside:inside;triangle(...b.map(id=>edge(a[0],id)));}
      else if(inside.length===2){const a=edge(inside[0],outside[0]),b=edge(inside[0],outside[1]),c=edge(inside[1],outside[0]),d=edge(inside[1],outside[1]);triangle(a,b,c);triangle(b,d,c);}
    }
  }
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(points,3));geo.setIndex(indices);geo.computeVertexNormals();
  const normals=geo.attributes.normal,p=geo.attributes.position,e=.001;
  for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i),z=p.getZ(i),n=new THREE.Vector3(field(x+e,y,z)-field(x-e,y,z),field(x,y+e,z)-field(x,y-e,z),field(x,y,z+e)-field(x,y,z-e)).normalize();normals.setXYZ(i,n.x,n.y,n.z);}
  return geo;
}
export function skinGeometry(geometry,bones,weights){
  const indices=[],values=[],p=geometry.attributes.position;
  for(let i=0;i<p.count;i++){
    const choices=weights(p.getX(i),p.getY(i),p.getZ(i)).filter(x=>x[1]>1e-7).sort((a,b)=>b[1]-a[1]).slice(0,4),sum=choices.reduce((s,x)=>s+x[1],0);
    while(choices.length<4)choices.push([bones[0],0]);
    indices.push(...choices.map(([bone])=>bones.indexOf(bone)));values.push(...choices.map(([,w])=>w/sum));
  }
  geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(indices,4));geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(values,4));return geometry;
}
export function tube(rings,segments=24,thickness=0){
  const positions=[],indices=[],layers=thickness?2:1;
  for(let layer=0;layer<layers;layer++)for(const [y,rx,rz] of rings)for(let j=0;j<segments;j++){
    const a=j/segments*Math.PI*2;positions.push(Math.sin(a)*(rx-layer*thickness),y,Math.cos(a)*(rz-layer*thickness));}
  const rows=rings.length,n=rows*segments;
  for(let l=0;l<layers;l++)for(let i=0;i<rows-1;i++)for(let j=0;j<segments;j++){
    const a=l*n+i*segments+j,b=l*n+i*segments+(j+1)%segments,c=a+segments,d=b+segments;indices.push(...(l?[a,c,b,b,c,d]:[a,b,c,b,d,c]));}
  if(thickness)for(const row of [0,rows-1])for(let j=0;j<segments;j++){const a=row*segments+j,b=row*segments+(j+1)%segments;indices.push(a,a+n,b,b,a+n,b+n);}
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geo.setIndex(indices);geo.computeVertexNormals();return geo;
}

// Open the garment at neck, cuffs and hem, then join an inward offset lining.
// Boundary edges are stitched, giving an actual rim instead of DoubleSide shading.
export function garmentShell(geometry,isOpening,thickness=.007){
  const p=geometry.attributes.position,n=geometry.attributes.normal,outer=[],edges=new Map();
  for(let i=0;i<geometry.index.count;i+=3){
    const tri=[0,1,2].map(j=>geometry.index.getX(i+j));
    if(tri.every(id=>isOpening(p.getX(id),p.getY(id),p.getZ(id))))continue;
    outer.push(...tri);
    for(let j=0;j<3;j++){const a=tri[j],b=tri[(j+1)%3],key=`${Math.min(a,b)}:${Math.max(a,b)}`;
      if(edges.has(key))edges.delete(key);else edges.set(key,[a,b]);}
  }
  const positions=[...p.array],count=p.count,indices=[...outer];
  for(let i=0;i<count;i++)positions.push(p.getX(i)-n.getX(i)*thickness,p.getY(i)-n.getY(i)*thickness,p.getZ(i)-n.getZ(i)*thickness);
  for(let i=0;i<outer.length;i+=3)indices.push(outer[i]+count,outer[i+2]+count,outer[i+1]+count);
  for(const [a,b] of edges.values())indices.push(a,b+count,b,a,a+count,b+count);
  const shell=new THREE.BufferGeometry();shell.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));shell.setIndex(indices);shell.computeVertexNormals();
  shell.userData={thickness,boundaryEdges:edges.size};return shell;
}

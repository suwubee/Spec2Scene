import * as THREE from '../engine/vendor/three.module.js';

export function ellipsoid(parent,radius,scale,position,mat,name=''){
  const mesh=new THREE.Mesh(new THREE.SphereGeometry(radius,32,24),mat);
  mesh.scale.set(...scale);mesh.position.set(...position);mesh.name=name;parent.add(mesh);return mesh;
}
export function stroke(parent,points,radius,mat){
  const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p)));
  const mesh=new THREE.Mesh(new THREE.TubeGeometry(curve,32,radius,10,false),mat);parent.add(mesh);return mesh;
}
// Tapered solid locks and straps, sampled in a curve's parallel frame. Elliptical
// sections give cloth real thickness and hair a volume, including from the side.
export function sweep(points,{width=.02,depth=.01,steps=40,sides=12,taper=()=>1}={}){
  const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p))),frames=curve.computeFrenetFrames(steps,false),pos=[],index=[];
  for(let i=0;i<=steps;i++){
    const p=curve.getPointAt(i/steps),r=taper(i/steps);
    for(let j=0;j<sides;j++){
      const a=j/sides*Math.PI*2,v=p.clone().addScaledVector(frames.normals[i],Math.cos(a)*width*r).addScaledVector(frames.binormals[i],Math.sin(a)*depth*r);pos.push(...v.toArray());
    }
  }
  for(let i=0;i<steps;i++)for(let j=0;j<sides;j++){const a=i*sides+j,b=i*sides+(j+1)%sides;index.push(a,b,a+sides,b,b+sides,a+sides);}
  for(const row of [0,steps]){const c=pos.length/3;pos.push(...curve.getPointAt(row/steps).toArray());for(let j=0;j<sides;j++){const a=row*sides+j,b=row*sides+(j+1)%sides;index.push(...(row?[c,a,b]:[c,b,a]));}}
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));geo.setIndex(index);geo.computeVertexNormals();return geo;
}
export function clothStrip(points,width,thickness=.006){
  // Width is kept along X; twist is small and intentional along the centreline.
  const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p))),p=[],idx=[],steps=48;
  for(let i=0;i<=steps;i++){const u=i/steps,c=curve.getPoint(u),t=curve.getTangent(u),cross=new THREE.Vector3(1,.08*Math.sin(u*5),0).projectOnPlane(t).normalize(),n=cross.clone().cross(t).normalize();
    for(const [a,b] of [[-1,-1],[1,-1],[1,1],[-1,1]])p.push(...c.clone().addScaledVector(cross,a*width/2).addScaledVector(n,b*thickness/2).toArray());}
  for(let i=0;i<steps;i++)for(let j=0;j<4;j++){const a=i*4+j,b=i*4+(j+1)%4;idx.push(a,b,a+4,b,b+4,a+4);}idx.push(0,2,1,0,3,2,steps*4,steps*4+1,steps*4+2,steps*4,steps*4+2,steps*4+3);
  for(let i=0;i<idx.length;i+=3)[idx[i+1],idx[i+2]]=[idx[i+2],idx[i+1]];
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setIndex(idx);g.computeVertexNormals();return g;
}

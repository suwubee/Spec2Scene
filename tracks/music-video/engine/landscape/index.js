import * as THREE from '../vendor/three.module.js';
import {hash} from '../core/math.js';
import {material} from '../materials/index.js';
export function box(parent, size, position, mat) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), mat); mesh.position.fromArray(position); parent.add(mesh); return mesh;
}
export function terrain({size = 200, segments = 100, height = (x,z) => Math.sin(x*.12)*Math.cos(z*.1)*.25, mat = material('snow')} = {}) {
  const geo = new THREE.PlaneGeometry(size, size, segments, segments); geo.rotateX(-Math.PI/2);
  const p = geo.attributes.position;
  for (let i=0;i<p.count;i++) p.setY(i,height(p.getX(i),p.getZ(i)));
  geo.computeVertexNormals(); return new THREE.Mesh(geo,mat);
}
export function water({size = 40, color = 0x132e41} = {}) {
  const mat = new THREE.ShaderMaterial({uniforms: {time: {value: 0}, base: {value: new THREE.Color(color)}},
    vertexShader: 'varying vec3 p; void main(){p=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: 'varying vec3 p; uniform float time; uniform vec3 base; void main(){float w=sin(p.x*19.+sin(p.y*4.+time)*2.)*.5+.5;float path=exp(-p.x*p.x*.8)*pow(w,14.);gl_FragColor=vec4(base+vec3(.4,.65,.9)*path,1.);}' });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size,size),mat); mesh.rotation.x=-Math.PI/2;
  return {mesh, update(t){mat.uniforms.time.value=t;}};
}
export function vegetation({count = 100, spread = 20, seed = 1, trees = false} = {}) {
  const geometry = trees ? new THREE.ConeGeometry(.8, 5, 7) : new THREE.ConeGeometry(.04,.7,3);
  const mesh = new THREE.InstancedMesh(geometry,material('cloth',{color:0x233f3d}),count), obj=new THREE.Object3D();
  for(let i=0;i<count;i++){obj.position.set((hash(i*3,seed)-.5)*spread,trees?2.5:.35,(hash(i*3+1,seed)-.5)*spread);obj.scale.setScalar(.6+hash(i*3+2,seed));obj.updateMatrix();mesh.setMatrixAt(i,obj.matrix);}
  return mesh;
}
export function skyline({count = 35, seed = 1} = {}) {
  const group = new THREE.Group(), wall=material('stone',{color:0x182535}), glow=new THREE.MeshBasicMaterial({color:0x8c6844});
  for(let i=0;i<count;i++) {const x=(i-count/2)*3, h=3+hash(i,seed)*12;
    box(group,[2.4,h,3],[x,h/2,-50-hash(i+200,seed)*15],wall);
    if(i%3===0) box(group,[.17,.12,.02],[x+.5,h*.7,-48.48],glow);
  } return group;
}
export function room({width = 8, height = 3, depth = 6} = {}) {
  const group = new THREE.Group(), mat=material('stone');
  box(group,[width,.1,depth],[0,0,0],mat);
  const opening=Math.min(2,width*.4),winHeight=height*.4;
  for(const sign of [-1,1])box(group,[(width-opening)/2,height,.12],[sign*(width+opening)/4,height/2,-depth/2],mat);
  box(group,[opening,height*.3,.12],[0,height*.15,-depth/2],mat);box(group,[opening,height*.3,.12],[0,height*.85,-depth/2],mat);
  box(group,[opening,winHeight,.02],[0,height/2,-depth/2],material('glass'));
  const fixture=new THREE.Mesh(new THREE.SphereGeometry(.1,16,12),new THREE.MeshBasicMaterial({color:0xffcc91}));fixture.position.set(0,height-.15,0);group.add(fixture);
  const lamp=new THREE.PointLight(0xffcc91,12,12);lamp.position.copy(fixture.position);group.add(lamp);
  box(group,[.12,height,depth],[-width/2,height/2,0],mat); return group;
}

import * as THREE from '../vendor/three.module.js';
import {hash,mod} from '../core/math.js';
export function particleAt(i,t,{seed=12,kind='snow',spread=60,height=22,speed=kind==='rain'?12:.65,wind=.25}={}) {
  return [(hash(i*3,seed)-.5)*spread+Math.sin(t*.24+i)*.15+mod(t*wind+hash(i+900,seed)*spread,spread)-spread/2,
    mod(hash(i*3+1,seed)*height-t*speed,height), (hash(i*3+2,seed)-.5)*spread];
}
export function precipitation({count=1500,kind='snow',...options}={}) {
  const geometry=new THREE.BufferGeometry(), positions=new Float32Array(count*3*(kind==='rain'?2:1));geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
  const mat=kind==='rain'?new THREE.LineBasicMaterial({color:0x9ab6c5,transparent:true,opacity:.23,depthWrite:false}):new THREE.PointsMaterial({color:kind==='fireflies'?0xb7e695:0xb9cfe0,size:kind==='dust'?.015:.04,transparent:true,opacity:.62,depthWrite:false});
  const object=kind==='rain'?new THREE.LineSegments(geometry,mat):new THREE.Points(geometry,mat);
  object.frustumCulled=false;
  return {object,update(t,wind=options.wind??.25){for(let i=0;i<count;i++){const p=particleAt(i,t,{...options,wind,kind});
    if(kind==='rain'){positions.set(p,i*6);positions.set([p[0]-.025,p[1]+.34,p[2]],i*6+3);}else positions.set(p,i*3);
  }geometry.attributes.position.needsUpdate=true;}};
}
export function sky({night=true,moon=true,phase=.85}={}) {
  const group=new THREE.Group();
  const material=new THREE.ShaderMaterial({side:THREE.BackSide,depthWrite:false,uniforms:{night:{value:night?1:0}},
    vertexShader:'varying vec3 p; void main(){p=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader:'varying vec3 p; uniform float night; void main(){float h=normalize(p).y;vec3 lo=mix(vec3(.65,.28,.12),vec3(.055,.105,.16),night);vec3 hi=mix(vec3(.10,.24,.40),vec3(.006,.015,.035),night);gl_FragColor=vec4(mix(lo,hi,smoothstep(-.05,.7,h)),1.);}' });
  group.add(new THREE.Mesh(new THREE.SphereGeometry(450,32,24),material));
  if(night){const points=[];for(let i=0;i<180;i++){const a=hash(i*2,81)*Math.PI*2,h=hash(i*2+1,81)*.85+.15,r=Math.sqrt(1-h*h);points.push(Math.cos(a)*r*390,h*390,Math.sin(a)*r*390);}
    const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(points,3));group.add(new THREE.Points(geo,new THREE.PointsMaterial({color:0xa9bdd6,size:.32,transparent:true,opacity:.24})));}
  if(moon) {
    const disc=new THREE.Mesh(new THREE.SphereGeometry(3.4,40,32),new THREE.ShaderMaterial({uniforms:{phase:{value:phase}},vertexShader:'varying vec3 n; void main(){n=normal;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',fragmentShader:'varying vec3 n;uniform float phase;void main(){float d=dot(normalize(n),normalize(vec3((phase-.5)*2.,.15,.7)));float m=.95+.05*sin(n.x*47.)*sin(n.y*38.);gl_FragColor=vec4(vec3(.66,.80,.91)*max(.08,d)*m*2.3,1.);}' }));
    disc.position.set(-31,41,-120);group.add(disc);
  }
  return group;
}
// Integrates density along the eye ray inside a finite cone. Geometry bounds the work; opaque depth occludes the volume.
export function lightVolume({position=[0,4,0],radius=2.5,height=4,color=0xffc68b,density=.22}={}) {
  const mat=new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.BackSide,blending:THREE.AdditiveBlending,premultipliedAlpha:true,
    uniforms:{tint:{value:new THREE.Color(color)},density:{value:density},radius:{value:radius},height:{value:height}},
    vertexShader:'varying vec3 p;varying vec3 eye;void main(){p=position;eye=(inverse(modelMatrix)*vec4(cameraPosition,1.)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader:'varying vec3 p;varying vec3 eye;uniform vec3 tint;uniform float density;uniform float radius;uniform float height;void main(){vec3 ray=normalize(p-eye);float len=min(length(p-eye),height*2.);float sum=0.;for(int i=0;i<16;i++){vec3 q=p-ray*len*(float(i)+.5)/16.;float h=clamp((height*.5-q.y)/height,0.,1.);float r=max(.02,h*radius);float inside=step(-height*.5,q.y)*step(q.y,height*.5);sum+=pow(max(0.,1.-length(q.xz)/r),2.)*inside*(1.-h*.5);}float a=1.-exp(-sum*len/16.*density);gl_FragColor=vec4(tint*a,a*.5);}' });
  const mesh=new THREE.Mesh(new THREE.ConeGeometry(radius,height,48,1,true),mat);mesh.position.set(position[0],position[1]-height/2,position[2]);return mesh;
}

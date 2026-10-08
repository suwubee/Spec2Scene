import * as THREE from '../engine/vendor/three.module.js';
/** Bounded world-space ray march, self shadow and forward scattering. No history buffer. */
export function createCloudSea({bounds=[[-200,15,-200],[200,45,200]],steps=40,shadowSteps=5,density=.15,scale=.035,seed=1,color=[.8,.87,1],silver=1.5}={}){
  if(!Number.isInteger(steps)||steps<8||steps>96||!Number.isInteger(shadowSteps)||shadowSteps<1||shadowSteps>8||!(density>=0)||!(scale>0)||bounds.length!==2||bounds.some(v=>v.length!==3||!v.every(Number.isFinite))||bounds[0].some((v,i)=>v>=bounds[1][i]))throw new Error('invalid cloud sea budget');
  const min=new THREE.Vector3(...bounds[0]),max=new THREE.Vector3(...bounds[1]),size=max.clone().sub(min);
  const uniforms={lo:{value:min},hi:{value:max},time:{value:0},density:{value:density},scale:{value:scale},seed:{value:seed},lightDir:{value:new THREE.Vector3(.4,.6,-.5).normalize()},lightColor:{value:new THREE.Vector3(...color)},silver:{value:silver}};
  const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.BackSide,uniforms,
    vertexShader:'varying vec3 worldPoint;void main(){worldPoint=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*viewMatrix*vec4(worldPoint,1.);}',
    fragmentShader:`varying vec3 worldPoint;uniform vec3 lo,hi,lightDir,lightColor;uniform float time,density,scale,seed,silver;
float hash(vec3 p){return fract(sin(dot(p,vec3(17.13,73.71,41.97))+seed)*43758.5453);}
float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float medium(vec3 p){vec3 q=(p+vec3(time*.55,0.,time*.17))*scale;float n=.57*noise(q)+.29*noise(q*2.03)+.14*noise(q*4.07);vec3 u=(p-lo)/(hi-lo);float edge=smoothstep(0.,.13,u.y)*(1.-smoothstep(.55,1.,u.y));edge*=smoothstep(0.,.08,min(min(u.x,1.-u.x),min(u.z,1.-u.z)));return max(0.,n-.34)*2.8*edge*density;}
void main(){vec3 ray=normalize(worldPoint-cameraPosition);vec3 inv=1./(sign(ray+vec3(.000001))*max(abs(ray),vec3(.00001)));vec3 a=(lo-cameraPosition)*inv,b=(hi-cameraPosition)*inv;vec3 enter=min(a,b),leave=max(a,b);float start=max(0.,max(max(enter.x,enter.y),enter.z)),end=min(min(leave.x,leave.y),leave.z);if(end<=start)discard;float dt=(end-start)/float(${steps}),T=1.;vec3 L=vec3(0.);float phase=.55+silver*pow(max(0.,dot(ray,lightDir)),16.);
for(int i=0;i<${steps};i++){vec3 p=cameraPosition+ray*(start+(float(i)+.5)*dt);float d=medium(p),shadow=0.;for(int j=0;j<${shadowSteps};j++){float ds=(hi.y-lo.y)/float(${shadowSteps});shadow+=medium(p+lightDir*(float(j)+.5)*ds)*ds;}float alpha=1.-exp(-d*dt);L+=T*alpha*lightColor*(.16+exp(-shadow)*phase);T*=1.-alpha;if(T<.005)break;}gl_FragColor=vec4(L/max(1.-T,.0001),1.-T);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`});
  const object=new THREE.Mesh(new THREE.BoxGeometry(size.x,size.y,size.z),material);object.position.copy(min).add(max).multiplyScalar(.5);object.name='cloud-sea';
  return {object,uniforms,update(t,w={}){if(!Number.isFinite(t))throw new Error('finite cloud time required');uniforms.time.value=t;uniforms.lightDir.value.fromArray(w.day>.5?(w.sunDir||[0,1,0]):(w.moonDir||[.4,.6,-.5])).normalize();},dispose(){object.geometry.dispose();material.dispose();}};
}

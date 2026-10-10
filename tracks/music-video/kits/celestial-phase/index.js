import {bakeSurface, phaseLight} from './surface.js';

export function createCelestialPhase(THREE, options = {}) {
  const baked = bakeSurface(options);
  const texture = new THREE.DataTexture(baked.data, baked.width, baked.height, THREE.RGBAFormat, THREE.FloatType);
  texture.wrapS = THREE.RepeatWrapping; texture.minFilter = texture.magFilter = THREE.LinearFilter; texture.needsUpdate = true;
  const uniforms = {
    surface: {value: texture}, size: {value: new THREE.Vector2(640, 360)}, light: {value: new THREE.Vector3()},
    clock: {value: 0}, radius: {value: .29}, earthshine: {value: .025}, cloud: {value: 0},
    seeing: {value: .2}, offset: {value: new THREE.Vector2()}, tint: {value: new THREE.Vector3(.86, .9, 1)},
  };
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const material = new THREE.RawShaderMaterial({glslVersion: THREE.GLSL3, uniforms, depthTest: false, depthWrite: false,
    vertexShader: `precision highp float; in vec3 position; void main(){gl_Position=vec4(position,1.0);}`,
    fragmentShader: `precision highp float;
uniform sampler2D surface;
uniform vec2 size, offset;
uniform vec3 light, tint;
uniform float clock, radius, earthshine, cloud, seeing;
out vec4 color;
const float PI=3.141592653589793;
vec4 sampleSurface(vec3 n){
  return texture(surface,vec2(atan(n.z,n.x)/(2.0*PI)+0.5,asin(clamp(n.y,-1.0,1.0))/PI+0.5));
}
void main(){
  vec2 jitter=seeing*vec2(sin(clock*.83),sin(clock*.67+1.0))/size.y;
  vec2 p=(gl_FragCoord.xy-size*.5)/size.y-offset-jitter;
  vec2 q=p/radius; float r2=dot(q,q);
  vec3 col=vec3(.0018,.0026,.005);
  if(r2<1.0){
    vec3 n=vec3(q,sqrt(1.0-r2));
    vec4 s=sampleSurface(n);
    vec3 east=normalize(vec3(-n.z,0.0,n.x));
    vec3 north=normalize(cross(east,n));
    vec3 normal=normalize(n-east*s.b-north*s.a);
    float cosine=dot(n,light), shadow=1.0;
    // March the actual light ray above the relief, only near grazing incidence.
    if(cosine>0.0 && cosine<.32){
      vec3 start=n*(1.0+s.g);
      for(int i=1;i<=10;i++){
        float distance=.003*float(i*i);
        vec3 ray=start+light*distance;
        float clearance=length(ray)-1.0-sampleSurface(normalize(ray)).g;
        shadow=min(shadow,smoothstep(-.00008,.00018,clearance));
      }
    }
    float direct=max(0.0,dot(normal,light))*smoothstep(-.006,.006,cosine)*shadow;
    float dark=earthshine*(1.0-smoothstep(-.08,.12,cosine));
    col=s.r*(tint*direct+vec3(.55,.68,1.0)*dark);
    float edge=1.0-smoothstep(1.0-2.0/(radius*size.y),1.0,sqrt(r2));
    col=mix(vec3(.0018,.0026,.005),col,edge);
  }
  // One faint filament; closed-form drift, no frame history or random calls.
  float line=p.y-.18*sin(p.x*2.0+clock*.11)-.24+clock*.012;
  float veil=cloud*exp(-line*line/0.0009)*(.55+.45*sin(p.x*17.0+clock*.08));
  col=mix(col,vec3(.08,.095,.12),clamp(veil,0.0,.12));
  color=vec4(pow(max(col,vec3(0.0)),vec3(1.0/2.2)),1.0);
}`});
  const scene = new THREE.Scene(), camera = new THREE.Camera(), mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false; scene.add(mesh);
  function resize(width, height) {
    if (![width, height].every(v => Number.isFinite(v) && v > 0)) throw new Error('Invalid phase viewport');
    uniforms.size.value.set(width, height);
  }
  function update(t, {phase = .5, radius = .29, earthshine = .025, cloud = 0, seeing = .2, offset = [0, 0], drift = .008} = {}) {
    if (![t, phase, radius, earthshine, cloud, seeing, drift, ...offset].every(Number.isFinite) || offset.length !== 2 || radius <= 0 || radius > 1 || earthshine < 0 || cloud < 0 || cloud > 1 || seeing < 0 || seeing > .49) throw new Error('Invalid phase state');
    uniforms.clock.value = t; uniforms.light.value.fromArray(phaseLight(phase));
    for (const [name, value] of Object.entries({radius, earthshine, cloud, seeing})) uniforms[name].value = value;
    uniforms.offset.value.set(offset[0] + drift * Math.sin(t * .13), offset[1] + drift * .5 * Math.cos(t * .17));
  }
  update(0);
  return {scene, camera, texture, uniforms, update, resize, dispose() { geometry.dispose(); material.dispose(); texture.dispose(); }};
}

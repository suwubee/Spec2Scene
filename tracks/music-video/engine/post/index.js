import * as THREE from '../vendor/three.module.js';
export function circleOfConfusion(depth,focus,focal=50,fstop=2.8,sensor=24) {
  const f=focal/1000;return Math.abs(f*f*(depth-focus)/(fstop*Math.max(depth,.001)*Math.max(focus-f,.001)))/(sensor/1000);
}
export function makeLUT(size=16,transform=rgb=>rgb) {
  const data=new Float32Array(size**3*4);
  for(let b=0;b<size;b++)for(let g=0;g<size;g++)for(let r=0;r<size;r++){const i=(b*size*size+g*size+r)*4;data.set([...transform([r/(size-1),g/(size-1),b/(size-1)]),1],i);}
  const texture=new THREE.Data3DTexture(data,size,size,size);texture.format=THREE.RGBAFormat;texture.type=THREE.FloatType;texture.minFilter=texture.magFilter=THREE.LinearFilter;texture.unpackAlignment=1;texture.needsUpdate=true;return texture;
}
const vertex='varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}';
export function createPost(renderer,width,height,{bloom=.16,grain=.0012,vignette=.28,aberration=0,tone='ACES'}={}) {
  const target=()=>{const rt=new THREE.WebGLRenderTarget(width,height,{type:THREE.HalfFloatType,depthBuffer:true});rt.depthTexture=new THREE.DepthTexture(width,height);return rt;};
  const a=target(),b=target(),small=new THREE.WebGLRenderTarget(Math.ceil(width/4),Math.ceil(height/4),{type:THREE.HalfFloatType,depthBuffer:false});
  const screen=new THREE.Scene(),camera=new THREE.Camera(),quad=new THREE.Mesh(new THREE.PlaneGeometry(2,2));screen.add(quad);
  const bloomMaterial=new THREE.ShaderMaterial({uniforms:{source:{value:a.texture},other:{value:b.texture},blend:{value:1},pixel:{value:new THREE.Vector2(1/width,1/height)}},vertexShader:vertex,
    fragmentShader:'varying vec2 vUv;uniform sampler2D source,other;uniform float blend;uniform vec2 pixel;void main(){vec3 c=vec3(0.);for(int x=-2;x<=2;x++)for(int y=-2;y<=2;y++){vec2 uv=vUv+vec2(float(x),float(y))*pixel*5.;vec3 s=mix(texture2D(other,uv).rgb,texture2D(source,uv).rgb,blend);c+=max(s-.65,0.);}gl_FragColor=vec4(c/25.,1.);}'});
  const uniforms={source:{value:a.texture},other:{value:b.texture},depth:{value:a.depthTexture},depthOther:{value:b.depthTexture},glow:{value:small.texture},blend:{value:1},pixel:{value:new THREE.Vector2(1/width,1/height)},lens:{value:new THREE.Vector3(35,16,8)},lensOther:{value:new THREE.Vector3(35,16,8)},near:{value:.1},far:{value:500},bloom:{value:bloom},grain:{value:grain},vignette:{value:vignette},aberration:{value:aberration},time:{value:0},exposure:{value:1},lut:{value:makeLUT()},useLut:{value:0},tone:{value:tone==='AgX'?1:0}};
  const finalMaterial=new THREE.ShaderMaterial({uniforms,vertexShader:vertex,fragmentShader:`
    varying vec2 vUv; uniform sampler2D source,other,depth,depthOther,glow; uniform highp sampler3D lut;
    uniform vec2 pixel; uniform vec3 lens,lensOther; uniform float near,far,blend,bloom,grain,vignette,aberration,time,exposure,useLut,tone;
    float linearDepth(float d){return near*far/(far-d*(far-near));}
    vec3 focusSample(sampler2D tex,sampler2D dep,vec3 l){float z=linearDepth(texture2D(dep,vUv).x);float f=l.x*.001;
      float coc=clamp(abs(f*f*(z-l.y)/(l.z*z*max(l.y-f,.01)))/.024,0.,.022);
      vec3 c=texture2D(tex,vUv).rgb;float weight=1.;
      for(int i=0;i<12;i++){float angle=float(i)*2.399963;vec2 off=vec2(cos(angle),sin(angle))*sqrt((float(i)+.5)/12.)*coc;off.x*=pixel.x/pixel.y;
        float dz=linearDepth(texture2D(dep,vUv+off).x);float w=dz<z*.8?.1:1.;c+=texture2D(tex,vUv+off).rgb*w;weight+=w;}
      return c/weight;}
    vec3 aces(vec3 x){return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.);}
    vec3 agx(vec3 x){vec3 v=clamp((log2(max(x,vec3(1e-6)))+12.47393)/16.5,0.,1.);vec3 v2=v*v,v4=v2*v2;return clamp(15.5*v4*v2-40.14*v4*v+31.96*v4-6.868*v2*v+.4298*v2+.1191*v-.00232,0.,1.);}
    void main(){vec3 c=mix(focusSample(other,depthOther,lensOther),focusSample(source,depth,lens),blend);
      vec3 g=vec3(0.);for(int i=-2;i<=2;i++)g+=texture2D(glow,vUv+vec2(float(i)*.006,0.)).rgb/5.;c+=g*bloom;
      c.r+=aberration*(texture2D(source,vUv+vec2(.002,0.)).r-texture2D(source,vUv).r);
      c*=exposure;c=mix(aces(c),agx(c),tone);c=mix(c,texture(lut,c*.9375+.03125).rgb,useLut);
      c*=1.-vignette*smoothstep(.15,.8,length((vUv-.5)*vec2(1.3,1.)));
      float n=fract(sin(dot(floor(vUv/pixel),vec2(12.9898,78.233))+floor(time*24.)*.13)*43758.5453)-.5;c+=n*grain;
      c=mix(c*12.92,1.055*pow(max(c,0.),vec3(1./2.4))-.055,step(vec3(.0031308),c));gl_FragColor=vec4(c,1.);}`});
  return {a,b,uniforms, render({blend=1,lens,lensOther=lens,t=0,exposure=1}={}) {
    uniforms.blend.value=blend;bloomMaterial.uniforms.blend.value=blend;uniforms.time.value=t;uniforms.exposure.value=exposure;
    for(const [key,state] of [['lens',lens],['lensOther',lensOther]])uniforms[key].value.set(state.focal,state.focus,state.fstop);
    quad.material=bloomMaterial;renderer.setRenderTarget(small);renderer.render(screen,camera);
    quad.material=finalMaterial;renderer.setRenderTarget(null);renderer.render(screen,camera);
  },resize(w,h){a.setSize(w,h);b.setSize(w,h);small.setSize(Math.ceil(w/4),Math.ceil(h/4));uniforms.pixel.value.set(1/w,1/h);bloomMaterial.uniforms.pixel.value.set(1/w,1/h);},dispose(){a.dispose();b.dispose();small.dispose();uniforms.lut.value.dispose();quad.geometry.dispose();bloomMaterial.dispose();finalMaterial.dispose();}};
}

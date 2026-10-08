import * as THREE from '../engine/vendor/three.module.js';

/** Small HDR preview pass; same shot cameras and dissolve weights, no cinematic depth-of-field. */
export async function createPreviewEngine({canvas,width,height,timeline,sets,world,preset}) {
  const pictureHeight=Math.round(width/2.38806),aspect=width/pictureHeight;
  const w=Math.max(2,Math.round(width*preset.scale)),h=Math.max(2,Math.round(pictureHeight*preset.scale));
  const renderer=new THREE.WebGLRenderer({canvas,antialias:false,powerPreference:'high-performance'});
  renderer.setPixelRatio(1);renderer.setSize(w,Math.round(height*preset.scale),false);
  renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.8;renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.shadowMap.enabled=preset.shadow>0;renderer.shadowMap.type=THREE.PCFShadowMap;
  const gl=renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
  const qualityInfo={renderer:String(gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL||gl.RENDERER))};
  if(!gl.getExtension('EXT_color_buffer_float'))throw new Error('HDR preview needs EXT_color_buffer_float');
  const ctx={renderer,aspect,quality:'preview',qualityInfo:{...qualityInfo,...preset},playback:preset};
  const instances=new Map();
  const targets=[0,1].map(()=>new THREE.WebGLRenderTarget(w,h,{type:THREE.HalfFloatType,depthBuffer:true}));
  const composite=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,
    uniforms:{a:{value:targets[0].texture},b:{value:targets[1].texture},blend:{value:0}},
    vertexShader:'varying vec2 v;void main(){v=uv;gl_Position=vec4(position.xy,0.,1.);}',
    fragmentShader:`varying vec2 v;uniform sampler2D a,b;uniform float blend;
      void main(){gl_FragColor=mix(texture2D(a,v),texture2D(b,v),blend);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`});
  const screen=new THREE.Scene(),camera=new THREE.Camera(),quad=new THREE.Mesh(new THREE.PlaneGeometry(2,2),composite);screen.add(quad);
  async function getSet(id) {
    if(!instances.has(id))instances.set(id,await sets[id].create(ctx));
    return instances.get(id);
  }
  return {renderer,qualityInfo,ctx,getSet,
    async seek(t) {
      const layers=timeline.resolve(t);ctx.t=t;ctx.state=world.at(t);
      for(let i=0;i<layers.length;i++) {
        const l=layers[i],inst=await getSet(l.shot.set),cam=inst.camera,pose=inst.cameraAt(l.tLocal,l.shot);
        cam.position.fromArray(pose.pos);cam.up.set(0,1,0);cam.lookAt(...pose.target);cam.fov=pose.fov;cam.aspect=aspect;cam.updateProjectionMatrix();cam.updateMatrixWorld();
        ctx.tLocal=l.tLocal;inst.update(l.tLocal,l.shot,ctx);
        renderer.setRenderTarget(targets[i]);renderer.setViewport(0,0,w,h);renderer.render(inst.scene,cam);
      }
      composite.uniforms.blend.value=layers.length>1?layers[1].weight:0;
      renderer.setRenderTarget(null);renderer.setClearColor(0x000000);renderer.clear();
      renderer.setViewport(0,Math.round((canvas.height-h)/2),w,h);renderer.render(screen,camera);
      return {t,layers:layers.map(l=>({id:l.shot.id,set:l.shot.set}))};
    },
    dispose(){for(const inst of instances.values())inst.dispose?.();targets.forEach(t=>t.dispose());quad.geometry.dispose();composite.dispose();renderer.dispose();}
  };
}

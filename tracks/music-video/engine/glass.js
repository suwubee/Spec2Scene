import * as THREE from './vendor/three.module.js';
/** Local XY pane, +Z normal. Position/rotate object for windows or angled vehicle glass. */
export function createGlassReflection({width=2,height=2,resolution=512,opacity=.35,tint=0xa6bfd0,clipBias=.003}={}){
  if(![width,height,resolution,opacity,clipBias].every(Number.isFinite)||width<=0||height<=0||!Number.isInteger(resolution)||resolution<16||resolution>2048||opacity<0||opacity>1)throw new Error('invalid glass reflection');
  const target=new THREE.WebGLRenderTarget(resolution,resolution,{type:THREE.HalfFloatType}),camera=new THREE.PerspectiveCamera(),textureMatrix=new THREE.Matrix4();
  const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,
    uniforms:{reflection:{value:target.texture},textureMatrix:{value:textureMatrix},tint:{value:new THREE.Color(tint)},opacity:{value:opacity}},
    vertexShader:'uniform mat4 textureMatrix; varying vec4 vReflect; void main(){vec4 p=modelMatrix*vec4(position,1.);vReflect=textureMatrix*p;gl_Position=projectionMatrix*viewMatrix*p;}',
    fragmentShader:'uniform sampler2D reflection; uniform vec3 tint; uniform float opacity; varying vec4 vReflect; void main(){vec3 uv=vReflect.xyz/vReflect.w;vec3 c=texture2D(reflection,uv.xy).rgb;gl_FragColor=vec4(mix(c,tint,.12),opacity);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}'});
  const object=new THREE.Mesh(new THREE.PlaneGeometry(width,height),material);object.name='glass-reflection';
  let busy=false;
  function update(renderer,scene,view){
    if(busy)return false;
    if(!view.isPerspectiveCamera)throw new Error('glass reflection requires a perspective camera');
    object.updateWorldMatrix(true,false);view.updateWorldMatrix(true,false);
    const point=object.getWorldPosition(new THREE.Vector3()),normal=new THREE.Vector3(0,0,1).transformDirection(object.matrixWorld),position=view.getWorldPosition(new THREE.Vector3());
    if(position.clone().sub(point).dot(normal)<0)normal.negate();
    const reflectPoint=p=>p.clone().addScaledVector(normal,-2*p.clone().sub(point).dot(normal));
    const direction=view.getWorldDirection(new THREE.Vector3()),up=new THREE.Vector3(0,1,0).transformDirection(view.matrixWorld).reflect(normal);
    camera.copy(view,false);camera.position.copy(reflectPoint(position));camera.up.copy(up);camera.lookAt(reflectPoint(position.add(direction)));camera.updateMatrixWorld(true);camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    camera.projectionMatrix.copy(view.projectionMatrix);
    textureMatrix.set(.5,0,0,.5,0,.5,0,.5,0,0,.5,.5,0,0,0,1).multiply(camera.projectionMatrix).multiply(camera.matrixWorldInverse);
    // Oblique near plane excludes geometry behind the glass, including the wall supporting it.
    const plane=new THREE.Plane().setFromNormalAndCoplanarPoint(normal,point).applyMatrix4(camera.matrixWorldInverse),clip=new THREE.Vector4(plane.normal.x,plane.normal.y,plane.normal.z,plane.constant),p=camera.projectionMatrix.elements;
    const q=new THREE.Vector4((Math.sign(clip.x)+p[8])/p[0],(Math.sign(clip.y)+p[9])/p[5],-1,(1+p[10])/p[14]);
    const dot=clip.dot(q);if(Math.abs(dot)<1e-8)return false;clip.multiplyScalar(2/dot);
    p[2]=clip.x;p[6]=clip.y;p[10]=clip.z+1-clipBias;p[14]=clip.w;camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    const oldTarget=renderer.getRenderTarget(),oldVisible=object.visible,oldXR=renderer.xr.enabled,oldAuto=renderer.autoClear,oldShadow=renderer.shadowMap.autoUpdate;
    const viewport=renderer.getViewport(new THREE.Vector4()),scissor=renderer.getScissor(new THREE.Vector4()),scissorTest=renderer.getScissorTest();
    busy=true;
    try{object.visible=false;renderer.xr.enabled=false;renderer.shadowMap.autoUpdate=false;renderer.autoClear=true;renderer.setRenderTarget(target);renderer.setScissorTest(false);renderer.clear();renderer.render(scene,camera);return true;}
    finally{object.visible=oldVisible;renderer.xr.enabled=oldXR;renderer.shadowMap.autoUpdate=oldShadow;renderer.autoClear=oldAuto;renderer.setRenderTarget(oldTarget);renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(scissorTest);busy=false;}
  }
  return {object,target,camera,textureMatrix,update,dispose(){target.dispose();object.geometry.dispose();material.dispose();}};
}

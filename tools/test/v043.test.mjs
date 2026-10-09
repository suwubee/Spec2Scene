import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../tracks/music-video/engine/vendor/three.module.js';
import {ensureFixedLightLayout,FIXED_LIGHT_LAYOUTS} from '../../tracks/music-video/player/fixed-lights.js';
import {estimateGpuMemory} from '../../tracks/music-video/player/memory.js';
import {PRESETS,chooseStartMode} from '../../tracks/music-video/player/quality.js';
import {assertNoNewPrograms,programIdentitySet} from '../../tracks/music-video/player/compile-monitor.js';

function signature(scene,camera){
  const counts={};scene.traverseVisible(o=>{if(!o.isLight||!o.layers.test(camera.layers))return;const key=o.type+(o.castShadow?'-shadow':'');counts[key]=(counts[key]||0)+1;});return counts;
}
test('fixed lights preserve camera/layer/ancestor and shadow signatures, restore the previous scene hook and reject overflow',()=>{
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(),group=new THREE.Group();scene.add(group);
  const key=new THREE.DirectionalLight(0xffffff,2);key.castShadow=true;group.add(key);
  const point=new THREE.PointLight(0xff0000,1);point.layers.set(2);scene.add(point);
  let calls=0;const hook=()=>calls++;scene.onBeforeRender=hook;
  const rig=ensureFixedLightLayout(scene,'outdoor');assert.equal(ensureFixedLightLayout(scene),rig);
  scene.onBeforeRender(null,scene,camera);const initial=signature(scene,camera);assert.equal(calls,1);
  group.visible=false;rig.update(camera);assert.deepEqual(signature(scene,camera),initial);
  camera.layers.set(2);rig.update(camera);assert.deepEqual(signature(scene,camera),initial);
  assert.ok(rig.placeholders.every(l=>l.intensity===0));assert.equal(key.intensity,2);
  for(let i=0;i<FIXED_LIGHT_LAYOUTS.outdoor.point;i++){const light=new THREE.PointLight();light.layers.set(2);scene.add(light);}
  rig.refresh();assert.throws(()=>rig.update(camera),/budget exceeded/);
  rig.dispose();assert.equal(scene.onBeforeRender,hook);assert.ok(rig.placeholders.every(l=>!l.parent));
  assert.throws(()=>ensureFixedLightLayout(new THREE.Scene(),{directional:1,directionalShadow:2}),/Invalid/);
});
test('resident estimate includes hidden objects, shared interleaved/morph/instance buffers and numeric texture formats',()=>{
  const scene=new THREE.Scene(),g=new THREE.BufferGeometry();
  const data=new THREE.InterleavedBuffer(new Float32Array(18),6);g.setAttribute('position',new THREE.InterleavedBufferAttribute(data,3,0));g.setAttribute('normal',new THREE.InterleavedBufferAttribute(data,3,3));
  g.setIndex([0,1,2]);g.morphAttributes.position=[new THREE.Float32BufferAttribute(new Float32Array(9),3)];
  const texture=new THREE.DataTexture(new Uint16Array(8*4*2),8,4,THREE.RGFormat,THREE.HalfFloatType);texture.generateMipmaps=false;
  const mat=new THREE.ShaderMaterial({uniforms:{maps:{value:[texture,texture]}}});
  const mesh=new THREE.Mesh(g,mat);mesh.visible=false;scene.add(mesh,new THREE.Mesh(g,mat));
  const rt=new THREE.WebGLRenderTarget(8,4,{type:THREE.HalfFloatType,depthBuffer:true,samples:2});
  const result=estimateGpuMemory({scenes:[scene,scene],renderTargets:[rt,rt]});
  assert.equal(result.scenes,1);assert.equal(result.geometryBytes,72+6+36);assert.equal(result.textureBytes,128);assert.equal(result.renderTargetBytes,(8*4*8+8*4*4)*3);
  assert.equal(result.textures,1);assert.equal(result.totalBytes,result.geometryBytes+result.textureBytes+result.renderTargetBytes);
  g.dispose();mat.dispose();texture.dispose();rt.dispose();
});
test('warm start threshold, fixed MSAA and program identity replacement are explicit',()=>{
  assert.equal(new Set(Object.values(PRESETS).map(q=>q.msaa)).size,1);
  for(const [warm,expected] of [[null,'a'],[{etaMs:null},'a'],[{etaMs:20001},'a'],[{etaMs:20000},'b'],[{etaMs:0},'b'],[{etaMs:0,done:true},'a']])assert.equal(chooseStartMode('auto',warm),expected);
  assert.equal(chooseStartMode('a',{etaMs:1}),'a');assert.equal(chooseStartMode('b',null),'b');
  const a={},b={};const before=programIdentitySet({info:{programs:[{program:a}]}}),after=programIdentitySet({info:{programs:[{program:b}]}});
  assert.throws(()=>assertNoNewPrograms(before,after),/new program identities/);assertNoNewPrograms(before,new Set(before));
});

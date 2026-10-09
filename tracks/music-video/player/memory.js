import * as THREE from '../engine/vendor/three.module.js';

/** Resident resource estimate, not a measurement of driver VRAM. Hidden objects
 * still occupy memory. GPU buffers are deduplicated by attribute/interleaved data,
 * textures by object (distinct sampler configurations can allocate distinct storage).
 */
export function estimateGpuMemory({scenes=[],renderTargets=[]}={}){
  const roots=new Set(scenes?.isObject3D?[scenes]:scenes),textures=new Set(),buffers=new Set(),geometries=new Set(),seen=new Set();
  let geometryBytes=0,textureBytes=0,renderTargetBytes=0,unknownTextures=0;
  function buffer(attribute){if(!attribute)return;const data=attribute.isInterleavedBufferAttribute?attribute.data:attribute;if(buffers.has(data))return;buffers.add(data);geometryBytes+=data.array?.byteLength||0;}
  function visit(value){
    if(!value||typeof value!=='object'||seen.has(value))return;seen.add(value);
    if(value.isTexture){textures.add(value);return;}
    if(Array.isArray(value)){value.forEach(visit);return;}
    // Material properties, shader uniforms and material extension uniforms only.
    if(value.isMaterial||Object.getPrototypeOf(value)===Object.prototype)for(const [key,v] of Object.entries(value))if(key!=='parent')visit(v);
  }
  for(const scene of roots){
    visit(scene.background);visit(scene.environment);
    scene.traverse(o=>{
      const g=o.geometry;if(g&&!geometries.has(g)){geometries.add(g);Object.values(g.attributes).forEach(buffer);buffer(g.index);Object.values(g.morphAttributes||{}).flat().forEach(buffer);}
      buffer(o.instanceMatrix);buffer(o.instanceColor);visit(o.material);
    });
  }
  function texBytes(t){
    const images=Array.isArray(t.image)?t.image:[t.image||t.source?.data];
    if(t.isCompressedTexture){return (t.mipmaps||[]).reduce((n,m)=>n+(m.data?.byteLength||0),0);}
    const ch=t.format===THREE.RedFormat||t.format===THREE.DepthFormat?1:t.format===THREE.RGFormat?2:t.format===THREE.RGBFormat?3:4;
    const scalar=[THREE.FloatType,THREE.UnsignedIntType,THREE.IntType].includes(t.type)?4:[THREE.HalfFloatType,THREE.UnsignedShortType,THREE.ShortType].includes(t.type)?2:1;
    const bpp=t.type===THREE.UnsignedInt248Type?4:ch*scalar;
    let bytes=0;
    for(const im0 of images){const im=im0?.image||im0;if(!im?.width||!im?.height){unknownTextures++;continue;}bytes+=im.width*im.height*(im.depth||1)*bpp*(t.generateMipmaps?4/3:1);}
    return bytes;
  }
  const targets=new Set(renderTargets),attachments=new Set([...targets].flatMap(rt=>[...(rt.textures||[rt.texture]),rt.depthTexture].filter(Boolean)));
  for(const t of textures)if(!attachments.has(t)&&!t.isRenderTargetTexture)textureBytes+=texBytes(t);
  for(const rt of targets){const color=(rt.textures||[rt.texture]).reduce((n,t)=>n+texBytes(t),0),depth=rt.depthBuffer?rt.width*rt.height*4:0;renderTargetBytes+=(color+depth)*(1+(rt.samples||0));}
  const totalBytes=textureBytes+geometryBytes+renderTargetBytes,mb=n=>Math.round(n/2**20*10)/10;
  return {scenes:roots.size,textures:textures.size,geometryBuffers:buffers.size,textureBytes,geometryBytes,renderTargetBytes,totalBytes,
    textureMB:mb(textureBytes),geometryMB:mb(geometryBytes),renderTargetMB:mb(renderTargetBytes),totalMB:mb(totalBytes),unknownTextures,
    scope:'estimate: referenced textures, geometry buffers and supplied render targets; excludes driver overhead and unlisted targets'};
}
export const estimateMemory=estimateGpuMemory;

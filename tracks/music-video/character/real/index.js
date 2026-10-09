/**
 * External, production-oriented character adapter.
 *
 * The repository deliberately does not ship a GLB or an animation pack.  A
 * project owns its loader and its licensed files, then calls
 * `prepareRealCharacter()` once during boot.  The returned factory has the
 * same `{object, rig, update(), inspect()}` surface as `createCharacter()`.
 * When a project has no asset yet, the factory returns the procedural actor so
 * a scene can still be reviewed without pretending that a real model loaded.
 */
import * as THREE from '../../engine/vendor/three.module.js';
import {createCharacter} from '../index.js';
import {adaptExternalCharacter} from '../external.js';
import {createSilhouetteMaterial, applyCharacterLook} from '../look.js';
import {inspectRig} from '../rig.js';

const V=()=>new THREE.Vector3();
const CANONICAL=['hips','chest','neck','leftUpperArm','leftLowerArm','leftHand','rightUpperArm','rightLowerArm','rightHand','leftUpperLeg','leftLowerLeg','leftFoot','rightUpperLeg','rightLowerLeg','rightFoot'];
const ALIASES={
  hips:['hips','pelvis','root','mixamorig:hips','pelvis_bone'],
  chest:['chest','spine_03','spine3','spine_02','spine2','spine'],
  neck:['neck','neck_01','neck1','mixamorig:neck'],
  leftUpperArm:['leftupperarm','upperarm_l','upperarm.l','upperarm_l.001','mixamorig:leftarm','l_upperarm'],
  leftLowerArm:['leftlowerarm','lowerarm_l','lowerarm.l','mixamorig:leftforearm','l_forearm'],
  leftHand:['lefthand','hand_l','hand.l','mixamorig:lefthand','l_hand'],
  rightUpperArm:['rightupperarm','upperarm_r','upperarm.r','mixamorig:rightarm','r_upperarm'],
  rightLowerArm:['rightlowerarm','lowerarm_r','lowerarm.r','mixamorig:rightforearm','r_forearm'],
  rightHand:['righthand','hand_r','hand.r','mixamorig:righthand','r_hand'],
  leftUpperLeg:['leftupperleg','thigh_l','thigh.l','mixamorig:leftupleg','l_thigh'],
  leftLowerLeg:['leftlowerleg','calf_l','calf.l','mixamorig:leftleg','l_calf','shin_l'],
  leftFoot:['leftfoot','foot_l','foot.l','mixamorig:leftfoot','l_foot'],
  rightUpperLeg:['rightupperleg','thigh_r','thigh.r','mixamorig:rightupleg','r_thigh'],
  rightLowerLeg:['rightlowerleg','calf_r','calf.r','mixamorig:rightleg','r_calf','shin_r'],
  rightFoot:['rightfoot','foot_r','foot.r','mixamorig:rightfoot','r_foot'],
};
const cleanName=name=>String(name||'').toLowerCase().replace(/[ :.-]/g,'');
const asList=value=>Array.isArray(value)?value:[value];

function allBones(scene){const list=[];scene.traverse(o=>{if(o.isBone||o.type==='Bone')list.push(o);});return list;}
function resolveMapping(scene, mapping={}){
  const bones=allBones(scene), byName=new Map();
  for(const bone of bones){const key=cleanName(bone.name);if(!byName.has(key))byName.set(key,[]);byName.get(key).push(bone);}
  const out={};
  for(const key of CANONICAL){
    const supplied=mapping[key];
    if(supplied?.isObject3D){out[key]=supplied;continue;}
    const wanted=asList(supplied??ALIASES[key]).map(cleanName);
    const matches=wanted.flatMap(name=>byName.get(name)||[]);
    const unique=[...new Set(matches)];
    if(unique.length!==1)throw new Error(`missing or ambiguous external bone: ${key}`);
    out[key]=unique[0];
  }
  return out;
}

function normaliseScene(scene,height){
  if(!scene?.isObject3D)throw new TypeError('scene is required');
  scene.updateMatrixWorld(true);
  const box=new THREE.Box3();let found=false;
  scene.traverse(o=>{if(!o.isMesh)return;o.geometry?.computeBoundingBox?.();if(o.geometry?.boundingBox){box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));found=true;}});
  if(!found||!Number.isFinite(box.min.y)||box.max.y<=box.min.y)throw new Error('external scene has no measurable mesh bounds');
  if(height!==undefined){if(!Number.isFinite(height)||height<1.2||height>2.2)throw new Error('height must be 1.2..2.2');const scale=height/(box.max.y-box.min.y);scene.scale.multiplyScalar(scale);scene.position.y-=box.min.y*scale;}
  scene.updateMatrixWorld(true);return scene;
}

function convertMaterials(root,{albedo=[.045,.046,.05],preserveHairTexture=false}={}){
  root.traverse(node=>{
    if(!node.isMesh||!node.material)return;
    const hair=/hair|scalp|ponytail|bun/i.test(node.name||'');
    node.material=asList(node.material).map(source=>createSilhouetteMaterial(source,{color:albedo,preserveMap:hair&&preserveHairTexture}));
    if(node.material.length===1)node.material=node.material[0];
  });
}

function addShell(actor,{coat=true,coatStyle='long',scarf=true,bun=true,coatColor=0x25272c,scarfColor=0x343840,hairColor=0x0b0c0e}={}){
  const root=actor.object, box=new THREE.Box3().setFromObject(root), size=box.getSize(V()), center=box.getCenter(V());
  const radius=Math.max(.08,Math.max(size.x,size.z)*.52);
  const garments=[];
  const shellMat=new THREE.MeshPhysicalMaterial({color:coatColor,roughness:1,metalness:0,specularIntensity:0,envMapIntensity:0,side:THREE.DoubleSide});shellMat.userData.spec2sceneSilhouette=true;
  if(coat){
    const geometry=coatStyle==='cloak'?new THREE.ConeGeometry(radius*1.45,radius*3.7,32,4,true):new THREE.CylinderGeometry(radius*(coatStyle==='short'?1.03:1.28),radius*(coatStyle==='short'?1.12:1.55),radius*(coatStyle==='short'?2.15:3.7),32,4,true);
    const mesh=new THREE.Mesh(geometry,shellMat);mesh.name=`real-${coatStyle}-shell`;mesh.position.set(center.x,box.min.y+radius*(coatStyle==='short'?1.08:1.85),center.z);mesh.userData.thickness=.007;mesh.userData.procedural=true;mesh.castShadow=mesh.receiveShadow=true;root.add(mesh);garments.push(mesh);
  }
  if(scarf){
    const mat=shellMat.clone();mat.color.setHex(scarfColor);mat.specularIntensity=0;const ring=new THREE.Mesh(new THREE.TorusGeometry(radius*.34,radius*.075,8,32),mat);ring.name='real-scarf-wrap';ring.rotation.x=Math.PI/2;ring.position.set(center.x,box.max.y-radius*.72,center.z);root.add(ring);garments.push(ring);
    for(const [i,z] of [[0,radius*.12],[1,-radius*.12]]){const tail=new THREE.Mesh(new THREE.BoxGeometry(radius*.28,radius*1.9,radius*.08),mat);tail.name=`real-scarf-tail-${i}`;tail.position.set(center.x+(i?-.1:.1)*radius,box.max.y-radius*1.45,center.z+z);tail.rotation.z=(i?-.08:.08);root.add(tail);garments.push(tail);}
  }
  if(bun){const mat=shellMat.clone();mat.color.setHex(hairColor);mat.specularIntensity=0;const mesh=new THREE.Mesh(new THREE.SphereGeometry(radius*.38,16,12),mat);mesh.name='real-bun';mesh.position.set(center.x,box.max.y-radius*.35,center.z-radius*.34);mesh.scale.set(1,.78,.9);root.add(mesh);garments.push(mesh);}
  return {garments,update(t,pose){const wind=Number.isFinite(pose?.secondary)?pose.secondary:Math.sin(t*2.1)*.02;for(const mesh of garments){if(mesh.name.includes('shell'))mesh.rotation.z=wind*.18;else if(mesh.name.includes('tail'))mesh.rotation.x=wind*.8;}}};
}
export const createProceduralWardrobe=(actor,options={})=>addShell(actor,options);

/** Retarget an animation clip's node paths without changing its shader/runtime. */
export function retargetAnimationClip(clip,{mapping={},scale=1,name}={}){
  if(!clip?.tracks||!Number.isFinite(scale)||scale<=0)throw new TypeError('clip and positive scale are required');
  const bySource=new Map(Object.entries(mapping).map(([from,to])=>[cleanName(from),to?.name||String(to)]));
  const tracks=clip.tracks.map(track=>{const dot=track.name.indexOf('.'),source=dot<0?track.name:track.name.slice(0,dot),path=dot<0?'':track.name.slice(dot);const target=bySource.get(cleanName(source))||source;const copy=track.clone();copy.name=target+path;if(path==='.position'&&scale!==1)for(let i=0;i<copy.values.length;i++)copy.values[i]*=scale;return copy;});
  return new THREE.AnimationClip(name||`${clip.name||'clip'}:retargeted`,clip.duration,tracks);
}

/** Retarget all named UAL clips. `actions` maps public action → source clip name. */
export function retargetUALClips(animations=[],{mapping={},scale=1,actions={walk:'Walk_Formal_Loop',windWalk:'Walk_Loop',stop:'Walk_Formal_Loop'}}={}){
  const list=Array.isArray(animations)?animations:animations.animations||[];const byName=new Map(list.map(clip=>[clip.name,clip]));const result={};
  for(const [action,sourceName] of Object.entries(actions)){const source=byName.get(sourceName)||list.find(c=>c.name?.toLowerCase()===String(sourceName).toLowerCase());if(source)result[action]=retargetAnimationClip(source,{mapping,scale,name:action});}
  return result;
}

function fallbackFactory(options={}){
  const actor=createCharacter({coatStyle:options.coatStyle||'long',hairStyle:'bun',...options});
  const update=actor.update.bind(actor);let lastPose=null;
  actor.update=(action,t,opts={})=>(lastPose=update(action,t,opts));
  actor.inspect=()=>lastPose?{status:inspectRig(actor.rig,lastPose).errors.length?'FAIL':'PASS',...inspectRig(actor.rig,lastPose)}:{status:'SKIP',errors:['update the actor before inspection']};
  actor.fallback={status:'SKIP',reason:'no licensed external character asset was provided; using the procedural character'};
  return actor;
}

function makeActor(scene,{license,mapping={},height=1.66,clips={},coat=true,scarf=true,bun=true,look=true,lookOptions={},...wardrobe}={}){
  if(typeof license!=='string'||!license.trim())throw new Error('record the user-provided asset license before adaptation');
  normaliseScene(scene,height);const resolved=resolveMapping(scene,mapping);const adapter=adaptExternalCharacter({scene,mapping:resolved,license});
  convertMaterials(adapter.object,lookOptions);const clothes=addShell(adapter,{coat,scarf,bun,...wardrobe});
  if(look)applyCharacterLook(adapter,{rim:null,...lookOptions});
  const clipList=clips?.animations||clips;const clipMap=Array.isArray(clipList)?Object.fromEntries(clipList.map(clip=>[clip.name,clip])):(clipList&&typeof clipList==='object'?clipList:{});let mixer=null,activeClip=null,lastClipAction=null;
  if(Object.keys(clipMap).length){mixer=new THREE.AnimationMixer(adapter.object);for(const clip of Object.values(clipMap))if(clip?.tracks)clipMap[clip.name||'clip']=clip;}
  const api={...adapter,object:adapter.object,head:resolved.head||resolved.neck,mapped:resolved,garments:clothes.garments,capabilities:{...adapter.capabilities,clips:Object.keys(clipMap)},
    update(action,t,options={}){
      const requested=action==='breathe'?'stand':action;
      const clipDriven=Boolean(mixer&&clipMap[requested]&&options.useClips!==false);
      let pose;
      if(clipDriven){
        pose=adapter.update('stand',t,options);const clip=clipMap[requested];if(activeClip!==clip){activeClip&&mixer.existingAction(activeClip)?.stop();activeClip=clip;mixer.clipAction(clip).play();}mixer.setTime(((t%clip.duration)+clip.duration)%clip.duration);lastClipAction=requested;
        // Apply the small, deterministic overlays after the imported base clip.
        if(options.lookUp||requested==='lookUp')resolved.neck.rotation.x-=Math.min(.9,Math.max(0,.48*Math.min(1,t/2)));
      }else{pose=adapter.update(requested,t,options);lastClipAction=null;}
      clothes.update(t,pose);api.lastPose=pose;return pose;
    },
    inspect(previous){if(lastClipAction)return {status:'SKIP',errors:[],reason:'clip-driven motion needs the project asset review sequence',capabilities:api.capabilities};return adapter.inspect(previous);},
    beforeRender(renderer,scene,camera){api.outerEdgePass??=createOuterEdgeMaskPass({actor:api,width:options.maskWidth||512,height:options.maskHeight||512});return api.outerEdgePass.render(renderer,scene,camera);},
  };
  return api;
}

/** Adapt an already loaded MPFB2/MakeHuman scene synchronously. */
export function adaptRealCharacter(options={}){return makeActor(options.scene,{...options});}

/** Load one GLB and optionally a Quaternius UAL GLB with the project loader. */
export async function loadRealCharacter({url,loader,ual,clips,license,mapping,...options}={}){
  if(!loader?.loadAsync||!url)throw new TypeError('url and a project-owned glTF/VRM loader are required');
  const gltf=await loader.loadAsync(url);let clipMap=clips;
  if(ual){const animationAsset=await loader.loadAsync(ual);clipMap=retargetUALClips(animationAsset.animations,{mapping:options.clipMapping||mapping||{},scale:options.clipScale||1,actions:options.clipActions});}
  return makeActor(gltf.scene,{...options,mapping,license,clips:clipMap});
}

/**
 * Prepare once, then clone/construct actors synchronously.  Without a URL or
 * when an optional asset is unavailable, return a clearly documented
 * procedural fallback rather than a fake “real” result.
 */
export async function prepareRealCharacter({url,loader,ual,license,mapping,clips,fallback=true,...options}={}){
  if(!url||!loader?.loadAsync){return actorOptions=>fallbackFactory({...options,...actorOptions});}
  try{
    const gltf=await loader.loadAsync(url);let clipMap=clips;
    if(ual){const source=await loader.loadAsync(ual);clipMap=retargetUALClips(source.animations,{mapping:options.clipMapping||mapping||{},scale:options.clipScale||1,actions:options.clipActions});}
    return actorOptions=>makeActor(gltf.scene,{...options,...actorOptions,mapping,license,clips:clipMap});
  }catch(error){if(!fallback)throw error;const factory=actorOptions=>fallbackFactory({...options,...actorOptions});factory.fallback={status:'SKIP',reason:`licensed character asset unavailable: ${error.message}`};return factory;}
}

export const prepareRealChar=prepareRealCharacter;
export const createExternalCharacter=adaptRealCharacter;
export const createRealCharacter=adaptRealCharacter;
export const loadExternalCharacter=loadRealCharacter;

/** A stable, prewarmable outer-edge mask pass. It never mutates shader defines per frame. */
export function createOuterEdgeMaskPass({width=512,height=512,actor=null}={}){
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1)throw new TypeError('positive mask dimensions required');
  const target=new THREE.WebGLRenderTarget(width,height,{depthBuffer:true,stencilBuffer:false});target.texture.name='character-outer-edge-mask';
  const maskMaterial=new THREE.MeshBasicMaterial({color:0xffffff,side:THREE.DoubleSide});maskMaterial.name='character-outer-edge-mask';
  const rimMaterial=new THREE.ShaderMaterial({uniforms:{uMask:{value:target.texture},uTexel:{value:new THREE.Vector2(1/width,1/height)},uColor:{value:new THREE.Color(0.62,.72,.9)},uStrength:{value:1}},vertexShader:'void main(){gl_Position=vec4(position,1.0);}',fragmentShader:'uniform sampler2D uMask;uniform vec2 uTexel;uniform vec3 uColor;uniform float uStrength;void main(){vec2 uv=gl_FragCoord.xy*uTexel;float c=texture2D(uMask,uv).r;float n=0.;for(int i=0;i<8;i++){float a=float(i)*.785398;vec2 d=vec2(cos(a),sin(a))*uTexel*2.5;n=max(n,(1.-texture2D(uMask,uv+d).r));}gl_FragColor=vec4(uColor,n*c*uStrength);}',depthTest:false,depthWrite:false,transparent:true});
  rimMaterial.customProgramCacheKey=()=>'character-outer-edge-v1';
  const pass={target,maskMaterial,rimMaterial,actor,signature:'character-outer-edge-v1',programKey:'character-outer-edge-v1',ready:false,
    resize(w,h){if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1)throw new TypeError('positive mask dimensions required');target.setSize(w,h);rimMaterial.uniforms.uTexel.value.set(1/w,1/h);},
    warm(renderer,scene,camera){if(renderer?.compile&&scene&&camera)renderer.compile(scene,camera);pass.ready=true;return pass;},
    render(renderer,scene,camera){if(!renderer||!scene||!camera||!actor?.object)return pass;const previous=scene.overrideMaterial,hidden=[];for(const child of scene.children){if(child!==actor.object&&!actor.object.getObjectById(child.id))hidden.push([child,child.visible]),child.visible=false;}scene.overrideMaterial=maskMaterial;const old=renderer.getRenderTarget?.();renderer.setRenderTarget(target);renderer.clear?.();renderer.render(scene,camera);renderer.setRenderTarget(old||null);scene.overrideMaterial=previous;for(const [node,visible] of hidden)node.visible=visible;actor.object.userData.outerEdgeMask=target.texture;pass.ready=true;return pass;},
    dispose(){target.dispose();maskMaterial.dispose();rimMaterial.dispose();pass.ready=false;},
  };return pass;
}
export const createRimOutlinePass=createOuterEdgeMaskPass;

export function attachOuterEdgePass(actor,options={}){if(!actor?.object)throw new TypeError('actor.object is required');const pass=createOuterEdgeMaskPass({actor,...options});actor.outerEdgePass=pass;actor.beforeRender=(renderer,scene,camera)=>pass.render(renderer,scene,camera);return pass;}

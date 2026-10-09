import * as THREE from '../engine/vendor/three.module.js';

// Total lights, including shadow casters. Keep indoor and outdoor budgets separate.
export const FIXED_LIGHT_LAYOUTS=Object.freeze({
  indoor:Object.freeze({directional:2,directionalShadow:1,point:6,pointShadow:1,spot:4,spotShadow:0,hemisphere:1}),
  outdoor:Object.freeze({directional:2,directionalShadow:1,point:4,pointShadow:0,spot:1,spotShadow:0,hemisphere:1}),
});
const kinds=['directional','point','spot','hemisphere'];
const kindOf=o=>o.isDirectionalLight?'directional':o.isPointLight?'point':o.isSpotLight?'spot':o.isHemisphereLight?'hemisphere':null;
function placeholder(kind,shadow){
  const light=kind==='directional'?new THREE.DirectionalLight(0xffffff,0):kind==='point'?new THREE.PointLight(0xffffff,0,1):kind==='spot'?new THREE.SpotLight(0xffffff,0,1):new THREE.HemisphereLight(0,0,0);
  light.name=`fixed-light.${kind}`;light.userData.fixedLightPlaceholder=true;light.layers.enableAll();light.visible=false;
  light.position.set(0,-10000,0);
  if(shadow){light.castShadow=true;light.shadow.mapSize.set(16,16);light.shadow.camera.near=.1;light.shadow.camera.far=1;}
  return light;
}
/** Pad the lights actually visible to each camera, including reflection/FX passes.
 * Never hide a real light to silence it: set intensity=0. Call refresh() after adding lights.
 * Overflow is an error: silently expanding the signature defeats program reuse.
 */
export function ensureFixedLightLayout(scene,layout='outdoor'){
  if(scene.userData.fixedLightRig)return scene.userData.fixedLightRig;
  const source=typeof layout==='string'?FIXED_LIGHT_LAYOUTS[layout]:layout;
  if(!source)throw new Error('Unknown fixed light layout');
  const counts={},pools={};
  for(const kind of kinds){
    const n=source[kind]??0,sh=source[kind+'Shadow']??0;
    if(!Number.isInteger(n)||!Number.isInteger(sh)||sh<0||n<sh||n>32)throw new RangeError('Invalid light budget');
    counts[kind]=n;if(kind!=='hemisphere')counts[kind+'Shadow']=sh;
    for(const [key,size,shadow] of [[kind,n-sh,false],...(kind==='hemisphere'?[]:[[kind+'Shadow',sh,true]])]){
      pools[key]=Array.from({length:size},()=>{const light=placeholder(kind,shadow);scene.add(light);if(light.target)scene.add(light.target);return light;});
    }
  }
  let real=[];const previous=scene.onBeforeRender;
  const rig={counts,placeholders:Object.values(pools).flat(),
    refresh(){real=[];scene.traverse(o=>{if(kindOf(o)&&!o.userData.fixedLightPlaceholder)real.push(o);});},
    update(camera){
      const actual=Object.fromEntries(Object.keys(pools).map(k=>[k,0]));
      for(const light of real){let visible=true;for(let p=light;p;p=p.parent)visible&&=p.visible;if(!visible||!light.layers.test(camera.layers))continue;
        const kind=kindOf(light);actual[kind+(kind!=='hemisphere'&&light.castShadow?'Shadow':'')]++;
      }
      for(const kind of kinds){
        const sh=kind==='hemisphere'?0:counts[kind+'Shadow'],usedSh=actual[kind+'Shadow']||0;
        if(actual[kind]>counts[kind]-sh||usedSh>sh)throw new Error(`Fixed light budget exceeded: ${kind}`);
        pools[kind].forEach((l,i)=>l.visible=i<counts[kind]-sh-actual[kind]);
        pools[kind+'Shadow']?.forEach((l,i)=>{l.visible=i<sh-usedSh;l.shadow.autoUpdate=!l.shadow.map;});
      }
      return actual;
    },
    dispose(){scene.onBeforeRender=previous;for(const light of rig.placeholders){light.shadow?.dispose();light.removeFromParent();light.target?.removeFromParent();}delete scene.userData.fixedLightRig;},
  };
  scene.onBeforeRender=function(renderer,s,camera,...rest){previous?.call(this,renderer,s,camera,...rest);rig.update(camera);};
  rig.refresh();scene.userData.fixedLightRig=rig;return rig;
}
export const attachFixedLights=ensureFixedLightLayout;
export const fixedLightCounts=scene=>({...scene.userData.fixedLightRig?.counts});

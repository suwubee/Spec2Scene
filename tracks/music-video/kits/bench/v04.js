import * as THREE from '../../engine/vendor/three.module.js';
import {createEngine,defaultWorld} from '../../engine/core.js';
import {createSky} from '../../engine/sky.js';
import {createAtmosphere,makeValleyMaterial} from '../../engine/terrain.js';
import {createLightShaft} from '../../engine/particles.js';
import {createCloudSea} from '../cloud-sea.js';
import {createSmallWater} from '../small-water.js';
import {createRock} from '../rock.js';
import {createInteriorMoonlight} from '../moonlight-interior.js';
import {createMountainLOD} from '../heightfield.js';
import {createCharacter} from '../../character/index.js';
import {inspectRig} from '../../character/rig.js';
import {characterBounds} from '../../engine/composition.js';
import {createLyrics} from '../../engine/lyrics.js';
const q=new URLSearchParams(location.search),mode=q.get('mode')||'cloud',canvas=document.querySelector('canvas'),width=+(q.get('w')||640),height=+(q.get('h')||360);
try{
  let inspect=()=>({mode});
  const create=ctx=>{
    const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(42,width/height,.05,3000),objects=[],cleanups=[];
    scene.background=new THREE.Color(0x142235);scene.add(new THREE.HemisphereLight(0xb8d6ff,0x353b45,1.3));const key=new THREE.DirectionalLight(0xd0e1ff,2);key.position.set(-3,8,4);scene.add(key);
    const floor=new THREE.Mesh(new THREE.PlaneGeometry(100,100),new THREE.MeshStandardMaterial({color:0x45515b,roughness:.9}));floor.rotation.x=-Math.PI/2;scene.add(floor);camera.position.set(3,2.4,5);camera.lookAt(0,.6,0);
    let update=()=>{},character;
    if(mode==='cloud'){
      floor.visible=false;const cloud=createCloudSea({bounds:[[-60,0,-80],[60,12,15]],scale:.065,density:.5,steps:48});scene.add(cloud.object);objects.push(cloud);camera.position.set(0,21,30);camera.lookAt(0,3,-30);update=(t,w)=>cloud.update(t,w);
    }else if(mode==='water'){
      const kits=[createSmallWater({kind:'basin',radius:.65,height:.6,position:[-1.3,0,0]}),createSmallWater({kind:'jar',radius:.52,height:.92,position:[.2,0,-.3]}),createSmallWater({kind:'puddle',radius:.6,height:.012,position:[1.7,0,.4],puddles:[[0,0,1],[-.3,1,.55]]})];kits.forEach(k=>{scene.add(k.object);objects.push(k);});
      const pole=new THREE.Mesh(new THREE.BoxGeometry(.25,2,.25),new THREE.MeshStandardMaterial({color:0xe0814f}));pole.position.set(-.2,1,-1.4);scene.add(pole);update=t=>{pole.position.x=.7*Math.sin(t*.7);kits.forEach(k=>k.update(ctx.renderer,scene,camera));};
    }else if(mode==='rock'){
      for(let i=0;i<3;i++){const rock=createRock({seed:i+1,radius:.6+i*.14});rock.object.position.set((i-1)*1.7,.6,-i*.3);scene.add(rock.object);objects.push(rock);}
    }else if(mode==='mountain'){
      floor.visible=false;camera.position.set(0,30,150);camera.lookAt(0,40,-400);const mountain=createMountainLOD({height:(x,z)=>20+60*(.5+.5*Math.sin(x*.017+Math.sin(z*.023)))*Math.exp(-(((z+470)/180)**2)),maxSegments:256});scene.add(mountain.object);objects.push(mountain);let stats;update=t=>{camera.setFocalLength(t<2?35:150);stats=mountain.update(camera,{width});};inspect=()=>({mode,...stats});
    }else if(mode==='character'||mode==='subtitle'){
      character=createCharacter({body:'feminine',coatStyle:'short',scarf:false,hairStyle:'bun'});scene.add(character.object);let pose;
      const side=q.get('view')==='side';camera.position.set(side?3.8:0,1.35,side?0:3.8);camera.lookAt(0,.85,0);
      const action=q.get('action')||'sitKnees',seat=new THREE.Mesh(new THREE.BoxGeometry(.65,.44,action==='hugKnees'?.3:.55),new THREE.MeshStandardMaterial({color:0x826853}));const bodyScale=character.proportions.height/1.851,seatHeight=action==='hugKnees'?.24:.44;seat.scale.set(bodyScale,bodyScale*seatHeight/.44,bodyScale);seat.position.set(0,seatHeight*bodyScale/2,(action==='hugKnees'?-.28:-.4)*bodyScale);scene.add(seat);
      let lyrics;const alignment={lines:[{text:'A synthetic line',start:0,end:9,locked:true,words:[]}]};
      if(mode==='subtitle'){lyrics=createLyrics({width,height,pictureHeight:height,song:alignment,config:{fontFamily:'serif',lead:0,bottom:{place:.65,size:100}}});lyrics.canvas.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none';document.body.append(lyrics.canvas);cleanups.push(()=>lyrics.dispose());}
      update=t=>{pose=character.update(action==='blend'?'sitKnees':action,t,{blend:action==='blend'?{from:'pushWindow',time:3,weight:Math.max(0,Math.min(1,t/4))}:undefined,additive:[{action:'lookUp',weight:.3,time:t}]});if(lyrics)lyrics.draw(t,{characterBounds:characterBounds(camera,[character.object])});};inspect=()=>({mode,anatomy:inspectRig(character.rig,pose),placements:lyrics?.placements||[]});
    }else if(mode==='sky'||mode==='fog'){
      floor.visible=false;const sky=createSky(ctx,{budget:'low',moonScale:4,moonTint:[1,1,1],lunarDiscNeutrality:1,cloudDensity:0,stars:.3});scene.add(sky.object,sky.overlay);objects.push(sky);camera.position.set(0,2,0);camera.lookAt(0,4,-50);
      let atmos;if(mode==='fog'){
        atmos=createAtmosphere(ctx,{sky,terrain:{heightAt:(x,z)=>12+8*Math.sin(x*.005),bounds:[-3000,-3000,3000,3000],resolution:64}});objects.push(atmos);
        const mat=makeValleyMaterial(atmos,'surface');for(const [x,y,z,w] of [[-80,32,-300,70],[50,42,-650,100],[-90,60,-1100,200]]){const geometry=new THREE.BoxGeometry(w,y,50),values=[];for(let i=0;i<geometry.attributes.position.count;i++)values.push(.8,.02,1,0);geometry.setAttribute('aMat',new THREE.Float32BufferAttribute(values,4));const hill=new THREE.Mesh(geometry,mat);hill.position.set(x,12+y/2,z);scene.add(hill);}camera.position.y=22;camera.lookAt(0,18,-700);
      }
      update=(t,w)=>{sky.update(t,w,camera);atmos?.update(t,w,camera,{valleyFog:{sigma:.008,H:20,start:20},ambMist:[.025,.035,.05]});};inspect=()=>({mode,phase:sky.info.moonPhaseAngle,radiance:sky.info.moonRad,transmission:sky.info.tMoonCam});
    }else if(mode==='shaft'){
      scene.children.filter(o=>o.isLight).forEach(o=>o.intensity=0);const lights=createInteriorMoonlight({intensity:5});scene.add(lights.object);objects.push(lights);
      const shaft=createLightShaft(ctx,{origin:[0,2.8,-1],dir:[0,-1,.5],width:1,height:1,length:3,color:[.6,.8,1],intensity:5,density:.4});scene.add(shaft.object);objects.push(shaft);
      const block=new THREE.Mesh(new THREE.BoxGeometry(.6,1.3,.6),new THREE.MeshStandardMaterial({color:0x826853}));block.position.set(0,.65,0);scene.add(block);update=(t,w)=>{block.position.x=Math.sin(t)*.5;shaft.update(t,w,camera);lights.update(t,w);};
    }else throw new Error('unknown v04 bench');
    camera.updateMatrixWorld(true);
    return {scene,camera,character,update(t,shot,c){update(c.t,c.state);},dispose(){objects.forEach(o=>o.dispose());cleanups.forEach(f=>f());scene.traverse(o=>{o.geometry?.dispose();if(o.material&&!Array.isArray(o.material))o.material.dispose();});}};
  };
  const shot={id:'bench',set:'bench',t0:0,t1:10,post:{whiteBalance:[1,1,1],exposure:0}},timeline={FPS:24,DURATION:10,shots:[shot],resolve:t=>[{shot,tLocal:t,weight:1,gain:1,fade:1}]},world={at:t=>({...defaultWorld.at(t),rain:0,cloudCover:0,mist:.6,moonElev:2,moonAzim:0,sunDir:[0,-1,0],moonDir:[0,Math.sin(Math.PI/90),-Math.cos(Math.PI/90)],moonPhaseAngle:t*25,lunarDiscNeutrality:1})};
  const engine=await createEngine({canvas,width,height,pictureHeight:height,world,timeline,sets:{bench:{create}},quality:q.get('quality')||'preview',msaa:Number(q.get('msaa')||0),lyrics:false,postOverride:{whiteBalance:[1.4,.7,.5],exposure:.5,dof:{enabled:false},grain:{strength:0}}});
  window.__scene={...engine,ready:true,inspect:()=>inspect(),capture:()=>canvas.toDataURL('image/png')};await engine.seek(0);document.querySelector('output').textContent=`${mode} · 通用构件回归`;
  window.addEventListener('pagehide',()=>engine.dispose());
}catch(error){window.__sceneError=error.stack;console.error(error);}

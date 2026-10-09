import * as THREE from '../engine/vendor/three.module.js';
import {material} from './materials.js';
import {createSkeleton,applyPose,limit,anatomy} from './rig.js';
import {poseAt,handPoses,fingerAngles} from './motion.js';
import {ellipsoid} from './geometry.js';
import {makeFace} from './face.js';
import {solveHandContacts} from './contact.js';
import {makeBoot,addTailoring,makeScarf} from './wardrobe.js';
import {makeProps,poseForProp,propNames} from './props.js';
import {loftField,union,isoSurface,skinGeometry,tube,garmentShell} from './surface.js';
import {smooth,clamp} from './math.js';
export {poseAt,blendPoses} from './motion.js';
export {inspectRig} from './rig.js';
const cache=new Map();
export function createCharacter({body='masculine',height=body==='feminine'?1.66:1.78,headRatio=body==='feminine'?7.4:7.6,shoulderWidth=1,posture=0,coat=true,scarf=true,backpack=false,hat=false,coatColor=0x635346,coatStyle='long',hairStyle=body==='feminine'?'shoulder':'short',prop='none'}={}){
  if(!['masculine','feminine'].includes(body)||![height,headRatio,shoulderWidth,posture].every(Number.isFinite)||shoulderWidth<.8||shoulderWidth>1.2||height<1.2||height>2.2||headRatio<6.5||headRatio>9)throw new Error('unsupported body proportions');
  if(!['long','cloak','short'].includes(coatStyle)||!['short','shoulder','ponytail','bun'].includes(hairStyle)||!propNames.includes(prop))throw new Error('unknown wardrobe or prop');
  const feminine=body==='feminine',neckRadius=feminine?.042:.049,handScale=feminine?.88:1;
  const rig=createSkeleton(),holder=new THREE.Group();holder.add(rig.root);
  const width=feminine?.86:1,skin=material('skin',{color:0xc28c71}),cloth=material('cloth',{color:coatColor}),pants=material('cloth',{color:0x273038}),bootMat=material('cloth',{color:0x211f1c,roughness:.55});
  for(const l of Object.values(rig.limbs))if(l.type==='arm')l.upper.position.x*=width*shoulderWidth;
  rig.root.updateMatrixWorld(true);
  const armLocal={};for(const side of ['L','R'])armLocal[side]=rig.limbs[side+'arm'].upper.matrixWorld.clone().invert();
  const bodyRings=feminine?
    [[.775,.035,.042],[.81,.153,.103],[.90,.203,.133],[1.00,.184,.124],[1.11,.128,.090],[1.23,.154,.108],[1.36,.176,.114],[1.43,.178,.105],[1.49,.169,.086],[1.53,.11,.065],[1.56,.046,.043],[1.63,.042,.040],[1.65,.005,.005]]:
    [[.775,.035,.042],[.81,.15,.095],[.90,.18,.115],[1.00,.164,.108],[1.11,.153,.098],[1.24,.178,.112],[1.37,.203,.125],[1.44,.205,.12],[1.49,.196,.100],[1.52,.14,.077],[1.56,.057,.049],[1.63,.049,.045],[1.65,.005,.005]];
  const armRings=[[-.59,.006,.006],[-.55,.035,.030],[-.47,.042,.036],[-.36,.054,.043],[-.29,.049,.046],[-.19,.061,.058],[-.05,.075,.071],[.025,.056,.055],[.06,.005,.005]];
  if(feminine)for(const r of armRings){r[1]*=.88;r[2]*=.90;}
  const legRings=[[.05,.012,.02],[.08,.044,.048],[.20,.052,.053],[.33,.065,.068],[.47,.059,.064],[.54,.067,.068],[.69,.087,.088],[.84,.098,.10],[.94,.087,.09],[1.00,.01,.01]];
  const hem=coatStyle==='short'?.99:coatStyle==='cloak'?.32:.595;
  const coatRings=coatStyle==='cloak'?[[hem,.34,.235],[.72,.31,.21],[1.02,.27,.18],[1.28,.252*width,.193],[1.36,.250*width,.185],[1.43,.243*width,.15],[1.50,.195*width,.113],[1.56,neckRadius+.016,.06]]:
    [[hem,coatStyle==='short'?(feminine?.209:.198):.279,.18],[Math.max(hem+.012,.78),feminine?.25:.267,.17],[1.03,feminine?.206:.223,.15],[1.13,feminine?.157:.198,.132],[1.28,.213*width,feminine?.180:.144],[1.35,.225*width,feminine?.169:.143],[1.43,.232*width,.134],[1.49,.215*width,.105],[1.52,.15*width,.081],[1.56,neckRadius+.014,.054]];
  if(coatStyle==='short')coatRings.splice(0,2,[hem,feminine?.208:.218,.145]);
  const bust=(x,y,z)=>{
    let d=1;
    if(feminine)for(const sign of [-1,1])d=Math.min(d,(Math.hypot((x-sign*.072)/.069,(y-1.326)/.067,(z-.082)/.068)-1)*.067);
    return d;
  };
  const v=new THREE.Vector3();
  const field=(x,y,z,garment=false)=>{
    let f=union(loftField(bodyRings,x,y,z),bust(x,y,z),.060);
    if(garment)f=Math.max(loftField(coatRings,x,y,z),hem-y);
    for(const side of ['L','R']){const sign=side==='L'?1:-1;v.set(x,y,z).applyMatrix4(armLocal[side]);let a=loftField(armRings,v.x,v.y,v.z);if(garment)a=Math.max(a-.012,-v.y-.54);f=union(f,a,.060);
      if(!garment)f=union(f,loftField(legRings,x-sign*anatomy.hipWidth,y,z),.052);}
    if(garment)f=Math.max(f,y-1.55);return f;
  };
  const armWeights=(arm,amount,elbow,y)=>{
    const u=clamp((-y-arm.a)/arm.b)*3,i=Math.min(2,Math.floor(u)),t=smooth(u-i),chain=[arm.lower,...arm.twists];
    return [[arm.upper,amount*(1-elbow)],[chain[i],amount*elbow*(1-t)],[chain[i+1],amount*elbow*t]];
  };
  const weights=(x,y,z)=>{
    const side=x>=0?'L':'R',arm=rig.limbs[side+'arm'],leg=rig.limbs[side+'leg'];
    const a=v.set(x,y,z).applyMatrix4(armLocal[side]);
    let trunk=union(loftField(bodyRings,x,y,z),bust(x,y,z),.060);
    for(const sign of [-1,1])trunk=union(trunk,loftField(legRings,x-sign*anatomy.hipWidth,y,z),.052);
    const armMix=smooth((trunk-loftField(armRings,a.x,a.y,a.z)+.05)/.10);
    const elbow=smooth((-a.y-.21)/.16),legMix=(1-smooth((y-.79)/.24))*(1-armMix),knee=1-smooth((y-.44)/.15),chestMix=smooth((y-1.03)/.30),torso=1-armMix-legMix;
    return [...armWeights(arm,armMix,elbow,a.y),[leg.upper,legMix*(1-knee)],[leg.lower,legMix*knee],[rig.pelvis,torso*(1-chestMix)],[rig.chest,torso*chestMix*(1-smooth((y-1.52)/.12))],[rig.neck,torso*chestMix*smooth((y-1.52)/.12)]];
  };
  const meshes=[],key=`${body}-${shoulderWidth}-${coatStyle}`;
  const cached=(name,fn)=>{const k=key+name;if(!cache.has(k))cache.set(k,fn());return cache.get(k).clone();};
  const bodyGeo=cached('body',()=>isoSurface((x,y,z)=>field(x,y,z),[-.46,.025,-.175],[.46,1.68,.195]));
  const colors=[],color=new THREE.Color();for(let i=0;i<bodyGeo.attributes.position.count;i++){const y=bodyGeo.attributes.position.getY(i),x=bodyGeo.attributes.position.getX(i);color.set(y>1.555?0xc28c71:y<(coat&&coatStyle==='short'?1.015:.982)&&Math.abs(x)<.245?0x273038:0x8b8274);colors.push(color.r,color.g,color.b);}bodyGeo.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  meshes.push([bodyGeo,material('skin',{color:0xffffff,vertexColors:true}),weights,'continuous-body']);
  if(coat){const geo=cached('coat',()=>{
    const outer=isoSurface((x,y,z)=>field(x,y,z,true),[-.57,Math.min(hem-.02,.79),-.27],[.57,1.575,.27],.012);
    const shell=garmentShell(outer,(x,y,z)=>(y<hem+.000001&&Math.abs(x)<.245)||y>1.549999||(Math.abs(x)>.28&&Math.abs(v.set(x,y,z).applyMatrix4(armLocal[x>0?'L':'R']).y+.54)<.000001));
    // Project the cut hem onto a common plane and a smooth elliptical rim.
    // Only the torso boundary is affected; sleeve/neck openings stay separate.
    const sp=shell.attributes.position;
    for(let i=0;i<sp.count;i++)if(sp.getY(i)<hem+.012&&Math.abs(sp.getX(i))<(coatStyle==='short'?.235:.40)){const x=sp.getX(i),z=sp.getZ(i),a=Math.atan2(x/coatRings[0][1],z/coatRings[0][2]),inner=i>=outer.attributes.position.count?.007:0;sp.setXYZ(i,Math.sin(a)*(coatRings[0][1]-inner),hem,Math.cos(a)*(coatRings[0][2]-inner));}
    shell.computeVertexNormals();outer.dispose();return shell;
  });meshes.push([geo,cloth,(x,y,z)=>{
    const arm=rig.limbs[(x>=0?'L':'R')+'arm'],local=v.set(x,y,z).applyMatrix4(armLocal[x>=0?'L':'R']);
    const armField=Math.max(loftField(armRings,local.x,local.y,local.z)-.012,-local.y-.54);
    const armMix=smooth((loftField(coatRings,x,y,z)-armField+.035)/.070);
    const elbow=smooth((-local.y-.21)/.16),chest=smooth((y-1.03)/.30);
    return [...armWeights(arm,armMix,elbow,local.y),[rig.pelvis,(1-armMix)*(1-chest)],[rig.chest,(1-armMix)*chest]];
  },'coat-shell']);}
  // Fully articulated five-finger hands. Each has one continuous palm/finger surface.
  rig.fingers=[];
  for(const [side,sign] of [['L',1],['R',-1]]){
    const tip=rig.limbs[side+'arm'].tip,fingerDefs=[];
    for(let i=0;i<5;i++){
      const thumb=i===0,length=(thumb?.048:[.065,.073,.067,.050][i-1])*handScale,root=new THREE.Bone();root.position.set(sign*(thumb?.035:-(i-2.5)*.018)*handScale,(thumb?-.027:-.080)*handScale,thumb?.007:0);root.rotation.z=thumb?sign*.70:-sign*(i-2.5)*.025;tip.add(root);
      const joints=[root];for(let j=1;j<3;j++){const b=new THREE.Bone();b.position.y=-length*(j===1?.43:.33);joints.at(-1).add(b);joints.push(b);}const item={joints,length,thumb,side,index:i,palmAxis:new THREE.Vector3(0,0,1)};rig.fingers.push(item);fingerDefs.push(item);ellipsoid(joints[2],.0043*handScale,[thumb?1.1:.85,1.45,.10],[0,-length*.13,-(thumb?.0061:.0045)*handScale],material('skin',{color:0xcc9c86,roughness:.38}));
    }
    rig.root.updateMatrixWorld(true);const invTip=tip.matrixWorld.clone().invert();
    const descriptors=fingerDefs.map(f=>({...f,inverse:f.joints[0].matrixWorld.clone().invert().multiply(tip.matrixWorld)}));
    const handField=(x,y,z)=>{
      let d=loftField([[-.098,.004,.004],[-.089,.027,.011],[-.078,.035,.018],[-.046,.038,.024],[-.018,.033,.023],[.009,.026,.019],[.021,.004,.005]].map(r=>r.map(q=>q*handScale)),x,y,z);
      // Thenar eminence joins the low, lateral thumb root into the palm.
      d=union(d,(Math.hypot((x-sign*.025*handScale)/(.021*handScale),(y+.038*handScale)/(.029*handScale),(z-.006)/(.022*handScale))-1)*.021,.008);
      for(const f of descriptors){v.set(x,y,z).applyMatrix4(f.inverse);const u=clamp(-v.y/f.length),knuckle=.0012*Math.exp(-(((u-.44)/.09)**2))+.0008*Math.exp(-(((u-.76)/.08)**2)),r=((f.thumb?.011:.0087)*(1-.29*u)+knuckle)*handScale,cy=clamp(v.y,-f.length,0);d=union(d,Math.hypot(v.x,(v.y-cy)*.9,v.z/.88)-r,.007*handScale);}return d;
    };
    const geo=cached(`hand${side}`,()=>isoSurface(handField,[-.09,-.17,-.031],[.09,.029,.034],.0028));geo.applyMatrix4(tip.matrixWorld);
    const handWeights=(x,y,z)=>{const local=new THREE.Vector3(x,y,z).applyMatrix4(invTip);let best=null,dist=Infinity;
      for(const f of descriptors){const p=local.clone().applyMatrix4(f.inverse),d=Math.hypot(p.x,p.z,Math.max(0,p.y));if(d<dist){dist=d;best={f,p};}}
      const {f,p}=best,amount=smooth((-.005-p.y)/.040),u=-p.y/f.length,j=smooth((u-.31)/.24),k=smooth((u-.64)/.22);
      return [[tip,1-amount],[f.joints[0],amount*(1-j)],[f.joints[1],amount*j*(1-k)],[f.joints[2],amount*k]];};
    meshes.push([geo,skin,handWeights,`hand-${side}`]);
    makeBoot(rig.limbs[side+'leg'].tip,bootMat);
    if(coat){const cuff=new THREE.Mesh(tube([[-.018,.044,.039],[.038,.052,.045]],32,.007),cloth);tip.add(cuff);}
  }
  rig.root.updateMatrixWorld(true);const bones=[];rig.root.traverse(o=>{if(o.isBone)bones.push(o);});const skeleton=new THREE.Skeleton(bones);
  for(const [geo,mat,weight,name] of meshes){skinGeometry(geo,bones,weight);const mesh=new THREE.SkinnedMesh(geo,mat);mesh.name=name;holder.add(mesh);mesh.bind(skeleton);mesh.castShadow=mesh.receiveShadow=true;mesh.frustumCulled=false;}
  const head=new THREE.Group(),headScale=1.85/(headRatio*.294);head.position.y=.13+.151*(1-headScale);head.rotation.x=posture;head.scale.setScalar(headScale);rig.neck.add(head);const face=makeFace(head,skin,{body,hairStyle});
  if(coat)addTailoring(rig,{cloth,coatStyle,width,neckRadius});
  // A sewn sweater waistband covers the material transition with a level hem.
  if(!coat){const hemMesh=new THREE.Mesh(tube([[.972,feminine?.192:.174,.130],[.992,feminine?.192:.174,.130]],64,.006),material('cloth',{color:0x8b8274}));hemMesh.position.y=-.94;rig.pelvis.add(hemMesh);}
  const scarfRig=scarf?makeScarf(rig.chest,neckRadius):null,props=makeProps(rig);
  if(backpack)ellipsoid(rig.chest,.2,[.8,1.05,.45],[0,-.04,-.21],material('cloth',{color:0x62584b}));
  if(hat){const brim=new THREE.Mesh(new THREE.CylinderGeometry(.14,.14,.014,40),cloth);brim.position.y=.10;head.add(brim);ellipsoid(head,.095,[1,.7,1],[0,.14,0],cloth);}
  holder.scale.setScalar(height/1.851);
  const api={object:holder,rig,skeleton,head,props,proportions:{body,height,headRatio,neckRadius,handScale,bodyRings},update(action,t,options={}){
    const selectedProp=options.prop??(action==='lanternWalk'?'lantern':action==='holdCup'?'cup':action==='phone'?'phone':action==='bagWalk'?'bag':prop);if(!propNames.includes(selectedProp))throw new Error('unknown prop');
    const pose=poseAt(action,t,options);poseForProp(rig,pose,selectedProp);applyPose(rig,pose);if(options.handTargets)pose.ik=solveHandContacts(rig,pose,options.handTargets,options.ik);head.rotation.z=pose.secondary*.06;
    const handPose=options.handPose||pose.handPose,angles=handPoses[handPose];if(!angles)throw new Error('unknown hand pose');pose.fingers=angles;
    pose.handPose=handPose;
    for(const f of rig.fingers){
      const gesture=options.handPose||pose.handPoseBySide?.[f.side]||handPose,flex=fingerAngles(gesture,f.index);f.gesture=gesture;
      f.joints.forEach((joint,j)=>joint.rotation.x=-limit('finger',flex[j]));
      const sign=f.side==='L'?1:-1;
      if(f.thumb){const closed=['carry','fist'].includes(gesture);f.joints[0].rotation.y=-sign*(closed?.78:.15);f.joints[0].rotation.z=sign*(closed?.38:.70);}
      else f.joints[0].rotation.z=-sign*(f.index-2.5)*(gesture==='open'?.095:.025);
    }
    face.eyes.forEach(e=>e.scale.y=pose.blink?.12:1);
    const expression=options.expression||'neutral',tilt={neutral:0,concern:.14,resolve:-.09,tired:.04}[expression];if(tilt===undefined)throw new Error('unknown expression');face.brows.forEach((b,i)=>b.rotation.z=(i?1:-1)*tilt);
    for(const key of ['viseme','jawOpen','mouthRound'])if(options[key]!==undefined&&!Number.isFinite(options[key]))throw new TypeError('finite mouth parameter required');
    face.updateMouth(clamp(options.jawOpen??options.viseme??0),clamp(options.mouthRound??0));
    const wind=options.wind??.5;
    if(options.deformClothing!==false)face.locks.forEach((lock,j)=>{const p=lock.geometry.attributes.position,r=lock.userData.rest;for(let i=0;i<p.count;i++){const u=clamp((.1-r[i*3+1])/.4),f=u*u;p.setXYZ(i,r[i*3]+f*wind*(.035+Math.sin(t*2.2+j*.4)*.014),r[i*3+1],r[i*3+2]+f*pose.secondary*.18);}p.needsUpdate=true;lock.geometry.computeVertexNormals();});
    if(options.deformClothing!==false)scarfRig?.update(t,wind,Math.sin(t*.38/.9*Math.PI*2));
    // Analytic leg envelopes keep the walking knees inside the coat. This is
    // a deterministic clearance deformation, not a cloth simulation.
    const skirt=holder.children.find(o=>o.name==='coat-shell');
    if(skirt&&options.deformClothing!==false){
      const p=skirt.geometry.attributes.position;
      if(!skirt.userData.rest){
        skirt.userData.rest=p.array.slice();skirt.userData.hem=[];
        for(let i=0;i<p.count;i++){
          const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
          if(y<1.05&&Math.abs(x)<.36)skirt.userData.hem.push({i,row:Math.round(clamp((y-hem)/(1.05-hem))*64),fade:1-smooth((y-.93)/.12),facing:smooth(Math.abs(z)/.06),left:Math.exp(-(((x-anatomy.hipWidth)/.17)**4)),right:Math.exp(-(((x+anatomy.hipWidth)/.17)**4))});
        }
      }
      const envelopes={};
      for(const side of ['L','R']){
        const leg=rig.limbs[side+'leg'],points=[leg.upper,leg.lower,leg.tip].map(b=>rig.pelvis.worldToLocal(b.getWorldPosition(new THREE.Vector3())));
        envelopes[side]=Array.from({length:65},(_,row)=>{
          const y=hem+row/64*(1.05-hem)-.94;let front=.125,back=-.125;
          for(let j=0;j<2;j++){
            const a=points[j],b=points[j+1],f=clamp((y-a.y)/(b.y-a.y||1e-8)),cy=a.y+(b.y-a.y)*f,r=j===0?.095:.077;
            if(Math.abs(y-cy)>r)continue;
            const z=a.z+(b.z-a.z)*f,pad=Math.sqrt(Math.max(0,r*r-(y-cy)**2))+.030;
            front=Math.max(front,z+pad);back=Math.min(back,z-pad);
          }
          return [front-.125,-back-.125];
        });
      }
      const r=skirt.userData.rest;
      for(const h of skirt.userData.hem){
        const {i,row,fade,facing,left,right}=h,z=r[i*3+2],side=z>=0?0:1;
        const clearance=Math.max(envelopes.L[row][side]*left,envelopes.R[row][side]*right)*fade*facing;
        const flutter=(1-smooth((r[i*3+1]-.6)/.45))**2*pose.secondary*.8;
        const proposed=z+(side===0?clearance:-clearance)+flutter;
        p.setZ(i,clearance>.001?(side===0?Math.max(z+clearance,proposed):Math.min(z-clearance,proposed)):proposed);
      }
      p.needsUpdate=true;
    }
    rig.root.updateMatrixWorld(true);props.update(selectedProp,t);rig.root.updateMatrixWorld(true);skeleton.update();return pose;
  }};api.update('stand',1);return api;
}

export {loadExternalCharacter,adaptExternalCharacter} from './external.js';
// Optional real-asset path.  It is kept in a submodule so importing the
// procedural character does not load a model, a loader, or any project asset.
export {
  adaptRealCharacter, loadRealCharacter, prepareRealCharacter, prepareRealChar,
  createExternalCharacter, createRealCharacter, retargetAnimationClip, retargetUALClips,
  createProceduralWardrobe,
  createOuterEdgeMaskPass, createRimOutlinePass, attachOuterEdgePass,
} from './real/index.js';

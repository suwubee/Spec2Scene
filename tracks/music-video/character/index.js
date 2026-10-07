import * as THREE from '../engine/vendor/three.module.js';
import {material} from './materials.js';
import {createSkeleton,applyPose,limit,anatomy} from './rig.js';
import {poseAt,handPoses} from './motion.js';
import {loftField,union,isoSurface,skinGeometry,tube,garmentShell} from './surface.js';
import {smooth,clamp} from './math.js';
export {poseAt} from './motion.js';
export {inspectRig} from './rig.js';
const cache=new Map();
function ellipsoid(parent,radius,scale,position,mat){const mesh=new THREE.Mesh(new THREE.SphereGeometry(radius,24,16),mat);mesh.scale.set(...scale);mesh.position.set(...position);parent.add(mesh);return mesh;}
function stroke(parent,points,radius,mat){const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p)));const mesh=new THREE.Mesh(new THREE.TubeGeometry(curve,20,radius,8,false),mat);parent.add(mesh);return mesh;}
function cubic(t,a,b,c,d){return b+.5*t*(c-a+t*(2*a-5*b+4*c-d+t*(3*(b-c)+d-a)));}
const headProfile=[[-.14,.027,.039],[-.127,.048,.060],[-.105,.068,.070],[-.063,.082,.083],[-.014,.086,.087],[.036,.084,.080],[.080,.082,.077],[.117,.064,.062],[.14,.027,.028],[.144,.001,.001]];
function profileAt(y){let k=1;while(k<headProfile.length-1&&headProfile[k][0]<y)k++;const a=headProfile[k-1],b=headProfile[k],t=clamp((y-a[0])/(b[0]-a[0]));return [1,2].map(i=>cubic(t,headProfile[Math.max(0,k-2)][i],a[i],b[i],headProfile[Math.min(headProfile.length-1,k+1)][i]));}
function sculptHead(mat){
  const rings=headProfile,pts=[],indices=[],n=96,rows=81;
  const bump=(v,c,s)=>Math.exp(-(((v-c)/s)**2));
  for(let i=0;i<rows;i++){const y=-.14+i/(rows-1)*.284;let k=1;while(rings[k][0]<y&&k<rings.length-1)k++;const lo=rings[k-1],hi=rings[k],f=(y-lo[0])/(hi[0]-lo[0]),rx=cubic(f,rings[Math.max(0,k-2)][1],lo[1],hi[1],rings[Math.min(rings.length-1,k+1)][1]),rz=cubic(f,rings[Math.max(0,k-2)][2],lo[2],hi[2],rings[Math.min(rings.length-1,k+1)][2]);
    for(let j=0;j<n;j++){const a=j/n*Math.PI*2,x=Math.sin(a)*rx;let z=Math.cos(a)*rz;
      if(z>0){const front=Math.max(0,Math.cos(a))**4;
        const bridge=bump(x,0,.012)*bump(y,.002,.045)*.024,tip=bump(x,0,.019)*bump(y,-.020,.014)*.026;
        const wings=(bump(x,-.018,.009)+bump(x,.018,.009))*bump(y,-.027,.009)*.010;
        const sockets=(bump(x,-.034,.023)+bump(x,.034,.023))*bump(y,.021,.015)*.009;
        const cheeks=(bump(x,-.049,.027)+bump(x,.049,.027))*bump(y,-.030,.025)*.010;
        const brow=(bump(x,-.034,.025)+bump(x,.034,.025))*bump(y,.042,.012)*.007;
        const muzzle=bump(x,0,.034)*bump(y,-.062,.022)*.008,chin=bump(x,0,.035)*bump(y,-.115,.014)*.009;
        z+=front*(bridge+tip+wings-sockets+cheeks+brow+muzzle+chin);
      }pts.push(x,y,z);}}
  for(let i=0;i<rows-1;i++)for(let j=0;j<n;j++){const a=i*n+j,b=i*n+(j+1)%n;indices.push(a,b,a+n,b,b+n,a+n);}
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(pts,3));const colors=[];for(let i=0;i<pts.length;i+=3){const x=pts[i],y=pts[i+1],z=pts[i+2],cheek=Math.exp(-(((Math.abs(x)-.05)/.03)**2)-((y+.03)/.025)**2)*Math.max(0,z)*10;colors.push(1-cheek*.035,1-cheek*.15,1-cheek*.16);}geo.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geo.setIndex(indices);geo.computeVertexNormals();return new THREE.Mesh(geo,material('skin',{color:0xc28c71,vertexColors:true,roughness:.60}));
}
function makeFace(head,skin){
  head.add(sculptHead(skin));
  const hair=material('cloth',{color:0x241710,roughness:.76}),lip=material('skin',{color:0x995c50,roughness:.6}),dark=material('skin',{color:0x432d29}),white=material('skin',{color:0xb9b3a2,roughness:.35}),iris=material('skin',{color:0x54412c,roughness:.3}),pupil=material('metal',{color:0x090c0b,metalness:0,roughness:.16});
  const eyes=[],lids=[],brows=[],locks=[];
  for(const sign of [-1,1]){
    // Ear helix, antihelix and concha, with a soft lobe.
    ellipsoid(head,.026,[.38,1,.65],[sign*.088,-.007,-.004],skin);
    ellipsoid(head,.014,[.3,1,.68],[sign*.096,-.006,.006],lip);
    stroke(head,[[sign*.091,-.025,.009],[sign*.103,-.012,.006],[sign*.105,.012,-.005],[sign*.096,.020,-.010]],.0038,skin);
    const x=sign*.033,y=.018,z=.067;
    const eye=ellipsoid(head,.016,[1,.42,.48],[x,y,z],white);eyes.push(eye);
    ellipsoid(eye,.005,[1,1.4,.24],[0,0,.0164],iris);ellipsoid(eye,.0023,[1,1.5,.25],[0,0,.0180],pupil);
    for(const upper of [true,false]){const points=[];for(let i=0;i<=10;i++){const u=i/10,dx=(u-.5)*.032;points.push([x+dx,y+(upper?1:-1)*Math.sin(u*Math.PI)*(upper?.0045:.0035),.073+Math.sin(u*Math.PI)*.003]);}
      lids.push(stroke(head,points,upper?.0015:.0012,skin));}
    const brow=stroke(head,[[x-.019,.037,.075],[x-.004,.043,.079],[x+.016,.039,.074]],.0018,hair);brows.push(brow);
    ellipsoid(head,.004,[1,.47,.6],[sign*.014,-.030,.101],dark);
  }
  stroke(head,[[-.026,-.065,.086],[-.012,-.061,.095],[0,-.064,.096],[.012,-.061,.095],[.026,-.065,.086]],.0022,lip);
  stroke(head,[[-.025,-.066,.087],[0,-.072,.096],[.025,-.066,.087]],.0028,lip);
  const mouth=stroke(head,[[-.024,-.066,.090],[0,-.066,.098],[.024,-.066,.090]],.0009,dark);
  // Hair cap follows an uneven hairline; swept locks expose the forehead and temples.
  const pos=[],ind=[],n=72,rows=22;
  for(let i=0;i<rows;i++)for(let j=0;j<n;j++){const a=j/n*Math.PI*2,front=Math.max(0,Math.cos(a)),line=-.040+.123*front**.6+.009*Math.sin(a*2)*front,u=i/(rows-1),y=line+(.151-line)*u,[rx,rz]=profileAt(Math.min(.144,y-.005));pos.push(Math.sin(a)*(rx+.004*(1-u)),y,Math.cos(a)*(rz+.004*(1-u)));}
  for(let i=0;i<rows-1;i++)for(let j=0;j<n;j++){const a=i*n+j,b=i*n+(j+1)%n;ind.push(a,b,a+n,b,b+n,a+n);}
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));geo.setIndex(ind);geo.computeVertexNormals();head.add(new THREE.Mesh(geo,hair));
  for(let i=0;i<12;i++){const x=-.047+i*.0076,points=[.089,.11,.132,.147].map((y,j)=>{const xx=x*(1-j*.22)+.008*Math.sin(j),[rx,rz]=profileAt(y-.005);return [xx,y,rz*Math.sqrt(Math.max(.01,1-(xx/rx)**2))+.004];});const lock=stroke(head,points,.0005,hair);locks.push(lock);}
  return {eyes,lids,brows,mouth,locks};
}
export function createCharacter({body='masculine',height=1.78,headRatio=7.6,shoulderWidth=1,posture=0,coat=true,scarf=true,backpack=false,hat=false,coatColor=0x635346}={}){
  if(!['masculine','feminine'].includes(body)||![height,headRatio,shoulderWidth,posture].every(Number.isFinite)||shoulderWidth<.8||shoulderWidth>1.2||height<1.2||height>2.2||headRatio<6.5||headRatio>9)throw new Error('unsupported body proportions');
  const rig=createSkeleton(),holder=new THREE.Group();holder.add(rig.root);
  const width=body==='feminine'?.89:1,skin=material('skin',{color:0xc28c71}),cloth=material('cloth',{color:coatColor}),pants=material('cloth',{color:0x273038}),bootMat=material('cloth',{color:0x211f1c,roughness:.55});
  for(const l of Object.values(rig.limbs))if(l.type==='arm')l.upper.position.x*=width*shoulderWidth;
  rig.root.updateMatrixWorld(true);
  const armLocal={};for(const side of ['L','R'])armLocal[side]=rig.limbs[side+'arm'].upper.matrixWorld.clone().invert();
  const bodyRings=[[.775,.035,.042],[.81,.15*width,.095],[.90,.18*width,.115],[1.00,.164*width,.108],[1.11,.145*width,.093],[1.24,.178*width,.112],[1.37,.203*width,.125],[1.44,.205*width,.12],[1.49,.196*width,.100],[1.52,.14*width,.077],[1.56,.057,.049],[1.63,.049,.045],[1.65,.005,.005]];
  const armRings=[[-.59,.006,.006],[-.55,.035,.030],[-.47,.042,.036],[-.36,.054,.043],[-.29,.049,.046],[-.19,.061,.058],[-.05,.075,.071],[.025,.056,.055],[.06,.005,.005]];
  const legRings=[[.05,.012,.02],[.08,.044,.048],[.20,.052,.053],[.33,.065,.068],[.47,.059,.064],[.54,.067,.068],[.69,.087,.088],[.84,.098,.10],[.94,.087,.09],[1.00,.01,.01]];
  const coatRings=[[.58,.285*width,.18],[.71,.277*width,.17],[.91,.247*width,.157],[1.1,.19*width,.132],[1.28,.205*width,.144],[1.43,.230*width,.142],[1.49,.218*width,.115],[1.52,.16*width,.086],[1.56,.062,.055]];
  const v=new THREE.Vector3();
  const field=(x,y,z,garment=false)=>{
    let f=loftField(bodyRings,x,y,z);
    if(garment)f=loftField(coatRings,x,y,z);
    for(const side of ['L','R']){const sign=side==='L'?1:-1;v.set(x,y,z).applyMatrix4(armLocal[side]);let a=loftField(armRings,v.x,v.y,v.z);if(garment)a=Math.max(a-.012,-v.y-.54);f=union(f,a,.060);
      if(!garment)f=union(f,loftField(legRings,x-sign*anatomy.hipWidth,y,z),.052);}
    if(garment)f=Math.max(f,.595-y,y-1.55);return f;
  };
  const armWeights=(arm,amount,elbow,y)=>{
    const u=clamp((-y-arm.a)/arm.b)*3,i=Math.min(2,Math.floor(u)),t=smooth(u-i),chain=[arm.lower,...arm.twists];
    return [[arm.upper,amount*(1-elbow)],[chain[i],amount*elbow*(1-t)],[chain[i+1],amount*elbow*t]];
  };
  const weights=(x,y,z)=>{
    const side=x>=0?'L':'R',arm=rig.limbs[side+'arm'],leg=rig.limbs[side+'leg'];
    const a=v.set(x,y,z).applyMatrix4(armLocal[side]);
    let trunk=loftField(bodyRings,x,y,z);
    for(const sign of [-1,1])trunk=union(trunk,loftField(legRings,x-sign*anatomy.hipWidth,y,z),.052);
    const armMix=smooth((trunk-loftField(armRings,a.x,a.y,a.z)+.05)/.10);
    const elbow=smooth((-a.y-.21)/.16),legMix=(1-smooth((y-.79)/.24))*(1-armMix),knee=1-smooth((y-.44)/.15),chestMix=smooth((y-1.03)/.30),torso=1-armMix-legMix;
    return [...armWeights(arm,armMix,elbow,a.y),[leg.upper,legMix*(1-knee)],[leg.lower,legMix*knee],[rig.pelvis,torso*(1-chestMix)],[rig.chest,torso*chestMix*(1-smooth((y-1.52)/.12))],[rig.neck,torso*chestMix*smooth((y-1.52)/.12)]];
  };
  const meshes=[],key=`${body}-${shoulderWidth}`;
  const cached=(name,fn)=>{const k=key+name;if(!cache.has(k))cache.set(k,fn());return cache.get(k).clone();};
  const bodyGeo=cached('body',()=>isoSurface((x,y,z)=>field(x,y,z),[-.46,.025,-.175],[.46,1.68,.18]));
  const colors=[],color=new THREE.Color();for(let i=0;i<bodyGeo.attributes.position.count;i++){const y=bodyGeo.attributes.position.getY(i),x=bodyGeo.attributes.position.getX(i);color.set(y>1.555?0xc28c71:y<.97&&Math.abs(x)<.245?0x273038:0x8b8274);colors.push(color.r,color.g,color.b);}bodyGeo.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  meshes.push([bodyGeo,material('skin',{color:0xffffff,vertexColors:true}),weights,'continuous-body']);
  if(coat){const geo=cached('coat',()=>{
    const outer=isoSurface((x,y,z)=>field(x,y,z,true),[-.55,.575,-.21],[.55,1.575,.21],.018);
    const shell=garmentShell(outer,(x,y,z)=>y<.595001||y>1.549999||(Math.abs(x)>.28&&Math.abs(v.set(x,y,z).applyMatrix4(armLocal[x>0?'L':'R']).y+.54)<.000001));
    outer.dispose();return shell;
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
      const thumb=i===0,length=thumb?.052:[.071,.079,.074,.059][i-1],root=new THREE.Bone();root.position.set(sign*(thumb?.032:-(i-2.5)*.019),thumb?-.025:-.089,0);root.rotation.z=thumb?sign*.65:-sign*(i-2.5)*.035;tip.add(root);
      const joints=[root];for(let j=1;j<3;j++){const b=new THREE.Bone();b.position.y=-length*(j===1?.43:.33);joints.at(-1).add(b);joints.push(b);}const item={joints,length,thumb,side,index:i};rig.fingers.push(item);fingerDefs.push(item);ellipsoid(joints[2],.005,[thumb?1.25:1,1.6,.15],[0,-length*.13,-.0085],material('skin',{color:0xcc9c86,roughness:.38}));
    }
    rig.root.updateMatrixWorld(true);const invTip=tip.matrixWorld.clone().invert();
    const descriptors=fingerDefs.map(f=>({...f,inverse:f.joints[0].matrixWorld.clone().invert().multiply(tip.matrixWorld)}));
    const handField=(x,y,z)=>{let d=loftField([[-.111,.006,.004],[-.102,.028,.009],[-.088,.037,.019],[-.045,.039,.022],[-.005,.032,.022],[.014,.01,.01]],x,y,z);
      for(const f of descriptors){v.set(x,y,z).applyMatrix4(f.inverse);const r=f.thumb?.0105:.0082;const cy=clamp(v.y,-f.length,0);d=union(d,Math.hypot(v.x,(v.y-cy)*.8,v.z)-r,.009);}return d;};
    const geo=cached(`hand${side}`,()=>isoSurface(handField,[-.089,-.185,-.028],[.089,.023,.028],.0035));geo.applyMatrix4(tip.matrixWorld);
    const handWeights=(x,y,z)=>{const local=new THREE.Vector3(x,y,z).applyMatrix4(invTip);let best=null,dist=Infinity;
      for(const f of descriptors){const p=local.clone().applyMatrix4(f.inverse),d=Math.hypot(p.x,p.z,Math.max(0,p.y));if(d<dist){dist=d;best={f,p};}}
      const {f,p}=best,amount=smooth((-.005-p.y)/.040),u=-p.y/f.length,j=smooth((u-.31)/.24),k=smooth((u-.64)/.22);
      return [[tip,1-amount],[f.joints[0],amount*(1-j)],[f.joints[1],amount*j*(1-k)],[f.joints[2],amount*k]];};
    meshes.push([geo,skin,handWeights,`hand-${side}`]);
    const shoe=ellipsoid(rig.limbs[side+'leg'].tip,.1,[.69,.47,1.48],[0,-.035,.045],bootMat);shoe.name='boot';
    const sole=new THREE.Mesh(tube([[-.085,.069,.145],[-.055,.068,.143]],40,.007),material('cloth',{color:0x111414}));sole.position.z=.044;rig.limbs[side+'leg'].tip.add(sole);
    if(coat){const cuff=new THREE.Mesh(tube([[-.018,.044,.039],[.038,.052,.045]],32,.007),cloth);tip.add(cuff);}
  }
  rig.root.updateMatrixWorld(true);const bones=[];rig.root.traverse(o=>{if(o.isBone)bones.push(o);});const skeleton=new THREE.Skeleton(bones);
  for(const [geo,mat,weight,name] of meshes){skinGeometry(geo,bones,weight);const mesh=new THREE.SkinnedMesh(geo,mat);mesh.name=name;holder.add(mesh);mesh.bind(skeleton);mesh.castShadow=mesh.receiveShadow=true;mesh.frustumCulled=false;}
  const head=new THREE.Group(),headScale=1.85/(headRatio*.294);head.position.y=.13+.151*(1-headScale);head.rotation.x=posture;head.scale.setScalar(headScale);rig.neck.add(head);const face=makeFace(head,skin);
  if(coat){for(const sign of [-1,1]){const shape=new THREE.Shape();shape.moveTo(sign*.045,.20);shape.lineTo(sign*.13,.15);shape.lineTo(sign*.055,-.04);shape.lineTo(sign*.005,.05);shape.closePath();const lapel=new THREE.Mesh(new THREE.ExtrudeGeometry(shape,{depth:.009,bevelEnabled:true,bevelSize:.002,bevelThickness:.002,bevelSegments:2,steps:1}),cloth);lapel.position.set(0,0,.137);rig.chest.add(lapel);}for(let i=0;i<3;i++)ellipsoid(rig.chest,.009,[1,1,.4],[.028,.065-i*.092,.15],bootMat);}
  let scarfTail;if(scarf){const mat=material('cloth',{color:0x8f8170});const collar=new THREE.Mesh(new THREE.TorusGeometry(.067,.018,12,40),mat);collar.rotation.x=Math.PI/2;collar.position.y=.305;rig.chest.add(collar);scarfTail=new THREE.Mesh(new THREE.BoxGeometry(.065,.37,.014,2,12,1),mat);scarfTail.position.set(-.071,.115,.145);rig.chest.add(scarfTail);}
  if(backpack)ellipsoid(rig.chest,.2,[.8,1.05,.45],[0,-.04,-.21],material('cloth',{color:0x62584b}));
  if(hat){const brim=new THREE.Mesh(new THREE.CylinderGeometry(.14,.14,.014,40),cloth);brim.position.y=.10;head.add(brim);ellipsoid(head,.095,[1,.7,1],[0,.14,0],cloth);}
  holder.scale.setScalar(height/1.851);
  const api={object:holder,rig,skeleton,head,update(action,t,options={}){
    const pose=poseAt(action,t,options);applyPose(rig,pose);head.rotation.z=pose.secondary*.06;
    const handPose=options.handPose||pose.handPose,angles=handPoses[handPose];if(!angles)throw new Error('unknown hand pose');pose.fingers=angles;
    for(const f of rig.fingers){
      f.joints.forEach((joint,j)=>joint.rotation.x=-limit('finger',angles[j]*(f.thumb?.65:1)*(handPose==='point'&&f.index===1?.08:1)));
      if(f.thumb){const sign=f.side==='L'?1:-1,closed=['carry','fist'].includes(handPose);f.joints[0].rotation.y=-sign*(closed?.90:0);f.joints[0].rotation.z=sign*(closed?.20:.65);}
    }
    face.eyes.forEach(e=>e.scale.y=pose.blink?.035:.42);
    const expression=options.expression||'neutral',tilt={neutral:0,concern:.14,resolve:-.09,tired:.04}[expression];if(tilt===undefined)throw new Error('unknown expression');face.brows.forEach((b,i)=>b.rotation.z=(i?1:-1)*tilt);
    if(options.viseme!==undefined&&!Number.isFinite(options.viseme))throw new TypeError('finite viseme required');
    face.mouth.scale.y=1+clamp(options.viseme||0)*1.5;
    face.locks.forEach((lock,i)=>lock.rotation.x=pose.secondary*Math.sin(i)*.14);
    if(scarfTail){
      const p=scarfTail.geometry.attributes.position;
      if(!scarfTail.userData.rest)scarfTail.userData.rest=p.array.slice();
      const r=scarfTail.userData.rest;
      for(let i=0;i<p.count;i++){const u=(.185-r[i*3+1])/.37;p.setZ(i,r[i*3+2]-.060+.085*smooth(u/.24)+u*u*(.012+pose.secondary*.55));}
      p.needsUpdate=true;
    }
    // Analytic leg envelopes keep the walking knees inside the coat. This is
    // a deterministic clearance deformation, not a cloth simulation.
    const skirt=holder.children.find(o=>o.name==='coat-shell');
    if(skirt&&options.deformClothing!==false){
      const p=skirt.geometry.attributes.position;
      if(!skirt.userData.rest){
        skirt.userData.rest=p.array.slice();skirt.userData.hem=[];
        for(let i=0;i<p.count;i++){
          const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
          if(y<1.05&&Math.abs(x)<.30)skirt.userData.hem.push({i,row:Math.round(clamp((y-.58)/.47)*64),fade:1-smooth((y-.93)/.12),facing:smooth(Math.abs(z)/.06),left:Math.exp(-(((x-anatomy.hipWidth)/.17)**4)),right:Math.exp(-(((x+anatomy.hipWidth)/.17)**4))});
        }
      }
      const envelopes={};
      for(const side of ['L','R']){
        const leg=rig.limbs[side+'leg'],points=[leg.upper,leg.lower,leg.tip].map(b=>rig.pelvis.worldToLocal(b.getWorldPosition(new THREE.Vector3())));
        envelopes[side]=Array.from({length:65},(_,row)=>{
          const y=.58+row/64*.47-.94;let front=.125,back=-.125;
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
    rig.root.updateMatrixWorld(true);skeleton.update();return pose;
  }};api.update('stand',1);return api;
}

export {loadExternalCharacter,adaptExternalCharacter} from './external.js';

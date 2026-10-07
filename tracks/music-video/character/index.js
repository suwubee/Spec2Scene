import * as THREE from '../engine/vendor/three.module.js';
import {material} from '../engine/materials/index.js';
import {createSkeleton,applyPose} from './rig.js';
import {poseAt} from './motion.js';
export {poseAt} from './motion.js';
export {inspectRig} from './rig.js';
function ellipsoid(parent, radius, scale, position, mat) {const mesh=new THREE.Mesh(new THREE.SphereGeometry(radius,24,16),mat);mesh.scale.set(...scale);mesh.position.set(...position);parent.add(mesh);return mesh;}
function segment(parent,length,radius,mat){const mesh=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius*.82,length,16),mat);mesh.position.y=-length/2;parent.add(mesh);ellipsoid(parent,radius,[1,1,1],[0,0,0],mat);return mesh;}
function sculptHead(mat) {
  const rings=[[-.135,.031,.043],[-.115,.058,.066],[-.07,.080,.081],[0,.086,.086],[.06,.084,.083],[.105,.070,.069],[.13,.035,.035],[.14,.002,.002]];
  const pts=[],indices=[],n=64,rows=45;
  for(let i=0;i<rows;i++) {const y=-.135+i/(rows-1)*.275;let k=rings.findIndex(r=>r[0]>=y);k=Math.max(1,k);const lo=rings[k-1],hi=rings[k],f=(y-lo[0])/(hi[0]-lo[0]),rx=lo[1]+(hi[1]-lo[1])*f,rz=lo[2]+(hi[2]-lo[2])*f;
    for(let j=0;j<n;j++){const a=j/n*Math.PI*2,x=Math.sin(a)*rx;let z=Math.cos(a)*rz;
      if(z>0){const front=Math.pow(Math.max(0,Math.cos(a)),8);const nose=Math.exp(-Math.pow(x/.015,2))*Math.exp(-Math.pow((y+.003)/.051,2))*.025;
        const socket=(Math.exp(-Math.pow((x-.033)/.020,2))+Math.exp(-Math.pow((x+.033)/.020,2)))*Math.exp(-Math.pow((y-.025)/.012,2))*.008;
        const lips=Math.exp(-Math.pow(x/.029,4))*Math.exp(-Math.pow((y+.067)/.009,2))*.005;z+=front*(nose-socket+lips);}
      pts.push(x,y,z);}}
  for(let i=0;i<rows-1;i++)for(let j=0;j<n;j++){const a=i*n+j,b=i*n+(j+1)%n;indices.push(a,b,a+n,b,b+n,a+n);}
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(pts,3));geo.setIndex(indices);geo.computeVertexNormals();return new THREE.Mesh(geo,mat);
}
export function createCharacter({body='masculine',height=1.78,headRatio=7.6,shoulderWidth=1,posture=0,coat=true,scarf=true,backpack=false,hat=false}={}) {
  if(!['masculine','feminine'].includes(body)||height<1.2||height>2.2||headRatio<6.5||headRatio>9) throw new Error('unsupported body proportions');
  const rig=createSkeleton(), holder=new THREE.Group(); holder.add(rig.root); holder.scale.setScalar(height/1.85);
  const cloth=material('cloth',{color:0x26333d}), pants=material('cloth',{color:0x172430}), skin=material('skin'), boots=material('metal',{color:0x10171b,metalness:.12,roughness:.7});
  const width=body==='feminine'?.89:1;
  const torso=new THREE.Mesh(new THREE.CylinderGeometry(.205*width,.18*width,.48,28),cloth);torso.position.y=.29;torso.scale.z=.65;rig.pelvis.add(torso);ellipsoid(rig.pelvis,.223,[width, .40, .65],[0,.50,0],cloth);
  const coatSkirt=new THREE.Mesh(new THREE.CylinderGeometry(.20*width,.29*width,.62,24,1,true),cloth);coatSkirt.position.y=.015;coatSkirt.scale.z=.72;coatSkirt.visible=coat;rig.pelvis.add(coatSkirt);
  if(coat) {
    for(const sign of [-1,1]){const lapel=new THREE.Mesh(new THREE.BoxGeometry(.065,.27,.018),cloth);lapel.position.set(sign*.06,.41,.155);lapel.rotation.z=sign*-.18;rig.pelvis.add(lapel);}
    for(let i=0;i<4;i++)ellipsoid(rig.pelvis,.012,[1,1,.5],[.025,.38-i*.095,.168],boots);
  }
  segment(rig.neck,.11,.052,skin).position.y=-.02;
  const head=new THREE.Group();head.position.y=.14;head.rotation.x=posture;head.scale.setScalar(7.6/headRatio);rig.neck.add(head);
  head.add(sculptHead(skin));
  const hair=material('cloth',{color:0x1c2126});
  ellipsoid(head,.11,[.82,.66,.86],[0,.08,-.013],hair);

  const eyes=[],brows=[];
  for(const sign of [-1,1]) {
    ellipsoid(head,.026,[.45,1,.65],[sign*.093,0,0],skin);
    ellipsoid(head,.016,[1,.32,.23],[sign*.033,.024,.075],skin);
    eyes.push(ellipsoid(head,.007,[1,.20,.15],[sign*.033,.022,.080],boots));
    const brow=ellipsoid(head,.018,[1,.10,.18],[sign*.034,.040,.079],hair);brow.rotation.z=sign*.08;brows.push(brow);
  }
  const mouth=ellipsoid(head,.022,[1,.10,.2],[0,-.067,.084],material('skin',{color:0x886b60}));
  if(hat){const hatMat=material('cloth',{color:0x252b30});const brim=new THREE.Mesh(new THREE.CylinderGeometry(.154,.154,.012,40),hatMat);brim.scale.z=.84;brim.position.y=.07;head.add(brim);const crown=new THREE.Mesh(new THREE.CylinderGeometry(.083,.104,.105,32),hatMat);crown.position.y=.122;head.add(crown);}
  const fingers=[];
  for(const l of Object.values(rig.limbs)) {
    const arm=l.type==='arm'; if(arm)l.upper.position.x*=width*shoulderWidth;
    segment(l.upper,l.a,arm?.071:.081,arm?cloth:pants);segment(l.lower,l.b,arm?.061:.069,arm?cloth:pants);
    if(arm){ellipsoid(l.tip,.066,[.6,1,.35],[0,-.048,0],skin);
      for(let i=0;i<5;i++){const finger=segment(l.tip,.048,.01,skin);finger.position.set((i-2)*.014,-.10,.008);fingers.push(finger);}
    }else ellipsoid(l.tip,.10,[.72,.45,1.5],[0,-.04,.05],boots);
  }
  let scarfTail;
  if(scarf){const mat=material('cloth',{color:0x435252});const collar=new THREE.Mesh(new THREE.TorusGeometry(.078,.022,8,32),mat);collar.rotation.x=Math.PI/2;collar.position.y=.61;rig.pelvis.add(collar);
    scarfTail=new THREE.Mesh(new THREE.BoxGeometry(.08,.37,.012),mat);scarfTail.position.set(-.08,.40,.182);rig.pelvis.add(scarfTail);}
  if(backpack)ellipsoid(rig.pelvis,.2,[.8,1.05,.45],[0,.30,-.20],material('cloth',{color:0x62584b}));
  return {object:holder,rig, update(action,t,options={}) {
    const pose=poseAt(action,t,options);applyPose(rig,pose);coatSkirt.rotation.x=pose.secondary;
    torso.scale.x=1+Math.sin(t*1.7)*.003;head.rotation.z=pose.secondary*.08;
    const expression=options.expression||'neutral';const browTilt={neutral:0,concern:.18,resolve:-.1,tired:.06}[expression];
    if(browTilt===undefined)throw new Error('unknown expression');brows.forEach((b,i)=>b.rotation.z=(i===0?-1:1)*(.08+browTilt));
    mouth.scale.y=options.viseme===undefined?.10:Math.max(.10,Math.min(.65,options.viseme));
    const fingerPose={rest:.22,open:0,fist:1.25,point:.5}[options.handPose||'rest'];
    if(fingerPose===undefined)throw new Error('unknown hand pose');pose.fingers=fingerPose;
    if(scarfTail)scarfTail.rotation.x=pose.secondary*2;
    eyes.forEach((e,i)=>{e.scale.y=pose.blink?.035:.25;e.position.x=(i===0?-1:1)*.033+(action==='turn'?Math.min(.003,t*.002):0);});
    fingers.forEach(f=>f.rotation.x=-pose.fingers);
    return pose;
  }};
}

import * as THREE from '../engine/vendor/three.module.js';
import {material} from './materials.js';
import {ellipsoid,stroke,sweep} from './geometry.js';
import {clamp,smooth} from './math.js';

const profile=[[-.141,.020,.035],[-.127,.045,.057],[-.105,.067,.071],[-.063,.080,.083],[-.014,.085,.087],[.036,.084,.082],[.080,.080,.078],[.117,.061,.062],[.142,.023,.025],[.146,.001,.001]];
function section(y,feminine){
  let k=1;while(k<profile.length-1&&profile[k][0]<y)k++;
  const a=profile[k-1],b=profile[k],t=clamp((y-a[0])/(b[0]-a[0])),h=b[0]-a[0],prev=profile[Math.max(0,k-2)],next=profile[Math.min(profile.length-1,k+1)];
  const r=i=>(2*t**3-3*t*t+1)*a[i]+(t**3-2*t*t+t)*h*(b[i]-prev[i])/(b[0]-prev[0])+(-2*t**3+3*t*t)*b[i]+(t**3-t*t)*h*(next[i]-a[i])/(next[0]-a[0]);
  return [r(1)*(feminine?.83+.13*smooth((y+.12)/.10):1),r(2)];
}
const bump=(v,c,s)=>Math.exp(-(((v-c)/s)**2));
function sculptHead(skin,feminine){
  const pts=[],indices=[],colors=[],n=96,rows=97;
  for(let i=0;i<rows;i++){
    const y=-.141+i/(rows-1)*.287,[rx,rz]=section(y,feminine);
    for(let j=0;j<n;j++){
      const a=j/n*Math.PI*2,x=Math.sin(a)*rx;let z=Math.cos(a)*rz;
      if(z>0){const front=Math.max(0,Math.cos(a))**4;
        const bridge=bump(x,0,.011)*bump(y,.001,.038)*.014,tip=bump(x,0,.015)*bump(y,-.021,.012)*(feminine?.012:.014);
        const wings=(bump(x,-.013,.008)+bump(x,.013,.008))*bump(y,-.027,.008)*.005;
        const sockets=(bump(x,-.032,.020)+bump(x,.032,.020))*bump(y,.018,.014)*.014;
        const cheeks=(bump(x,-.048,.027)+bump(x,.048,.027))*bump(y,-.025,.025)*(feminine?.005:.009);
        const brow=(bump(x,-.032,.025)+bump(x,.032,.025))*bump(y,.042,.012)*(feminine?.002:.005);
        const muzzle=bump(x,0,.032)*bump(y,-.062,.022)*.005,chin=bump(x,0,.032)*bump(y,-.115,.014)*(feminine?.004:.008);
        z+=front*(bridge+tip+wings-sockets+cheeks+brow+muzzle+chin);
      }
      pts.push(x,y,z);const warmth=bump(Math.abs(x),.045,.03)*bump(y,-.032,.028)*Math.max(0,z)*8;colors.push(1,1-warmth*.12,1-warmth*.13);
    }
  }
  for(let i=0;i<rows-1;i++)for(let j=0;j<n;j++){const a=i*n+j,b=i*n+(j+1)%n;indices.push(a,b,a+n,b,b+n,a+n);}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pts,3));g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));g.setIndex(indices);g.computeVertexNormals();
  const m=skin.clone();m.vertexColors=true;m.onBeforeCompile=skin.onBeforeCompile;m.customProgramCacheKey=skin.customProgramCacheKey;
  const mesh=new THREE.Mesh(g,m);mesh.name='sculpted-face';return mesh;
}
export function makeFace(head,skin,{body,hairStyle}){
  const feminine=body==='feminine',sculpt=sculptHead(skin,feminine);head.add(sculpt);const headRest=sculpt.geometry.attributes.position.array.slice();
  const hair=material('cloth',{color:0x291b16,roughness:.94,specularIntensity:.08}),lip=material('skin',{color:0xa76c60,roughness:.55}),dark=material('skin',{color:0x624138}),white=material('skin',{color:0xa59f8b,roughness:.3}),iris=material('skin',{color:0x4d4636,roughness:.34}),pupil=material('metal',{color:0x111712,metalness:0,roughness:.22});
  const eyes=[],brows=[],locks=[];
  for(const sign of [-1,1]){
    ellipsoid(head,.024,[.36,1,.62],[sign*(feminine?.081:.087),-.006,-.003],skin);
    stroke(head,[[sign*.087,-.024,.008],[sign*.097,-.011,.006],[sign*.097,.012,-.004],[sign*.088,.018,-.009]],.003,skin);
    const x=sign*.032,y=.019,z=.061,rx=feminine?.0145:.0135,ry=feminine?.0052:.0046;
    const eye=new THREE.Group();eye.position.set(x,y,z);head.add(eye);eyes.push(eye);
    ellipsoid(eye,.0118,[1,1,1],[0,0,0],white,'eyeball');
    ellipsoid(eye,.005,[1,1,.18],[0,0,.0114],iris);ellipsoid(eye,.0021,[1,1,.24],[0,0,.0123],pupil);
    // Fleshy lids cover the sphere, leaving a curved almond aperture.
    for(const upper of [true,false]){
      const points=[],positions=[],indices=[];
      for(let i=0;i<=24;i++){
        const u=i/24,dx=(u-.5)*rx*2,dy=(upper?1:-1)*Math.sin(u*Math.PI)*ry;
        const ez=z+Math.sqrt(Math.max(.000001,.0122**2-dx*dx-dy*dy));points.push([x+dx,y+dy,ez+.0004]);
        positions.push(x+dx,y+dy,ez,x+dx*1.30,y+dy+(upper?1:-1)*.010,.063-Math.abs(dx)*.18);
        if(i<24){const a=i*2;indices.push(a,a+1,a+2,a+1,a+3,a+2);}
      }
      const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geo.setIndex(indices);geo.computeVertexNormals();const lidMat=skin.clone();lidMat.side=THREE.DoubleSide;head.add(new THREE.Mesh(geo,lidMat));stroke(head,points,upper?.0013:.001,skin);
    }
    const brow=stroke(head,[[x-.016,.037,.075],[x-.002,.041,.080],[x+.015,.037,.074]],feminine?.0012:.0018,hair);brows.push(brow);
    ellipsoid(head,.0028,[1,.38,.45],[sign*.011,-.029,.096],dark);
  }
  // A soft cupid bow and lower lip, seated in the muzzle rather than drawn on it.
  const lowerLip=ellipsoid(head,.016,[1,.18,.28],[0,-.067,.0865],lip);
  const cavity=ellipsoid(head,.015,[1,.01,.35],[0,-.065,.091],new THREE.MeshStandardMaterial({color:0x26141a,roughness:1}),'mouth-cavity');
  const teeth=ellipsoid(head,.012,[1,.16,.1],[0,-.066,.094],new THREE.MeshStandardMaterial({color:0xd4cbb7,roughness:.55}),'upper-teeth');teeth.visible=false;
  for(const sign of [-1,1])ellipsoid(head,.009,[1,.20,.26],[sign*.007,-.0627,.0865],lip);
  const mouth=stroke(head,[[-.017,-.0648,.084],[0,-.0648,.090],[.017,-.0648,.084]],.0006,dark);
  // Scalp foundation has volume; larger swept locks define the silhouette.
  const pos=[],ind=[],n=64,rows=26;
  for(let i=0;i<rows;i++)for(let j=0;j<n;j++){
    const a=j/n*Math.PI*2,front=Math.max(0,Math.cos(a)),line=-.07+.159*front**.7,u=i/(rows-1),y=line+(.161-line)*u,[rx,rz]=section(Math.min(.145,y-.012),feminine);
    pos.push(Math.sin(a)*(rx+.007*(1-u)),y,Math.cos(a)*(rz+.009*(1-u)));
  }
  for(let i=0;i<rows-1;i++)for(let j=0;j<n;j++){const a=i*n+j,b=i*n+(j+1)%n;ind.push(a,b,a+n,b,b+n,a+n);}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setIndex(ind);g.computeVertexNormals();head.add(new THREE.Mesh(g,hair));
  const lock=(points,w,d,moving=false)=>{const mesh=new THREE.Mesh(sweep(points,{width:w,depth:d,taper:u=>.25+.75*Math.sin(Math.PI*(.05+.9*u))**.5}),hair);head.add(mesh);if(moving){mesh.userData.rest=mesh.geometry.attributes.position.array.slice();locks.push(mesh);}return mesh;};
  for(const sign of [-1,1])for(let i=0;i<6;i++){
    const x=sign*(.003+i*.008);
    lock([[x,.149-i*.001,.025],[sign*(.038+i*.006),.119,.057],[sign*(.075+i*.002),.065,.036],[sign*(.081+i*.002),-.035,-.012]],.007,.004);
  }
  if(hairStyle==='shoulder'){
    for(let i=0;i<27;i++){const a=.98+i/26*(Math.PI*2-1.96),x=Math.sin(a),z=Math.cos(a);
      lock([[x*.061,.121,z*.064],[x*.085,.034,z*.087],[x*.091,-.10,z*.096],[x*.090+.005*Math.sin(i),-.224+(i%3)*.007,z*.093]],.011,.009,true);}
  }else if(hairStyle==='ponytail'){
    for(let i=0;i<9;i++){const a=i/9*Math.PI*2;lock([[Math.sin(a)*.023,-.048,-.085],[Math.sin(a)*.027,-.12,-.145],[Math.sin(a)*.022+.018,-.22,-.16],[.026+Math.sin(a)*.013,-.31,-.137]],.015,.010,true);}
    ellipsoid(head,.029,[1,.7,.7],[0,-.07,-.109],hair);
  }else if(hairStyle==='bun'){
    ellipsoid(head,.05,[1,.82,.85],[0,.045,-.107],hair,'hair-bun');
    for(let i=0;i<7;i++){const a=i/7*Math.PI*2;lock([[Math.sin(a)*.033,.045+Math.cos(a)*.032,-.106],[Math.sin(a+.8)*.045,.045+Math.cos(a+.8)*.035,-.142],[Math.sin(a+1.6)*.018,.045+Math.cos(a+1.6)*.020,-.151]],.008,.006,true);}
  }else if(hairStyle!=='short')throw new Error('unknown hair style');
  let lastOpen=-1,lastRound=-1;
  return {eyes,brows,mouth,locks,updateMouth(open,round){
    if(open===lastOpen&&round===lastRound)return;lastOpen=open;lastRound=round;
    lowerLip.position.y=-.067-open*.027;lowerLip.position.z=.0865-open*.004;lowerLip.scale.x=1-round*.38;
    cavity.scale.set(1-round*.4,.01+open*.93,.35);cavity.position.y=-.065-open*.014;teeth.visible=open>.25;
    mouth.visible=open<.12;
    const p=sculpt.geometry.attributes.position;
    for(let i=0;i<p.count;i++){const x=headRest[i*3],y=headRest[i*3+1],z=headRest[i*3+2],weight=smooth((-.052-y)/.07);p.setXYZ(i,x,y-open*.027*weight,z-open*.009*weight);}
    p.needsUpdate=true;sculpt.geometry.computeVertexNormals();
  }};
}

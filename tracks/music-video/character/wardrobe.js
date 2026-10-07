import * as THREE from '../engine/vendor/three.module.js';
import {material} from './materials.js';
import {ellipsoid,stroke,sweep,clothStrip} from './geometry.js';
import {tube} from './surface.js';
import {smooth} from './math.js';

export function makeBoot(ankle,mat){
  const group=new THREE.Group();group.name='boot';ankle.add(group);
  // Shoe last: narrow heel, waist, broad metatarsals, rounded toe. All soles
  // share the gait's heel (-.106) and toe (+.194) contact landmarks.
  const sections=[[-.106,.006,-.059,.009],[-.098,.038,-.043,.035],[-.06,.048,-.012,.064],[0,.045,-.020,.054],[.075,.059,-.039,.035],[.145,.054,-.047,.027],[.183,.031,-.052,.022],[.194,.003,-.055,.019]];
  const last=(sole=false)=>{
    const p=[],idx=[],n=40;
    const path=new THREE.CatmullRomCurve3(sections.map(r=>new THREE.Vector3(r[0],r[1],r[2]))),depth=new THREE.CatmullRomCurve3(sections.map(r=>new THREE.Vector3(r[0],r[3],0))),rows=64;
    for(let i=0;i<rows;i++){const v=path.getPoint(i/(rows-1)),d=depth.getPoint(i/(rows-1)),z=v.x,rx=Math.max(.002,v.y),cy=v.z,ry=d.y;for(let j=0;j<n;j++){const a=j/n*Math.PI*2;p.push(Math.sin(a)*(rx+(sole?.003:0)),sole?-.074+Math.cos(a)*.009:Math.max(-.072,cy+Math.cos(a)*ry),z);}}
    for(let i=0;i<rows-1;i++)for(let j=0;j<n;j++){const a=i*n+j,b=i*n+(j+1)%n;idx.push(a,a+n,b,b,a+n,b+n);}
    for(const row of [0,rows-1]){
      const c=p.length/3,v=path.getPoint(row/(rows-1));p.push(0,sole?-.074:v.z,v.x);
      for(let j=0;j<n;j++){const a=row*n+j,b=row*n+(j+1)%n;idx.push(...(row?[c,b,a]:[c,a,b]));}
    }
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setIndex(idx);g.computeVertexNormals();return g;
  };
  const upper=new THREE.Mesh(last(),mat);upper.name='boot-last';group.add(upper);
  const soleMat=material('cloth',{color:0x171916,roughness:.78}),sole=new THREE.Mesh(last(true),soleMat);sole.name='boot-sole';group.add(sole);
  const shaft=new THREE.Mesh(tube([[-.02,.048,.052],[.035,.042,.045],[.11,.052,.055],[.14,.056,.058]],48,.004),mat);shaft.position.z=-.003;group.add(shaft);
  const heel=new THREE.Mesh(new THREE.BoxGeometry(.075,.012,.067),soleMat);heel.position.set(0,-.079,-.066);group.add(heel);
  stroke(group,[[-.041,-.004,.025],[0,.004,.043],[.041,-.004,.025]],.0013,soleMat);
  return group;
}
export function addTailoring(rig,{cloth,coatStyle,width,neckRadius}){
  const chest=rig.chest;
  const standCollar=new THREE.Mesh(tube([[.24,neckRadius+.028,.069],[.274,neckRadius+.016,.058]],48,.005),cloth);standCollar.name='coat-neck-binding';chest.add(standCollar);
  for(const sign of [-1,1]){
    const shape=new THREE.Shape();shape.moveTo(sign*.043,.245);shape.lineTo(sign*.137*width,.168);shape.lineTo(sign*.068,.025);shape.lineTo(sign*.020,.14);shape.closePath();
    const lapel=new THREE.Mesh(new THREE.ExtrudeGeometry(shape,{depth:.010,bevelEnabled:true,bevelSize:.002,bevelThickness:.002,bevelSegments:2,steps:1}),cloth);
    lapel.position.set(0,0,.14);lapel.name='coat-lapel';chest.add(lapel);
  }
  const collar=new THREE.Mesh(sweep([[-neckRadius,.225,.085],[-neckRadius-.025,.242,-.01],[0,.252,-.069],[neckRadius+.025,.242,-.01],[neckRadius,.225,.085]],{width:.025,depth:.008}),cloth);collar.name='coat-collar';chest.add(collar);
  for(let i=0;i<(coatStyle==='short'?2:3);i++)ellipsoid(chest,.006,[1,1,.45],[.024,.045-i*.093,.154],material('cloth',{color:0x292921}));
  if(coatStyle==='cloak'){
    // A deep open hood: outside and lining share a sewn rim; no face cap.
    const p=[],idx=[],rows=34,n=56,thick=.008;
    for(let layer=0;layer<2;layer++)for(let i=0;i<rows;i++)for(let j=0;j<=n;j++){
      const u=i/(rows-1),y=.292+u*.319,dome=Math.sqrt(Math.max(.0001,1-((y-.433)/.179)**2)),opening=.72*(1-smooth((u-.73)/.27)),a=opening+j/n*(Math.PI*2-2*opening),rx=.132*dome-layer*thick,rz=.135*dome-layer*thick;
      p.push(Math.sin(a)*Math.max(.001,rx),y,Math.cos(a)*Math.max(.001,rz)-.009);
    }
    const count=rows*(n+1);
    for(let l=0;l<2;l++)for(let i=0;i<rows-1;i++)for(let j=0;j<n;j++){const a=l*count+i*(n+1)+j,b=a+1,c=a+n+1,d=c+1;idx.push(...(l?[a,c,b,b,c,d]:[a,b,c,b,d,c]));}
    for(let i=0;i<rows-1;i++)for(const j of [0,n]){const a=i*(n+1)+j,b=a+n+1;idx.push(a,b,a+count,b,b+count,a+count);}
    for(const row of [0,rows-1])for(let j=0;j<n;j++){const a=row*(n+1)+j,b=a+1;idx.push(a,a+count,b,b,a+count,b+count);}
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setIndex(idx);g.computeVertexNormals();const hood=new THREE.Mesh(g,cloth);hood.name='cloak-hood';chest.add(hood);
    ellipsoid(chest,.018,[1,.7,.35],[0,.185,.153],material('metal',{color:0x726143,metalness:.5}));
  }
}
export function makeScarf(chest,neckRadius){
  const mat=material('cloth',{color:0x948577,roughness:.98}),group=new THREE.Group();group.name='scarf';chest.add(group);
  // One overlapping helical strip, 65 mm wide and 7 mm thick, not a torus.
  const points=[];
  for(let i=0;i<=52;i++){const u=i/52,a=-.35+u*Math.PI*2.22;points.push([Math.sin(a)*(neckRadius+.016+.002*Math.sin(a*5)),.295+u*.024+.004*Math.sin(a*3),Math.cos(a)*(neckRadius+.020+.002*Math.sin(a*5))]);}
  const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p))),p=[],idx=[],steps=80;
  for(let i=0;i<=steps;i++){const u=i/steps,c=curve.getPoint(u),a=-.35+u*Math.PI*2.22;for(const [dy,dr] of [[-.026,-.0035],[.026,-.0035],[.026,.0035],[-.026,.0035]])p.push(c.x+Math.sin(a)*dr,c.y+dy,c.z+Math.cos(a)*dr);}
  for(let i=0;i<steps;i++)for(let j=0;j<4;j++){const a=i*4+j,b=i*4+(j+1)%4;idx.push(a,b,a+4,b,b+4,a+4);}idx.push(0,1,2,0,2,3,steps*4,steps*4+2,steps*4+1,steps*4,steps*4+3,steps*4+2);
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setIndex(idx);g.computeVertexNormals();const wrap=new THREE.Mesh(g,mat);wrap.name='scarf-wrap';group.add(wrap);
  const knot=ellipsoid(group,.024,[1.05,.82,.66],[-.044,.283,.100],mat,'scarf-knot');
  stroke(group,[[-.063,.288,.112],[-.045,.293,.116],[-.027,.276,.112]],.002,mat);
  const tails=[];
  for(const [i,x,length] of [[0,-.061,.44],[1,-.015,.34]]){
    const mesh=new THREE.Mesh(clothStrip([[x,.269,.099],[x-.016,.20,.182],[x-.018,.08,.204],[x-.012,.269-length,.164]],i?.047:.055),mat);mesh.name=`scarf-tail-${i}`;mesh.userData.rest=mesh.geometry.attributes.position.array.slice();mesh.userData.length=length;group.add(mesh);tails.push(mesh);
  }
  return {group,tails,update(t,wind,gait){
    for(const [j,tail] of tails.entries()){const p=tail.geometry.attributes.position,r=tail.userData.rest;
      const rows=p.count/4,centres=[];
      for(let row=0;row<rows;row++){
        const c=new THREE.Vector3();for(let j=0;j<4;j++)c.add(new THREE.Vector3().fromArray(r,(row*4+j)*3));c.multiplyScalar(.25);
        const u=row/(rows-1),f=smooth(u)*u,flutter=Math.sin(t*3.1-u*3+j)*.026+gait*.035;
        c.x+=f*wind*(.48+flutter);c.y+=f*wind*.20;c.z+=f*(-wind*.25+flutter*.3);
        if(Math.abs(c.x)<.235){const clearance=.197*Math.sqrt(Math.max(0,1-(c.x/.235)**2))+.013;c.z+=(Math.max(c.z,clearance)-c.z)*smooth((u-.04)/.28);}
        centres.push(c);
      }
      for(let row=0;row<rows;row++){
        const tangent=centres[Math.min(rows-1,row+1)].clone().sub(centres[Math.max(0,row-1)]).normalize(),across=new THREE.Vector3().crossVectors(tangent,new THREE.Vector3(0,0,1)).normalize(),normal=across.clone().cross(tangent).normalize(),width=j?.047:.055;
        for(const [k,[a,b]] of [[-1,-1],[1,-1],[1,1],[-1,1]].entries()){
          const q=centres[row].clone().addScaledVector(across,a*width/2).addScaledVector(normal,b*.003);p.setXYZ(row*4+k,q.x,q.y,q.z);
        }
      }
      p.needsUpdate=true;tail.geometry.computeVertexNormals();
    }
  }};
}

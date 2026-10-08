import * as THREE from '../vendor/three.module.js';
/** Arc length, not curve parameter, determines step spacing. Same .45 m half-stride as gait(). */
export function pathFootsteps({path=null,count=62,step=.45,speed=.38,start=[0,0,9],stance=.105,startTime=null,birth=null,height=null}={}) {
  if(!Number.isInteger(count)||count<1||count>5000||![step,speed,stance].every(Number.isFinite)||step<=0||speed<=0||stance<0)throw new Error('invalid footsteps');
  const curve=Array.isArray(path)?new THREE.CatmullRomCurve3(path.map(p=>new THREE.Vector3(...p))):path;
  if(curve)curve.updateArcLengths();
  const length=curve?.getLength()??(count-1)*step;
  const n=Math.min(count,Math.floor(length/step+1e-7)+1);
  return Array.from({length:n},(_,i)=>{
    const d=i*step,u=length?d/length:0;
    const p=curve?curve.getPointAt(u):new THREE.Vector3(start[0]+Math.sin(i*.095)*.72,start[1],start[2]-d);
    const tangent=curve?curve.getTangentAt(u):new THREE.Vector3(.72*.095*Math.cos(i*.095)/step,0,-1).normalize();
    const yaw=Math.atan2(tangent.x,tangent.z),side=i%2?'R':'L',offset=(i%2?-1:1)*stance;
    p.x+=Math.cos(yaw)*offset;p.z-=Math.sin(yaw)*offset;
    if(height)p.y=height(p.x,p.z);
    return {x:p.x,y:p.y,z:p.z,yaw,side,distance:d,birth:birth?birth(i,d):(startTime??-count*step/speed)+d/speed};
  });
}

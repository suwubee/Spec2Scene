import * as THREE from './vendor/three.module.js';
/** Static project terrain sampled once; height and water coverage share world XZ coordinates. */
export function fogTerrain({heightAt,waterMask=()=>0,bounds=[-5000,-5000,5000,5000],resolution=128,skylineAt}={}) {
  if(typeof heightAt!=='function'||!Number.isInteger(resolution)||resolution<2||resolution>512||bounds.length!==4||!bounds.every(Number.isFinite)||bounds[2]<=bounds[0]||bounds[3]<=bounds[1])throw new Error('invalid fog terrain');
  const data=new Float32Array(resolution*resolution*4),[x0,z0,x1,z1]=bounds;
  for(let j=0;j<resolution;j++)for(let i=0;i<resolution;i++){
    const x=x0+(x1-x0)*i/(resolution-1),z=z0+(z1-z0)*j/(resolution-1),k=(j*resolution+i)*4,h=heightAt(x,z),water=waterMask(x,z);
    if(!Number.isFinite(h)||!Number.isFinite(water))throw new Error('nonfinite terrain sample');
    data[k]=h;data[k+1]=Math.max(0,Math.min(1,water));data[k+3]=1;
  }
  const texture=new THREE.DataTexture(data,resolution,resolution,THREE.RGBAFormat,THREE.FloatType);
  texture.minFilter=texture.magFilter=THREE.LinearFilter;texture.needsUpdate=true;
  const horizon=skylineAt||((p,azimuth)=>{
    const a=azimuth*Math.PI/180;let angle=-90;
    for(let d=10;d<=12000;d*=1.12){const x=p[0]+Math.sin(a)*d,z=p[2]-Math.cos(a)*d;if(x<x0||x>x1||z<z0||z>z1)break;angle=Math.max(angle,Math.atan2(heightAt(x,z)-p[1],d)*180/Math.PI);}
    return angle;
  });
  return {texture,bounds:new THREE.Vector4(x0,z0,x1-x0,z1-z0),skylineAt:horizon,dispose:()=>texture.dispose()};
}

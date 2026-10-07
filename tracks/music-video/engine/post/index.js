import * as THREE from '../vendor/three.module.js';
export function circleOfConfusion(depth,focus,focal=50,fstop=2.8,sensor=24) {
  const f=focal/1000;return Math.abs(f*f*(depth-focus)/(fstop*Math.max(depth,.001)*Math.max(focus-f,.001)))/(sensor/1000);
}
export function makeLUT(size=16,transform=rgb=>rgb) {
  const data=new Float32Array(size**3*4);
  for(let b=0;b<size;b++)for(let g=0;g<size;g++)for(let r=0;r<size;r++){const i=(b*size*size+g*size+r)*4;data.set([...transform([r/(size-1),g/(size-1),b/(size-1)]),1],i);}
  const texture=new THREE.Data3DTexture(data,size,size,size);texture.format=THREE.RGBAFormat;texture.type=THREE.FloatType;texture.minFilter=texture.magFilter=THREE.LinearFilter;texture.unpackAlignment=1;texture.needsUpdate=true;return texture;
}
export {createPost} from '../post.js';

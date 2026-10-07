import * as THREE from '../engine/vendor/three.module.js';
import {makeRng} from '../engine/noise.js';
import {box,mesh,disposeObject} from './common.js';
/** Facade faces +Z. Per-window schedules are absolute seconds, so reverse seek restores lights. */
export function createApartment({floors=10,columns=6,bayWidth=2.8,floorHeight=3,depth=9,seed=17,wetness=.6,windows={},balconies=true,airConditioners=true,roof=true}={}) {
  if(!Number.isInteger(floors)||!Number.isInteger(columns)||floors<1||floors>48||columns<1||columns>24||![bayWidth,floorHeight,depth,wetness].every(Number.isFinite)||Math.min(bayWidth,floorHeight,depth)<=0)throw new Error('invalid apartment dimensions');
  const object=new THREE.Group(),rng=makeRng(seed),width=columns*bayWidth,height=floors*floorHeight;
  const wall=new THREE.MeshPhysicalMaterial({color:0x68747b,roughness:.88-wetness*.35,clearcoat:THREE.MathUtils.clamp(wetness,0,1),clearcoatRoughness:.18});
  const concrete=new THREE.MeshStandardMaterial({color:0x6c7277,roughness:.9}),metal=new THREE.MeshStandardMaterial({color:0x5d6970,metalness:.7,roughness:.4}),recess=new THREE.MeshStandardMaterial({color:0x101c25,roughness:.7});
  object.add(box([width,height,depth],wall,[0,height/2,-depth/2-.32]));
  const lights=[];
  for(let floor=0;floor<floors;floor++)for(let col=0;col<columns;col++){
    const id=`${floor}:${col}`,x=(col-(columns-1)/2)*bayWidth,y=(floor+.5)*floorHeight,w=bayWidth*.62,h=floorHeight*.59;
    object.add(box([w+.18,h+.18,.03],recess,[x,y,-.29]));
    for(const side of [-1,1])object.add(box([.10,h+.3,.42],concrete,[x+side*(w+.12)/2,y,-.05]),box([w+.22,.10,.42],concrete,[x,y+side*(h+.18)/2,-.05]));
    const brightness=.15+rng()*.85,mat=new THREE.MeshPhysicalMaterial({color:0x26323c,emissive:0xffc883,emissiveIntensity:brightness,roughness:.18,metalness:.2,clearcoat:1});
    const pane=box([w,h,.03],mat,[x,y,-.26]);object.add(pane);lights.push({id,pane,base:brightness});
    object.add(box([.04,h,.12],metal,[x,y,-.19]));
    if(balconies&&(floor+col)%3===0){
      object.add(box([bayWidth*.9,.16,1.05],concrete,[x,y-h/2-.16,.35]));
      for(const side of [-1,1])object.add(box([bayWidth*.9,.05,.05],metal,[x,y-h/2+side*.38+.4,.86]));
      for(let i=0;i<8;i++)object.add(box([.028,.76,.028],metal,[x+(i/7-.5)*bayWidth*.86,y-h/2+.4,.86]));
    }
    if(airConditioners&&(floor+col)%2===0){
      const ax=x+bayWidth*.4;object.add(box([.52,.36,.25],concrete,[ax,y-h*.3,.05]));
      const fan=mesh(new THREE.TorusGeometry(.12,.012,5,16),metal,[ax,y-h*.3,.188]);object.add(fan);
      for(let i=0;i<4;i++)object.add(box([.27,.012,.015],metal,[ax,y-h*.3+(i-1.5)*.065,.19]));
    }
    // Wet runoff lies on the solid wall between bays, not over the glass.
    const stain=new THREE.MeshStandardMaterial({color:0x394c55,transparent:true,opacity:wetness*(.12+rng()*.25),roughness:.42,depthWrite:false});
    object.add(box([bayWidth*.05,floorHeight*(.4+rng()*.5),.004],stain,[x-bayWidth*.44,y-.2,.003-.319]));
  }
  if(roof){
    object.add(box([width+.3,.22,depth+.4],concrete,[0,height+.1,-depth/2]));
    const tank=mesh(new THREE.CylinderGeometry(.75,.75,1.5,24),metal,[-width*.2,height+1,-depth*.5]);object.add(tank);
    object.add(mesh(new THREE.ConeGeometry(.83,.3,24),metal,[-width*.2,height+1.9,-depth*.5]));
    object.add(box([.045,2.8,.045],metal,[width*.23,height+1.5,-depth*.4]));
    for(let i=0;i<4;i++)object.add(box([1.2-i*.17,.035,.035],metal,[width*.23,height+2+i*.16,-depth*.4]));
  }
  return {object,lights,update(t,world={}){if(!Number.isFinite(t))throw new Error('finite time required');for(const l of lights){const cfg=windows[l.id]||{},schedule=cfg.schedule||[];let value=cfg.brightness??l.base;for(const [at,b] of schedule)if(t>=at)value=b;if(t>=(cfg.offAt??Infinity))value=0;value=world.parameters?.[`window:${l.id}`]??value;l.pane.material.emissiveIntensity=Math.max(0,value);}},dispose(){disposeObject(object);}};
}

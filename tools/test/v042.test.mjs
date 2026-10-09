import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../tracks/music-video/engine/vendor/three.module.js';
import {createCharacter} from '../../tracks/music-video/character/index.js';
import {applyCharacterLook, rimIntensityForShot} from '../../tracks/music-video/character/look.js';
import {clampMoonPhase, moonLitFraction, clampMoonRadiance, moonDiscParameters} from '../../tracks/music-video/engine/moon-display.js';
import {disposeOwned, createResourceScope} from '../../tracks/music-video/engine/release.js';
import {guardGeometry, assertFiniteGeometry} from '../../tracks/music-video/engine/geometry-safety.js';
import {assertNoQualityRebuild, assertNoNewPrograms} from '../../tracks/music-video/player/compile-monitor.js';

test('character look is dark, low reflectance, hair-safe and idempotent', () => {
  const actor=createCharacter({coat:false});
  try {
    const look=applyCharacterLook(actor,{rim:.2}); assert.equal(applyCharacterLook(actor),look);
    actor.object.traverse(node=>{for(const material of (Array.isArray(node.material)?node.material:[node.material]).filter(Boolean)){assert.ok(material.roughness>=.99);assert.equal(material.metalness,0);assert.ok(material.color.r<.2&&material.color.g<.2&&material.color.b<.2);}});
    assert.ok(look.rim);look.update(null,[0,.4,-1],null,{distance:2});assert.equal(look.rim.intensity,rimIntensityForShot({distance:2}));look.dispose();
  } finally { actor.object.traverse(node=>{node.geometry?.dispose();for(const m of (Array.isArray(node.material)?node.material:[node.material]).filter(Boolean))m.dispose();}); }
});

test('moon display clamps phase/radiance and scales both halos with illuminated fraction', () => {
  assert.equal(clampMoonPhase(-10),0);assert.equal(clampMoonPhase(220),180);assert.equal(moonLitFraction(0),1);assert.ok(moonLitFraction(180)<1e-12);
  assert.throws(()=>clampMoonPhase(NaN));const a=clampMoonRadiance({requested:28,exposure:4});assert.ok(a.effective<a.requested&&a.effective<=a.cap);
  const full=moonDiscParameters({phase:0,radiance:20}),crescent=moonDiscParameters({phase:150,radiance:20});assert.ok(full.halos.inner>crescent.halos.inner);assert.ok(full.radius>0);
});

test('owned release leaves shared textures alive and repeated scopes do not double dispose', () => {
  let sharedDisposed=0,ownDisposed=0;const shared={dispose(){sharedDisposed++;},userData:{shared:true}},own={dispose(){ownDisposed++;}};
  const material={map:shared,dispose(){ownDisposed++;}},geometry={dispose(){ownDisposed++;}},root=new THREE.Group();const mesh=new THREE.Object3D();mesh.geometry=geometry;mesh.material=material;root.add(mesh);
  const first=disposeOwned(root);assert.equal(first.skipped,1);assert.equal(sharedDisposed,0);assert.equal(ownDisposed,2);const scope=createResourceScope({shared:[shared]}).own(own).share(shared);assert.equal(scope.dispose().disposed,1);assert.equal(scope.dispose().disposed,0);
});

test('geometry guard reports and repairs normal/color NaNs but never hides position NaN', () => {
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0],3));g.setAttribute('normal',new THREE.Float32BufferAttribute([NaN,0,0],3));g.setAttribute('color',new THREE.Float32BufferAttribute([0,Infinity,0],3));
  const report=guardGeometry(g,{repair:true});assert.equal(report.repaired,2);assertFiniteGeometry(g);g.attributes.position.array[0]=NaN;assert.throws(()=>assertFiniteGeometry(g,{repair:true}),/nonfinite/);g.dispose();
});

test('quality switch and program-count constraints are explicit', () => {
  assert.equal(assertNoQualityRebuild([{rebuilt:false,definesChanged:false}]),true);assert.throws(()=>assertNoQualityRebuild([{rebuilt:true}]),/rebuilt/);assert.equal(assertNoNewPrograms(4,4),true);assert.throws(()=>assertNoNewPrograms(4,5),/compiled/);
});

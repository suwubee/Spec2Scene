// Author: suwubee

// parted a little off-centre so the plum branch rises between them. Wind deformation is the closed-form GPU cloth
// chunk of geo.js/materials.js (M.applyCloth / setCloth), shadows use the matching alpha-hashed depth material
// (a mottled ~50 % shadow that carries the weave), back-lit translucency makes the panels glow with the lattice's
// shadow printed on them. World coordinates.
//

//   scene.add(gz.object);  gz.update(t, world, { gust: 0..1, still: 0..1 });
import * as THREE_NS from '../engine/vendor/three.module.js';
import * as G from '../engine/geo.js';
import { gnoise1, pink1 } from '../engine/noise.js';

export const GAUZE = { x: .12, topY: 2.2, length: 1.52, panels: [[-0.86, -0.24], [0.3, 0.9]] };

export function createGauze(ctx, M, opts = {}) {
  const THREE = ctx.THREE || THREE_NS;
  const O = { ...GAUZE, ...opts };
  const group = new THREE.Group(); group.name = 'interior.gauze';
  const panels = O.panels.map(([z0, z1], i) => {
    const w = (z1 - z0) * 1.18;                   // gathered: cloth wider than the span it covers
    const geo = G.clothPlane(w, O.length, 40, { folds: 6 + i, foldDepth: 0.03, seed: 11 + i, segsY: 44 });
    geo.scale((z1 - z0) / w, 1, 1);                // compress across (the folds deepen)
    const mat = M.gauze({ seed: 2 + i, translucency: 0.95, objSeed: 61 + i });
    mat.depthWrite = true;                         // DOF: the panel's own depth (not the far exterior's)
    M.applyCloth(mat, { width: z1 - z0, height: O.length });
    const mesh = new THREE.Mesh(geo, mat); mesh.name = 'gauzePanel' + i;
    mesh.position.set(O.x + i * 0.012, O.topY - 0.012, (z0 + z1) / 2);
    mesh.rotation.y = Math.PI / 2;                 // local +z -> world +x (room side); local x -> world -z
    mesh.castShadow = true; mesh.receiveShadow = true;
    const dm = M.makeDepthMaterial(mat); mesh.customDepthMaterial = dm.depth; mesh.customDistanceMaterial = dm.distance;
    mesh.renderOrder = 30;
    group.add(mesh);
    return { mesh, mat, geo, z0, z1, phase: i * 1.7 };
  });
  // rod + rings (dark bamboo)
  const rodMat = M.bambooRod({ seed: 8, objSeed: 64, color: new THREE.Color().setRGB(0.55, 0.45, 0.35), anisotropy: 0 });   // (isotropic: pole UVs of the rod ends)
  const rod = new THREE.Mesh(G.bambooRod({ length: 1.94, radius: 0.0085, nodeSpacing: 0.4, seed: 21 }), rodMat);
  rod.rotation.x = Math.PI / 2; rod.position.set(O.x, O.topY, -0.97);
  rod.castShadow = true; rod.receiveShadow = true; rod.name = 'gauzeRod';
  group.add(rod);
  const ringMat = M.metalString({ kind: 'brass', seed: 3, anisotropy: 0 }); ringMat.roughness = 1.8;
  const ringGeo = new THREE.TorusGeometry(0.0125, 0.0016, 6, 16);
  for (const p of panels) {
    const n = Math.max(4, Math.round((p.z1 - p.z0) / 0.075));
    for (let k = 0; k <= n; k++) {
      const r = new THREE.Mesh(ringGeo, ringMat);
      r.position.set(O.x, O.topY - 0.003, p.z0 + (p.z1 - p.z0) * (k / n)); r.rotation.y = 0;
      r.castShadow = true; group.add(r);
    }
  }
  // brackets holding the rod (small dark wooden blocks on the wall)
  const brMat = M.wood({ variant: 'hardwood', seed: 17, objSeed: 65 });
  for (const z of [-0.95, 0.95]) {
    const b = new THREE.Mesh(G.bevelBox(0.11, 0.03, 0.03, 0.004), brMat);
    b.position.set(O.x - 0.045, O.topY + 0.006, z); b.castShadow = true; b.receiveShadow = true; group.add(b);
  }
  return {
    object: group, panels,
    /** t = film time; x: { gust (extra wind 0..1), still (hush 0..1), amp } */
    update(t, world, x = {}) {
      const still = x.still ?? 0;
      for (const p of panels) {
        const gust = (x.gust ?? 0) * (0.7 + 0.3 * gnoise1(t * 0.8 + p.phase, 5));
        const w = Math.min(1, (world ? world.wind : 0.25) * (1 - 0.9 * still) + gust * 0.8);
        const P = G.clothParams({ ...world, wind: w }, p.mesh, { amp: (x.amp ?? 0.16) * (1 + 0.6 * gust), freq: 0.3 + 0.08 * gust, idle: 0.004 * (1 - 0.7 * still), h: O.length });
        M.setCloth(p.mat, P, t + p.phase);
      }
    },
    dispose() { for (const p of panels) p.geo.dispose(); ringGeo.dispose(); },
  };
}
export default createGauze;

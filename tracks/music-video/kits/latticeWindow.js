// Author: suwubee


// with its pull cord and knot. World coordinates (ROOM.win of roomShell.js).
//

//   scene.add(win.object);
//   win.update(t, world, { roll, sway, still })    // pure fn of (t, world): blind roll/sway, cord swing
//   win.blindEdgeY(roll)                            // world y of the blind's lower edge for a roll value (patch maths)
import * as THREE_NS from '../engine/vendor/three.module.js';
import * as G from '../engine/geo.js';
import { makeRng, hashString, gnoise1 } from '../engine/noise.js';

export const WINDOW = {
  center: [0, 1.5, 0], width: 1.4, height: 1.5, frameW: 0.045, barW: 0.025, depth: 0.04,
  blind: { x: .095, topY: 2.228, width: 1.36, length: 1.6, seed: 7 },
};

export function createLatticeWindow(ctx, M, opts = {}) {
  const THREE = ctx.THREE || THREE_NS;
  const O = { ...WINDOW, ...opts };
  const group = new THREE.Group(); group.name = 'interior.window';
  // ---------------- lattice (faces west; bevelled members; grain along every member) ----------------
  const lg = G.latticeFrame(5, 6, { width: O.width, height: O.height, frameW: O.frameW, barW: O.barW, depth: O.depth, barDepth: 0.028, bevel: 0.004, barBevel: 0.0028, seed: 3 });
  const latMat = M.wood({ variant: 'hardwood', seed: 13, edgeWear: 0.7, objSeed: 31, params: { scratches: 0.4 } });
  const lattice = new THREE.Mesh(lg, latMat); lattice.name = 'lattice';
  lattice.position.set(O.center[0], O.center[1], O.center[2]); lattice.rotation.y = -Math.PI / 2;
  lattice.castShadow = true; lattice.receiveShadow = true;
  group.add(lattice);
  // ---------------- blind ----------------
  const bd = G.slatArray({ width: O.blind.width, length: O.blind.length, rolled: 0.5, rollSide: -1, seed: O.blind.seed, ragged: 0.005 });
  // Rolled slat ends have degenerate UV tangents; isotropic specular avoids unbounded highlights.
  const slatMat = M.bambooSlat({ seed: 3, translucency: 0.95, anisotropy: opts.slatAnisotropy ?? 0 });
  const threadMat = M.linen({ seed: 6, color: new THREE.Color().setRGB(0.24, 0.16, 0.1), translucency: 0.0 });
  const barMat = M.bambooRod({ seed: 5, objSeed: 33, anisotropy: 0 });   // (isotropic: capped rod ends have degenerate pole UVs → NaN tangents)
  const blind = G.blindGroup(bd, { slat: slatMat, thread: threadMat, bar: barMat });
  blind.name = 'blind';
  blind.position.set(O.blind.x, O.blind.topY, O.center[2]);
  blind.rotation.y = Math.PI / 2;                   // local +z (front) -> world +x (room side)
  // perf: replace the per-slat instanced thread segments (3 × n instances) by 3 pairs of straight binding threads
  // running down the hanging part (front + back of the slats); they follow the blind's closed-form pendulum swing
  const oldThreads = blind.getObjectByName('threads');
  if (oldThreads) { blind.remove(oldThreads); oldThreads.geometry.dispose(); }
  const threadPivot = new THREE.Group(); threadPivot.name = 'threadPivot';
  const tGeo = new THREE.CylinderGeometry(0.00075, 0.00075, 1, 5, 1, true); tGeo.translate(0, -0.5, 0);
  const threadMeshes = [];
  for (const x of bd.threadX) for (const sz of [-1, 1]) {
    const m = new THREE.Mesh(tGeo, threadMat); m.castShadow = true; m.receiveShadow = true;
    m.userData.tx = x; m.userData.tz = sz * (bd.opts.slatT / 2 + 0.0008);
    threadPivot.add(m); threadMeshes.push(m);
  }
  blind.add(threadPivot);
  blind.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  group.add(blind);
  // pull cord: a tube from the top bar down to ~0.6 m, knot bead; swings (closed form) with the blind
  const cordLen = 0.62;
  const cordCurve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.002, -cordLen * 0.33, 0), new THREE.Vector3(-0.001, -cordLen * 0.66, 0), new THREE.Vector3(0.0, -cordLen, 0)]);
  const cordMat = threadMat;
  const cord = new THREE.Mesh(G.tubeAlongCurve(cordCurve, 0.0014, { tubular: 24, radial: 5 }), cordMat); cord.name = 'cord';
  const knot = new THREE.Mesh(new THREE.SphereGeometry(0.0055, 10, 8), cordMat); knot.position.y = -cordLen * 0.93; knot.scale.set(1, 1.3, 1);
  const tassel = new THREE.Mesh(new THREE.ConeGeometry(0.004, 0.028, 8, 1, true), cordMat); tassel.position.y = -cordLen - 0.012; tassel.rotation.x = Math.PI;
  const cordPivot = new THREE.Group(); cordPivot.name = 'cordPivot';
  cordPivot.add(cord, knot, tassel);
  cordPivot.position.set(O.blind.x + 0.012, O.blind.topY - 0.02, O.center[2] + O.blind.width / 2 - 0.03);
  cordPivot.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  group.add(cordPivot);

  const data = bd;
  /** world y of the blind's lower edge for a given roll fraction (mean of the ragged edge) */
  function blindEdgeY(roll) {
    const P = G.blindPlacement(data, roll);
    return O.blind.topY + P.rollCenter[1] - (P.flatCount - 0.5) * data.pitch - data.opts.slatW / 2;
  }
  return {
    object: group, lattice, blind, cordPivot, data, materials: { lattice: latMat, slat: slatMat, thread: threadMat, bar: barMat },
    blindEdgeY,
    /** t = film time; world = world.at(t); x: { roll, sway (0..1 multiplier), still (0..1 hush damping) } */
    update(t, world, x = {}) {
      const still = x.still ?? 0;
      const sway = (x.sway ?? 1) * (1 - 0.85 * still);
      G.updateBlind(blind, t, world, { roll: x.roll, sway, seed: 3 });
      const w = world ? world.wind : 0.25;
      {   // binding threads: same pivot + swing as geo.updateBlind (seed 3)
        const P = blind.userData.placement;
        if (P) {
          const [, yc, zc] = P.rollCenter, len = P.flatCount * bd.pitch;
          threadPivot.position.set(0, yc, zc);
          threadPivot.rotation.x = sway * (0.012 * w + 0.002) * (0.6 * Math.sin(2 * Math.PI * 0.23 * t + 3) + 0.4 * gnoise1(t * 0.7, 3));
          for (const m of threadMeshes) { m.position.set(m.userData.tx, 0, -zc + m.userData.tz); m.scale.set(1, len, 1); }
        }
      }
      const a = sway * (0.05 * w + 0.01) * (0.65 * Math.sin(t * 1.37 + 0.4) + 0.35 * gnoise1(t * 0.9, 41));
      cordPivot.rotation.x = a; cordPivot.rotation.z = 0.4 * a * gnoise1(t * 0.6, 43);
    },
    dispose() { lg.dispose(); },
  };
}
export default createLatticeWindow;

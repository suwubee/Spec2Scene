// Author: suwubee
// rock/sdf.js — naive surface nets on a signed-distance lattice (CPU, pure JS, deterministic).
// f(x,y,z) < 0 inside. Returns indexed triangles with smooth normals (lattice gradient) and a baked
// ambient-occlusion value per vertex (SDF cone estimate). Used for the 太湖石 pieces with real holes.

/**
 * @param f      (x,y,z) => signed distance (negative inside)
 * @param min,max  [x,y,z] bounds of the lattice (metres or unit space)
 * @param cell   lattice spacing
 * @param opts   { aoDist: [d1,d2,d3] sample distances, aoStrength }
 * @returns {{ pos: Float32Array, nor: Float32Array, ao: Float32Array, idx: Uint32Array, vertexCount, triCount }}
 */
export function surfaceNets(f, min, max, cell, opts = {}) {
  const nx = Math.max(3, Math.ceil((max[0] - min[0]) / cell) + 1);
  const ny = Math.max(3, Math.ceil((max[1] - min[1]) / cell) + 1);
  const nz = Math.max(3, Math.ceil((max[2] - min[2]) / cell) + 1);
  const val = new Float32Array(nx * ny * nz);
  const sx = 1, sy = nx, sz = nx * ny;
  for (let k = 0; k < nz; k++) {
    const z = min[2] + k * cell;
    for (let j = 0; j < ny; j++) {
      const y = min[1] + j * cell;
      let o = k * sz + j * sy;
      for (let i = 0; i < nx; i++, o++) val[o] = f(min[0] + i * cell, y, z);
    }
  }
  // cell (i,j,k) spans lattice points (i..i+1, j..j+1, k..k+1); vertex id per cell
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const cellId = new Int32Array(cx * cy * cz).fill(-1);
  const P = [], CORNERS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const cv = new Float32Array(8);
  for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      const v = val[(k + CORNERS[c][2]) * sz + (j + CORNERS[c][1]) * sy + (i + CORNERS[c][0])];
      cv[c] = v; if (v < 0) mask |= 1 << c;
    }
    if (mask === 0 || mask === 255) continue;
    let ax = 0, ay = 0, az = 0, n = 0;
    for (let e = 0; e < 12; e++) {
      const a = EDGES[e][0], b = EDGES[e][1];
      if ((cv[a] < 0) === (cv[b] < 0)) continue;
      const t = cv[a] / (cv[a] - cv[b]);
      ax += CORNERS[a][0] + (CORNERS[b][0] - CORNERS[a][0]) * t;
      ay += CORNERS[a][1] + (CORNERS[b][1] - CORNERS[a][1]) * t;
      az += CORNERS[a][2] + (CORNERS[b][2] - CORNERS[a][2]) * t;
      n++;
    }
    cellId[(k * cy + j) * cx + i] = P.length / 3;
    P.push(min[0] + (i + ax / n) * cell, min[1] + (j + ay / n) * cell, min[2] + (k + az / n) * cell);
  }
  const idx = [];
  const cid = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= cx || j >= cy || k >= cz) ? -1 : cellId[(k * cy + j) * cx + i];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) idx.push(a, b, c, a, c, d); else idx.push(a, c, b, a, d, c);
  };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v0 = val[k * sz + j * sy + i] < 0;
    if (i < nx - 1 && j > 0 && k > 0 && (val[k * sz + j * sy + i + 1] < 0) !== v0)       // edge along +x
      quad(cid(i, j - 1, k - 1), cid(i, j, k - 1), cid(i, j, k), cid(i, j - 1, k), v0);
    if (j < ny - 1 && i > 0 && k > 0 && (val[k * sz + (j + 1) * sy + i] < 0) !== v0)     // edge along +y
      quad(cid(i - 1, j, k - 1), cid(i - 1, j, k), cid(i, j, k), cid(i, j, k - 1), v0);
    if (k < nz - 1 && i > 0 && j > 0 && (val[(k + 1) * sz + j * sy + i] < 0) !== v0)     // edge along +z
      quad(cid(i - 1, j - 1, k), cid(i, j - 1, k), cid(i, j, k), cid(i - 1, j, k), v0);
  }
  const nv = P.length / 3;
  const pos = new Float32Array(P);
  // lattice gradient (central differences), trilinear at the vertex
  const gradAt = (i, j, k, out) => {
    const ii = Math.min(nx - 2, Math.max(1, i)), jj = Math.min(ny - 2, Math.max(1, j)), kk = Math.min(nz - 2, Math.max(1, k));
    const o = kk * sz + jj * sy + ii;
    out[0] = val[o + 1] - val[o - 1]; out[1] = val[o + sy] - val[o - sy]; out[2] = val[o + sz] - val[o - sz];
  };
  const nor = new Float32Array(nv * 3), ao = new Float32Array(nv);
  const g = [new Float32Array(3), new Float32Array(3), new Float32Array(3), new Float32Array(3), new Float32Array(3), new Float32Array(3), new Float32Array(3), new Float32Array(3)];
  const lat = (x, y, z) => {           // trilinear lattice lookup (outside → +large)
    const fx = (x - min[0]) / cell, fy = (y - min[1]) / cell, fz = (z - min[2]) / cell;
    if (fx < 0 || fy < 0 || fz < 0 || fx >= nx - 1 || fy >= ny - 1 || fz >= nz - 1) return 1;
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz), u = fx - i, v = fy - j, w = fz - k;
    const o = k * sz + j * sy + i;
    const a = val[o] * (1 - u) + val[o + 1] * u, b = val[o + sy] * (1 - u) + val[o + sy + 1] * u;
    const c = val[o + sz] * (1 - u) + val[o + sz + 1] * u, d = val[o + sz + sy] * (1 - u) + val[o + sz + sy + 1] * u;
    return (a * (1 - v) + b * v) * (1 - w) + (c * (1 - v) + d * v) * w;
  };
  const aoD = opts.aoDist || [cell * 1.5, cell * 4, cell * 9], aoS = opts.aoStrength ?? 1.0;
  for (let v = 0; v < nv; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    const fx = (x - min[0]) / cell, fy = (y - min[1]) / cell, fz = (z - min[2]) / cell;
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz), u = fx - i, vv = fy - j, w = fz - k;
    let gx = 0, gy = 0, gz = 0, c = 0;
    for (let dk = 0; dk < 2; dk++) for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
      gradAt(i + di, j + dj, k + dk, g[c]);
      const wt = (di ? u : 1 - u) * (dj ? vv : 1 - vv) * (dk ? w : 1 - w);
      gx += g[c][0] * wt; gy += g[c][1] * wt; gz += g[c][2] * wt; c++;
    }
    const l = Math.hypot(gx, gy, gz) || 1;
    gx /= l; gy /= l; gz /= l;
    nor[v * 3] = gx; nor[v * 3 + 1] = gy; nor[v * 3 + 2] = gz;
    // SDF ambient occlusion: how much of the cone along the normal is blocked
    let occ = 0, wsum = 0;
    for (let q = 0; q < aoD.length; q++) {
      const d = aoD[q], s = lat(x + gx * d, y + gy * d, z + gz * d);
      const wq = 1 / (1 + q * 0.9);
      occ += wq * Math.max(0, Math.min(1, (d - s) / d)); wsum += wq;
    }
    ao[v] = 1 - Math.min(1, aoS * occ / wsum);
  }
  return { pos, nor, ao, idx: new Uint32Array(idx), vertexCount: nv, triCount: idx.length / 3 };
}

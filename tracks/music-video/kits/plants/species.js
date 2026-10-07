// Author: suwubee
// plants/species.js — the species catalogue: names, generator parameters, colours (linear RGB), LOD distances.
// Heights / radii in metres for a "nominal" individual; instances scale by 0.8 … 1.25.
// Colour notes: leaf colours are albedo multipliers on top of the atlas luminance (mean ≈ 0.7), early-summer fresh green.

const bark = (col, style, uRep = 1, vScale = 0.4, uvStretch = 1) => ({ col: [col[0] * 0.93, col[1], col[2] * 1.08], style, uRep, vScale, stretch: uvStretch });

// generator 'broadleaf' (sub-crown model): trunk → leaders → branches → sub-crowns of leaf cards
export const SPECIES = {
  camphor: {
    zh: '香樟', gen: 'broadleaf', variants: 2, scale: [0.85, 1.2], lodMul: 1.15,
    H: 13, R: 6.2, trunkH: 3.3, trunkR: 0.42, taper: 0.55, leaders: 3, spread: 38, leaderLen: 1.0, leaderR: 0.62, apical: 0.9, branchLen: 0.62,
    nb: 5, lean: 0.03, sweep: 0.25, subR: 0.34, subSquash: 0.72, fill: 5,
    tile: 'broad', cardSize: 0.95, density: 1.5, col: [0.073, 0.148, 0.033], trans: 0.55, flex: 0.55, faceOut: 0.5,
    bark: bark([0.078, 0.062, 0.050], 0, 1, 0.5),
  },
  broadleaf: {   // 榆 / 榉 / 槐 / 枫杨 / 女贞 filler: taller vase-shaped crown, small leaflets
    zh: '杂木(榆·枫杨·槐)', gen: 'broadleaf', variants: 2, scale: [0.8, 1.2], lodMul: 1.1,
    H: 11.5, R: 4.6, trunkH: 3.6, trunkR: 0.30, taper: 0.5, leaders: 3, spread: 30, leaderLen: 1.0, leaderR: 0.6, apical: 1.3, branchLen: 0.6,
    nb: 5, lean: 0.04, sweep: 0.3, subR: 0.32, subSquash: 0.8, fill: 4,
    tile: 'fine', cardSize: 0.85, density: 1.5, col: [0.081, 0.150, 0.033], trans: 0.6, flex: 0.7, faceOut: 0.45,
    bark: bark([0.070, 0.058, 0.048], 0, 1, 0.5),
  },
  wutong: {
    zh: '梧桐', gen: 'broadleaf', variants: 1, scale: [0.85, 1.15], lodMul: 1.1,
    H: 10.5, R: 3.9, trunkH: 4.3, trunkR: 0.22, taper: 0.62, leaders: 3, spread: 33, leaderLen: 1.0, leaderR: 0.62, apical: 1.0, branchLen: 0.62,
    nb: 4, lean: 0.03, sweep: 0.15, subR: 0.36, subSquash: 0.7, fill: 3,
    tile: 'wutong', cardSize: 1.0, density: 1.3, col: [0.085, 0.165, 0.039], trans: 0.65, flex: 0.65, faceOut: 0.5,
    bark: bark([0.125, 0.155, 0.100], 1, 1, 0.3),
  },
  plane: {      // 悬铃木 / 法国梧桐 (London plane): a common temperate street tree — straight trunk with mottled olive / cream / grey bark, broad spreading crown, big palmate leaves
    zh: '悬铃木', gen: 'broadleaf', variants: 2, scale: [0.85, 1.2], lodMul: 1.2,
    H: 15.5, R: 6.2, trunkH: 4.8, trunkR: 0.36, taper: 0.5, leaders: 4, spread: 34, leaderLen: 1.0, leaderR: 0.62, apical: 0.95, branchLen: 0.64,
    nb: 5, lean: 0.03, sweep: 0.2, subR: 0.34, subSquash: 0.78, fill: 5,
    tile: 'wutong', cardSize: 1.1, density: 1.25, col: [0.088, 0.172, 0.040], trans: 0.62, flex: 0.62, faceOut: 0.5,
    bark: bark([0.31, 0.29, 0.24], 4, 1, 3.0), stagger: 0.2,
  },
  ginkgo: {     // 银杏: straight trunk, ascending branches, ovoid crown of fresh yellow-green fan leaves
    zh: '银杏', gen: 'broadleaf', variants: 2, scale: [0.85, 1.2], lodMul: 1.1,
    H: 15, R: 4.1, trunkH: 3.6, trunkR: 0.30, taper: 0.5, leaders: 5, spread: 21, leaderLen: 1.0, leaderR: 0.6, apical: 1.5, branchLen: 0.58,
    nb: 5, lean: 0.015, sweep: 0.1, subR: 0.32, subSquash: 1.12, fill: 4,
    tile: 'ginkgo', cardSize: 0.8, density: 1.5, col: [0.108, 0.198, 0.036], trans: 0.78, flex: 0.68, faceOut: 0.5,
    bark: bark([0.12, 0.105, 0.088], 0, 1, 0.5), stagger: 0.16,
  },
  magnolia: {   // 广玉兰: evergreen, dark glossy, dense conical dome
    zh: '广玉兰', gen: 'broadleaf', variants: 1, scale: [0.85, 1.25], lodMul: 1.1,
    H: 10.5, R: 4.0, trunkH: 2.2, trunkR: 0.30, taper: 0.5, leaders: 2, spread: 24, leaderLen: 1.0, leaderR: 0.7, apical: 1.5, branchLen: 0.62,
    nb: 5, lean: 0.02, sweep: 0.12, subR: 0.34, subSquash: 0.85, fill: 5,
    tile: 'large', cardSize: 1.1, density: 1.4, col: [0.037, 0.085, 0.025], trans: 0.35, flex: 0.45, faceOut: 0.55, rough: 0.5,
    bark: bark([0.075, 0.066, 0.056], 1, 1, 0.4),
  },
  yulan: {      // 玉兰 (Magnolia denudata)
    zh: '玉兰', gen: 'broadleaf', variants: 1, scale: [0.8, 1.2], lodMul: 1.0,
    H: 7.5, R: 3.4, trunkH: 1.7, trunkR: 0.2, taper: 0.5, leaders: 3, spread: 36, leaderLen: 1.0, leaderR: 0.62, apical: 1.0, branchLen: 0.66,
    nb: 4, lean: 0.04, sweep: 0.2, subR: 0.34, subSquash: 0.8, fill: 3,
    tile: 'large', cardSize: 0.95, density: 1.3, col: [0.083, 0.150, 0.033], trans: 0.55, flex: 0.6, faceOut: 0.5,
    bark: bark([0.165, 0.150, 0.130], 1, 1, 0.4),
  },
  maple: {      // 枫 (鸡爪槭): layered horizontal crown
    zh: '枫', gen: 'broadleaf', variants: 1, scale: [0.8, 1.25], lodMul: 1.0,
    H: 6.0, R: 3.3, trunkH: 1.8, trunkR: 0.17, taper: 0.5, leaders: 3, spread: 48, leaderLen: 0.95, leaderR: 0.62, apical: 0.4, branchLen: 0.7,
    nb: 4, lean: 0.07, sweep: 0.35, subR: 0.34, subSquash: 0.5, fill: 3,
    tile: 'maple', cardSize: 0.85, density: 1.5, col: [0.085, 0.150, 0.033], trans: 0.7, flex: 0.8, faceOut: 0.4, up: 0.8,
    bark: bark([0.090, 0.072, 0.058], 1, 1, 0.4),
  },
  crabapple: {  // 海棠
    zh: '海棠', gen: 'broadleaf', variants: 1, scale: [0.85, 1.2], lodMul: 0.9,
    H: 4.6, R: 2.6, trunkH: 1.2, trunkR: 0.13, taper: 0.5, leaders: 3, spread: 42, leaderLen: 1.0, leaderR: 0.65, apical: 0.7, branchLen: 0.7,
    nb: 4, lean: 0.06, sweep: 0.4, subR: 0.36, subSquash: 0.75, fill: 2,
    tile: 'broad', cardSize: 0.7, density: 1.5, col: [0.071, 0.140, 0.033], trans: 0.6, flex: 0.75, faceOut: 0.5,
    bark: bark([0.082, 0.068, 0.056], 0, 1, 0.5),
  },
  loquat: {     // 枇杷
    zh: '枇杷', gen: 'broadleaf', variants: 1, scale: [0.8, 1.2], lodMul: 0.95,
    H: 5.6, R: 2.9, trunkH: 1.3, trunkR: 0.16, taper: 0.5, leaders: 3, spread: 34, leaderLen: 1.0, leaderR: 0.66, apical: 1.0, branchLen: 0.66,
    nb: 4, lean: 0.04, sweep: 0.2, subR: 0.38, subSquash: 0.85, fill: 3,
    tile: 'large', cardSize: 0.85, density: 1.45, col: [0.055, 0.105, 0.026], trans: 0.4, flex: 0.5, faceOut: 0.55, rough: 0.5, fruit: true,
    bark: bark([0.085, 0.070, 0.056], 0, 1, 0.5),
  },
  plum: {       // 梅
    zh: '梅', gen: 'broadleaf', variants: 1, scale: [0.85, 1.2], lodMul: 0.9,
    H: 4.8, R: 2.9, trunkH: 1.1, trunkR: 0.14, taper: 0.45, leaders: 3, spread: 46, leaderLen: 1.0, leaderR: 0.62, apical: 0.6, branchLen: 0.75,
    nb: 5, lean: 0.09, sweep: 0.55, subR: 0.32, subSquash: 0.7, fill: 2,
    tile: 'fine', cardSize: 0.7, density: 1.4, col: [0.088, 0.148, 0.037], trans: 0.6, flex: 0.8, faceOut: 0.45,
    bark: bark([0.050, 0.044, 0.038], 0, 1, 0.5),
  },
  osmanthus: {  // 桂花
    zh: '桂花', gen: 'broadleaf', variants: 1, scale: [0.85, 1.2], lodMul: 0.9, l2Lum: 1.14,
    H: 5.2, R: 2.6, trunkH: 0.9, trunkR: 0.12, taper: 0.55, leaders: 4, spread: 30, leaderLen: 1.0, leaderR: 0.6, apical: 1.0, branchLen: 0.6,
    nb: 4, lean: 0.03, sweep: 0.15, subR: 0.4, subSquash: 0.9, fill: 4,
    tile: 'broad', cardSize: 0.65, density: 1.6, col: [0.049, 0.097, 0.026], trans: 0.4, flex: 0.4, faceOut: 0.6, rough: 0.5,
    bark: bark([0.082, 0.068, 0.056], 1, 1, 0.4),
  },
  orange: {     // 橘
    zh: '橘', gen: 'broadleaf', variants: 1, scale: [0.85, 1.15], lodMul: 0.8,
    H: 3.2, R: 1.7, trunkH: 0.7, trunkR: 0.07, taper: 0.55, leaders: 3, spread: 36, leaderLen: 1.0, leaderR: 0.65, apical: 0.8, branchLen: 0.7,
    nb: 3, lean: 0.03, sweep: 0.12, subR: 0.42, subSquash: 0.85, fill: 2,
    tile: 'broad', cardSize: 0.5, density: 1.6, col: [0.049, 0.105, 0.025], trans: 0.4, flex: 0.4, faceOut: 0.6, rough: 0.45, fruit: 'orange',
    bark: bark([0.080, 0.065, 0.052], 1, 1, 0.4),
  },
  // ----------------------------------------------------------------------------------------------------- willow
  willow: {
    zh: '垂柳', gen: 'willow', variants: 2, scale: [0.85, 1.2], lodMul: 1.15, farLum: 1.35,
    H: 9.5, R: 4.9, trunkH: 2.2, trunkR: 0.30, taper: 0.55, leaders: 4, spread: 34, leaderLen: 1.0, leaderR: 0.6, apical: 0.15, branchLen: 0.6,
    nb: 3, lean: 0.07, sweep: 0.3, strands: 200, strandW: 0.8, strandL: [2.4, 5.0],
    tile: 'willow', capTile: 'fine', cardSize: 0.8, col: [0.098, 0.165, 0.034], trans: 0.85, flex: 0.9, faceOut: 0.5,
    bark: bark([0.088, 0.072, 0.058], 0, 1, 0.5),
  },
  // ------------------------------------------------------------------------------------------------------ pines
  pine: {       // 黑松
    zh: '黑松', gen: 'pine', variants: 2, scale: [0.8, 1.25], lodMul: 1.1, farLum: 1.05,
    H: 9.5, R: 3.8, trunkH: 2.6, trunkR: 0.28, taper: 0.4, lean: 0.12, sweep: 0.6, whorls: 15, branchLenMax: 4.6, padSize: 2.0,
    tile: 'pine', col: [0.041, 0.078, 0.033], trans: 0.28, flex: 0.5,
    bark: bark([0.066, 0.050, 0.040], 2, 1, 0.45),
  },
  podocarpus: { // 罗汉松 (dense, dark, rounded cone)
    zh: '罗汉松', gen: 'conifer', variants: 1, scale: [0.8, 1.2], lodMul: 0.9,
    H: 5.0, R: 1.9, trunkH: 0.8, trunkR: 0.13, lean: 0.03, tile: 'cypress', cardSize: 0.6, density: 1.7, col: [0.052, 0.098, 0.040], trans: 0.3, flex: 0.4,
    shape: 'dome', bark: bark([0.070, 0.052, 0.042], 0, 1, 0.5),
  },
  cypress: {    // 圆柏 / 柏
    zh: '圆柏', gen: 'conifer', variants: 1, scale: [0.8, 1.25], lodMul: 1.0,
    H: 8.5, R: 1.7, trunkH: 0.9, trunkR: 0.17, lean: 0.03, tile: 'cypress', cardSize: 0.7, density: 1.8, col: [0.048, 0.092, 0.038], trans: 0.3, flex: 0.4,
    shape: 'column', bark: bark([0.080, 0.058, 0.044], 0, 1, 0.5),
  },
  // ---------------------------------------------------------------------------------------------------- banana
  banana: {
    zh: '芭蕉', gen: 'banana', variants: 1, scale: [0.85, 1.2], lodMul: 0.9,
    H: 2.9, R: 1.8, stem: 1.3, blades: 8, bladeL: [1.8, 2.5], bladeW: 0.78, tile: 'banana', col: [0.104, 0.185, 0.037], trans: 0.8, flex: 0.9,
    bark: bark([0.10, 0.17, 0.06], 1, 1, 0.5),
  },
  // --------------------------------------------------------------------------------------------------- bamboo
  bamboo: {     // 淡竹 clump
    zh: '淡竹', gen: 'bamboo', variants: 2, scale: [0.8, 1.25], lodMul: 1.0, farLum: 1.04,
    H: 7.0, R: 1.4, culms: 22, culmH: [5.2, 8.6], culmR: [0.022, 0.034], tile: 'bamboo', col: [0.088, 0.165, 0.037], trans: 0.8, flex: 0.95,
    bark: bark([0.095, 0.150, 0.075], 3, 1, 1.0),
  },
  sasa: {       // 箬竹 understory
    zh: '箬竹', gen: 'shrub', variants: 1, scale: [0.8, 1.3], lodMul: 0.6,
    H: 1.3, R: 0.9, tile: 'bamboo', cardSize: 0.8, cards: 36, col: [0.085, 0.150, 0.037], trans: 0.7, flex: 0.9, up: 1.0,
    bark: bark([0.08, 0.12, 0.06], 1),
  },
  // ----------------------------------------------------------------------------------------------------- shrubs
  azalea: { zh: '杜鹃', gen: 'shrub', variants: 1, scale: [0.7, 1.3], lodMul: 0.55, H: 0.85, R: 0.7, tile: 'fine', cardSize: 0.5, cards: 40, col: [0.071, 0.132, 0.033], trans: 0.5, flex: 0.5, bark: bark([0.06, 0.05, 0.04], 1) },
  boxwood: { zh: '黄杨', gen: 'shrub', variants: 1, scale: [0.8, 1.2], lodMul: 0.5, H: 0.7, R: 0.62, tile: 'fine', cardSize: 0.45, cards: 40, col: [0.055, 0.108, 0.029], trans: 0.4, flex: 0.2, shape: 'ball', bark: bark([0.06, 0.05, 0.04], 1) },
  camellia: { zh: '山茶', gen: 'shrub', variants: 1, scale: [0.8, 1.25], lodMul: 0.7, H: 2.4, R: 1.2, tile: 'large', cardSize: 0.7, cards: 46, col: [0.037, 0.080, 0.025], trans: 0.3, flex: 0.4, rough: 0.5, bark: bark([0.06, 0.05, 0.04], 1) },
  hibiscus: { zh: '芙蓉', gen: 'shrub', variants: 1, scale: [0.8, 1.3], lodMul: 0.7, H: 2.2, R: 1.1, tile: 'wutong', cardSize: 0.85, cards: 30, col: [0.104, 0.168, 0.041], trans: 0.65, flex: 0.8, bark: bark([0.08, 0.07, 0.06], 1) },
  nandina: { zh: '天竹', gen: 'shrub', variants: 1, scale: [0.8, 1.3], lodMul: 0.5, H: 1.3, R: 0.55, tile: 'bamboo', cardSize: 0.65, cards: 22, col: [0.085, 0.140, 0.033], trans: 0.65, flex: 0.8, up: 1.0, bark: bark([0.08, 0.07, 0.05], 1) },
  peony: { zh: '牡丹', gen: 'shrub', variants: 1, scale: [0.8, 1.2], lodMul: 0.45, H: 0.7, R: 0.55, tile: 'maple', cardSize: 0.4, cards: 26, col: [0.076, 0.145, 0.033], trans: 0.55, flex: 0.5, bark: bark([0.08, 0.07, 0.05], 1) },
};

/** tree-like kinds that take part in LOD2 (far blobs): crown envelope derived from the table */
export function crownOf(S) {
  if (S.gen === 'bamboo') return { cy: S.H * 0.55, ry: S.H * 0.45, rx: S.R * 1.2 };
  if (S.gen === 'banana') return { cy: S.H * 0.55, ry: S.H * 0.4, rx: S.R * 0.9 };
  if (S.gen === 'pine') return { cy: S.trunkH + (S.H - S.trunkH) * 0.5, ry: (S.H - S.trunkH) * 0.5, rx: S.R * 0.95, flat: true };
  if (S.gen === 'conifer') return { cy: S.trunkH + (S.H - S.trunkH) * 0.5, ry: (S.H - S.trunkH) * 0.5, rx: S.R };
  if (S.gen === 'willow') return { cy: S.H * 0.58, ry: S.H * 0.42, rx: S.R };
  if (S.gen === 'shrub') return { cy: S.H * 0.5, ry: S.H * 0.5, rx: S.R };
  const depth = S.H - S.trunkH * 0.85;
  return { cy: S.trunkH * 0.85 + depth * 0.5, ry: depth * 0.5 * (S.subSquash ? 0.5 + 0.5 * S.subSquash : 1), rx: S.R };
}

/** LOD switching distances (m) per quality: [near → mid, mid → far-mid, far-mid → far blob]; scaled per species by lodMul and by size */
export const LOD_DIST = {
  high: [13, 58, 150], medium: [10, 44, 112], low: [7, 32, 80],
};

/** species names accepted by createTreeBatch(): keys, Chinese names, English names, a few context-module kinds */
export const ALIASES = {
  悬铃木: 'plane', 法国梧桐: 'plane', 二球悬铃木: 'plane', 'london plane': 'plane', 'plane tree': 'plane', platanus: 'plane', plane: 'plane',
  香樟: 'camphor', 樟: 'camphor', 樟树: 'camphor', camphor: 'camphor',
  银杏: 'ginkgo', 白果树: 'ginkgo', ginkgo: 'ginkgo',
  垂柳: 'willow', 柳: 'willow', 柳树: 'willow', willow: 'willow', weeping: 'willow',
  黑松: 'pine', 松: 'pine', 松树: 'pine', pine: 'pine',
  圆柏: 'cypress', 柏: 'cypress', cypress: 'cypress', 罗汉松: 'podocarpus', podocarpus: 'podocarpus', conifer: 'cypress',
  梧桐: 'wutong', 玉兰: 'yulan', 广玉兰: 'magnolia', 枫: 'maple', 枫香: 'maple', maple: 'maple', 海棠: 'crabapple', 枇杷: 'loquat', 梅: 'plum', 桂花: 'osmanthus', 橘: 'orange',
  芭蕉: 'banana', 竹: 'bamboo', 淡竹: 'bamboo', bamboo: 'bamboo', broadleaf: 'broadleaf', 杂木: 'broadleaf', 榆: 'broadleaf', 槐: 'broadleaf', 国槐: 'broadleaf', 女贞: 'broadleaf',
};
/** a species key from a key / alias / null → `fallback` */
export function resolveSpecies(name, fallback = 'broadleaf') {
  if (!name) return fallback;
  if (SPECIES[name]) return name;
  const k = String(name).trim().toLowerCase();
  return ALIASES[name] || ALIASES[k] || (SPECIES[k] ? k : fallback);
}

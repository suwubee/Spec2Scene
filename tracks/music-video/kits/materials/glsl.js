// GLSL library: snow, ice, snow-on-ice boundary. Function prefix mat*, structs Mat*. Needs uniform uMatNoise (noise.js).
// Rules (README "Rules", any model must follow them):
//   R1 every pattern samples WORLD position P (ground: P.xz; possibly steep: matTri triplanar). Never mesh UV / screen space.
//   R2 every detail layer has a resolvability window from the pixel footprint (matFootprint, metres/pixel) and fades out before
//      it can alias; discrete dots (glints/bubbles) are sized by the short-axis footprint (matFootprintMin).
//   R3 anisotropic patterns (wind ripples) stay <= 3:1 (2.6:1 here) and are domain-warped; longer streaks converge in perspective.
//   R4 de-tile close-ups with matN2; uv 1.0 = one 256 px tile = 4 base cells.
//   R8 glints/bubbles use texelFetch(level 0) white noise and a smooth knee; no time, no Math.random: same (P, V, light) -> same pixel.
// Hosts: three built-in materials via surfaces.js (onBeforeCompile), or any custom ShaderMaterial via injectMaterialLibrary().
export const MAT_GLSL_COMMON = /* glsl */ `
uniform sampler2D uMatNoise;
// Pixel footprint: world size (m) covered by one pixel, including grazing elongation (max of both axes)
float matFootprint(vec3 P){ return max(length(dFdx(P)), length(dFdy(P))) + 1e-5; }
// Short-axis footprint (<< long axis at grazing angles): size discrete dots (glints/bubbles) by it, otherwise they squash into flat ellipses
float matFootprintMin(vec3 P){ return min(length(dFdx(P)), length(dFdy(P))) + 1e-5; }
// De-tiled sample: the same 256² tile plus a second sample rotated 36.87° and scaled 1.37, mixed 0.6/0.4. The two lattices are
// incommensurate, so no tile period is visible (a single sample reads as a regular grid in close-ups).
// Convention: uv 1.0 = one tile = 4 base cells (the fbm adds 8..64 octave detail).
vec4 matN2(vec2 uv){
  return texture(uMatNoise, uv) * 0.6 + texture(uMatNoise, mat2(0.8, -0.6, 0.6, 0.8) * uv * 1.37 + vec2(0.41, 0.73)) * 0.4;
}
// Triplanar sample (weights |n|^4, each plane de-tiled): for snow that can be steep (drift lee faces, wall-foot snow)
vec4 matTri(vec3 P, vec3 N, float s){
  vec3 w = abs(N); w *= w; w *= w; w /= (w.x + w.y + w.z);
  return matN2(P.zy * s + vec2(0.31, 0.17)) * w.x
       + matN2(P.xz * s) * w.y
       + matN2(P.xy * s + vec2(0.67, 0.43)) * w.z;
}
// Dominant-plane coordinate (no blending): for discrete patterns like glints/bubbles (blending would ghost them)
vec2 matPlane(vec3 P, vec3 N){
  vec3 a = abs(N);
  return a.y >= max(a.x, a.z) ? P.xz : (a.x >= a.z ? P.zy + 31.7 : P.xy + 57.3);
}
float matHash(vec2 id, vec2 off){ return texelFetch(uMatNoise, ivec2(mod(id + off, 256.0)), 0).b; }
// Sparse discrete glints (one octave): cell cs metres, at most one facet per cell; facet normal jittered around Nf,
// lit only when aligned with the half vector H (smooth knee, no pow() knife edge: sub-ULP jitter cannot flip a glint)
float matGlintOct(vec2 q, float cs, vec3 Nf, vec3 H, float dens, vec2 off, float fpx){
  vec2 g = q / cs;
  vec2 id = floor(g), f = g - id;
  float h0 = matHash(id, off), h1 = matHash(id, off + vec2(101.0, 37.0));
  float h2 = matHash(id, off + vec2(13.0, 173.0)), h3 = matHash(id, off + vec2(211.0, 89.0));
  float pres = step(1.0 - dens, h0);
  vec2 c = 0.2 + 0.6 * vec2(h1, h2);
  // dot radius = max(physical ~0.12 cell, ~1.1 px): a glint is always a 1-2 px point, never a polka dot
  float rr = max(0.12, 1.3 * fpx / cs);
  float spot = 1.0 - smoothstep(rr * 0.45, rr, length(f - c));
  vec3 fn = normalize(Nf + vec3(h1 - 0.5, 0.0, h3 - 0.5) * 1.15);
  float al = smoothstep(0.90, 0.985, dot(fn, H));
  return pres * spot * al;
}
`;

// Snow. prm = (W cross-wind wavelength m [0.35..1.2], ripple strength [0..1.5], grain [0..1.5], glint density [0..1]);
// prm2 = (macro amplitude [0..0.3], crust amplitude [0..0.3], _, _). Returns albK (albedo multiplier ~1), N (perturbed world
// normal), glint (0..~1; caller multiplies by light colour x gain x shadow), rough, crest.
export const MAT_GLSL_SNOW = /* glsl */ `
struct MatSnow { float albK; vec3 N; float glint; float rough; float crest; };
float matRidge(float n){ return 1.0 - min(abs(n - 0.5) * 2.6, 1.0); }
MatSnow matSnow(vec3 P, vec3 Ng, vec3 V, vec2 wd, vec3 H, float fp, vec4 prm, vec4 prm2){
  MatSnow o;
  vec3 N = Ng;
  float flatK = smoothstep(0.45, 0.85, Ng.y);
  // Grazing attenuation: at grazing view angles perspective compresses ripples into straight horizontal bands ("strata").
  // A pixel integrates several crests along the view direction, so their normals average out: fade the ripple layers.
  float grazK = mix(0.3, 1.0, smoothstep(0.03, 0.2, abs(dot(V, Ng))));
  vec2 pr = vec2(-wd.y, wd.x);
  vec3 Ta = vec3(wd.x, 0.0, wd.y), Tc = vec3(pr.x, 0.0, pr.y);
  float W = max(prm.x, 0.05);
  // ① 宏观明暗：各向同性、世界坐标（~45 m 与 ~11 m 斑），远景"雪原层次"的底
  float m1 = texture(uMatNoise, P.xz * (1.0 / 180.0) + 0.13).r;
  float m2 = matTri(P, Ng, 1.0 / 44.0).g;
  float albK = 1.0 + (m1 - 0.5) * prm2.x * smoothstep(0.3, 0.7, Ng.y) + (m2 - 0.5) * prm2.x * 0.6;
  // ② 风壳斑（wind crust）：域扭曲的中尺度板块，亮一点（风压实）或暗一点（松雪凹）
  vec2 wq = P.xz + (texture(uMatNoise, P.xz * (1.0 / 60.0) + 0.29).rg - 0.5) * 9.0;
  float cr = texture(uMatNoise, wq * (1.0 / 36.0) + 0.81).r;
  float upK = smoothstep(0.3, 0.7, Ng.y);                         // xz 投影的层只用在朝上的面（竖面上会拉成竖条）
  albK *= 1.0 + prm2.y * upK * (smoothstep(0.5, 0.8, cr) * 0.6 - smoothstep(0.35, 0.08, cr) * 0.8);
  // ③ sastrugi 风纹：域扭曲后的"等值脊线"，沿风 2.6W、跨风 W（长宽比 2.6:1），迎风缓背风陡；
  //    可解析窗：fp < 0.06W 全强，> 0.3W 消失（远处交给 ①② 的明暗）——不会汇聚成放射条纹
  // 风纹成片出现（风刨区 / 平雪区交错，~12 m 斑）——满屏同密度的脊线会读成"规则笔触"
  float patchA = smoothstep(0.38, 0.70, texture(uMatNoise, P.xz * (1.0 / 48.0) + 0.71).g);
  float sK = flatK * grazK * (1.0 - smoothstep(0.06 * W, 0.30 * W, fp)) * prm.y * (0.15 + 0.85 * patchA);
  vec2 warp = (texture(uMatNoise, P.xz * (0.11 / W) + 0.47).rg - 0.5) * (1.3 * W);   // 扭曲过大会把脊线拧成"大理石/水纹"
  vec2 xw = P.xz + warp;
  vec2 q = vec2(dot(xw, wd) / (2.6 * W), dot(xw, pr) / W) * 0.25;
  const float e = 0.0045;
  // 两个尺度叠加（1 : 2.3，错位）——单一 fbm 的等值线间距太均匀，会读成规则"笔触/虚线"
  vec2 q2s = q * 2.3 + vec2(0.37, 0.71);
  float n0 = matN2(q).r * 0.78 + texture(uMatNoise, q2s).g * 0.22;
  float h0 = matRidge(n0);
  float ha = matRidge(matN2(q + vec2(e, 0.0)).r * 0.78 + texture(uMatNoise, q2s + vec2(e * 2.3, 0.0)).g * 0.22);
  float hc = matRidge(matN2(q + vec2(0.0, e)).r * 0.78 + texture(uMatNoise, q2s + vec2(0.0, e * 2.3)).g * 0.22);
  float A = 0.07 * W;                                            // 脊高 ~ 0.07W（W 0.6 → 4 cm）
  float sa = (ha - h0) / e * (0.25 / (2.6 * W)) * A;
  float sc = (hc - h0) / e * (0.25 / W) * A;
  sa *= sa > 0.0 ? 0.6 : 1.35;                                   // 迎风面缓、背风面陡
  vec2 sl = clamp(vec2(sa, sc), -0.32, 0.32) * sK;               // 坡度上限 ~18°（低月掠射下更陡会读成"水面/大理石"）
  // ③b 大风纹（W2 = 3.5W，中景可读的风积垄；同样 ≤3:1 + 域扭曲 + 足迹窗）
  float W2 = 3.5 * W;
  float patchB = smoothstep(0.28, 0.66, texture(uMatNoise, P.xz * (1.0 / 90.0) + 0.13).r);
  float sK2 = flatK * grazK * (1.0 - smoothstep(0.08 * W2, 0.45 * W2, fp)) * prm.y * (0.2 + 0.8 * patchB);
  vec2 xw2 = P.xz + (texture(uMatNoise, P.xz * (0.09 / W2) + 0.61).gr - 0.5) * (1.2 * W2);
  vec2 q2 = vec2(dot(xw2, wd) / (2.6 * W2), dot(xw2, pr) / W2) * 0.25 + 0.37;
  float m0 = matN2(q2).g;
  float g0 = matRidge(m0);
  float ga = matRidge(matN2(q2 + vec2(e, 0.0)).g);
  float gc = matRidge(matN2(q2 + vec2(0.0, e)).g);
  float A2 = 0.05 * W2;
  float sa2 = (ga - g0) / e * (0.25 / (2.6 * W2)) * A2, sc2 = (gc - g0) / e * (0.25 / W2) * A2;
  sa2 *= sa2 > 0.0 ? 0.6 : 1.35;
  sl += clamp(vec2(sa2, sc2), -0.3, 0.3) * sK2;
  N = normalize(N - Ta * sl.x - Tc * sl.y);
  albK *= 1.0 + (h0 - 0.45) * 0.08 * sK + (g0 - 0.45) * 0.14 * sK2;   // 脊顶风压实略亮、槽里松雪略暗（与光向无关，月光顺风时也读得出）
  // ③c 斑驳（mottle）：~4 m 与 ~1.2 m 的各向同性域扭曲明暗（风刨面/松雪/薄壳），足迹窗内显示
  float moK = 1.0 - smoothstep(0.25, 1.2, fp);
  vec2 mq = P.xz + (texture(uMatNoise, P.xz * (1.0 / 14.0) + 0.83).rg - 0.5) * 3.0;
  float mo = texture(uMatNoise, mq * (0.25 / 4.0) + 0.19).g * 0.65 + texture(uMatNoise, mq * (0.25 / 1.2) + 0.59).r * 0.35;
  albK *= 1.0 + (mo - 0.5) * prm2.y * 0.9 * moK * upK;
  // ④ 扰动痕 / 中尺度起伏（0.4 m，各向同性，三平面）：fp < 1.5 cm 全强
  float mK = 1.0 - smoothstep(0.015, 0.06, fp);
  vec4 mb = matTri(P, Ng, 1.0 / 1.6);
  vec3 dm = vec3(mb.r - 0.5, 0.0, mb.g - 0.5) * 0.22 * mK;
  // ⑤ 近景颗粒（4 cm，三平面）：fp < 4 mm 全强
  float gK = (1.0 - smoothstep(0.004, 0.016, fp)) * prm.z;
  vec4 gb = matTri(P, Ng, 1.0 / 0.6);                            // 瓦片 0.6 m：基础单元 15 cm、最细倍频 ~1 cm
  vec3 dg = vec3(gb.r - 0.5, gb.g - 0.5, gb.a - 0.5) * 0.6 * gK;
  vec3 d = dm + dg;
  N = normalize(N + (d - N * dot(d, N)));
  albK *= 1.0 + (gb.g - 0.5) * 0.10 * gK;
  // ⑥ 月下冰晶闪点：三个八度，各在自己的可解析窗内（近 2.5 cm 晶面 / 中 18 cm 簇 / 远 1.2 m 簇）
  vec2 pq = matPlane(P, Ng);
  float fq = matFootprintMin(P);                                  // 闪点按短轴足迹选八度与定点径
  float gl = matGlintOct(pq, 0.025, N, H, prm.w * 0.55, vec2(0.0), fq) * (1.0 - smoothstep(0.0015, 0.004, fq));
  gl += matGlintOct(pq, 0.18, N, H, prm.w * 0.40, vec2(53.0, 7.0), fq) * smoothstep(0.0012, 0.004, fq) * (1.0 - smoothstep(0.014, 0.035, fq)) * 0.8;
  gl += matGlintOct(pq, 1.2, N, H, prm.w * 0.30, vec2(17.0, 141.0), fq) * smoothstep(0.014, 0.035, fq) * (1.0 - smoothstep(0.1, 0.25, fq)) * 0.55;
  o.albK = albK; o.N = N; o.glint = gl; o.rough = 0.66; o.crest = h0 * sK;
  return o;
}
`;

// Ice (dark transparent: parallax depth shading, two crack levels, two bubble layers, milky patches, polish roughness field)
// and the per-pixel snow-on-ice boundary. prm = (crack cell m [1.5..8], crack [0..1], bubbles [0..1], milky [0..1]);
// prm2 = (polish [0..1], dark [0..1], albedo gain [0.5..3], _).
export const MAT_GLSL_ICE = /* glsl */ `
struct MatIce { vec3 alb; vec3 N; float rough; float crack; float milky; };
float matLine(float dm, float hw, float fp){                       // 距线 dm 米、半宽 hw 米 → 覆盖率（像素足迹抗锯齿）
  return (1.0 - smoothstep(hw, hw + fp, dm)) * clamp(2.0 * hw / fp, 0.0, 1.0);
}
MatIce matIce(vec3 P, vec3 Ng, vec3 V, vec2 wd, float fp, vec4 prm, vec4 prm2){
  MatIce o;
  vec3 rd = refract(-V, Ng, 1.0 / 1.31);
  vec2 pd = rd.xz / max(-rd.y, 0.2);                             // 每米冰深的水平错位
  // 乳白 / 黑冰大斑（域扭曲，各向同性 ~50 m）
  vec2 wq = P.xz + (texture(uMatNoise, P.xz * (1.0 / 70.0) + 0.21).rg - 0.5) * 14.0;
  float mk = texture(uMatNoise, wq * (1.0 / 52.0) + 0.63).r;
  float milky = smoothstep(0.78 - prm.w * 0.6, 0.95 - prm.w * 0.6, mk);
  vec3 black = mix(vec3(0.050, 0.068, 0.085), vec3(0.020, 0.030, 0.042), prm2.y);
  vec3 alb = mix(black, vec3(0.30, 0.33, 0.37), milky * 0.85);
  // 冰内深层明暗（0.3 m 深处的"冰下云"，随视角错位 → 通透感）
  float deep = texture(uMatNoise, (P.xz + pd * 0.3) * (1.0 / 6.0) + 0.44).g;
  alb *= 0.6 + 0.8 * deep;
  // Host albedo gain applies to the ice body only; cracks/bubbles keep absolute albedo (a gain on them paints white lines).
  alb *= prm2.z > 0.0 ? prm2.z : 1.0;
  // 冰裂：两级 Worley 边界，位于 3 cm 深（视差错位），线宽按足迹抗锯齿（远处自然变淡，不闪）
  float S1 = prm.x, S2 = prm.x * 0.31;
  vec2 cp = P.xz + pd * 0.03;
  vec2 cw = (texture(uMatNoise, cp * (1.0 / (S1 * 5.0)) + 0.17).rg - 0.5) * S1 * 0.55;
  float a1 = texture(uMatNoise, (cp + cw) * (1.0 / (S1 * 16.0))).a;
  float a2 = texture(uMatNoise, (cp + cw * 0.6) * (1.0 / (S2 * 16.0)) + 0.5).a;
  // 纹理里的 Worley F2−F1 在边界处是 V 形，双线性插值到不了 0——线用 a < ~0.1 的软阈值画（线宽 ≈ 0.018·单元，
  // 沿线随纹素位置明暗起伏 = 天然的断续裂纹），再按像素覆盖淡出（远处自然变淡，不闪）
  float c1 = (1.0 - smoothstep(0.035, 0.11, a1)) * clamp(0.036 * S1 / fp, 0.0, 1.0);
  float c2 = (1.0 - smoothstep(0.035, 0.11, a2)) * clamp(0.036 * S2 / fp, 0.0, 1.0) * 0.7;
  // 次级裂纹只在部分单元出现（不是满屏网格）
  c2 *= smoothstep(0.45, 0.7, texture(uMatNoise, cp * (1.0 / (S1 * 3.0)) + 0.9).g);
  // 第三级：大冰裂 / 冻合压力缝（~6×主单元，线宽 3 cm，缝里嵌雪 → 远景也可读的白色网线）
  float S3 = prm.x * 6.0;
  float a3 = texture(uMatNoise, (cp + cw * 2.0) * (1.0 / (S3 * 16.0)) + 0.23).a;
  float c3 = (1.0 - smoothstep(0.03, 0.09, a3)) * clamp(0.03 * S3 / fp, 0.0, 1.0) * smoothstep(0.35, 0.6, texture(uMatNoise, cp * (1.0 / (S3 * 2.0)) + 0.4).r);
  float crack = max(max(c1, c2), c3) * prm.y;
  alb = mix(alb, vec3(0.30, 0.34, 0.39), crack * (1.0 - 0.6 * milky) * 0.6);    // 黑冰上的应力白纹（克制：过亮会读成白线描边）
  // 气泡两层（2 cm / 8 cm 深，单元 3.5 cm / 9 cm），只在可解析时出现
  float bub = 0.0;
  {
    vec2 b1 = (P.xz + pd * 0.02) / 0.035;
    vec2 id = floor(b1), f = b1 - id;
    float pres = step(1.0 - prm.z * 0.35, matHash(id, vec2(7.0, 19.0)));
    vec2 c = 0.25 + 0.5 * vec2(matHash(id, vec2(61.0, 3.0)), matHash(id, vec2(5.0, 77.0)));
    float fq = matFootprintMin(P);
    bub += pres * (1.0 - smoothstep(0.10, 0.2, length(f - c))) * (1.0 - smoothstep(0.0025, 0.008, fp)) * smoothstep(8.0, 3.0, fp / fq);
    vec2 b2 = (P.xz + pd * 0.08) / 0.09;
    id = floor(b2); f = b2 - id;
    pres = step(1.0 - prm.z * 0.22, matHash(id, vec2(97.0, 41.0)));
    c = 0.25 + 0.5 * vec2(matHash(id, vec2(29.0, 151.0)), matHash(id, vec2(131.0, 11.0)));
    bub += 0.6 * pres * (1.0 - smoothstep(0.08, 0.2, length(f - c))) * (1.0 - smoothstep(0.006, 0.02, fp)) * smoothstep(8.0, 3.0, fp / fq);
  }
  alb += vec3(0.16, 0.18, 0.21) * bub * (1.0 - milky);
  // 风蚀抛光（各向同性 ~18 m 斑）：光滑处低粗糙（月光亮痕由此断续）；乳白冰粗
  float pol = texture(uMatNoise, P.xz * (1.0 / 72.0) + 0.9).g;
  float rough = mix(0.035, 0.035 + 0.2 * prm2.x, smoothstep(0.35, 0.72, pol));
  rough = mix(rough, 0.5, milky);
  // 微起伏（冻结波纹，极弱）
  vec4 mr = texture(uMatNoise, P.xz * (1.0 / 3.0) + 0.27);
  vec3 N = normalize(Ng + vec3(mr.r - 0.5, 0.0, mr.g - 0.5) * 0.035);
  o.alb = alb; o.N = N; o.rough = rough; o.crack = crack; o.milky = milky;
  return o;
}
// 冰上积雪边界：cover = 宏观覆盖（0..1，可来自顶点插值的粗掩码）；返回 (实雪, 薄雪纱)。
// 形状：沿风向拉长的雪舌（26×14 m、5×2.8 m，长宽比 ≤ 1.9:1——掠射机位下透视还会再压扁一次）+ 域扭曲 + 0.8 m 各向同性细边；
// 边缘锐利（几厘米，风压雪板）但不规则；实雪之外有一圈渐薄的雪纱（风吹雪粉），裸冰不出现孤立圆斑。
vec2 matSnowOnIce(vec2 xz, vec2 wd, float cover, float fp){
  vec2 pr = vec2(-wd.y, wd.x);
  vec2 xw = xz + (texture(uMatNoise, xz * (1.0 / 90.0) + 0.37).rg - 0.5) * 22.0;
  float a = dot(xw, wd), c = dot(xw, pr);
  float n1 = matN2(vec2(a / 26.0, c / 14.0) * 0.25 + 0.11).g;
  float n2 = matN2(vec2(a / 5.0, c / 2.8) * 0.25 + 0.53).r;
  float n3 = texture(uMatNoise, xw * (0.25 / 0.8) + 0.77).g;
  float fineK = 1.0 - smoothstep(0.02, 0.08, fp);
  float e = cover + (n1 - 0.5) * 0.45 + (n2 - 0.5) * 0.26 + (n3 - 0.5) * 0.10 * fineK;
  float aa = fwidth(e) * 0.75 + 0.012;
  float snow = smoothstep(0.5 - aa, 0.5 + aa, e);
  float veil = smoothstep(0.34, 0.5, e) * (1.0 - snow);              // 雪纱只是边缘一圈（宽了会把裸冰走廊整片洗灰）
  float st = texture(uMatNoise, vec2(a / 1.3, c / 0.5) * 0.25 + 0.29).r;     // 雪粉细丝（短、2.6:1，遵守 R3 ≤ 3:1）
  veil *= mix(0.6, 0.3 + 0.7 * smoothstep(0.4, 0.72, st), 1.0 - smoothstep(0.03, 0.1, fp));
  return vec2(snow, veil);
}
`;

/** Whole library in fixed order. */
export const MAT_GLSL = MAT_GLSL_COMMON + MAT_GLSL_SNOW + MAT_GLSL_ICE;

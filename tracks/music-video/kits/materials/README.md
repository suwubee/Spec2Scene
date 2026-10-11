# 雪 / 冰 / 夯土材质库

通用、参数化、确定性的程序材质：雪面（风纹、风壳、斑驳、颗粒、冰晶闪点）、冰面（深色通透、两级冰裂、两层气泡、乳白冰斑、抛光粗糙度）与冰上积雪边界、夯土（版筑层理、施工缝、风蚀竖沟、返潮暗带、墙脚与顶面积雪），以及高度场风积雪丘几何。全部图案用**世界坐标**（陡面三平面投影）采样，不需要网格 UV，不读时间、不用 `Math.random`，无任何图片文件。

它由强模型做成组件、用自动质检锁住，供任何模型装配使用：**雪、冰、夯土只用本库**，不要在场景里另写一套同类 shader；改本库必须过本页“验收”。

```js
import * as THREE from '../engine/vendor/three.module.js';
import {snowMaterial, iceMaterial, rammedEarthMaterial, snowDriftGeometry, setMaterialLight} from './kits/materials/index.js';

// create(ctx) 里一次性创建（不要在 update 里懒建）
const snow = snowMaterial(THREE, {preset: 'field', wind: [0.94, 0.34], light: moonDir});      // MeshStandardMaterial
const street = snowMaterial(THREE, {preset: 'compacted', params: {ridge: 0.4}});              // 预设 + 字段覆写
const ice = iceMaterial(THREE, {preset: 'black', cover: 0.3, wind: [0.94, 0.34]});          // cover = 宏观雪盖 0..1
const iceV = iceMaterial(THREE, {coverAttribute: 'snowCover'});                               // 或逐顶点 float 属性
const wall = rammedEarthMaterial(THREE, {quality: ctx.quality, groundY: 0, top: 6, layer: 0.12, footSnow: 0.25});
const drift = new THREE.Mesh(snowDriftGeometry(THREE, {r: 2.5, h: 1.2, windDir: [0.94, 0.34], seed: 3}), snowMaterial(THREE, {preset: 'drift'}));

// update(t, world)：光向只由 t 推出
setMaterialLight(snow, world.moonDir, world.moonColor);
```

自写 `ShaderMaterial` 宿主（片元含 `#include <common>`）用 `injectMaterialLibrary(shader, materialUniforms(THREE, {snow, ice}))` 注入后直接调用 `matSnow / matIce / matSnowOnIce`（世界坐标版；视空间法线先 `inverseTransformDirection(normal, viewMatrix)` 转世界，算完再 `(viewMatrix * vec4(N, 0.0)).xyz` 转回）。噪声纹理每个 THREE 实例一份，材质 `dispose()` 不释放它；整片拆除时 `disposeMaterialNoise(THREE)`。

## 规则（任何模型都不得违反）

| # | 规则 | 违反时的典型画面 | 自动拦截 |
|---|---|---|---|
| R1 | 一切空间图案只用**世界坐标**：地面 `P.xz`，可能出现陡面（> ~50°）用 `matTri` 三平面；禁止网格 UV、屏幕坐标 | 竖直面上的 xz 投影 → 竖条纹墙 | picture-qa ①；测试禁止 `vUv`/`gl_FragCoord` |
| R2 | 每层细节有**足迹窗**：`matFootprint(P)`（长轴，米/像素）内淡入淡出；离散点（闪点/气泡）按 `matFootprintMin`（短轴）定点径与八度 | 远处亚像素图案闪烁、拉丝；掠射下闪点压成横向白色扁椭圆 | 闪烁检查 + 人工 |
| R3 | 各向异性图案长宽比 **≤ 3:1**（风纹 2.6:1）且域扭曲（≈1.2–1.3 × 特征宽） | 沿风 6:1–12:1 的长条纹在透视下汇聚成放射条纹或竖条纹墙 | 测试检查 `WIND_ASPECT` 与雪粉丝比例；picture-qa ① |
| R4 | 噪声瓦片不得在画面中重复可见：近景/特写用 `matN2` 去平铺；uv 每 1.0 = 一整张瓦片 = 4 个基础单元 | 规则网格、虚线阵 | picture-qa ① |
| R5 | 雪几何必须是**高度场**（y = f(x,z)，坡度 ≤ ~60°）；雪丘/雪檐用 `snowDriftGeometry`；不用“半径不随高度收缩的环”拼雪丘 | 圆柱竖壁 + 竖条纹 | 测试 `maxSlopeDegrees ≤ 60` |
| R6 | 地面起伏按**焦段**定：长焦（≥ 85 mm）掠射下 ±2 cm 已可见；街面起伏 ≤ ±2 cm，车辙 ≤ 5 cm，雪堆细起伏 ≤ 2 cm | 长焦下“岩层/波浪木板”横带 | picture-qa ①（低幅横带用 ⑥ + roi） |
| R7 | 风纹不得满屏同密度：~12 m / ~22 m 斑块让风刨区与平雪区交错 | 均匀规则笔触 | 人工 |
| R8 | 闪点/气泡用 `texelFetch(level 0)` 白噪声 + 平滑膝部（不用 `pow(x, 90)` 刀锋）；不读时间 | 两次渲染间闪点翻转 | 确定性复渲 |
| R9 | 冰上积雪边界**逐像素**（`matSnowOnIce`：沿风雪舌 + 域扭曲 + 细边 + 窄雪纱）；宏观覆盖可来自顶点 | 顶点插值粗掩码 × 高反差黑冰 → 团絮“豹纹” | picture-qa ⑥ + roi |
| R10 | 掠射视角衰减风纹法线（`grazK`）：像素沿视线积分多条脊，法线应被平均 | 中远景风纹被透视压成高反差横带 | picture-qa ① |
| R11 | 冰裂/气泡保持绝对反照率，宿主增益只作用于冰体；裂纹混合 ≤ 0.6 | 黑冰上一圈圈白线，像描边 | picture-qa ② |
| R12 | 大体积道具（雪丘、石堆）离机位 > 3× 高度，或明确设计为前景框 | 机位前几米的一整面“墙” | picture-qa ①③ |

材质的“程序缓存键”按种类固定（`kits.materials.snow.v1` 等），同一工厂的不同种类必须给不同键——同键会让 three 复用错误程序，新代码从未执行（“声称修复但画面没变”的常见根因）。

## 参数（越界直接抛 RangeError）

| 雪参数 | 默认 | 合法区间 | 作用 | 过大/过小 |
|---|---|---|---|---|
| `W` | 0.6 m | 0.35–1.2 | 风纹跨风波长；沿风 2.6W；大风纹 3.5W | 小 → 中景成颗粒噪声；大 → 近景像沙丘 |
| `ridge` | 1.0 | 0–1.5 | 风纹强度（坡度上限 ~18°） | > 1.5 在低月掠射下读成水纹/大理石 |
| `grain` | 1.0 | 0–1.5 | 近景颗粒（足迹 < 4 mm 全强） | 0 → 近景像塑料 |
| `glint` | 0.4 | 0–1 | 闪点密度（2.5 cm / 18 cm / 1.2 m 三八度，各有足迹窗） | > 0.6 满屏星点 |
| `macro` | 0.22 | 0–0.3 | 宏观明暗（~45 m / 11 m 斑） | 0 → 远景灰布 |
| `crust` | 0.16 | 0–0.3 | 风壳斑与 4 m / 1.2 m 斑驳 | > 0.3 成迷彩 |
| `glintGain` | 5.0 | 0–8 | 闪点亮度（× `glintColor`） | — |

雪预设：`field` 旷野、`compacted` 踩实/车碾路面、`bank` 迎风坡、`drift` 雪丘（几何给宏观形）、`far` 远景。冰参数：`cell` 冰裂主单元 1.5–8 m、`crack` 0–1、`bubbles` 0–1、`milky` 0–1、`polish` 0–1、`dark` 0–1、`gain` 0.5–3（`iceMaterial` 在 three 物理光照下默认 2）；冰预设 `clear`、`black`、`shore`。夯土：`layer` 0.08–0.15 m、`layerContrast` 0.15–0.3（< 0.15 读不出层理）、`erosion` 0–2、`damp` 0–1.5 m、`dampK` 0–0.6、`footSnow` 0–1 m、`topSnow` 0–1、`tileU/V` 1–16 m、`quality` preview|final。运行时逐镜调整：`material.userData.materialLibrary.uSnowP.value.set(W, ridge, grain, glint)`、`uRamFootDamp.value.set(footSnow, damp, dampK, topSnow)`。

夯土层理是**设计出的规则纹理**，会被 picture-qa ① 看见：在该镜头配置里用 `allowStripes` 框出墙面并写 `why`（总面积 ≤ 35%）。

## 验收（改本库或接入新宿主后必须做）

```bash
node --test tools/test/materials-kit.test.mjs                     # 烘焙确定性/可平铺、规则、参数区间、注入锚点、雪丘坡度
npm run test:picture-browser                                       # WebGL2 编译 + 五视角实验台 + seek 确定性 + picture-qa
node tools/test/materials-browser.mjs --out out/materials-r01     # 同上，保留截图/标注图/报告到被忽略目录
```

实验台 [example.html](example.html)：`?t=1` 雪低机位长焦掠射、`?t=5` 雪 30 m 俯视、`?t=9` 冰与雪舌、`?t=13` 夯土墙、`?t=17` 高度场雪丘；`window.__scene` 提供 seek/resize/capture/inspect。五张图的 picture-qa 必须全部 PASS（逐镜配置写在 `tools/test/materials-browser.mjs`：俯视两张无地平线 → `sky:"none"`；夯土墙层理 → `allowStripes`；俯视雪原放了几块暗色石头给出画面最暗处，亮度阈值不放宽；冰面视角里没有人物/暗物体轮廓，暗冰上的亮雪粉丝是已记录的 ② 误报 → `skip` + `skipWhy`；每条豁免带 `exempt` + `_why`）。项目接入后，在真实镜头上同样逐镜跑 `npm run qa:picture`。

## 已知局限

- 冰面积雪在低机位（< 5 m）看远处（> 20 m）时仍会压成横带——用雾/空气透视、降低 `cover` 反差、抬高机位或缩短视距；picture-qa ① 会指出。
- 极低月（< ~10°）掠射下风纹明暗对比很强，细亮脊可能触发 ②；夜景主光仰角建议 15–35°。
- 闪点是自发光近似，不受阴影遮挡；需要严格遮挡时由宿主乘阴影项。
- 没有雪的体积/次表面散射、没有实时积雪堆积；雪的宏观形由几何负责。

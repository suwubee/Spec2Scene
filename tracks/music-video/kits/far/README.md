# 远山 / 地平线层与建筑体块材质化

通用、参数化、确定性的远景组件：**远山与地平线层**（极坐标 ridged 高度场分层、雪线与裸岩、按距离与按层的空气透视、山脚雾、烽燧/远村剪影插槽）和**建筑体块材质化辅助**（夯土平顶房、城墙与拱门、残烽燧、搭接船板船体等通用件的“结构”，材质一律来自[材质库](../materials/README.md)）。不含任何作品的地名、布局或造型：所有尺寸、方位、种子都由调用方显式给出；预设只是通用的“四层弧形山带”和“一圈低远地平线”。

它由强模型做成组件、用自动质检锁住，供任何模型装配：**远山/地平线只用 `createFarRanges`；房屋、城墙、船、残台等体块只用本页写手 + 材质库**；改本组件必须过本页“验收”。

## 一页纸（照做即可）

1. 远山只用 `createFarRanges`（极坐标 ridged 高度场）。不要“方格网 + 大振幅噪声”拼山，也不要竖直带状面片——长焦下就是一片片“三角折纸”（E1）。
2. 远山用 **85 mm 及更长**的镜头拍；35–50 mm、低机位看远山时，层层山脊会叠成水平带（已知局限 1），这时改用 `distantRing` 一层低远剪影或抬高机位。
3. 体块必须有**结构**：檐（外挑 + 椽头 + 雪檐）、门窗**真洞**（四壁 + 洞底）、雪有**厚度**（高度场雪盖、下风雪檐、边唇、墙脚雪坡）。“6 面盒子 + 单色”一律是错误（E10）。墙用 `rammedEarthMaterial`，雪用 `snowMaterial`，不另写同类 shader。
4. 所有批次在 build 前过 `finishBatch`（绕序校正 + 零/NaN 法线兜底；`buildBlockMeshes` 已自动调用）（E5/E6）。
5. 交付前：本组件实验台六视角 + 项目真实镜头 `picture-qa` 全 PASS（只允许“设计内纹理”类豁免，写 `exempt` + `_why`）；确定性复渲逐字节一致。

```js
import * as THREE from '../../engine/vendor/three.module.js';
import {createFarRanges, FAR_PRESETS, blockBatches, flatRoofHouse, fortWall, plankHull, rammedTowerGeometry, buildBlockMeshes, blockMaterials, withAtmosFog} from './kits/far/index.js';

// create(ctx)：同步构建（四层约 30 万顶点、约 2 s），绝不在 update 里懒建
const far = createFarRanges(THREE, {...FAR_PRESETS.layeredArc, baseY: (x, z) => groundY(x, z), atmos,        // 引擎大气：与地面同一套雾
  light: {gain: 0.6, ambient: 1.3, subsurface: 0.5, airGlow: 1.7}});
scene.add(far.object);
const b = blockBatches();                                                     // {wall, snow, hole, wood, brick}
flatRoofHouse(b, {pos: [x, y, z], yaw, w: 7, d: 5, h: 3.2, wind: 1, seed: 3, chimney: {a: 1.6, c: 0.4, h: 0.9},
  doors: [{face: '+c', u: 2.2, w: 1.1, h: 2.0}], windows: [{face: '+c', u: 4.6, y: 1.1, w: 0.9, h: 0.9, lit: true}]});
const mats = blockMaterials(THREE, {quality: ctx.quality, top: 4, wind: [0.94, 0.34]});
withAtmosFog(mats.wall, atmos, 'houses');                                      // 引擎场景：远处体块与地面同雾（E11）
for (const m of Object.values(buildBlockMeshes(THREE, b, mats))) scene.add(m);

// update(t)：灯强度定稿之后
far.update({lights: [moon]});           // 'three' 口径：与 MeshStandard 地面同一盏灯；不给 lights 且有 atmos = 引擎 vDirect 口径
```

不接引擎（纯 three.js 场景）时省略 `atmos`：远山用自带的空气透视，`sky: {up, low}` 给天空平均辐亮度与地面反照，MeshStandard 体块用 `scene.fog`（雾色取同一个 `sky.up`，平原与山脚才接得上）。

## 文件与接口

| 文件 | 内容 |
|---|---|
| `params.js` | `LAYER_DEFAULTS` / `LAYER_RANGES`（越界抛错）、`FAR_PRESETS.layeredArc` / `distantRing`、`airParams` / `lightParams`、`MAX_ELEVATION_DEG` 5°、`MAX_STEP_DEG` 0.19° |
| `ranges.js` | `createFarRanges(THREE, opts)`；纯函数 `buildLayerArrays(layer, center, baseY)`、`layerRelHeight`、`crestAt`、`slotPosition`、`slotArrays`（node 可测，不需要 THREE） |
| `shade.js` | `makeFarMaterial(THREE, {atmos?, air, snow, light, sky})`：GLSL3 ShaderMaterial；程序键 `kits.far.v1.engine` / `kits.far.v1.standalone` |
| `blocks.js` | `GeoBatch`、`blockBatches`、`finishBatch` / `orientIndex` / `inspectBatch`、`frame` / `quad` / `boxF`、`wallWithOpenings`、`snowCap`、`flatRoofHouse`、`fortWall`、`rammedTowerGeometry`、`plankHull`、`withAtmosFog`、`buildBlockMeshes` |
| `surfaces.js` | `plankWoodMaterial`（每板明度差、搭接暗缝、低反差顺纹、足迹淡出）、`openingMaterial`（洞底发光）、`blockMaterials`（墙/砖=材质库夯土，雪=材质库雪） |
| `example.html` | 六视角实验台（见“验收”） |

`createFarRanges` 返回 `{object, meshes, material, layers, slots, stats:{verts, layers, maxSlopeDeg}, heightAt(x,z), crestAt(layer, az), update(extra), dispose()}`。`update` 的 `extra` 可逐镜改：`lights`、`gain`、`ambient`、`airGlow`、`air:{vis,strength,footH,foot}`、`sky:{up,low}`（独立口径），全部按合法区间校验。方位角自北顺时针，+x（东）= 90°。

## 远山层规则

| 项 | 规则 | 为什么 |
|---|---|---|
| 拓扑 | 以 `center` 为圆心的极坐标带：方位列按**弧长**细分（近层 5 m、远层 13–18 m，≤ 0.19°），径向 30–84 行、峰线附近加密 | 85 mm 下剪影每段 ≤ 15 px；方格网 70–170 m 一格 = 一块折纸 |
| 高度 | `Hm·包络 + (Hp−Hm)·峰线核 ×(二维 ridged)`：山体只随大尺度变；方位向峰线起伏只活在峰线 ±0.42W；支脊 = 低频 ridged 扰动包络 | 峰线起伏若沿径向拖到山脚 → 正面一排竖“帷幕褶”（E2） |
| 倍频 | 方位向 ridged 只 2 倍频；二维 ridged 5 倍频，比 2.4×行距更细的倍频退成均值 | 行距采不到的细节 = 逐列跳变的法线 = 竖条纹 |
| 坡度 | 坡度 > ~42° 的顶点向四邻松弛 4 轮；测试要求 ≤ 60° | 远山没有竖直“墙” |
| 带边 | 前坡到 R−2.5W、后坡到 R+1.7W，带外平滑归零并**埋进平原 3 m**；方位两端 `edge` 度收成平原 | 无纸边、无山脚悬空 |
| 平原 | 场景平原必须延伸到远山山脚之后；近场网格不动，外延另建块 | 平原直线边会把山脚切成一条水平线；改近场网格会让已过审镜头漂移（E13） |
| 雪/岩 | 陡坡（成片调制）、雪线以上岩斑（λ140/330 m）为主，脊顶风刨与石肋只作轻微调制；冲沟永远是雪；岩面有 22% 雪粉（冬季岩面不是纯黑） | 岩成片不成线：脊线细岩带正面看是一道道横“笔触”（E15） |
| 足迹淡出 | 岩斑反差按像素足迹淡出（`160/fp`）；明暗起伏（法线）按足迹收向竖直（`220/fp`）；冲沟/石肋三层各有足迹窗 | 宽镜头/掠射下 100 m 的斑被压成 2–4 px 的横线（E4/E15） |
| 空气透视 | ① 引擎 haze（atmos 口径）② 按距离 + 按层 `haze` 收向**天空平均辐亮度**与“月照空气辉光”的较大者 ③ 山脚雾高度/强度按 λ700 m 起伏 | ② 不能用视线方向的地平线天色（E3）；③ 等高雾带层层叠 = 水平条纹（E4） |
| 层次 | 远层比近层**亮而淡**（`airGlow` ≥ ~1.4），比夜空亮 | 远层收向近黑天色 = 一团黑影，近层亮脊被暗背景包围 = ② 光晕（E16） |
| 亮度 | 远山 ≈ 近处雪 × 0.6（夜，'three' 口径，`gain`）；`ambient` 跟场景天光一起调 | 远山比雪原亮会顶出镜头亮度带 |
| 插槽 | `beacon`：脊顶夯土残台剪影（底 7 m、高 9–11 m、收分、残顶、塌落基台）；`village`：山前平原低矮平顶院落 | 大景的尺度参照；< 300 m 的残台/残墙改用 `rammedTowerGeometry` |

### 层参数（单位：米 / 度；越界抛 RangeError）

| 字段 | 默认 | 合法区间 | 过大 / 过小 |
|---|---|---|---|
| `R` | 2400 | 1500–9000 | 太近（< 1.5 km）几何细度不够 |
| `W` | 480 | 0.12–0.30 R | 太窄像一道墙；太宽层与层糊成一片 |
| `H0` / `H1` | 40 / 140 | H0 < H1，峰线仰角 ≤ 5° | 太高挡月挡天、不再读作“远”；太低读不出 |
| `sharp` | 1.8 | 1.2–2.2 | > 2.2 刀脊 + 竖崖 |
| `lam` | 420 | 0.5–1.4 W | 太小斑点山；太大一坨 |
| `relief` | 0.6 | 0–0.85 | 0 = 一条峰线（像沙丘） |
| `peakLen` | 8 | 3–30 | 太小锯齿 |
| `step` / `rows` | 7 / 44 | 弧长 ≤ 0.19° / 24–160 | 太粗 = 折纸 |
| `haze` | 0 | 0–0.85（由近到远递增） | 全 0 = 无分层 |
| `snowLine` / `rock` | 0.18 / 1 | 0–0.45 / 0–1.5 | rock 太小远山成白布；太大成黑山 |
| `gaps` | [] | `{az, w 0.3–25, depth 0–0.9}` | 垭口/谷口；只给近层会被远层填平 |
| `air` | vis 9000 / strength 0.5 / footH 60 / foot 0.55 | 1500–60000 / 0–1 / 5–400 / 0–0.9 | — |
| `light` | gain 1 / ambient 1 / subsurface 0.35 / airGlow 1.5 | 0–4 / 0–4 / 0–1.5 / 0–2 | — |

`FAR_PRESETS.layeredArc`：四层 R 2350/3050/3950/5300，方位 183–353°，一个三层都开的垭口和一个侧缺口，两座烽燧插槽。`FAR_PRESETS.distantRing`：一层 R 6200 全周、低（30–120 m）、雾重，一个烽燧插槽——“天地极大”的大景只要极淡的尺度参照。两者都只是起点：项目覆写 `center`、`baseY`、方位与种子。

## 建筑体块规则

| 件 | L1 结构 | L2 材质 | L3 瑕疵与接触 |
|---|---|---|---|
| 平顶房 `flatRoofHouse` | 墙 + 门窗**真洞**（四壁 + 洞底，深 0.32 m；窗台朝上自动积雪；十字棂）+ 屋面板外挑 0.35–0.45 m + 椽头（±16 cm 抖动、12% 缺失：等距一排读成条纹）+ 平顶雪盖（中厚边圆、下风雪檐、边唇）+ 可选烟囱 / 院墙 | 墙：材质库夯土（引擎场景 `withAtmosFog`，程序键唯一）；雪：材质库雪；门板/棂/椽：`plankWoodMaterial`；洞底：`openingMaterial`（暗洞近黑、暖窗约 1900 K） | 墙脚埋 0.4 m；`chimneyTop` 返回烟囱口（炊烟起点） |
| 城墙 `fortWall` | 收分墙体 + 墙顶走道雪 + 垛口（每垛薄雪帽）+ 墙头 + 拱门道（9 段拱、0.62 m 砖券、门道深处**一点暗暖**）+ 门楼 + 外侧墙脚雪坡（`gY` 贴地） | 墙：夯土；砖：夯土灰色细层 | 远看：剪影 + 雪顶亮线 + 墙脚亮带；门道只剩一点灯 |
| 残台 `rammedTowerGeometry` | 连续实心曲面（周向 176 × 高度约 0.09 m 一行）：超椭圆截面（上部被啃圆）、版筑分版（0.5 m 收缝、±3 cm 进退、1.8 m 错缝）、迎风竖沟、2–3 m 风化鼓凹、剥落坑、墙脚掏蚀、V 形塌口（塌口里不留台阶）、掉角、内凹顶台、碎土堆 | 调用方配材质（`blockMaterials().wall` 设 `vertexColors` 用 AO） | 法线 = 网格差分；AO = 凹陷度；最内圈留 4% 半径（无退化三角） |
| 船体 `plankHull` | 方头平底、外飘船帮、N 列**搭接**船板（下沿外搭 1.2 cm 一道暗缝）、内板、舷缘压条、外倾方艄板、内肋、坐板、可选舱内积雪（高度场，顺风堆向一端） | `plankWoodMaterial`：`aMat.w` = 板号（每板明度差），`uv.x` = 跨板坐标（板缝） | 反照约 0.12–0.17；灯下特写压到约 0.1（否则暖色超标，E12） |

写手约定：`b = {wall, snow, hole, wood, brick}` 都是 `GeoBatch`（position / normal / color / aMat / uv）。局部坐标 `frame(o, yaw).p(a, y, c)`：a 沿局部 +x、c 沿局部 +z；外法线 −c 的墙要朝外，就选 yaw 使 −c 指向外。开洞位置写在“面坐标”里（u 从该面的起点量起，`+c` 面从 +a 端走向 −a 端），放不下的洞直接抛错。

## 常见错误（症状 → 根因 → 修法 → 自动拦截）

| # | 症状 | 根因 | 修法 | 拦截 |
|---|---|---|---|---|
| E1 | 远山“一片片三角折纸” | 70–170 m 方格网 + 大振幅噪声，每个三角一个平面；带的前后沿竖直截断 | 极坐标弧长细分 + ridged + 坡度限制 + 埋进平原 | ③ flat / 目检 |
| E2 | 远山正面一排竖“帷幕褶” | 方位向高频峰线沿径向拖到山脚；亚行距细节逐列跳 | 峰线起伏只在峰线附近；方位 ridged 2 倍频；`minLam` 淡出 | ① stripes |
| E3 | 远山细竖条纹 | 雾色取视线方向的地平线天色：天空方位起伏写进整列 | 收向天空平均辐亮度 | ① stripes；测试禁止 `vHazeColor` |
| E4 | 远景横条纹 | 等高山脚雾带层层叠；层与层只差雾；掠射下每道山脊的明暗对压成 2–4 px | 山脚雾按噪声起伏；明暗起伏按像素足迹收敛；远山用长焦 | ① stripes |
| E5 | 整帧变黑 / 大片黑块 | 收拢到一点的顶面中心法线为零 → 着色器 normalize 出 NaN → bloom 扩散 | 内圈不收成一点；`finishBatch` 零法线兜底；node 自检 | `inspectBatch`、测试 |
| E6 | 半透明“折纸帐篷” | 一半三角绕序朝里，背面剔除后只剩一半 | `orientIndex` / `finishBatch`；雪丘一律高度场 | 测试 `against = 0` |
| E7 | 残台“一块平板” | 4 面平板、每面一个法线 | 连续曲面 + 网格法线 + 分版/冲沟/鼓凹 | ③ / 目检 |
| E8 | 背光面死黑，体积读不出 | 只有地平线方向天光 | 竖直面加天顶冷补光（≈ 受光面 1/8），**顶面不加** | ② / ④ |
| E9 | 连续曲面一圈白边 | 平板时代的轮廓光在曲面上到处 \|N·V\|→0；高月下顶面雪盖在天空前成亮沿 | 轮廓光 pow 4、×0.6、顶面不加；残台顶雪按镜头减量（`topSnow`） | ② halo |
| E10 | 无材质白盒（码头/船/房） | 盒子 + 单色；雪是盒子 | 本页结构 + 材质库 | ③ / 目检 |
| E11 | 远处房屋比地面“跳”出来 | MeshStandard 没接场景雾 | `withAtmosFog(mat, atmos, key)`；独立场景用同色 `scene.fog` | 目检 |
| E12 | 木头读成黑洞 / 灯下木头暖色超标 | 顶点色 × 材质色把反照压到 0.02；或灯下反照过高 | 反照 0.12–0.17，灯下特写约 0.1 | ④ / ⑦ |
| E13 | 改平原后已过审镜头数值漂移 | 外延改变了近场顶点分布 | 近场网格一顶点不动，外延另建块 | ⑥ diff 与基线逐字节 |
| E14 | 环绕/过肩机位穿过人物头部、拍到正脸 | 两个机位直线插值；人物在插值中转身 | 绕人物环绕，方位跟她转身同步（始终在背后约 30°），半径后段才收拢 | ③ / 目检 |
| E15 | 远山满是水平“笔触”与亮细边 | 脊顶风刨、石肋这类**线状**岩在正面看全是横线；宽镜头下岩斑被压扁 | 岩以成片为主；岩斑反差按足迹淡出；岩面带雪粉 | ② halo、① stripes |
| E16 | 远山近层亮脊被暗边包围，远层比近层还黑 | 远层收向近黑天色（缺月照空气辉光） | `airGlow` ≥ ~1.4：远层亮而淡 | ② halo |
| E17 | 整帧一片地面色/空景，人物不在画里 | 走位 `walkPath` 忽略 speed（恒 1 m/s），人物落后于机位与脚印 | 距离 = 行走时间 × speed（见[人物](../../character/README.md#行走路径与脚印对齐)） | 测试 + 目检 |

## 检查方法（每次改远景/建筑必做）

```bash
node --test tools/test/far-kit.test.mjs                 # 参数区间、几何确定性/NaN/法线/坡度/埋边、插槽、着色规则、真洞、雪盖、绕序
SCENE_PICTURE_BROWSER=1 node --test tools/test/far-kit.test.mjs   # + WebGL2 编译、六视角、seek 确定性、picture-qa
node tools/test/far-browser.mjs --out out/far-r01       # 同上，保留截图/标注图/报告到被忽略目录
```

项目里：远景镜头出图后 `npm run qa:picture -- --dir <本版> --compare <上一版> --claim stripes,halo,flat --roi <改动区域>`；确定性复渲；改过引擎时旧场景基准帧逐字节不变。目检要点（长焦、1080p 4× 裁切）：剪影有峰有鞍、无平涂三角面；无竖“帷幕褶”、无水平“笔触”；层与层由近到远变淡；山脚从平原长出；建筑有檐影、门窗是洞、雪有厚度与亮边。

## 验收（实验台）

[example.html](example.html) 六视角（`?t=1|5|9|13|17|21`）：85 mm 长焦四层远山、35 mm 低远一圈地平线（烽燧 + 远村插槽）、三栋平顶房（真洞、暖窗、烟囱、院墙）、城墙拱门与门楼、残烽燧（塌口与碎土堆）、雪中的搭接船板船体。`window.__scene` 提供 seek / resize / capture / inspect。六张图的 picture-qa 必须全部 PASS 且没有配置警告；配置在 `tools/test/far-browser.mjs`：只有两条“设计内纹理”豁免（房屋与城墙的夯土层理、檐线），各带 `exempt` + `_why`，没有放宽任何阈值、没有声明天空区域。迭代中改掉的是画面：岩斑成片与足迹淡出、远层空气辉光、雪粉、残台顶雪减量、舱内积雪、门道只留一点暗暖、机位抬高与焦段。

## 已知局限

1. 35–50 mm、低机位看远山时，层层山脊仍会叠成水平带（picture-qa ① 会指出）：远山镜头用 85 mm 以上，或抬高机位、改用 `distantRing`。
2. 插槽是剪影级（几十个三角）；近于 300 m 的残台、残墙用 `rammedTowerGeometry` 与本页写手。
3. 独立口径的空气透视是简化模型（天空平均辐亮度 + 月照空气辉光）；接引擎时用 `atmos` 与地面同源。
4. 雪盖是静态几何，没有逐帧积雪；风吹雪粉、炊烟等动态由粒子系统负责。
5. 没有实时阴影投到远山上（远山不接 three 阴影图）；需要云影时由场景大气提供。

# 三维电影引擎

本版整体移植用户授权的成熟电影引擎。两个授权快照逐模块比对，15 个模块的 SHA-256 全部相同；选择共同版本保留算法，而不是根据目录时间猜测版本。来源字节数与摘要见 [port-manifest.json](port-manifest.json)。后续快照新增的植物、假山与铺装通用算法放在 [kits](../kits/README.md)，没有导入原作品场景、坐标布局、歌曲、字体或素材。代码作者 suwubee；three.js r186 保留原 MIT 许可。

## 模块与入口

| 模块 | 保留的能力 |
|---|---|
| core.js | 异步 seek 队列、场景懒创建、逐帧相机复位、HDR 主层、FX 层、双层叠化、快门子采样、资源释放 |
| post.js | 半浮点 HDR、分层散景、near-CoC 扩张、Kawase bloom、halation、横向 streak、曝光/白平衡、3D LUT、grain/dither、2.39:1 黑边 |
| camera.js | Super-35 镜头、焦距/FOV、沿视轴对焦、呼吸、手持、景深与快门 |
| sky.js / moon.js | 大气透射/多次散射 LUT、raymarch 云、雨云区域、云隙、太阳/月球程序纹理、月晕、星、环境照明 |
| terrain.js | 独立配置实例、河道/岸坡、域扭曲 ridged multifractal 山岭、田地、树冠、芦苇、共享高度雾与光照 GLSL；`makeValleyMaterial(atmos,'slope')` 提供不含河道布局的山坡地面 |
| water.js | 实际场景平面反射、Fresnel、解析波/雨环、月光闪烁、岸边/雾；planeY 指定水面高度 |
| particles.js | 雨、滴水、溅水、花瓣、光束、尘埃、蒸汽、萤火、分层薄雾；闭式时间位置、独立 FX 深度测试 |
| materials.js / procTex.js | 程序纹理、ORM、微表面法线、湿润/积水、薄片透光、软 PCF、面光近似、木/石/纸/纱/瓷/金属 |
| geo.js | 倒角、厚壁旋转体、瓦檐、窗格、卷帘、布面、竹杆、曲线管与合批 |
| noise.js / util.js | PCG 整数哈希、可分叉种子 RNG、gradient/simplex/fbm/curl、曲线、色彩/参数树 |
| audio.js / lyrics.js | 项目歌曲事件采样、逐字/竖排/片头片尾布局、Canvas 字幕后合成、显式项目字体和真实 cmap 覆盖 |

`core/index.js` 是镜头 JSON 的异步适配入口，`timeline.js` 把 v0.2 镜头表转换为原生 layers。`world/index.js` 保留曲线采样，`world/environment.js` 添加太阳/月亮方向和独立 `parameters` 注册表。`traces/index.js` 的 `footprintField()` 生成真正的负高度脚印和凸起边沿，雪地直接对地形采样它。

旧轻量天空、地形与后期渲染器已移除。`post/index.js` 只保留光学/LUT 辅助并转出完整后期工厂。`materials/index.js` 仍是现有角色调用的兼容材料入口；`audio/index.js` 的播放时钟、`lyrics/index.js` 的 DOM 排版、旧 traces 小构件保留为辅助，不负责样片的天空、水面或后期。

## 已有功能清单 / do-not-reimplement

下表按引擎实际导出整理。场景与道具代码**只能通过预设或参数使用这些能力，不得另写同类实现**（自写相机晃动、自写雾/天空、`fract(sin())` 哈希、硬编码署名等由 `tools/no-reimplement.mjs` 静态检查，生成项目 `npm run qa:reimplement`）。参数从标定值起步；超出标定区间约 3 倍前先在 DIRECTOR-DECISIONS 写理由。真正缺的能力提给唯一的引擎授权负责人，按[深做制作法](../../../playbook/11-deep-production.md)的引擎修改规则加入引擎，而不是在场景里复制一份。

| 能力 | 用什么（模块 · 函数/参数） | 标定与用法 | 禁止 |
|---|---|---|---|
| 相机路径 | camera.js · `evalCam(spec,t,dur,aspect)`、`dolly`、`crane`、`orbit`、`applyCamState`；镜头 JSON `shot.cam.keys` | 关键帧 + `ease`/`easeIn`/`easeOut`；Set 可用 `cameraAt(tLocal,shot,ctx)` 返回 `{pos,target,fov,handheld}` | 在 `update()` 里用 noise/sin/random 转动或平移相机 |
| 手持微抖 | camera.js · `handheld(t,amount,seed)`，由引擎在 Set `update()` 之后统一叠加（`shot.cam.handheld` 或预设返回的 `handheld`） | 1/f 频谱；amount 1.0 = ±0.15° 峰值（俯仰 ×0.85、横滚 ×0.5、位移 4/3/2 mm），每 amount 线性；工作区间 0–0.35，引擎钳到 1.5 | 自写抖动（曾出现过约为标定值 30 倍的自写抖动）；amount > 1 |
| 对焦与呼吸 | camera.js · `breathe(fov,dist,amount)`（默认 0.02/屈光度）、`rackFocus`、`focusKeys`、`evalFocus`、`viewDepth`；`shot.focus`、Set `focus()` | 引擎每个样本按焦距与对焦距离算 CoC，`ctx.refreshLens()` 在 Set 改相机后重算 | 自己缩放 fov 模拟呼吸、自己算景深 |
| 天空、月、星、云 | sky.js · `createSky`、`getSharedSky`、`scopeSharedSky`、`SKY_DEFAULTS`（`cloudDensity`、`cirrus`、`mie`…）、`twilightGains`；sky-presets.js · `skyPreset`、`SKY_PRESETS`；moon.js · `createMoonTexture`；moon-display.js · `clampMoonPhase`、`createMoonHalo`；kits · `createCelestialPhase`、`createCloudSea` | 大气透射/多次散射 LUT、raymarch 低云、卷云、月晕；常驻多场景用 `scopeSharedSky` 写全键 | 自写天空球/渐变天空着色器、贴图月亮 |
| 雾与空气透视 | terrain.js · `createAtmosphere(ctx,{sky,skylineAt,waterMist,moonColor})`（共享高度雾与光照 GLSL）；fog-terrain.js · `fogTerrain`；kits/far · `withAtmosFog`、`airParams`；particles.js · `createMistCards` | 近/中/远层由同一大气 uniforms 决定 | `new THREE.Fog*` 或自写 `exp(-d)` 雾（检查台可用 allow 注释写理由） |
| 地形与远景 | terrain.js · `createTerrainLibrary`、`createTerrain`、`makeValleyMaterial(atmos,'slope')`；kits · `createFarRanges`（远山/地平线）、`continuousHeightfield`、`createMountainLOD`、`createSnowfield`、`createRiver` | 远山三层 + 雪线 + 空气透视；体块用 kits/far 写手 | 色块远山、三角折纸山 |
| 水 | water.js · `createWater`（planeY、Fresnel、解析波/雨环、月光闪烁）、`ringsFromNotes`；kits · `createSmallWater` | 平面反射与岸边雾已接好 | 自写镜面水 |
| 粒子与天气 | particles.js · `createRain`、`createSplashes`、`createDripLine`、`createRingEvents`、`createPetals`、`createDust`、`createSteam`、`createMistCards`、`createFireflies`、`createLightShaft`；`particleTimeDomain` | 闭式时间位置（可任意 seek），FX layer 7 独立深度测试；风积分范围约 −8–248 秒 | 逐帧累加的粒子、自写体积光 |
| 材质与程序纹理 | materials.js · `createMaterials`、`configureShadows`、`makeMoonLight`/`makeSunLight`/`makeLanternLight`/`makeLampLight`/`makeSkyFill`；procTex.js · `bake`、`bakeDetail`、`listMaterials`、`hexLin`；kits/materials · `snowMaterial`、`iceMaterial`、`rammedEarthMaterial`、`injectMaterialLibrary`；kits/far · `plankWoodMaterial`、`openingMaterial`、`blockMaterials` | 线性 HDR、两层材质 + 瑕疵；灯走统一曝光约定 | 同类材质 shader 再写一份、私自乘亮度 |
| 几何构件 | geo.js · `bevelBox`、`lathe`、`tubeAlongCurve`、`roofMesh`、`latticeFrame`、`clothPlane`/`CLOTH_GLSL`、`paperSheet`、`merge`、`mergeInstanced`；kits/far · `wallWithOpenings`、`blockBatches`、`flatRoofHouse`、`fortWall`、`plankHull` | 真洞门窗、倒角、合批 | 白盒体块、贴片假窗 |
| 噪声与随机 | noise.js · `makeRng`、`hashString`、`pcg`/`pcg2d`/`pcg3d`、`hash11`…`hash33`、`fbm`、`snoise2/3`、`curl2/3`、`pink1`；GLSL `GLSL_HASH`、`GLSL_NOISE` | 整数哈希，跨 GPU 稳定；RNG 在创建期分叉 | `Math.random`、`fract(sin())` 哈希、`Date`/墙钟驱动 |
| 后期 | post.js · `createPost`、`DEFAULT_POST`、`mergePost`：`dof`（分层散景）、`bloom`、`halation`、`streak`、`lens`（畸变/色差/暗角）、`tone`、`grade`（LGG、分离色调、饱和度）、3D LUT、`grain`/`dither`/`weave`、`fade`；镜头级 `shot.post`/`grade`，全局 `postOverride` | 只映射一次；镜头参数覆盖全局 | 自写 bloom/景深/调色 pass |
| 歌词、片名与署名 | lyrics.js · `createLyrics`、`loadFonts`、`reflowLyrics`；credits.js · `normalizeCredits`、`creditTitles`、`undeclaredCredits`；composition.js · `placeSubtitle`、`measureComposition` | 字幕在最终画布内合成；片名/署名只来自项目 credits 显式字段 | 场景里硬编码作者、署名或片名卡 |
| 人物与走位 | character · `createCharacter`、`walkPath`、`character/real/`（外缘轮廓光 `rim.js`） | 剪影/背影优先；距离含 speed，脚印同源 | 场景里另写人体或轮廓光 |
| 常驻、确定性与释放 | shared-state.js · `createSharedScope`；first-sample-prime.js（`primeFirstSample`）；release.js · `createResourceScope`、`disposeObjectSafely`；geometry-safety.js · `guardGeometry` | 全键写入并恢复；首样本双渲；成对释放 | 依赖渲染顺序的懒缓存 |
| QA 钩子 | core.js · `engine.lastCamera()`：最后渲染样本的最终相机 `{e: matrixWorld, fov, aspect, shot, t}`（Set update、呼吸、手持之后） | `tools/cam-check.mjs` 用它判定相机稳定（p95 ≤ 1.5 px、每镜 rms ≤ 1.5 px、峰值 ≤ 4 px，1920 宽） | 用截图目测抖动 |

## 使用

```bash
scripts/new-project.sh music-video cinematic-demo
node tools/serve.mjs --root projects/cinematic-demo --port 39920
# 全画质单帧/试验台：?quality=final&w=1920&h=1080&t=4
```

```js
import {createEngine} from './engine/core/index.js';
import {createEnvironment} from './engine/world/environment.js';
const engine = await createEngine({canvas, shots, scenes,
  world: createEnvironment({wind:[[0,.2],[60,.6]]}, {tableLamp:[[0,1],[40,0]]}),
  width:1920, height:1080, quality:'final'});
await engine.seek(12.5);
const png = engine.capture();
await engine.resize(960,540);
engine.dispose();
```

页面暴露 `window.__scene`，以及供移植工具使用的同一对象 `window.__mv`。`seek(t)` 和 `resize(w,h)` 必须 await；`capture()` 返回已完成画面的 PNG data URL。字幕开启后在最终画布内合成；外部 DOM 不在画布捕获中。默认无歌词、署名、音乐或字体，音频由项目提供并遵守浏览器默认播放策略。创建场景失败会 reject，不会输出占位片伪装成功。

`createAtmosphere(ctx, {sky, skylineAt, waterMist, moonColor})` 默认使用内置地平线；传入 `waterMist:false` 会关闭水面薄雾项，`moonColor:[r,g,b]` 以线性空间指定月光色。旧调用不传这些字段时保持旧值。`slope` 材质只读顶点色、噪声、湿度和法线，故不会隐式引入河道、田块、田埂或路径；与 `terrain` 共享同一大气 uniforms。

场景适配工厂 `scenes[id](ctx)` 返回 `{scene,camera?,update(t,world,camera,shot,ctx),dispose?}`。原生入口 `core.js` 接收 `timeline:{shots,resolve,DURATION,FPS}` 与 `sets:{id:{create(ctx)}}`；原生 set 的 `update(tLocal,shot,ctx)` 为同步函数，`ctx.t` 才是全片时间。叠化时局部时间可能为负或超过镜长。不要把一种契约的 update 直接接到另一种契约。

## 确定性、光照与资源

动画只依赖时间、种子、世界参数；禁止累加 delta、用墙钟驱动物体或依赖上一帧相机。RNG 在创建阶段分叉；seek 不重新消耗共享 RNG。原库中少量旧正弦随机辅助已接到整数哈希。固定同一浏览器/图形后端才能要求像素一致，不承诺跨 GPU 或跨浏览器版本逐位一致。粒子风积分查找表沿用固定范围约 -8–248 秒；更长项目应显式扩展采样范围并重新验确定性。

所有材质输出线性 HDR，renderer 不做 tone mapping，后期只映射一次。颜色纹理标 sRGB，法线/ORM/噪声保持线性。几何 UV 以米为单位。月光和日光使用同一曝光约定，不能靠每个构件私自乘亮度补偿。大面积 radiance 超过约 10 会触发宽 streak；先修正灯、材质和曝光，再微调光学参数。

透明加色雨/尘埃/雾放 FX layer 7，深度来自主场景；粒子库已处理此契约。加色光输出预乘颜色且 alpha=0，遮挡才使用 alpha。不要让透明物的背景深度参与普通实体景深。反射/LUT 等预渲染必须保存并恢复 renderTarget、viewport、scissor；dispose 成对释放纹理、几何和后期 RT。

## 常驻多场景：共享对象隔离与首帧 prime

**共享对象按场景保存/恢复。** 常驻播放器里所有场景同时存在，一个 renderer 只有一个共享天空（`getSharedSky`）；共享大气、共享材质同理。场景只 `setOptions` 一个子集、或在实例已存在时把选项传给 `getSharedSky`（被忽略），画面就跑在“上一个渲染的场景”或引擎默认值上：单场景调试帧对、全片帧错，换 seek 顺序像素就变。规则：每个场景在使用前写入**全键向量**（默认值补齐它没设的键），用完恢复。

```js
import {getSharedSky, scopeSharedSky} from './engine/sky.js';
const sky = getSharedSky(ctx);                                            // 实例已存在时传入的选项会被忽略并告警
const mySky = scopeSharedSky(sky, {mie: 7, cloudDensity: 0, cirrus: 0.12}, 'night-field');   // create()：未知键立即抛错
update(t, w, camera) { mySky.update(t, w, camera); }                      // 全键写入 → sky.update → 恢复
```

任何其它共享对象用 `engine/shared-state.js` 的 `createSharedScope(target, defaults, {read, write})`：`bind(owner, overrides).run(fn)` 写入全键向量、执行、恢复；禁止嵌套、拒绝默认值里没有的键（不在向量里的键无法隔离）。

**首帧 prime。** 渲染管线对每个场景实例的第一次渲染存在“首用惰性”（渲染目标、阴影图、程序第一次使用），同一帧第一次与之后的渲染可差几到二十个码值，与 JS 状态无关；常驻多场景时“哪个场景先渲染”取决于 seek 顺序，于是同帧乱序不一致。`createEngine` 默认把**每个场景实例的第一个样本完整渲染两遍并丢弃第一遍**（`engine/first-sample-prime.js`），`engine.primedSets()` 列出已 prime 的场景，实时播放器写入 `__player.warm.primed`。诊断时用 `primeFirstSample:false`（starter 页 `?prime=0`）：只在实例第一帧出现、开 prime 即消失的差异才是管线惰性；每次换顺序都出现的差异是 JS 状态问题（首次用到时懒算的缓存、`Math.random`、`Date`、跨帧累积、上一帧残留的渲染目标），必须修代码，prime 不掩盖它们。确定性回归仍比较第一次、第二次与倒序像素。

**署名。** 片名与片头片尾署名只来自项目的显式字段（starter `src/credits.js`，`engine/credits.js`）：未填写不生成；时间轴里出现项目没有声明的署名卡记为引擎错误；占位词（TODO、作者、`{{…}}`）直接拒绝。

## 质量档与测量经验

| 请求 | 内部路径 | 比例 / MSAA / 阴影 |
|---|---|---|
| high | final | 1 / 4 / 2048 |
| medium | preview | .75 / 0 / 1024 |
| low | preview | .5 / 0 / 512 |
| auto | GPU high，软件 low | 随实际 renderer 检测 |
| final | 明确离线全画质 | 软件后端也保持 high |

实时 quality 请求在检测到软件后端时自动降 low；离线截图须显式 `quality=final`。不能把实时截图与全后期成片比较后归因于算法。

来源经验保留为测量方法，不沿用来源的性能数字作为本次成绩：半浮点多 tap 后期通常受带宽限制；半分辨率景深/云和预烘焙噪声较有效；大规模 instancing 在软件后端可能比合批更慢；懒创建和 shader 编译应与稳态 seek 分开计时；用真实 RT 内容与 GPU 同步采样，不能只测 JS 提交。多 worker 吞吐不一定提高，线程/CPU 必须受限。

离线命令、预算、续渲、字体子集化和优先级让路见 [tools/cinematic](../../../tools/cinematic/README.md)。试验台和样片证据由 `node scripts/validate-cinematic.mjs` 生成到项目 out/；独立 G1/G2/G3 仍需要审核人。云底、自阴影、贴片植物近景、屏幕空间雾、解析雨光和薄膜反射都有近似，不能把程序化画面当实拍或真实数据验证。

## 帧通道与场景接口

月相使用 world.moonPhaseAngle，月盘中和使用 lunarDiscNeutrality。全局 postOverride 是镜头默认值，shot.post/grade 优先；seek 的显式 post 最高。逐帧曲线和谷雾地形契约见[构件说明](../kits/v04.md)。字符包围盒用于原生字幕避让；返回无法避让的情况须调整构图。

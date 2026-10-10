# 三维电影引擎 v0.3

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

## v0.4 帧通道与场景接口

月相使用 world.moonPhaseAngle，月盘中和使用 lunarDiscNeutrality。全局 postOverride 是镜头默认值，shot.post/grade 优先；seek 的显式 post 最高。逐帧曲线和谷雾地形契约见 [v0.4](../kits/v04.md)。字符包围盒用于原生字幕避让；返回无法避让的情况须调整构图。

# 场景反馈工具接口

新增工具都是通用参数化代码。`bench/feedback.html?mode=apartment|props|glass|snow|character|lyrics` 是本地复验台；`character` 可加 `action=sit|lie|shout|contact&view=side`。修改后运行 `node tools/test/feedback-browser.mjs <ignored-or-temporary-output>`，默认自动播放策略，截图只进入输出目录，连续序列/正侧视联系表和 JSON 报告一起保存。

| 工具 | 输入与行为 | 验收边界 |
|---|---|---|
| engine/traces/path.js | `pathFootsteps({path,count,step,speed,stance,startTime,birth,height})`；path 为 Curve3 或控制点，按弧长左右交替，默认步距 .45 m 与角色半步一致 | 不会自动推断角色轨迹；非匀速角色用 `birth(index,distance)` 接入同一距离时钟 |
| engine/traces/index.js | `footprintField({...pathOptions,depth,width,length,fillAfter,fillDuration})`；脚掌/鞋跟两个凹面与边缘，按时间出现和回填 | `height(x,z,t)` 必须接到实际地形；真实表面法线/材质接收月光，无贴图发光冒充凹陷 |
| heightfield.js | `sampleAxis({min,max,nearMin,nearMax,step,growth})`、`continuousHeightfield({x,z,height,maxVertices})` | 一个连续网格，中心密集、远方渐疏；近区须覆盖项目路径；默认 40 万顶点预算 |
| snowfield.js | `createSnowfield(ctx,{tracks,terrain,mountains,skyPreset})`；统一近远高度函数，默认 coldNight，update(t) 更新凹陷 | 不同场景边界须共用高度函数；工具不自动消除外部几何接缝 |
| engine/sky-presets.js | `skyPreset('coldNight'|'moonlit'|'dawn')` 返回 sky 参数和环境 channels；createSky 接受 `{preset}` | 冷色夜景中月光穿过云的消光保留亮度、去除偏黄；是可选美术控制 |
| engine/world/environment.js | 第三个参数 `{particleTimeDomain:{start:-8,end:720,step:.125}}`；同一 world 的域不可在创建 FX 后更改 | 默认到 600 秒；最多 16384 样本，起点对齐 step；域外保持边界值，因此 end 要覆盖歌曲与尾声 |
| apartment.js | `createApartment({floors,columns,bayWidth,floorHeight,depth,seed,wetness,windows,balconies,airConditioners,roof})` | 楼层从 0 起；窗口 ID 为 `floor:column`，支持 brightness/offAt/schedule；`world.parameters['window:ID']` 优先覆盖 |
| close-props.js | `createPottedPlant({leaves,height,potRadius,seed})`；update(t,{growth,unfurl,wind}) | 双面叶层、细叶脉、透光材质和露珠；无植物生理模型 |
| close-props.js | `createFoldedPaper({size,kind:'boat'|'paper',waterHeight})`；update(t,{fold,float,x,z}) | fold 0–1 确定性折叠包络；浮动跟随水面函数；非保面积折纸/刚体浮力仿真 |
| engine/glass.js | `createGlassReflection({width,height,resolution,opacity,tint})`；局部 XY 平面 +Z 法线；update(renderer,scene,camera) 在主渲染前调用 | 支持竖直/旋转玻璃、半透明、斜裁剪和状态恢复；透视相机，单层倒影，不是无限递归镜面 |
| engine/composition.js | `measureComposition({scene,camera,characters,columns,rows,ignore})` | 可见人物占比、投影占比、遮挡比例、负空间；屏幕采样光线估计，默认 64×36，细小对象提高采样；不处理 shader 位移/alpha 贴图 |

composition 的负空间是没有命中参与统计网格的屏幕采样比例。全屏背景/天空可通过 `ignore` 或 mesh.userData.compositionIgnore 排除；不是自动语义分割或审美判分。透明度低于 .15 的材质不算遮挡，高于该值按表面计。

画质信息 `qualityInfo` 分别记录 `requested`、`actual`、`offlineQuality`。软件后端只在 auto 时选择 low；high、medium、final 明确请求会保留。`final` 映射 high、`preview` 映射 medium。离线工具的 worker 状态与逐帧性能日志也记录这三个字段；缺少引擎信息写 null，不猜测硬件能力。软件运行结果不代表目标硬件帧率。

角色新接口见 character/README.md。所有工具需项目集成和独立视觉审核；试验台的程序化几何与实现者自测不代签 G1/G2/G3。

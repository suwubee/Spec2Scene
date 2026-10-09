# 实时播放层（实验性，默认不用）

默认入口已改为[逐镜预热与常驻播放器](../realtime/README.md)。本层仍随项目生成，通过 `experimental.html` 或 `?player=experimental` 显式选择；以下是实验选项的契约和历史实现说明，不代表默认行为。

生成音乐视频项目仍包含 `player/`、60 秒程序合成配乐和实验实时页。配乐只在生成时写入项目 `assets/demo.wav`，仓库不保存音频。将 `#music` 的 `src` 换成获授权的同源音频即可接入歌曲；歌词、镜头表和授权记录仍由项目管理。

`boot.js` 是无依赖的普通脚本。它先绑定控件，点击调用栈中同步执行 `media.play()`，随后才加载播放器模块。音频不等待场景、字体或着色器。浏览器默认自动播放策略保持不变；音乐可播放时点击到解码信号应 ≤1 秒。资源尚未缓冲时显示真实 `buffered / duration` 百分比，按钮登记播放请求，也可取消等待。未知长度显示 0%，不伪装成下载完成。此指标是媒体缓冲比例，不是字节下载比例。

实时页以 `HTMLMediaElement.currentTime` 为唯一时间源。主线程更新控件与字幕，Worker 使用独立 OffscreenCanvas 构建和绘制，最多一条在途请求。GPU fence 完成后才传回位图；慢帧期间丢弃采样，不补帧、不改变音频速率、不暂停音乐。换档期间保留最近完成的位图。浏览器不支持 Worker/OffscreenCanvas 时明确提示画面不可用，音频仍可操作。

`film.js` 接受 `{canvas,width,height,quality,shots,scenes,previewScenes?,world,progress,compile}`；scene 工厂收到 `ctx.playback` 参数及引擎上下文。普通项目只需传 `scenes`，它们在单一引擎中常驻；显式提供 `previewScenes` 时，实时层一次性选择这组轻量 HDR 工厂并在所有档位复用，确定性截图仍使用完整引擎。实时工厂只依赖 `renderer/aspect/quality/qualityInfo/playback`，负责应用粒子和几何预算，不依赖电影引擎的粒子/天空上下文。默认样片提供这组工厂，保持相同镜头和世界坐标。

预热完成前仍允许音频播放；Worker 按单条在途命令推进预热，避免把所有 GPU 命令一次压入队列。真实 `KHR_parallel_shader_compile` 能力写入诊断；扩展缺失时编译仍在 Worker，并在报告中标注软件回退。预热完成后 `idle()` 只负责补齐未完成的代表时刻，不按镜头销毁或懒建场景。

实时层 v0.4.3 在页面载入后只创建一个 renderer 和一份常驻场景集合。`previewScenes`（若项目提供）在这个单引擎中作为实时场景预算使用，高、中、低档都通过 `ctx.playback`、阴影贴图尺寸、粒子 `drawRange`、后期 uniform/跳过 pass 和运行时 `post.resize()` 改参数；不会销毁引擎、场景或材质，也不会改变 shader defines。MSAA 在整个页面生命周期内固定。`resize()` 会原地调整 renderer、相机、后期 RT、景深尺寸 uniform 和字幕纹理，保留程序缓存。

预热从 Worker 初始化后立即开始，不阻塞 `media.play()`：场景先各创建一次并调用 `compileAsync`，随后按镜头首/中/尾和叠化代表时刻渲染，暂时关闭视锥剔除以覆盖阴影、反射和后期组合，再渲染当前时刻恢复画面。HUD/`window.__player.warm` 显示 `场景 x/N · 程序 n/≈N · 步 k/K`；暖机结束时 `programTotalEstimated` 变为 `false`，场景创建数和程序身份快照被冻结。暖机后的 `diagnostics.programs` 记录程序身份集合，`newPrograms` 应为 0；`diagnostics.switches` 要求 `rebuilt:false` 且 `definesChanged:false`。

开始方式可用 `?start=a|b|auto`。a 在可信点击栈中立即调用 `media.play()`；b 在同一点击栈中先静音解锁媒体，等待暖机完成后音画同起，等待中再次点击会转为立即播放；auto 只在预计剩余暖机时间不超过 20 秒时选择 b。默认自动播放策略、慢网缓冲比例和音频主时钟不变。

播放器返回 `memory` 粗估和 HUD 的 `常驻≈X MB（纹理 / 几何 / RT）`。估算去重纹理对象、几何 typed-array 和提供的 render target，明确排除驱动开销、压缩纹理的未知分配和未登记目标，不能当成真机显存读数。`player/fixed-lights.js` 的室内/室外布局用零强度占位灯稳定 three 的灯数组程序键；项目场景不得在播放中增删灯。



通用 Worker 加载 `data-runtime` 指定的项目模块，该模块导出 `createRuntime(options)`，返回 `shots`、`capabilities`、`render(t,quality)` 和 `idle(t)`。默认适配器见 starter 的 `src/runtime.js`。项目可提供自己的工厂，不需要修改播放时钟或按钮逻辑。`shots` 支持可选 `caption`，实时 DOM 字幕随音频时间更新；复杂歌词项目可扩展字幕视图，不能假称 DOM 已进入离线画布。

| 实时档位 | 渲染比例 | MSAA | 阴影图 | 粒子比例 | 画面路径 |
|---|---:|---:|---:|---:|---|
| 高 | 1.0 | 0（固定） | 2048 | 1 | 常驻场景、景深与后期 |
| 中 | 0.65 | 0（固定） | 1024 | 0.5 | 远景角色与合批场景、半浮点 HDR、色调映射，无体积云/反射/电影景深 |
| 低 | 0.5 | 0（固定） | 512 | 0.25 | 远景角色与合批场景、半浮点 HDR、色调映射，进一步减少阴影开销 |

自动档从中档开始。每个 2 秒窗口统计 p90：>50 ms 降一级，<22 ms 连续 4 秒升一级，中间区间重置升档累计；切换后冷却 3 秒，曾因慢帧退出的档位 30 秒内不升回。手动高/中/低不自动改变。HUD 的 fps 是最近 4 秒实际交付帧数/观察时长，p90 是请求到 GPU 完成并交付的延迟；暂停和尚无样本时显示文字，不写假定 60 fps 或初始化 0 fps。`window.__player` 提供有界逐帧记录、档位变化、编译记录与能力，不是离线渲染接口。

截图必须打开 `?mode=capture`（`?quality=final` 兼容），只初始化固定高画质的确定性入口，禁用音频与自适应循环，暴露 `window.__scene`。实时页不提供 `__scene`，避免截图工具误测实时状态。不根据 `navigator.webdriver` 改变路径。实时中/低档和电影高档的视觉差异需分别审图；不能用低档截图代签最终画质，也不能用离线渲染的帧率冒充实时交付帧率。

验收命令（输出使用临时目录或忽略目录）：

```bash
timeout 360s npm run test:playback -- /tmp/scene-player-evidence
timeout 1200s npm test
timeout 1500s npm run test:browser -- --isolated --offline
```

`npm test` 和三产线浏览器验收均包含真实 starter 的按钮、默认自动播放锁、点击至解码波形、20 秒墙钟/音频窗口、自动档与帧时间、慢网、4 倍 CPU 降速、暂停重播、字幕、跨场景、移动视口及截图模式隔离检查。浏览器去掉 Playwright 默认静音，不放宽自动播放策略；Linux 上限制为 2 个软件 shader worker、2 个 CPU 与 2 个 raster 线程。临时仓库仍由 `scripts/new-project.sh` 生成项目；当前仓库的 projects 不写入。失败报告及截图保留。

自动验收的解码波形不等于真人听到扬声器；SwiftShader 不等于 Windows/ANGLE D3D11。独立审核者必须在目标设备的实时页亲自点播放，并记录出声、连续播放与视觉流畅度。

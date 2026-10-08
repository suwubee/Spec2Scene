# 实时播放层

生成音乐视频项目即包含 `player/`、60 秒程序合成配乐和默认实时页。配乐只在生成时写入项目 `assets/demo.wav`，仓库不保存音频。将 `#music` 的 `src` 换成获授权的同源音频即可接入歌曲；歌词、镜头表和授权记录仍由项目管理。

`boot.js` 是无依赖的普通脚本。它先绑定控件，点击调用栈中同步执行 `media.play()`，随后才加载播放器模块。音频不等待场景、字体或着色器。浏览器默认自动播放策略保持不变；音乐可播放时点击到解码信号应 ≤1 秒。资源尚未缓冲时显示真实 `buffered / duration` 百分比，按钮登记播放请求，也可取消等待。未知长度显示 0%，不伪装成下载完成。此指标是媒体缓冲比例，不是字节下载比例。

实时页以 `HTMLMediaElement.currentTime` 为唯一时间源。主线程更新控件与字幕，Worker 使用独立 OffscreenCanvas 构建和绘制，最多一条在途请求。GPU fence 完成后才传回位图；慢帧期间丢弃采样，不补帧、不改变音频速率、不暂停音乐。重建画质时保留最近完成的位图。浏览器不支持 Worker/OffscreenCanvas 时明确提示画面不可用，音频仍可操作。

`film.js` 接受 `{canvas,width,height,quality,shots,scenes,previewScenes?,world,progress,compile}`；scene 工厂收到 `ctx.playback` 参数及引擎上下文。普通项目只需传 `scenes`，所有档位继续使用完整引擎，降低分辨率/MSAA/阴影和低档后期。显式提供 `previewScenes` 才会在中低档使用轻量 HDR 管线；这些工厂只依赖 `renderer/aspect/quality/qualityInfo/playback`，负责应用粒子和几何预算，不依赖电影引擎的粒子/天空上下文。默认样片提供这组工厂，保持相同镜头和世界坐标。

首先只构建当前镜头所需场景；其后在帧间空闲任务中，按镜头起点顺序、提前最多 8 秒，每次准备一个后续场景，调用 `renderer.compileAsync(scene,camera)`。真实 `KHR_parallel_shader_compile` 能力写入诊断；扩展缺失时编译仍在 Worker。首次后期编译可能发生在第一帧，冷启动耗时必须单列。

通用 Worker 加载 `data-runtime` 指定的项目模块，该模块导出 `createRuntime(options)`，返回 `shots`、`capabilities`、`render(t,quality)` 和 `idle(t)`。默认适配器见 starter 的 `src/runtime.js`。项目可提供自己的工厂，不需要修改播放时钟或按钮逻辑。`shots` 支持可选 `caption`，实时 DOM 字幕随音频时间更新；复杂歌词项目可扩展字幕视图，不能假称 DOM 已进入离线画布。

| 实时档位 | 渲染比例 | MSAA | 阴影图 | 粒子比例 | 画面路径 |
|---|---:|---:|---:|---:|---|
| 高 | 1.0 | 2 | 2048 | 1 | 完整电影场景、景深与后期 |
| 中 | 0.65 | 0 | 1024 | 0.5 | 远景角色与合批场景、半浮点 HDR、色调映射，无体积云/反射/电影景深 |
| 低 | 0.5 | 0 | 关闭 | 0.25 | 远景角色与合批场景、半浮点 HDR、色调映射，进一步减少阴影开销 |

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

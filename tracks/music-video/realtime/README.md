# 默认播放器：逐镜预热与场景常驻

生成音乐视频项目后，默认使用此播放器。点击调用栈同步 `play()+pause()` 解锁媒体，再创建一个完整电影引擎，逐镜 `renderFrame(t, {sync:true})` 渲染首、中、尾代表帧和叠化内部双层帧。预热进度可见；失败显示错误并允许重新点击。全部完成后正式播放，场景和程序缓存常驻。没有后台懒建、换档重建或自动分层选择。

`src/resident-runtime.js` 导出 `createRuntime({canvas})`，返回带 `timeline.shots / fps / duration / renderer / renderFrame / setIds / dispose` 的引擎。项目替换场景和镜头表即可；播放器不包含作品内容。默认完整电影画质，`?w=1280&h=720` 指定固定尺寸。尺寸和预热耗时须在目标设备测量；软件浏览器不能证明目标 GPU 流畅。HUD 的“绘制 fps”统计完成的绘制调用，不代表显示器呈现或 GPU 完成帧率。

## 载入页、第一帧与预热预算

- 点击后先渲染并显示所选起点的第一帧（`__player.warm.firstPictureMs`），之后画布一直可见，状态栏显示 `warm.pct` 百分比与 `warm.etaMs` 剩余时间。**载入页不能只有文字**：几分钟的纯文字会被当成“动画全是文字”。
- `createResidentPlayer({..., budgetMs})` 默认 60 000 ms；预热总时长 `warm.ms` 超出时 `warm.overBudget = true`。浏览器回归打印实测时长，设置 `SCENE_WARM_BUDGET_MS` 时按预算判失败；时长受机器与负载影响，最终在交付机器上按 GATE 验收。交付前在共享负载下实测点击→第一帧与总预热（目标：软件渲染 ≤ 60 秒，GPU 约 15 秒），写进 GATE。
- 预热计划 `warmPlan`：起步工程默认 `'scene'`，即每个场景/后期组合（`warmKey`，默认 set/scene/id + post/grade + preset）一个样本加所有叠化中点；前提是播放回归报告 `newPrograms === 0`。`?warm=shot` 切回逐镜首/中/尾，用于排查某镜头漏编译。软件渲染下预热主要花在每个场景的首次着色器编译，减少样本数只能去掉重复部分。
- 昂贵的程序纹理烘焙结果可缓存为项目文件，但必须与现场烘焙逐字节核对后才能启用；不能用缓存掩盖确定性差异。

## 常驻场景的两条确定性约定

- 每个场景实例的第一个样本由引擎双渲、丢弃首遍（首帧 prime），预热因此每场景多一个样本；`__player.warm.primed` 应列出全部场景。`?prime=0` 只用于诊断。
- 共享天空等共享对象必须按场景写入全键向量并恢复（`scopeSharedSky` / `createSharedScope`），否则全片模式会跑在别的场景或默认参数上（[引擎说明](../engine/README.md)）。

## 声音与时间

- 点击先解锁，预热完成再出声。首声预算分为点击到预热完成、网络等待、二者就绪到解码信号三段；不能隐藏预热时间。
- `audio.js` 只在媒体 `error` 事件选择下一候选源，没有探测超时。`#music` 的 `src` 与可选子元素 `source` 按顺序使用，项目自行填写获授权音频。慢网显示“声音载入中”，画面先按墙钟；`loadedmetadata` 尝试播放，实际 `playing` 时再次对齐并交给 `currentTime`。
- `NotAllowedError` 显示“点击启用声音”；音源耗尽显示“声音载入失败 · 点击重试”。暂用墙钟始终有提示，不存在静默无声成功状态。暂停、重播、拖动、加载中重试都保留明确状态。
- `window.__player` 提供 `sound / clock / transport.state.transitions / warm / frames / newPrograms` 诊断。声音输出链用浏览器 analyser 验证，真人听审另做。

`?mode=capture` 或 `?quality=final` 保留确定性 `window.__scene` 的 `seek/capture/resize`，没有音频请求或自动播放。原分层播放器在 `experimental.html` 或 `?player=experimental`，**实验性，默认不用**；其专属控制与 Worker 只在显式选择时加载。

## 硬切、时间重映射与闪烁

`timing.js` 的 `createCutSafe(hardCuts(shots), {fps, jump, shutterAngle, duration})` 生成 `cutSafe(t)`。默认窗口为世界跳变 8 ms + 半个 180°/24 fps 快门 + 0.1 ms 容差，实时采样最多约偏移 18.52 ms，保留切点左右归属；截图 seek 不偏移。项目改变快门或世界跳变范围时须同步配置。重叠保护窗口拒绝接受，应先调整切点或快门。

`remapShotClock({t, frame, fps, start, end, from, to, world})` 返回预设 `t`、`frameT`、真实 `realFrameT` 和精确逆映射的 `world`。`frameT` 从真实 `frame/fps` 映射，不能对映射后的时间再取帧号。支持倒放；冻结预设没有唯一逆映射，明确采样当前真实世界时间。场景要显式使用此返回上下文，不能只改动画时间而保留旧的世界查询。

运行服务后执行 `npm run check:flicker`；每轮指定新的输出，例如 `npm run check:flicker -- --out out/flicker-r02`。工具按 24 Hz seek 与 60 Hz 实时采样策略扫描，并对硬切 ±1/±4.5/±25 ms 加密，输出 `rows.json`、`flags.txt`、缩略图和分页联系表。60 Hz 是时间采样密度，不是声称实际实时达到 60 fps。详细参数见 [工具说明](../../../tools/README.md)。候选需人工看连续帧，正常硬切也会报告；无候选不代签视觉验收。

浏览器回归：`timeout 960s npm run test:playback -- <临时证据目录>`。覆盖默认策略、严格用户激活且关闭 webdriver 特征、音频延迟 5 秒/25 秒、解码信号、媒体接管同步、失败重试、暂停重播、常驻程序和真实引擎的闪烁两条路径。

## 进度与成片下载

原生时间滑块支持鼠标点击/拖动、触控与键盘；预热中选定的时间保存在同一 transport，预热后从所选时间开始。正常有声播放时 2.5 秒无操作隐藏，鼠标/触控/键盘唤回；暂停、预热、载入/声音错误、拖动和键盘焦点时保持可见。控件触控区域 ≥44px，时间显示与 aria-valuetext 一起更新。

页面 `#download` 的 `data-video` 指向同源 MP4，默认 `assets/video/share.mp4`。HEAD 检查成功且 MIME 为 video/mp4 才加 href 与 download；404/网络错误/错误 MIME 显示“成片生成中”禁用态，30 秒或窗口重新聚焦时复查。文件由项目编码 QA 后放入，starter 不伪造视频。截图/离线路径隐藏全部 transport，且不发 HEAD。

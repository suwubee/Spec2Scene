# 电影引擎离线工具

整体保留原帧渲染、捕获/PNG、编码、QA、确定性、叠化与运维优先级工具，接到生成项目目录。新增预算与续渲身份检查。所有页面使用浏览器默认自动播放策略，错误/缺失场景直接失败。下列命令用于实现证据与预览，不替代独立审核、生产成片放行或部署授权。

12 个移植工具文件的来源快照摘要见 [port-manifest.json](port-manifest.json)。`verify_determinism` 在输出目录保存 `report.json`，包含采样帧、CPU 组、逐次像素比较及失败信息；不匹配时另保留 A/B/差异图片。

```bash
# 稀疏预览：半分辨率、每 N 帧、指定时间段；联系表 + 标为“预览非成片”的 MP4
node tools/cinematic/preview.mjs --root projects/demo --start 28 --end 34 --every 4 --out projects/demo/out/preview --port 39920
# 高画质关键帧
node tools/cinematic/render_frames.mjs --root projects/demo --frames 0,360,720,840 --w 1920 --h 1080 --quality final --workers 1 --nproc 2 --out projects/demo/out/keys --port 39920
# 相同源码、浏览器、后端与配置才能续渲
node tools/cinematic/render_frames.mjs --root projects/demo --frames 0,360,720,840 --w 1920 --h 1080 --quality final --workers 1 --nproc 2 --out projects/demo/out/keys --port 39920 --resume
# 连续/等间距帧编码；缺帧默认失败，音频必须显式提供
node tools/cinematic/encode.mjs --frames projects/demo/out/frames --out projects/demo/out/preview.mp4 --every 4 --threads 2
node tools/cinematic/qa.mjs projects/demo/out/preview.mp4 --silent --w 960 --h 540 --out projects/demo/out/qa
# 两个新浏览器进程，乱序 + 干扰帧 + 重复帧；比较 raw RGBA
node tools/cinematic/verify_determinism.mjs --root projects/demo --frames 0,360,724,840 --k 4 --w 960 --h 540 --out projects/demo/out/determinism --port 39920
node tools/cinematic/verify_dissolve.mjs --root projects/demo --cuts 30 --w 960 --h 540 --query quality=final --port 39920
```

`render_frames.mjs` 用绝对帧号 `f%05d.png` 和 `t=f/fps`，PNG 原子写入，记录 render_state.json / render_log.jsonl / render_identity.json。身份包括运行源代码和数据树摘要（含项目媒体、排除 out/cache）、浏览器可执行文件摘要、后端、尺寸、fps、质量、捕获方式与 CPU/线程配置。修改任一身份项后续渲拒绝；旧帧没有身份文件也拒绝。不同后端不能混在一次成片里。

默认 1 worker、最多 4 CPU / 4 raster 线程；本工具限制最多 2 workers。默认未压缩帧磁盘预算 4 GiB，显式 `--max-gib` 最高 32；真正批量成片应按段渲染并提前估算。帧上传仅接受已签发 token、单帧最多 64 MiB。`--retries 0` 同样约束初始化失败。PNG 续渲检查完整头尾；它不代替最终逐帧 QA。

指定 `--channel` 时还必须提供 `--chrome`，以便摘要对应实际浏览器可执行文件。native 模式的进程控制连接也只从 39920–39929 选择空闲 loopback 端口，记录 browser PID 并等待关闭；端口不足则失败。

服务只绑定 127.0.0.1，电影工具端口 39920–39929。软件后端默认在私有 Xvfb 上用 llvmpipe，提供 SwiftShader 回退与显式 native；只能记录/停止自己启动的 PID，close 等待退出。优先级工具只操作显式传入、同用户、启动时间仍一致的 render PID 树；降低 priority，不自动杀进程。

```bash
python3 tools/cinematic/ops/prio_guard.py OWN_RENDER_PID --light 5 --heavy 19 --every 10
python3 tools/cinematic/ops/prio_guard.py --selftest
```

`encode` 保留 BT.709 矩阵与标签、limited range、H.264 High、faststart、帧号元数据；默认无音频。稀疏预览必须显式传 `--every N`，默认按连续帧检查，避免规律缺帧被误判成降低帧率。`qa --silent` 允许静音预览，音画同步必须标 SKIP；黑场/冻结/亮度尖峰/色带是供人检查的候选，不能当审美评分。`verify_dissolve` 比较独立开发后的双层画面，检查 0/1 端点和平均亮度单调。

字体由项目提供。`build_fonts.mjs` 保留递归文本收集、fontTools woff2 子集与实际 cmap 覆盖检查；Python 环境通过 `--python` 指定，不使用任何机器私有目录。

```bash
node tools/cinematic/build_fonts.mjs --config projects/demo/fonts.config.json --text projects/demo/song.json,projects/demo/titles.json --out projects/demo/assets/fonts
node tools/cinematic/build_fonts.mjs --selftest
```

字体配置：`{"fonts":[{"src":"user.ttf","out":"serif.woff2","family":"MV Serif","weight":400,"index":0}],"extra":""}`。src 相对配置文件；需要 fonttools+brotli。生成 `fonts.json` 的 `files` 传给 `loadFonts({files,baseURL,coverageURL})`。源字体没有的字会列出，不能把系统字体回退当覆盖检查成功。字体许可由项目确认，不分发字体文件。

项目生成器会复制整个工具链到 tools.local/cinematic/，保持相对依赖可独立运行。`snap.mjs` 可单页拍摄，`scripts/validate-cinematic.mjs` 是仓库 A 线的样片/工具包浏览器验收。真人、真实音频、目标 GPU 和生产环境缺失时如实 SKIP。

# 本地感知与评测工具

不含模型或数据。`local-loader.mjs` 使用同源 import.meta.url 解析后的 URL 与显式 WasmFileset；binary 为 .wasm.bin，model 为 .task.bin。`scripts/fetch-models.sh --project projects/my-motion --kind pose` 从官方固定模型版本及 npm 固定运行时下载，验证运行时 integrity、记录模型 SHA-256 和许可来源。下载不自动证明模型可商用。

本地化不代表没有遥测：固定包需检查定时器与网络路径，CSP connect-src 同源兜底。若需要补丁，使用 `patch-runtime.mjs --input FILE --output FILE --patch PATCH.json`，配置包含 expectedSha256、find、replace、count，原哈希和匹配数不符即失败。不能把旧版本的压缩符号补丁套在新版本上。下载器发现已知遥测标记会停止，浏览器至少覆盖统计定时窗口复审。

`one-euro.mjs` 输入值及严格递增秒时间；滤波不修改采集时间；重置仅发生在输入源切换或校准开始之前。

## SimPose / InputSource 契约

`await source.start()` 初始化，`source.sample(tSeconds)` 返回 `{timestamp,points:[{x,y,z,visibility}],source}`；`stop()` 释放媒体/模型。标准骨架点序遵循所选检测器，时间单位不得混用。相机原始坐标保存解剖学左右，镜像仅在显示映射进行。合成来源必须标 `sim`，不得计入真实活动和真实准确率。

## 真实视频评测

项目测试页传入真实 landmarker 与 detectEvents 到 harness-template.mjs，暴露 `__poseEval.ready` 和 `detect(bitmap,timestampMs)`。用 FFmpeg 抽帧绕开浏览器 H.264/seek 差异：

```bash
node tools/pose/evaluate-video.mjs --video '<licensed-video>' --url http://127.0.0.1:39920/tests/harness.html --out out/evaluation --labels '<labels.json>'
```

标签 JSON：`{"events":[{"t":1.2,"hand":"L","type":"action"}]}`。明确 t 是动作起点还是峰值、hand 是人物解剖学左右。工具最大化一对一时间匹配，再最小化误差；同手 precision/recall 与不限定手的手别准确率分别统计，另列类型准确率、时间中位误差和丢点率。工具输出指标，项目按 SPEC 应用门槛；工具 PASS 仅表示评测链路完成。

仅在数据可选且缺失时使用 --allow-missing，明确 SKIP。输入已存在但失败不能跳过。输出包含事件/采样联系表，需人工检查漏判与误报；数据和输出均不得回填基准仓库。

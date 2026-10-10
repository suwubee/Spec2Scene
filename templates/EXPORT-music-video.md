# 成片导出记录

状态：PENDING；负责人：`<角色>`；独立 FINAL 记录：`<文件>`；源码/数据/浏览器/后端/种子摘要：`<填写>`。

| 阶段 | 命令及超时 | 资源与 PID | 证据/结论 |
|---|---|---|---|
| 预览审片 | `<稀疏帧/编码命令>` | `<尺寸/帧范围>` | `<联系表/独立意见>` |
| final | `<完整帧命令>` | `<workers/taskset/nproc/磁盘估算/端口/PID>` | `<manifest/完整性>` |
| 停摆与续渲 | `<INT/等待/--resume>` | `<原/新 worker 数>` | `<失败日志/缺帧/修复日志>` |
| 母版 | `<CRF 14>` | `<线程限制>` | `<完整 QA>` |
| 分享版 | `<CRF 19/maxrate 16M>` | `<线程限制>` | `<完整 QA>` |
| 轻量版（可选） | `<尺寸/CRF/码率>` | `<预算>` | `<差异与 QA 或 SKIP 原因>` |
| 下载交付 | `<目标/文件哈希>` | `<自己的静态服务 PID>` | `<HEAD/Range/浏览器下载一致>` |

以下命令在生成的项目内执行，参数按本项目替换，先填独立审核再执行 final：

```bash
timeout 30s node tools.local/review-gates.mjs --help
timeout 7200s node tools.local/cinematic/render_frames.mjs --root . --port 39920 --quality final --range 0:1440 --workers 1 --taskset "$RENDER_CPUS" --out out/final
timeout 7200s node tools.local/render-resume-guard.mjs --frames out/final --command out/render-argv.json --minutes 3 --expected 1440
timeout 1800s node tools.local/cinematic/encode.mjs --frames out/final --audio assets/audio/music.wav --crf 14 --threads 2 --out out/master.mp4
timeout 1800s node tools.local/cinematic/encode.mjs --frames out/final --audio assets/audio/music.wav --crf 19 --maxrate 16M --bufsize 20M --threads 2 --out out/share.mp4
timeout 1800s node tools.local/cinematic/qa.mjs out/master.mp4 --out out/qa-master --frames 1440
timeout 1800s node tools.local/cinematic/qa.mjs out/share.mp4 --out out/qa-share --frames 1440
```

渲染和监控是两个终端中的独立命令；监控不在渲染结束后才启动。`render-argv.json` 保存完整渲染命令的 JSON 字符串数组（包含 node、脚本及参数）。记录自己后台启动的 `$!`；停摆用 `kill -INT "$RENDER_PID"`，随后 `wait "$RENDER_PID"`，只操作本次 PID。优先级守卫也记录 PID，按 PID 停止并等待。续渲命令保持全部输出身份字段不变。

- [ ] 完整解码；黑帧/冻结候选逐项说明；音画长度与起点差 ≤ 50 ms。
- [ ] BT.709 矩阵/primaries/transfer、tv range、yuv420p、AAC 48 kHz、faststart。
- [ ] QA 无 FAIL；警告有审核意见；未以补帧隐藏失败。
- [ ] `assets/video/share.mp4` 的 HEAD、GET、Range 与下载哈希一致，404 为生成中。
- [ ] 原始证据只在项目输出，部署/推送授权另行记录。

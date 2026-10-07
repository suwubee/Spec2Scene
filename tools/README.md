# 通用工具

全部为参数化重写工具，无历史作品内容。Node.js ≥20，`npm ci` 安装固定 Playwright/sharp；`npx playwright install chromium` 安装浏览器。运行时可用 SCENE_CHROMIUM 指定已有浏览器路径。浏览器工具不放宽自动播放策略，默认单浏览器或单 worker；所有输出自行指定到项目/out 或临时目录。

| 工具 | 用法摘要 | 依赖 / 验证 |
|---|---|---|
| serve.mjs | `--root DIR --port 39920`；回环、MIME、HEAD、Range、开发 no-cache | Node；npm test 覆盖区间、越界、符号链接与 MIME |
| render-frames.mjs | `--url URL --out DIR --identity HASH --fps 24 --count 48` | Playwright/sharp；新浏览器逆序复渲比对；--resume 仅相同 identity/配置/浏览器 |
| encode.sh / encode.mjs | `--frames DIR --out FILE.mp4 --fps 24 [--audio FILE]` | FFmpeg；连续编号与 BT.709、音频裁切/补齐 |
| qa.mjs | `--frames DIR [--compare DIR] [--video FILE] --out REPORT.json` | sharp/FFmpeg/ffprobe；黑场、冻结、色阶稀少候选、AV 长度与起点、解码、像素确定性 |
| contact-sheet.mjs | `--dir DIR --out SHEET.png [--labels labels.json]` | sharp；每页最多 80 图，标签 XML 转义 |
| snap.mjs | `--url URL --out DIR --lstar --selectors '#a,#b'` | Playwright/sharp；多视口、CIE L*、可选 ROI、元素重叠/越界 |
| music/analyze_song.py | `--input FILE --bpm-hint 120 --out out/song.json` | librosa/numpy/matplotlib；输出 JSON+SVG，--tempo 使用 rubberband 并重新分析 |
| voice/gen_voice.py | `--script lines.json --voice '<voice-id>' --out out/voice` | edge-tts 或 --engine command；FFmpeg 两遍响度归一与清单 |
| deploy/test-evidence.mjs | `--source SITE --command '["npm","test"]' --out EVIDENCE.json` | 发布树摘要绑定通过测试；证据放源目录外 |
| deploy/deploy-static.sh | `--config CONFIG.json [--activate]` | 默认准备 releases/version，激活前按配置比 MIME/缓存/字节 |
| package/make-release.sh | `--source DIR --out OUTSIDE_SOURCE.tar.gz [--verify-hook EXECUTABLE]` | tar；排除、包内外 SHA-256、解压验证，钩子失败不出包 |
| pose/ | [独立说明](pose/README.md)：本地加载、滤波、视频评测、精确补丁和 SimPose 接口 | 模型另行下载到项目，无内置数据 |

每个可执行入口均有 `--help`；浏览器库和纯函数通过各工具入口及 npm test 验证。--identity 必须由项目提供源码与输入摘要，工具不能自动发现页面全部外部输入；固定机器/GPU 后端，跨 GPU 的像素一致性不作保证。帧 QA 的色带是低色阶启发式，冻结以完全相同像素计算，编码视频另使用 FFmpeg freezedetect；有意静帧/黑场与真实色带需人工复核，--strict 将候选警告视为失败。音画长度检查不等于语义上的节拍同步。

截图 `--viewports 1920x1080,1366x768,390x844`；`--roi x,y,w,h` 裁剪亮度测量；`--time SECONDS` 调用 seek；selector 是明确保护区，嵌套容器不应同时选入。先规定 ROI 与门槛，再看数据，不能只凭整屏均值判断视觉质量。

Python 环境：

```bash
python3 -m venv .venv
.venv/bin/pip install -r tools/music/requirements.txt -r tools/voice/requirements.txt
.venv/bin/python tools/music/analyze_song.py --selftest
.venv/bin/python tools/voice/gen_voice.py --selftest
```

音乐网格是固定 BPM 附近的拟合；变拍/自由速度需人工标注或项目扩展。小节相位与语义段落是候选，谱图窗口有延迟；报告残差，分析实际发布音频，变速后重分析。语音 JSON 为 `[{"id":"start","text":"开始","category":"guide"}]`，用户自行填写台本与许可；商业发行核对声音/服务条款。替代引擎 `--engine command --command '["<executable>","{text}","{output}"]'` 用参数数组执行，不经过 shell。

部署示例配置见 deploy/config.example.json。构建输出用相对资源 URL，整个运行树放版本目录，根 index 是无缓存跳转入口；它避免重写 JS 内动态路径。准备版本也要求通过测试证据；--activate 前候选目录应已由现有服务器提供，工具按 smoke 校验再替换入口。旧版本保留，回滚复制 previous-index.html 回 index.html 并复验；高并发生产流程应接入项目自己的发布系统。配置路径相对当前工作目录。工具不安装代理规则、不管理进程/证书、不推送。

打包默认排除媒体/模型，`--include-media` 仅适用于自己确认许可的项目资源；受限测试目录仍排除。需要更严格白名单时先构建 staging，再对它打包。验证钩子接收解压目录参数，不依赖当前源码目录。

验证：`npm test` 覆盖通用 JS 的正常与失败路径；`npm run test:browser` 验证三项目页面、模型、渲染→编码→QA→联系表→截图、解压和部署本地冒烟。无真实授权数据的额外回归明确 SKIP，不将合成输入宣称为真人结果。

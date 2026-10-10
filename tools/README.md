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
| music/analyze_song.py | `--input FILE --bpm-hint 120 --out out/song.json` | librosa/numpy/matplotlib；输出 JSON+PNG，--tempo 使用 rubberband 并重新分析 |
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

## v0.2 三维电影与音乐证据

- `music/understand.py --input FILE --out JSON [--line-count N]`：本地人声活动候选、频段进出、重复段、主导音高、可手调行时间及 PNG；可接本地人声轨/本地分离器，不自动下载模型。详见 music/README.md。
- `check-anatomy.mjs [--out JSON]`：所有程序角色动作的固定铰链方向、关节范围、骨长、接触、滑步与手端检查。必须与转台/动作序列一起审核。
- `review-gates.mjs --record JSON --gate G1|G2|G3`：检查当前版本的独立审核记录，拒绝自审或缺前关；不代签结论。
- `hygiene.mjs [--patterns EXTERNAL_FILE]`：扫描 tracked 和未忽略文件、私有路径、媒体/模型扩展及固定哈希运行时；禁词表由任务在仓库外提供。
- `scripts/validate-cinematic.mjs --out IGNORED_DIR`：生成临时三维样片，Playwright 截图、八向转台、全动作与三段连续序列、像素复渲、软件后端性能；自动清理自己的项目和服务 PID，保留证据。

离线帧工具在页面支持 resize(w,h) 时按请求尺寸设置实际画布。软件后端可设置 `SCENE_SOFTWARE_GL=1`，渲染 manifest 记录该选项；浏览器自动播放策略保持默认。裸 canvas 捕获不含 DOM 字幕，带字幕输出须显式合成叠加层。

`render-final.mjs --review REVIEW_JSON --identity REVISION --url URL --out DIR` 是音乐视频正式渲染入口：要求同版本独立 G1–G3 PASS 并逐个确认审核证据存在，再进入单 worker 渲染。生成项目提供 `npm run render:final -- ...`；预览仍使用 render-frames.mjs，不应把预览冒充已获独立批准的 final。

## v0.3 完整电影工具

音乐视频使用 [cinematic/README.md](cinematic/README.md) 的移植离线工具，含半分辨率预览片段、严格身份续渲、BT.709 编码、像素确定性、叠化校验、字体子集化与 PID 优先级让路。原通用工具仍用于其他产线。

## v0.4 执行与回归

`tools/watchdog.mjs --help`：源码 60 分钟无变化后，按自有 PID 结束、等待退出、通过检查点重启，重启次数有上限。`scripts/validate-v04.mjs <临时输出>` 直接验证通用构件、字幕和正侧动作，保留失败图。`scripts/validate-projects.mjs --isolated --offline` 用临时仓库生成三产线夹具并显式 SKIP 模型推理，避免下载及修改当前 projects。

## v0.4.1 播放验收

`timeout 360s npm run test:playback -- /tmp/scene-player-evidence` 在临时仓库通过生成器创建样片，使用默认自动播放策略、未静音 Chromium，测按钮与解码波形起点、20 秒音频推进、真实帧率、自动画质、慢网和弱机；同时验证显式截图模式与逆序像素一致。该回归已接入 npm test 和三产线浏览器验收。当前 projects 不写入，原始 JSON 与截图保留在指定临时目录；Windows/D3D11、真人听审和独立审美另行验收。详见[播放层](../tracks/music-video/player/README.md)。

## 音乐视频闪烁检查

生成项目运行服务后：

```bash
timeout 600s npm run check:flicker -- --timeout 540000 --out out/flicker-r01
```

仓库工具：`node tools/flicker-check.mjs --url http://127.0.0.1:39920 --out <临时证据目录> [--start 0 --end 60 --width 640 --height 360]`。只接收回环 39920–39929，不启动其他服务。场景需 `window.__scene={ready,canvas,seek,renderRealtime,hardCuts,duration}`；starter 已接入。`renderRealtime` 使用与默认播放器相同的 cutSafe 策略，离线 seek 不改时间。每条路径从新页面开始。

按 24 Hz 与 60 Hz 时间网格顺序采样，硬切附加 ±1/±4.5/±25 ms。64×36 RGB 相邻平均差检测 spike/step，16×9 个 4×4 像素块检测局部 spike。默认全局阈值 12、局部阈值 28（0–255），相邻/跨帧差比 3；可用 `--global-threshold`、`--local-threshold`、`--ratio` 调整并随报告保存。不是实时 60 fps 性能测量。

输出 `rows.json`、`flags.txt`、全部缩略图与候选邻帧/概览联系表（每页 ≤12 图、960 px 宽，最多 60 页；超出帧数写入 omittedContactFrames，全部缩略图与 flags 仍保留）。单进程顺序绘制，默认最多 30000 样本、最长 300000 ms；`--max-samples` 上限 60000，超预算提前拒绝，禁止覆盖已有轮次。长片按区间分批；软件后端可增加明确超时。原始图像只留项目 out/ 或临时目录。工具 COMPLETE 表示扫描完成，spike/step 候选含正常硬切；审核者须逐帧解释并记录结论。超时/页面错误保留失败 rows/flags，发布前重新检测。

## 渲染停摆与成片交付（v0.6）

`timeout 7200s node tools/render-resume-guard.mjs --frames <帧目录> --command <命令数组.json> --minutes 3 --poll-seconds 5` 监控原子完成的 `frame-000000.png` / `f00000.png|jpg`，忽略临时文件、空文件、目录和符号链接。命令文件是原渲染命令 JSON 字符串数组。停摆返回 2 并打印安全引用的 `--resume` 与减半 worker（最少 1）；不执行命令、不发信号。收到 INT/TERM 退出 130。`--expected` 达到文件计数仅结束监控，不能代替 manifest/解码完整性检查。

仅对自己的光栅 GPU 进程使用 `timeout 7200s python3 tools/cinematic/ops/prio_guard.py <渲染PID> --heavy 19`；收帧与写盘优先级保持。自检 `timeout 30s python3 tools/cinematic/ops/prio_guard.py --selftest` 不改变优先级。逐版编码/QA/下载命令见 [EXPORT](../templates/EXPORT-music-video.md)，卫生工具 `--patterns` 使用仓库外禁词正则表，检查文件名与内容；严禁把禁词表本身带入仓库。

# Spec2Scene

**From spec to scene — an AI-agent playbook for music videos, 3D simulations and motion games.**

[English](README.md) · [方法总览](playbook/00-overview.md) · [工具说明](tools/README.md) · [更新记录](CHANGELOG.md)（当前 0.9.0，倒序）

这是一套让 AI 编码智能体按规格产出作品的仓库基准：方法、模板、工具、三条产线和智能体适配。导演明确目标，编码智能体实现，审核者亲自复跑测试、查看真实数据和截图。仓库本身只包含通用流程与起步代码，不含具体作品、素材、模型或数据集。

## 五分钟上手

准备 Node.js ≥20、npm、Python 3；浏览器验收需要 Playwright Chromium，视频工具需要 FFmpeg/ffprobe。

```bash
npm ci
npx playwright install chromium
scripts/doctor.sh
scripts/new-project.sh music-video my-scene
node tools/serve.mjs --root projects/my-scene --port 39920
```

打开 `http://127.0.0.1:39920`，点击播放即可试听程序合成配乐并观看本地 three.js 驱动的 60 秒三维样片：雪夜旷野的升起长镜头，以及雨夜站台的剪辑与拉焦。主画面使用 three.js 三维；SVG/Canvas 可用于叠加层与排版。前台服务用 Ctrl+C 结束；后台服务记录 PID，只停止自己的进程。另两条产线：

```bash
scripts/new-project.sh 3d-simulation my-world
scripts/new-project.sh motion-games my-motion
```

每个项目独占 `projects/<name>/`，包含 SPEC、AGENTS、CLAUDE、素材说明、源码、测试、文档、必要通用工具副本及带 `test` 的 package.json。整个项目输出被忽略；若需要版本管理，可在其中单独 `git init`。复制到其他机器后在项目内 `npm install`，工具仍可独立运行。

体感起步页提供明确标记的合成骨架演示及真实摄像头入口。使用 `scripts/fetch-models.sh --project projects/my-motion --kind pose` 安装本地模型后，摄像头关键点在本机计算并绘制；不将模拟结果冒充真人识别。三维起步页提供程序化透视线框与来源视图，需导入获授权的真实数据才能成为真实场景。

## 工作顺序

1. 填写项目 `SPEC.md`：用户原话、范围、限制、接口、性能预算、可量化验收。
2. 按 [Codex 提示词](templates/codex-prompt.md) 或 [Claude 提示词](templates/claude-prompt.md) 派发明确文件归属的任务。
3. 审核者用 [REVIEW](templates/REVIEW.md) 复跑测试、看联系表、多视角与序列，记录问题、根因和复验命令。
4. 合并后重新测试，记录待发布版本与证据。部署是独立动作；线上复验 MIME、缓存头、字节一致及真实浏览器流程。

## 导航

| 位置 | 内容 |
|---|---|
| [playbook](playbook/00-overview.md) | 角色、规格、审核、测量、并行、测试、发布、打包、隐私及共享服务器；[深做制作法](playbook/11-deep-production.md) |
| [经验索引](playbook/lessons/README.md) | 每条经验均有“现象→根因→修复→预防”；[覆盖对照](validation/coverage.md) |
| [templates](templates/SPEC.md) | SPEC / REVIEW / REPORT / RELEASE / HOTFIX / UI 清单 / 任务提示词 |
| [音乐视频](tracks/music-video/README.md) | 解析→分镜→世界曲线→确定性渲染→编码质检 |
| [三维模拟](tracks/3d-simulation/README.md) | 真实数据→可信度→程序几何→漫游→手机降级→静态发布 |
| [体感游戏](tracks/motion-games/README.md) | 本地模型→输入与判定→免手与声音→真实回归→配对与缓存 |
| [agents](agents/README.md) | Claude Code 技能、Codex 片段与派发脚本、提供方中断续跑 |
| [tools](tools/README.md) | 所有工具用法、依赖、限制与自检 |
| [projects](projects/README.md) | 每个新项目独立输出目录 |
| [validation](validation/README.md) | 基准验收与证据 |

执行 `npm test`、`npm run test:browser -- --isolated --offline`（不写当前 projects、不下载模型）或常规 `npm run test:browser` 及工具文档列出的 Python `--selftest`。浏览器验收自动生成三条产线的演示项目，使用 39920–39939 的本地端口，验证后按自己的 PID 关闭并清理。受限数据缺失明确 SKIP，不能将合成测试结果写成真实识别准确率。

## 音乐视频要点

本节只描述当前做法；每一版改了什么见 [更新记录](CHANGELOG.md)。

**意境先于歌词。** 先写[意境书](tracks/music-video/directing/01-mood-first.md)与[意象转译表](tracks/music-video/directing/01b-imagery-translation.md)：例如让脚印承接月光，用大景小人和留白烘托孤独。歌词是情绪证据，不能直接变成逐句图解的镜头清单。每镜至少前/中/后三层空间，半浮点 HDR 与色调映射、有动机的灯光、雾或体积光、焦距/光圈/对焦距离驱动的景深，以及镜头表驱动的运动与转场。详见 [05-quality-bar](tracks/music-video/directing/05-quality-bar.md)。

**独立关卡。** G1 意境/分镜/样张 → G1b 新引擎重渲 → G2G3 全曲/表演/字幕 → FINAL 最终复验，均由独立审核人完成，前关未通过不得推进，自审不算审核。模板见[导演稿](templates/CONCEPT-music-video.md)与[送审](templates/GATE-music-video.md)。

**新世界与深做。** 每部新 MV 按[区分度规则](playbook/12-distinct-worlds.md)建立自己的世界观和禁用清单，只复用底层引擎与改型改色的通用构件；按[深做制作法](playbook/11-deep-production.md)每个场景一个负责人分阶段推进，按[成片交付](playbook/13-film-delivery.md)完成集成、续渲、编码 QA 与下载。

**画面关卡。** 每轮代表帧先过不依赖任何模型的 [picture-qa](tools/picture-qa/README.md)（条纹、外缘光晕、平涂、亮度分布、积云团、暖色占比、修复对比）；修复声明必须附 `--compare --claim`，豁免必须有依据，配置变宽会报警。分工见[画面关卡与模型分工](playbook/14-picture-gate.md)。难件与场景按[迭代协议](playbook/15-iteration-protocol.md)推进：一轮一会话、每轮附导演审过的联系表、观感指标成对上下限并写明测量口径、每件最多三轮后降级冻结。

**引擎与构件。** [三维电影引擎](tracks/music-video/engine/README.md)、[参数化构件](tracks/music-video/kits/README.md)（远山与建筑体块、雪/冰/夯土材质、天体相位、云海与水面等）、[人物](tracks/music-video/character/README.md)、[歌词对齐](tools/music/lyrics/README.md)与[离线预览与复验工具](tools/cinematic/README.md)。`npm run test:cinematic` 在生成项目的 out/ 写入关键帧、联系表、连续序列和性能证据。

**实时播放。** [默认播放器](tracks/music-video/realtime/README.md)：点击同步解锁音频 → 先显示起点第一帧 → 在画面上显示预热百分比与剩余时间 → 音频驱动画面，场景与引擎常驻、播放中零新着色器程序。载入页不能只有文字，点击到第一帧和预热总时长都要测量并对照预算。截图用 `?mode=capture` 或 `?quality=final`（固定高画质、确定性 seek、无音频）。原[分层播放器](tracks/music-video/player/README.md)为实验性，默认不用。`npm run check:flicker` 检查硬切与闪烁，`timeout 960s npm run test:playback -- <临时证据目录>` 跑严格自动播放与慢网回归。

**验证边界。** 软件后端截图与回归不等于目标 GPU 性能、独立审美、真人听审或生产验收；各轮实测记录在 [validation](validation/README.md)。

## 许可与责任

本仓库原创内容采用 [Apache-2.0](LICENSE)，版权为 suwubee 与贡献者。未随仓库分发第三方创作素材；第三方依赖保留各自许可，模型下载记录许可来源，使用前仍须核验。用户对上传、导入、下载、生成内容及第三方服务的授权负责；输出需人工审核，体感活动不构成医疗或专业健身建议，摄像头默认本地处理。完整说明见 [中英免责声明](DISCLAIMER.md)、[隐私与许可](playbook/09-privacy-and-licensing.md)。

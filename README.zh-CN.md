# Spec2Scene

**From spec to scene — an AI-agent playbook for music videos, 3D simulations and motion games.**

[English](README.md) · [方法总览](playbook/00-overview.md) · [工具说明](tools/README.md)

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

打开 `http://127.0.0.1:39920`，即可看到本地 three.js 驱动的 60 秒三维样片：雪夜旷野的升起长镜头，以及雨夜站台的剪辑与拉焦。主画面使用 three.js 三维；SVG/Canvas 可用于叠加层与排版。前台服务用 Ctrl+C 结束；后台服务记录 PID，只停止自己的进程。另两条产线：

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
| [playbook](playbook/00-overview.md) | 角色、规格、审核、测量、并行、测试、发布、打包、隐私及共享服务器 |
| [经验索引](playbook/lessons/README.md) | 每条经验均有“现象→根因→修复→预防”；[覆盖对照](validation/coverage.md) |
| [templates](templates/SPEC.md) | SPEC / REVIEW / REPORT / RELEASE / HOTFIX / UI 清单 / 任务提示词 |
| [音乐视频](tracks/music-video/README.md) | 解析→分镜→世界曲线→确定性渲染→编码质检 |
| [三维模拟](tracks/3d-simulation/README.md) | 真实数据→可信度→程序几何→漫游→手机降级→静态发布 |
| [体感游戏](tracks/motion-games/README.md) | 本地模型→输入与判定→免手与声音→真实回归→配对与缓存 |
| [agents](agents/codex/README.md) | Claude Code 技能、Codex 片段与派发脚本 |
| [tools](tools/README.md) | 所有工具用法、依赖、限制与自检 |
| [projects](projects/README.md) | 每个新项目独立输出目录 |
| [validation](validation/README.md) | 基准验收与证据 |

执行 `npm test`、`npm run test:browser` 及工具文档列出的 Python `--selftest`。浏览器验收自动生成三条产线的演示项目，使用 39920–39939 的本地端口，验证后按自己的 PID 关闭并清理。受限数据缺失明确 SKIP，不能将合成测试结果写成真实识别准确率。

## 效果门槛（v0.3）

先写[意境书](tracks/music-video/directing/01-mood-first.md)与[意象转译表](tracks/music-video/directing/01b-imagery-translation.md)：例如让脚印承接月光，用大景小人和留白烘托孤独。歌词是情绪证据，不能直接变成逐句图解的镜头清单。

每镜至少前/中/后三层空间，半浮点 HDR 与色调映射、有动机的灯光、雾或体积光、焦距/光圈/对焦距离驱动的景深，以及镜头表驱动的运动与转场。默认角色使用写实比例，肘膝限位和人体结构检查进入 npm test。详细标准见 [05-quality-bar](tracks/music-video/directing/05-quality-bar.md)。

G1 意境与分镜、G2 角色与表演、G3 成片预览均由独立审核人完成，前关未通过不得推进，自审不算审核。v0.3 整体移植成熟引擎并提供 [参数化工具包](tracks/music-video/kits/README.md)、[离线预览与复验工具](tools/cinematic/README.md)。执行 `npm run test:cinematic` 生成 1920×1080 关键帧、大图联系表、升起/叠化/雨连续序列、工具包截图和性能证据，保存到生成项目的 out/。角色独立验收不由本引擎脚本代签；历史基线见 [v0.2 报告](validation/v0.2/README.md)。软件后端截图不等于真机性能或独立审美通过。

## 许可与责任

本仓库原创内容采用 [Apache-2.0](LICENSE)，版权为 suwubee 与贡献者。未随仓库分发第三方创作素材；第三方依赖保留各自许可，模型下载记录许可来源，使用前仍须核验。用户对上传、导入、下载、生成内容及第三方服务的授权负责；输出需人工审核，体感活动不构成医疗或专业健身建议，摄像头默认本地处理。完整说明见 [中英免责声明](DISCLAIMER.md)、[隐私与许可](playbook/09-privacy-and-licensing.md)。

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
| [agents](agents/codex/README.md) | Claude Code 技能、Codex 片段与派发脚本 |
| [tools](tools/README.md) | 所有工具用法、依赖、限制与自检 |
| [projects](projects/README.md) | 每个新项目独立输出目录 |
| [validation](validation/README.md) | 基准验收与证据 |

执行 `npm test`、`npm run test:browser -- --isolated --offline`（不写当前 projects、不下载模型）或常规 `npm run test:browser` 及工具文档列出的 Python `--selftest`。浏览器验收自动生成三条产线的演示项目，使用 39920–39939 的本地端口，验证后按自己的 PID 关闭并清理。受限数据缺失明确 SKIP，不能将合成测试结果写成真实识别准确率。

## 效果门槛（v0.4）

先写[意境书](tracks/music-video/directing/01-mood-first.md)与[意象转译表](tracks/music-video/directing/01b-imagery-translation.md)：例如让脚印承接月光，用大景小人和留白烘托孤独。歌词是情绪证据，不能直接变成逐句图解的镜头清单。

每镜至少前/中/后三层空间，半浮点 HDR 与色调映射、有动机的灯光、雾或体积光、焦距/光圈/对焦距离驱动的景深，以及镜头表驱动的运动与转场。默认角色使用写实比例，肘膝限位和人体结构检查进入 npm test。详细标准见 [05-quality-bar](tracks/music-video/directing/05-quality-bar.md)。

G1 意境/分镜/样张、G1b 新引擎重渲、G2G3 全曲/表演/字幕、FINAL 最终复验均由独立审核人完成，前关未通过不得推进，自审不算审核。v0.3 整体移植成熟引擎并提供 [参数化工具包](tracks/music-video/kits/README.md)、[离线预览与复验工具](tools/cinematic/README.md)。执行 `npm run test:cinematic` 生成 1920×1080 关键帧、大图联系表、升起/叠化/雨连续序列、工具包截图和性能证据，保存到生成项目的 out/。角色独立验收不由本引擎脚本代签；历史基线见 [v0.2 报告](validation/v0.2/README.md)。软件后端截图不等于真机性能或独立审美通过。

## v0.3.1 通用增补

[歌词对齐管线](tools/music/lyrics/README.md)提供本地 Demucs/pYIN、逐字 DP、人工校正、锁定字幕与合成歌误差自测；[场景反馈工具](tracks/music-video/kits/feedback.md)提供曲线鞋印、连续地形、公寓近物、玻璃倒影及可见性统计。完整复验可设置 `SCENE_PYTHON` 指向已安装音乐依赖的 Python；缺少依赖会显式 SKIP 音频自测。

## v0.4.0 能力与验证边界

| 能力 | 已实现与实测范围 | 仍未验证或不足 |
|---|---|---|
| 天空与气氛 | 逐帧月相、低月珍珠白中和、光线步进云海自阴影/银边、外部地形谷雾；软件浏览器同帧/逆序检查 | 云内复杂物体交界、目标 GPU 性能 |
| 场景构件 | 盆/缸/水洼场景反射、长焦远山细分、室内月光反弹/漫射、细分岩石与程序材质 | GI、波面动力学、超近景石材、城市语义 LOD |
| 镜头与后期 | 分镜曝光/白平衡覆盖全局，逐镜曲线、FX 光柱状态刷新 | 真机实时全曲音画同步预算 |
| 角色 | 动作交叉混合、加性抬头/转头/低头、坐姿膝上手位、抱膝、发髻高光；人体采样与多视角连续序列 | 中景脸/手/衣料真实感、任意坡面 IK、完整布料/接触碰撞 |
| 歌词与排版 | 人声留存、静音乐句/段落保序/比例行窗、±0.3 秒起点与审核批准、人物包围盒避让 | 真实歌曲识别精度、真人听审；比例边界始终是估计 |
| 流程 | 导演稿及虚构示例、四道独立关卡、命令超时、上下文检查点、60 分钟停滞看门狗 | 自动检查不代签审美、真人表演或生产验收 |

接口见 [v0.4 构件](tracks/music-video/kits/v04.md)、[导演稿](templates/CONCEPT-music-video.md)、[版本记录](CHANGELOG.md)及[本轮验收](validation/v0.4/README.md)。`npm run test:v04 -- <临时证据目录>` 直接测试仓库通用构件；图像和原始日志只留临时输出。目标 GPU、真人听审、真实模型推理与生产环境无本轮通过声明。保留 `wip/v021-partial` 参考分支，不自动推送。

## v0.5 默认实时播放

[默认播放器](tracks/music-video/realtime/README.md)采用点击 → 逐镜代表帧真实渲染预热 → 音频驱动画面，场景与引擎常驻。点击手势中同步 play()+pause() 解锁；只在媒体 error 换源，无超时判失败；慢网先用墙钟并提示载入中，音频就绪后对齐接管；阻止声音和失败均可点击恢复。原 [tracks/music-video/player](tracks/music-video/player/README.md) 保留为**实验性，默认不用**，通过 experimental.html 或 ?player=experimental 选择。截图仍显式 ?mode=capture 或 ?quality=final，固定高画质、确定性 seek，无音频。

`timeout 960s npm run test:playback -- <临时证据目录>` 测默认策略与严格用户激活、去 webdriver 特征、音频延迟 5 秒/25 秒、最终解码信号和同步。生成项目新增 `npm run check:flicker`：24 Hz seek 与 60 Hz 实时策略双路、硬切 ±1/4.5/25 ms、64×36 全局 spike/step 和 16×9 局部 spike，输出 rows.json、flags.txt、联系表。60 Hz 是时间采样密度，不是实际显示帧率声明；候选需逐帧审核。

每部新 MV 按[区分度规则](playbook/12-distinct-worlds.md)建立自己的世界观和禁用清单；SET-brief 写差异说明与自查，AD 评审 1 首项查禁用清单。只复用底层引擎与改型改色的通用构件。经验见[同机对比、稳定技术栈与七类闪烁](playbook/lessons/v05-playback-and-flicker.md)，实测与边界见[v0.5 验证](validation/v0.5/README.md)。库回归不代签独立审美、真人听审、目标 GPU 或生产验收。

## 许可与责任

本仓库原创内容采用 [Apache-2.0](LICENSE)，版权为 suwubee 与贡献者。未随仓库分发第三方创作素材；第三方依赖保留各自许可，模型下载记录许可来源，使用前仍须核验。用户对上传、导入、下载、生成内容及第三方服务的授权负责；输出需人工审核，体感活动不构成医疗或专业健身建议，摄像头默认本地处理。完整说明见 [中英免责声明](DISCLAIMER.md)、[隐私与许可](playbook/09-privacy-and-licensing.md)。

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

打开 `http://127.0.0.1:39920`，即可看到时间可定位的程序化画面。前台服务用 Ctrl+C 结束；后台服务记录 PID，只停止自己的进程。另两条产线：

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

## 许可与责任

本仓库原创内容采用 [Apache-2.0](LICENSE)，版权为 suwubee 与贡献者。未随仓库分发第三方创作素材；第三方依赖保留各自许可，模型下载记录许可来源，使用前仍须核验。用户对上传、导入、下载、生成内容及第三方服务的授权负责；输出需人工审核，体感活动不构成医疗或专业健身建议，摄像头默认本地处理。完整说明见 [中英免责声明](DISCLAIMER.md)、[隐私与许可](playbook/09-privacy-and-licensing.md)。

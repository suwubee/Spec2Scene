---
name: music-video
description: 从获授权音频制作程序化音乐视频；适用于音乐解析、分镜、时间函数画面、逐帧渲染和 QA。
---

# music-video

在 Spec2Scene 仓库根目录工作，以下路径均相对仓库根。若技能复制到本地技能目录，仍以当前仓库为准，先确认项目 AGENTS 与用户限制。

读 tracks/music-video/README.md、SPEC.md、QA.md、lessons.md。先明确素材、转录、署名与交付限制，解析音乐后先写意境书和意象转译表，再写分镜与共享世界曲线。主画面使用 three.js 三维；SVG/Canvas 可用于叠加层与排版。读 tracks/music-video/directing/ 的导演方法，使用 engine/ 与 character/ 通用库，禁止逐句图解。seek(t) 确定性、预览审片、冻结字幕后一次 final；固定后端，渲染→编码→QA，并复渲比原始像素。

通用工具用 tools/README.md 及各入口 --help。只迁移通用经验，禁止复制历史作品、人物、地址、素材和原报告。共享服务器遵守 playbook/10-shared-server-safety.md；项目产物在 projects/，不自动推送。只有任务明确授权才并行派发、部署或发送外部消息。

入口参考：[总览](../../../../playbook/00-overview.md)、[工具](../../../../tools/README.md)。

画面关卡：每轮看图目录先跑 `npm run qa:picture`（tools/picture-qa，纯像素、不依赖模型）全部 PASS 再送审；任何“已修复”必须附 `--compare <上一轮> --claim <检查项>`；人物用 character 组件（走位用 walkPath，距离含 speed）、雪/冰/夯土用 kits/materials、远山/地平线与房屋城墙残台船等体块用 kits/far，不另写同类实现。豁免只依据设计内纹理/真实光源/真实非天空区域并写 exempt + _why，配置变宽用 --check-config --baseline 报警；共享天空用 scopeSharedSky 按场景隔离；片名署名只来自项目 credits 显式字段。见 playbook/14-picture-gate.md。

设计深度与引擎能力：SET 组件表（件 | 尺寸 | 材质(色值) | 程序做法 | L1 | L2 | L3 | 来源）、NEW-HARD 八项配方与逐镜物料清单由设计者写满，派发前 `npm run qa:brief` PASS，实现者只写回填段；引擎已有能力（相机手持/呼吸、天空、雾、水、粒子、后期、署名）只调用不重写，见 engine/README.md“已有功能清单”，每轮 `npm run qa:reimplement`，有相机运动时 `npm run qa:camera`。英雄镜头审核附标杆帧并排对照；用户否决已通过的内容时先写审核误判记录（playbook/03-review.md）。

迭代协议（playbook/15-iteration-protocol.md）：难件与检查台一轮一会话、每件最多 3 轮后按 ⑧ 降级冻结；每轮派发附导演审过的上一轮联系表，联系表交付前自检非空；观感指标成对上下限 + 测量口径（`--mask/--exclude/--erode`、`surface`、人物 `--silhouette`）；引擎缺陷报告先由另一会话复现，真问题以可选开关、默认不变落地；检查台 URL 参数不与引擎参数同名；结束前按 PID 清理并汇报。迭代日志用 templates/ITERATION-LOG.md。场景阶段英雄先行：英雄可见件全部检查台冻结（分镜机位 + 整件全形视角），英雄基准帧每轮回归，夜景逐镜写剪影或受光读法，拒绝捷径，场景区分度并排，冻结件在本场景光照下复验、修复做场景帧回归，确定性跨进程乱序测；`qa:camera` 含万向节检查，联系表过 `qa:sheet`；会话中途不调读图工具；导演按明确路径提交；提供方中断用 agents/run-with-resume.sh 续跑。

强制 G1 意境分镜、G2 人体与表演、G3 成片预览。每关产出证据后停下，等待独立审核 PASS；实现者自审不算。使用 templates/REVIEW-music-video.md。编排者仅按已获授权安排独立会话或人类审核，不推定并行权限。

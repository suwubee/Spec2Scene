---
name: spec2scene
description: 按规格组织音乐视频、三维模拟和体感游戏的实现与审核；用于新项目建立或跨产线流程，不用于无关普通代码编辑。
---

# spec2scene

在 Spec2Scene 仓库根目录工作，以下路径均相对仓库根。若技能复制到本地技能目录，仍以当前仓库为准，先确认项目 AGENTS 与用户限制。

先读 playbook/00-overview.md 与 AGENTS.md。确定产线，用 scripts/new-project.sh 生成独立项目，填写 SPEC 的用户原话、硬约束、文件归属和验收。导演/实现/审核按 playbook/01-roles.md 分工，审核独立复跑。按变更需要读测量、测试、发布和隐私页；部署依已有授权单独执行。

通用工具用 tools/README.md 及各入口 --help。只迁移通用经验，禁止复制历史作品、人物、地址、素材和原报告。共享服务器遵守 playbook/10-shared-server-safety.md；项目产物在 projects/，不自动推送。只有任务明确授权才并行派发、部署或发送外部消息。

入口参考：[总览](../../../../playbook/00-overview.md)、[工具](../../../../tools/README.md)。

# Codex 适配

根 AGENTS.md 定义共同规则；AGENTS.fragment.md 可并入用户项目已有说明，保留原约束。任务使用 templates/codex-prompt.md，输入完整 SPEC/本轮 REVIEW 与可写目录。

`dispatch.sh PROJECT PROMPT_FILE LOG_DIR [CONTACT_SHEET.png ...]` 以 stdin 传入提示词，可选把导演审过的上一轮联系表以 `--image` 附上（文件缺失或为空即退出 2），用显式 workspace-write 沙箱运行 `codex exec`，后台保存 PID 并等待；它只是一份派发示例，不被生成器或测试自动调用。调用者先确认目标目录与任务授权，不扩大已有权限。不使用跳过安全机制的参数，不把密钥放提示词或日志。

迭代派发按 [迭代协议](../../playbook/15-iteration-protocol.md)：一轮一会话，每轮附上一轮联系表，审片后再派下一轮；并行会话数按额度窗口规划，被切断的会话从 LOG/CHECKPOINT 断点续跑。部分命令行会话在会话内读不到图，提示里要求先复述附件中的问题，读不到时明说并改用数值剖面。

CLI 用法核对来源：[官方非交互说明](https://developers.openai.com/codex/noninteractive)。不同版本以安装的 `codex exec --help` 为准，模型选择遵循用户配置，不强制某个版本。此脚本用于有相应 CLI 的本地环境，基准验收仅检查语法与帮助，不实际启动额外智能体。

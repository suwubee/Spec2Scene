# Codex 适配

根 AGENTS.md 定义共同规则；AGENTS.fragment.md 可并入用户项目已有说明，保留原约束。任务使用 templates/codex-prompt.md，输入完整 SPEC/本轮 REVIEW 与可写目录。

`dispatch.sh PROJECT PROMPT_FILE LOG_DIR` 以 stdin 传入提示词，用显式 workspace-write 沙箱运行 `codex exec`，后台保存 PID 并等待；它只是一份派发示例，不被生成器或测试自动调用。调用者先确认目标目录与任务授权，不扩大已有权限。不使用跳过安全机制的参数，不把密钥放提示词或日志。

CLI 用法核对来源：[官方非交互说明](https://developers.openai.com/codex/noninteractive)。不同版本以安装的 `codex exec --help` 为准，模型选择遵循用户配置，不强制某个版本。此脚本用于有相应 CLI 的本地环境，基准验收仅检查语法与帮助，不实际启动额外智能体。

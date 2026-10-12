# 智能体适配 / Agents

- [claude-code/skills](claude-code/skills/)：各产线的 Claude Code 技能说明。
- [codex](codex/README.md)：Codex 适配、`AGENTS.fragment.md` 与派发示例 `dispatch.sh`。
- `run-with-resume.sh`：与提供方无关的续跑循环（下文）。

迭代派发的规则见[迭代协议](../playbook/15-iteration-protocol.md)（一轮一会话、附图、额度与续跑）。

## run-with-resume.sh：提供方中断后断点续跑

提供方会中途切断会话：额度窗口用尽、过载（503/502）、重连耗尽。这个包装脚本把一个会话的启动命令包在续跑循环里：

```bash
agents/run-with-resume.sh --prompt docs/tasks/part-r2.md --log-dir out/agents/part-r2 \
  --pattern 'overloaded|\b50[23]\b|usage limit' --retry-after 600 --max-attempts 12 \
  --ports 39931 --probe 'timeout 120 codex exec --sandbox read-only "reply OK" >/dev/null' \
  --watch out/agents/part-r2/session/stderr.log --watch out/agents/part-r2/session/final.md \
  -- agents/codex/dispatch.sh "$PWD" '{prompt_file}' out/agents/part-r2/session
```

- **启动命令**：`--` 之后的命令。每次尝试的提示写到 `LOG_DIR/prompt-N.md`，经 stdin 传入，参数里的 `{prompt_file}` 换成该路径；环境变量 `RESUME_ATTEMPT`、`RESUME_PROMPT_FILE`、`RESUME_LOG_FILE`。输出写 `LOG_DIR/attempt-N.log`，结果记在 `LOG_DIR/attempts.tsv`。
- **识别中断**：`--pattern`（可重复）或 `--patterns-file` 给出提供方临时错误的扩展正则（不区分大小写），只匹配日志最后 `--tail` 行（默认 200）；启动器把输出写进自己的日志时（如 `dispatch.sh` 的 `stderr.log`、`final.md`），用 `--watch FILE` 一并检查（只看本次尝试期间改过的文件），避免任务输出里早先出现的“503”误判。未给时用内置默认（overloaded、502/503/504、rate limit、usage limit、quota、Reconnecting…、temporarily unavailable）。日志尾部出现标记即视为中断，即使启动器退出码为 0。
- **重试**：中断后按 PID 关闭 `--ports` 上遗留的监听进程（不按名字杀，不碰别的端口、本脚本及其父进程），等待 `--retry-after` 秒（默认 600），可选运行 `--probe`（非零 = 提供方仍不可用，本次尝试计为等待），再在原提示前加“断点续跑”说明重启；最多 `--max-attempts` 次（默认 12）。说明要求会话先读自己的 LOG / CHECKPOINT、复述最后完成的一步、从下一步继续，不重做、不回退文件；可用 `--resume-note` 替换。
- **退出码**：0 完成；没有中断标记的非零退出原样返回、不重试（真实任务失败要人看）；75 次数用尽；2 用法错误。
- **规划**：并行会话数按额度窗口规划；一个提供方过载时，不把全部会话同时切到另一个提供方的同一额度窗口。被续跑的轮次在迭代日志标“中断·续跑”并写尝试次数。

测试：`tools/test/run-with-resume.test.mjs` 用假启动器覆盖过载→清理遗留服务→带说明续跑→完成、真实失败不重试、次数用尽、探测失败与只匹配日志尾部。

English: `run-with-resume.sh` wraps any agent CLI. Transient provider errors are recognised from the log tail by regex; between attempts it kills listeners on the session's own ports by PID only, waits, optionally probes, and relaunches with a resume-from-breakpoint note prefixed to the prompt. Real task failures are not retried; exhausted attempts exit 75.

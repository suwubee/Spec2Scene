# 体感游戏工具入口

通用实现统一维护在 [tools](../../../tools/README.md)，生成项目复制到 tools.local/，避免多份不一致脚本。

本地加载：pose/local-loader.mjs；滤波：pose/one-euro.mjs；真实视频：pose/evaluate-video.mjs 与 harness-template.mjs；语音：voice/gen_voice.py；音乐：music/analyze_song.py。模型获取使用仓库 scripts/fetch-models.sh。

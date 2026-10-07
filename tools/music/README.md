# 离线音乐理解证据

在独立 Python 环境安装 requirements.txt。输入只由参数指定，不读取项目目录来寻找音频或歌词。默认不使用在线服务、不下载模型；限制线程，长音频默认最多 600 秒，重复段矩阵聚合到最多 300×300。

```bash
OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 python tools/music/analyze_song.py --input <authorized-audio> --bpm-hint 120 --out <ignored-output>/grid.json
OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 python tools/music/understand.py --input <authorized-audio> --line-count 12 --out <ignored-output>/music.json
python tools/music/analyze_song.py --selftest
python tools/music/understand.py --selftest
```

analyze_song 输出节拍、小节、段落候选、网格漂移与 PNG。understand 输出谱图/能量/音高/自相似 PNG，以及含频段能量和谱通量、频段进出候选、人声活动候选、重复段、主导音高及置信度的 JSON。PNG 供多模态审核人结合聆听查看；频段不是乐器名称，混合音频中的谐波乐器可能被误判成人声，主导音高也不等于多声部旋律转录。

`--line-count` 只按用户给的行数和活动量做半自动对齐，生成 start/end/locked 可手调 JSON；不读取歌词、不转录文字。没有人声候选时写 SKIP，不能编造行时间。最终对齐需听取辅音起点、换气和拖音，逐行校准。

人声分离默认 `--separation off`。可传用户已有 `--vocal-stem`，须与实际播放文件等长。也可配置 `--separation command --model-dir <local-model-directory> --separator-command '<JSON argv>'`，argv 必须包含 `{input}`、`{output}`、`{model}`，调用本地分离器；权重需用户事先在本机下载并确认许可。工具拒绝空模型目录，不使用 shell 拼接，并设置离线环境变量和单线程。外部分离器应预先审查为本地执行；本仓库不附带模型，selftest 不声称真实分离已验证。

JSON 的 `times` 是秒。接入引擎时将 energy 与 vocalActivity 配成 `{times,values}`；将人工确认的 sections 写成 start/end，而不是直接把分析候选标签当情绪段落。实际音乐、模型分离、歌词语义与真人听审在没有授权输入时必须列为 SKIP。

v0.3.1 的逐字对齐入口为 [lyrics/align.py](lyrics/README.md)：混音分析、固定版本 Demucs CPU 分离、pYIN 特征、音节起点与逐字 DP、手工 corrections、每行谱图/音高/字位置图、置信度锁定及 LRC。优先使用此链路；本页 understand 的 equal-activity 行分配仍用于没有歌词的粗略证据。

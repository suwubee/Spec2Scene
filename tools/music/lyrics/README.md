# 本地歌词对齐

`align.py` 接受获授权的音频和逐行文本，执行混音 RMS/频段人声活动、可选 Demucs 分离、pYIN、能量/频谱通量/音色/音高起点候选、活动块分组与逐字 DP。所有内容来自参数；不附带歌曲、歌词、音频、权重或原项目代码。中文按字，英文按元音组估计音节并保留原文本偏移；标点保留在显示文本中，不占演唱单元。

```bash
python3 -m venv .venv
.venv/bin/pip install -r tools/music/lyrics/requirements.txt
# 可选：固定 CPU 运行时，Python 3.10–3.13；无 GPU/CUDA 依赖
.venv/bin/pip install -r tools/music/lyrics/requirements-demucs.txt
scripts/fetch-models.sh --kind demucs --project projects/demo
.venv/bin/python tools/music/lyrics/align.py \
  --input projects/demo/assets/audio.wav --lyrics projects/demo/data/lyrics.txt \
  --model-dir projects/demo/cache/models/demucs --out projects/demo/out/alignment
.venv/bin/python tools/music/lyrics/align.py --selftest
```

下载命令只写现有子项目的 `cache/models/demucs/`，拒绝缓存路径/文件符号链接；下载固定 Demucs 4.0.1 `htdemucs` 官方权重，校验完整 SHA-256，并保存 MIT LICENSE、许可摘要及来源清单。权重/输出不提交；项目自行初始化 Git 后同样忽略 cache。运行对齐工具不会隐式联网下载。CPU 版本为 torch/torchaudio **2.6.0+cpu**；由于该固定官方 checkpoint 包含模型类，只有完整 SHA-256 验证后才允许 Demucs 的类反序列化加载。

`--vocal-stem` 使用已有等长人声，时长差不得超过 50 ms。无权重或可选依赖时自动回退到混音谐波/频段活动估计，输出明确 SKIP 分离原因，置信度封顶 **0.49**，自动锁定阈值最低 0.5。损坏模型直接 FAIL，不将其当作“未安装”。`--separation off` 可显式禁用分离。`--fmin/--fmax` 可调整声域；默认 65–1000 Hz。默认音频预算 600 秒，`--max-seconds` 上限 1800；数值库和 Demucs 单线程、分段 pYIN、最多 500 行/5000 单元、单行最多 128 单元。

歌词可以是 UTF-8 txt（一行一句）或 JSON：

```json
{"lines":[{"text":"甲乙丙丁","start":1.2,"end":4.8},{"text":"la le li lo","start":6.1,"end":9.8}]}
```

示例只是测试标签。可全部省略 start/end，由活动块 DP 分配；如果乐句切分有歧义，优先提供逐行窗口，窗口必须完整、按序、不重叠。工具不是 ASR，不知道唱出的字是否匹配文本；多段合并或不足的活动块降低置信度。乐器漏入、连唱无起音、长拖音、多音节英文和重复句可能需要人工调整。

输出包括：

- `lyrics.align.json`：`duration`、输入/文本哈希、分离状态、算法说明、行/word 的 start/end/confidence，以及行 `locked`、`lockReason`。words 是演唱单元，中文即单字；`offset/length` 是 Unicode 码点计数。
- `analysis.json` / `features.npz`：混音能量、人声活动、pYIN 音高、浊音概率和起点候选，供听审和诊断。
- `alignment_corrections.json`：首次创建，以后重跑保留；输入哈希不同拒绝误套校正。
- 每行一张 `line-ID.png`，含谱图、音高与字位置；`contact-NNN.png` 每页最多 12 行。`--font` 指定项目字体并验证覆盖；未指定时找系统中实际覆盖所需字的字体，没有可用字体会报错，不画缺字方框。
- `lyrics.lrc`：只导出 locked 行，行末插入清空时间戳，避免间奏停留。

默认阈值 0.8。置信度达到阈值自动锁定；低分行必须在校正文件确认。置信度是未校准的声学启发式分数，不能当成字词正确率。校正示例（保留生成文件中的两个 SHA-256）：

```json
{"schema":1,"inputSHA256":"保留生成值","textSHA256":"保留生成值","lines":[
  {"id":"1","start":1.25,"words":[{"index":0,"end":2.1},{"index":1,"start":2.1}],"confirmed":true,"reviewer":"reviewer-id"},
  {"id":"2","confirmed":false}
]}
```

只改 start/end/words 的行会解除原锁定，直到该次校正被确认；确认必须附 reviewer。越界、非有限、重叠、重复 ID 或单元索引直接 FAIL。`--corrections` 可以指定另一份校正文件。修改原歌词/音频应重新生成对应的校正文件，不能沿用旧摘要。

字幕接入：DOM 使用 `subtitleLayer(element, alignment.lines, {fontFamily, direction:'vertical'})`；画布使用 `createLyrics({song:alignment, config:{fontFamily,direction:'horizontal'}})`。电影引擎传 `{lyrics:true, alignment, fonts, timeline}`，其中 timeline.lyricsConfig 控制字号/位置/方向；字体文件由项目提供。两条路径都只显示严格的 `locked:true`，旧数据缺少锁定标记时也不显示。横排/竖排和标点由适配器保留，未提供锁定数据不会生成替代字幕。

合成自测程序生成 12 个谐波“人声”单元与伴奏，已知起点包含非 10 ms 刻度、重复同音高和不同长度。断言平均起点误差 ≤65 ms、最大 ≤120 ms，另外覆盖模型缺失、静音、手工确认/解锁、无效校正和重跑保存。此测试不证明真实歌声或 Demucs 分离质量；真实音频/真人听审缺失应明确 SKIP。`SCENE_PYTHON` 可让 npm test 使用安装了依赖的解释器。

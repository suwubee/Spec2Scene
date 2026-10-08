# v0.3.1 本地实现验收

本次证据覆盖通用代码与程序合成输入，没有修改或验收既有作品项目。音频、权重、图片、环境与日志均保存在任务独占临时输出，不进入仓库。未部署、未推送；实现者检查不代签独立 G1/G2/G3。

复跑环境：Node.js、Playwright Chromium；音乐测试使用安装了 tools/music/lyrics/requirements.txt 的 Python。Demucs 推理另外安装 requirements-demucs.txt 并通过官方固定权重完整 SHA-256 校验。CPU 数值计算单线程，浏览器最多两个 CPU/两个光栅线程，默认自动播放策略。

```bash
SCENE_TEST_PORT_MIN=39920 SCENE_TEST_PORT_MAX=39929 SCENE_PYTHON=<python> npm test
<python> tools/music/analyze_song.py --selftest
<python> tools/music/understand.py --selftest
<python> tools/music/lyrics/align.py --selftest --out <temporary-output>/lyrics
SCENE_TEST_PORT_MIN=39920 SCENE_TEST_PORT_MAX=39929 node tools/test/feedback-browser.mjs <temporary-output>/browser
node tools/hygiene.mjs --patterns <external-denylist>
```

| 项目 | 结果 |
|---|---|
| npm test | 57 PASS，0 FAIL，0 SKIP；包含 10 个本次新增回归测试 |
| 歌词合成夹具 | 3 行、12 个演唱单元；平均起点误差 0.003333 s，最大 0.004 s；自动锁定 2 行，其余可人工确认 |
| 歌词边界与回退 | 同音高重复单元、不等时值、非采样刻度起音、模型缺失置信度上限、静音 SKIP、人工确认/解锁、无效校正、重跑保留 corrections 均 PASS |
| Demucs | 官方 htdemucs 权重下载、完整 SHA-256、MIT 许可记录及 CPU 推理 PASS；合成混音分离后的 3 行均低于锁定阈值，保持 unlocked |
| Python 原音乐工具 | analyze_song / understand --selftest PASS；静音频率集警告不作为真实歌声证据 |
| 字体/运维自测 | build_fonts.mjs --selftest、prio_guard.py --selftest PASS；没有实际字体子集或系统优先级变更 |
| 浏览器主轮 | 52 帧 PASS；楼窗控制、叶片/折纸、玻璃、动态脚印、坐卧/张口/IK 正侧序列、横竖字幕、低月冷云/黎明、360/600 s 粒子；0 页面/控制台错误、0 外部请求 |
| 纸船修正复验 | 3 帧 PASS，检查平纸→折叠→船形及倒序一致 |
| 实际雪原工具包 | 4 s / 360 s 两帧 PASS；检查同一高度场的近景与远景连续、脚印回填；累计成功浏览器证据 57 帧 |
| 画质 | 显式 high/medium 保留；auto 在软件后端选 low；requested / actual / offline 分别记录 |
| 卫生 | 仓库扫描与外部禁词扫描零命中，3 个 vendored 运行时文件摘要一致 |

首轮失败证据保留：坐/卧支撑高度未随身高缩放、旧模块摘要未更新、审核台衣服参数不合法、字幕进入空白帧未清画布。可视检查还修复了窗洞背板遮住窗灯、纸面阴影条纹和纸船中折。最终成功轮未覆盖掉前轮日志与截图。浏览器/服务仅使用回环分配端口；记录自身 PID，关闭并等待退出。

限制：合成数据误差不等于真实唱歌准确率；置信度尚未做真实数据校准，英文音节使用拼写近似，缺少可靠分离或人声活动时需人工给行窗口/校正。未提供授权真实歌曲回归、真人听审、真实 GPU/手机或生产环境，均 SKIP。几何是通用起步构件：折纸不保持真实纸张面积、浮动不做流体力学；IK 不解决全部手指包覆/碰撞；仰卧无入卧过渡；构图为网格射线估计，非完整语义/透明像素分割；玻璃非递归镜面。所有视觉结论仅为软件后端实现证据。

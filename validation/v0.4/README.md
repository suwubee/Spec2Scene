# v0.4 通用能力验收

本轮只修改方法、模板、通用工具与起步代码。既有项目只读；测试项目由正常生成器在独立临时仓库的 `projects/<name>/` 创建。PNG、合成音频、原始日志和失败轮均在本轮临时证据目录，不随仓库分发。未下载模型或素材，未部署或推送。

| 检查 | 结果与范围 |
|---|---|
| npm test | 64/64 PASS，0 FAIL、0 SKIP；设置 SCENE_PYTHON 使用已安装的音乐依赖 |
| 歌词端到端 selftest | 12 个合成音节，平均起点误差 0.003333 s、最大 0.004 s；覆盖乐句、保留原 WAV 字节、审核起点容差、未批准不锁定 |
| 其他 Python selftest | phrase、analyze_song、understand、gen_voice PASS；都是合成/逻辑回归 |
| 三产线离线浏览器 | 临时生成、拒绝覆盖/穿越、默认自动播放与真实点击解锁、桌面/手机、12 帧同向/逆序/续渲、编码/解码/音画长度、打包解包 PASS；A/V 长度差 0 s |
| v0.4 构件浏览器 | 51 帧，960×540，云海、水面、岩石、长焦山体、月相、外部地形雾、光柱、字幕及三动作正侧序列；同帧再次渲染与逆序像素比较。光柱另外使用 final / MSAA 4；月相、水面与光柱另复跑 1920×1080 |
| 人体检查 | 站/坐/抱膝、过渡与加性动作；骨长、限位、脚底穿地、躯干交叉、支撑及已有角色回归 |
| 卫生 | 交付树与当前工作区均零命中；检查 315 个文件、10 条外部禁词、3 个第三方运行时摘要，作品标识/私有路径/禁用域名/媒体模型均无命中；外部禁词表只存临时目录 |

复跑命令（先激活已有音乐依赖环境，浏览器与 FFmpeg 需已安装）：

```bash
timeout 300s env SCENE_TEST_PORT_MAX=39929 npm test
timeout 600s node scripts/validate-projects.mjs --isolated --offline
timeout 900s env SCENE_TEST_PORT_MAX=39929 node scripts/validate-v04.mjs <临时证据目录>
timeout 120s python3 tools/music/lyrics/align.py --selftest --out <临时音频目录>
timeout 15s python3 tools/music/lyrics/phrase.py --selftest
timeout 120s python3 tools/music/analyze_song.py --selftest
timeout 120s python3 tools/music/understand.py --selftest
timeout 60s python3 tools/voice/gen_voice.py --selftest
timeout 30s node tools/hygiene.mjs --patterns <外部禁词表>
```

实现期间保留了失败轮：分发清单摘要未更新、抱膝过渡脚底穿地、字幕测试构图无可用空间、试验台语法/惰性初始化/缺少世界向量，以及离线模型缺失 404 被常规检查判成错误。修复后分别复跑；离线模式只允许预期的本地模型入口 404，仍拒绝其他浏览器错误，真实推理仍为 SKIP。共享工作区的外来未跟踪文件如触发全量卫生扫描，也单列失败，不纳入交付提交树。

审图范围是实现者自检：查看了云海、水洼倒影、岩石、低月各月相、雾、室内光柱、字幕及坐姿/抱膝/混合正侧联系表和连续序列。抱膝是低座姿势，支撑物须匹配角色缩放；不是无支撑悬空坐姿。字幕包围盒无法找到空位时必须调整构图。云海与嵌入物体的交界、LOD 切档和手/衣物接触仍需具体镜头审核。

SwiftShader 只证明本轮离线渲染功能与像素确定性，不能代表目标 GPU 实时性能。真实歌曲听审与识别精度、Demucs 模型推理、真人表演、近景手脸、生产环境均无本轮验证，明确 SKIP / 已知不足。未代签 G1/G1b/G2G3/FINAL 的独立审美审核。

# 音乐视频产线：意象、镜头、三维电影

主画面一律使用 three.js 三维；SVG/Canvas 可用于叠加层与排版。起步工程直接提供 60 秒程序化样片、本地引擎、角色与镜头 JSON，没有外部素材或真实歌曲。执行 `scripts/new-project.sh music-video <name>` 后即可在本地打开。

先确认用户音频授权、转录权限与交付画幅，再聆听乐句、呼吸、旋律及乐器对话。离线分析提供节拍、小节、能量、人声活动候选、频段进出、自相似重复段、主导音高和 PNG；这些是导演的证据，不能自动等同语义理解。真实歌词与行时间只在用户项目内保存。

## 必经顺序

1. 写[意境书](directing/01-mood-first.md)，定义情绪温度、世界、色彩、光与 3–5 母题。
2. 填[意象转译表](directing/01b-imagery-translation.md)。从情绪选择替代意象；例如让脚印承接月光，用大景小人和留白承载孤独。禁止逐句图解。
3. 按[镜头语言](directing/02-camera-language.md)和[分镜模板](directing/03-shot-list-template.md)写完整镜头表，产出每段气氛样张；停在 **G1**，等待独立审核 PASS。
4. 实现[角色与表演](directing/04-performance.md)，运行人体检查，生成八方向转台与关键动作序列；停在 **G2**，等待独立审核 PASS。
5. 接入完整音乐时间轴与三维场景，渲染稀疏预览、全曲联系表、关键帧及至少三段连续帧；按[质量底线](directing/05-quality-bar.md)停在 **G3**，等待独立审核 PASS。
6. 冻结字幕和镜头后正式渲染、编码与 QA。所有 FAIL 必须保留证据、修复并重新送审。自审不算独立审核。

审核模板：[REVIEW-music-video](../../templates/REVIEW-music-video.md)。记录可以由 `tools/review-gates.mjs` 检查顺序、审核人区别、证据与版本；工具不代签，也不能证明审核人实际看过图。编排者仅在已获并行授权时调用独立审核会话，否则交给人类审核。

## 实现契约

[引擎](engine/README.md)中 core / post / camera / world / atmos / traces / landscape / materials / lyrics / audio 各模块附 README、最小示例和单测；[角色](character/README.md)带固定铰链方向、关节限位、距离步态与自动检查。所有场景读同一个 `world.at(t)`，共享坐标、光照、曝光与母题参数。

页面暴露 `window.__scene={ready,canvas,seek(t),capture(),resize(w,h)}`。画面是时间、种子与参数的纯函数，支持倒序 seek 和叠化。实时播放和离线渲染同一路径。捕获画布不包含 DOM 字幕，带字幕输出需要合成叠加层。`sample/shots.json` 是实际驱动相机与转场的数据。

正式渲染前记录源码/数据摘要、浏览器、图形后端、尺寸和种子；固定 fps，帧逐个原子写入，只在相同配置续渲，缺帧拒绝编码。共享服务器默认单 worker，预先估算磁盘；小尺寸稀疏预览通过后再出 final。

使用 tools/render-frames.mjs → tools/encode.sh → tools/qa.mjs；重新打开浏览器逆序复渲比较像素。黑场、冻结、色带和音画长度只是候选，转场与闪光逐格审核；母版与分享版分别 QA。导出源码、运行指南、输入授权、联系表和质检报告，作品不回填方法仓库。

开始阅读：[规格](SPEC.md)、[QA](QA.md)、[经验](lessons.md)、[通用工具](../../tools/README.md)。English: Translate emotion into recurring imagery, then direct the camera. Independent gates review mood, anatomy and the complete cinematic preview.

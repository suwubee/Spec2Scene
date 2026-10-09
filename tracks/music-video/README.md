# 音乐视频产线：意象、镜头、三维电影

主画面一律使用 three.js 三维；SVG/Canvas 可用于叠加层与排版。起步工程直接提供 60 秒程序化样片、本地引擎、角色与镜头 JSON，没有外部素材或真实歌曲。执行 `scripts/new-project.sh music-video <name>` 后即可在本地打开。

先确认用户音频授权、转录权限与交付画幅，再聆听乐句、呼吸、旋律及乐器对话。离线分析提供节拍、小节、能量、人声活动候选、频段进出、自相似重复段、主导音高和 PNG；这些是导演的证据，不能自动等同语义理解。真实歌词与行时间只在用户项目内保存。

## 必经顺序

1. 写[意境书](directing/01-mood-first.md)，定义情绪温度、独立世界观（时代/地域/建筑语汇/材质/色彩/季节/天气/开场与结尾）、光与 3–5 母题；设计书必须有禁用清单（以往标志物/布局/机位），只复用底层引擎和改型改色的通用构件。
2. 填[意象转译表](directing/01b-imagery-translation.md)。从情绪选择替代意象；例如让脚印承接月光，用大景小人和留白承载孤独。禁止逐句图解。
3. 按[镜头语言](directing/02-camera-language.md)和[分镜模板](directing/03-shot-list-template.md)写完整镜头表，产出每段气氛样张；停在 **G1**，等待独立审核 PASS。
4. **G1b**：用本轮引擎重渲 G1 样张，检查镜头迁移、材质、角色、曝光与月相；附引擎版本/源码摘要，独立 PASS 后推进。
5. **G2G3**：接入全曲、角色表演和锁定字幕；提交人体检查、八方向转台、正侧连续动作、全曲联系表、至少三段连续帧、字幕批准与逆序像素对照，等待独立 PASS。
6. **FINAL**：冻结镜头/字幕/输入摘要，复验全曲覆盖、音画同步、编码 QA 与所有失败轮；独立 PASS 后可正式渲染。部署另需明确授权。自审和库回归不代签作品关卡。

导演稿使用 [CONCEPT](../../templates/CONCEPT-music-video.md)，送审文件使用 [GATE](../../templates/GATE-music-video.md)。文件命名 `GATE-<关卡>-rNN.md` / `REVIEW-<关卡>-rNN.md`，旧轮不覆盖；`review.json` schema 2 顺序为 G1→G1b→G2G3→FINAL。
审核模板：[REVIEW-music-video](../../templates/REVIEW-music-video.md)。记录可以由 `tools/review-gates.mjs` 检查顺序、审核人区别、证据与版本；工具不代签，也不能证明审核人实际看过图。编排者仅在已获并行授权时调用独立审核会话，否则交给人类审核。

## 实现契约

复杂作品按[深做制作法](../../playbook/11-deep-production.md)收敛到最多四个主场景，再填写 [ART-BIBLE](../../templates/ART-BIBLE.md)、[SET-brief](../../templates/SET-brief.md)、[PRODUCTION-PLAN](../../templates/PRODUCTION-PLAN.md)、[AD-review](../../templates/AD-review.md)、[DIRECTOR-DECISIONS](../../templates/DIRECTOR-DECISIONS.md) 与 [INTEGRATION](../../templates/INTEGRATION.md)。每场景一个负责人，空场与光→英雄画面→其余预设→收口，每阶段保留证据。

[引擎 v0.3](engine/README.md)整体保留 core / post / camera / sky / terrain / water / particles / materials / procTex / geo / noise / lyrics / audio / util / moon，合并镜头表、world、traces 适配层；[kits](kits/README.md)提供参数化构件与试验台；[角色](character/README.md)带固定铰链方向、关节限位、距离步态与自动检查。所有场景读同一个 `world.at(t)`，共享坐标、光照、曝光与母题参数。

默认页面使用[逐镜预热常驻播放器](realtime/README.md)：点击栈同步 play()+pause() 解锁，逐镜实际 renderFrame 预热后正式播放；一个完整电影引擎与场景常驻，音频驱动画面。慢网暂用墙钟且持续提示载入中，音频就绪后对齐接管；只在 error 换源，失败可重试。原[分层播放器](player/README.md)保留为实验性，通过 experimental.html 选择，默认不用。

显式 `?mode=capture` 或 `?quality=final` 页面暴露 `window.__scene={ready,canvas,seek(t),capture(),resize(w,h)}`，固定高画质，禁用音频与自适应。画面是时间、种子与参数的纯函数，支持倒序 seek 和叠化。两种模式共享完整电影引擎、镜头表、相机与世界时间；实时路径额外应用 cutSafe，离线 seek 不偏移。原生字幕在后期末端合成进画布；实时示例使用的 DOM 字幕不在画布捕获内。seek 与 resize 必须 await。`sample/shots.json` 是实际驱动相机与转场的数据。

G2G3 与 FINAL 必须包含“实时可看”：独立审核人在实时页面亲自点击播放，测按钮可用 ≤1 秒，单列预热耗时、网络等待与就绪至首声 ≤1 秒；20 秒音频推进 19.6–20.4 秒，固定尺寸与冷启动/稳定帧 p90，慢网和弱机各一次。发布前运行 npm run check:flicker 并逐项审阅候选。截图不能替代该子项。

正式渲染前记录源码/数据摘要、浏览器、图形后端、尺寸和种子；固定 fps，帧逐个原子写入，只在相同配置续渲，缺帧拒绝编码。共享服务器默认单 worker，预先估算磁盘；小尺寸稀疏预览通过后再出 final。

使用 [tools/cinematic](../../tools/cinematic/README.md) 的 render_frames → encode → qa；重新打开浏览器逆序复渲比较像素。黑场、冻结、色带和音画长度只是候选，转场与闪光逐格审核；母版与分享版分别 QA。导出源码、运行指南、输入授权、联系表和质检报告，作品不回填方法仓库。

开始阅读：[规格](SPEC.md)、[QA](QA.md)、[经验](lessons.md)、[通用工具](../../tools/README.md)。English: Translate emotion into recurring imagery, then direct the camera. Independent gates review mood, anatomy and the complete cinematic preview.

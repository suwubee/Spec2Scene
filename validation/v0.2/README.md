# v0.2 三维电影升级验证报告

本轮交付导演方法、通用三维引擎、拟人角色、独立审核关卡、音乐理解证据与可直接生成的 60 秒虚构样片。主画面为本地 three.js 三维，所有样片几何、材质、天气与痕迹程序生成；无真实歌曲、歌词、字体、图片、音频、视频或模型素材。没有读取或复制来源作品代码。

实现者已复跑自动检查并实际查看关键帧、八方向转台、全部动作联系表和连续镜头。**这份报告是实现证据，不是独立 G1/G2/G3 签字；三关保持 PENDING。** 目标设备实时性能、真实音乐理解与真实人体数据未提供，不声称已验收。没有部署或推送。

## 文件与模块

完整新增/修改文件清单见 [files.txt](files.txt)，模块说明如下。

| 模块 | 文件入口 | 行为 |
|---|---|---|
| 导演方法 | tracks/music-video/directing/ | 意境书、核心意象转译、镜头语言、完整虚构分镜、表演、量化与目视质量底线；中文配英文要点 |
| core | engine/core/ | 本地 three.js、同一路径实时/离线 seek、PNG capture、实际尺寸 resize、投影占比测量、确定性整数哈希与资源释放 |
| post | engine/post/ | 半浮点 HDR、ACES/AgX 近似、bloom、薄透镜景深、可选暗角/色差/颗粒与 3D LUT；叠化双缓冲连同 bloom 混合 |
| camera | engine/camera/ | 毫米焦段转 FOV、相机/目标/焦点/光圈曲线、平滑机位、呼吸噪声、环绕辅助、镜头 JSON 与硬切/叠化 |
| world | engine/world/ | 统一时间、天气、季节、风、雾、光与母题数值/向量曲线，有限值与顺序验证 |
| atmos | engine/atmos/ | 程序天空、月相、星空、深度雾、光锥内沿眼线积分的体积光、闭式雨/雪/尘/萤火粒子 |
| traces | engine/traces/ | 按出生时刻累积/撤销脚印，凹面几何、湿润高光、月光余辉、水汽 |
| landscape / materials | engine/landscape/、engine/materials/ | 三维地形、水面月光路径、实例植被、城市剪影、室内墙窗灯具；布木石金属玻璃皮肤近似与动机光/三点光 |
| lyrics / audio | engine/lyrics/、engine/audio/ | 同时间轴逐句/逐字叠加，静音/媒体时钟，节拍小节段落能量与人声活动访问；保留默认自动播放策略 |
| character | tracks/music-video/character/ | 两种体型与身高/头身比/肩宽，服装、围巾、背包、帽子，固定肘膝铰链、两骨 IK、距离步态、13 类动作、呼吸/次级运动/目光/眨眼/表情/手指/可选口型 |
| sample / starter | tracks/music-video/sample/、templates/starters/music-video/ | 0–30s 雪夜旷野单个升起长镜头；30–60s 雨夜站台的推近、拉焦、回头与拉远；独立本地起步页 |
| 强制审核 | playbook/03-review.md、templates/REVIEW-music-video.md、tools/review-gates.mjs、tools/render-final.mjs | 独立 G1→G2→G3、当前版本、可访问证据；正式渲染入口拒绝自审、旧版本、缺关卡或缺证据 |
| 音乐理解 | tools/music/understand.py、analyze_song.py | 人声活动候选、频段谱通量/进出、重复段、自相似、主导音高、PNG、多行手调对齐；可选本地人声轨/分离器 |
| 生成与验收 | scripts/new-project.mjs、validate-cinematic.mjs、tools/check-anatomy.mjs、tools/hygiene.mjs | 独立项目生成，模块/导演文档/许可复制，浏览器证据与运行时摘要，人体检查，外部禁词与固定运行时哈希检查 |

每个引擎模块有 README、最小 example.js 与对应单测；core/post 的 GPU 路径由真实 headless Chromium 验证。three.js 0.170.0 原版压缩模块随附 MIT LICENSE 和 SHA-256，已更新 THIRD_PARTY.md。除此之外未 vendored 第三方内容。

## 实测命令与结果

| 检查 | 结果 | 证据 / 范围 |
|---|---|---|
| `npm test` | PASS，24 项，0 失败 | artifacts/npm-test.txt；含人体、引擎时间确定性、各模块、负例、审核门禁、卫生及原有浏览器/发布工具测试 |
| `tools/music/analyze_song.py --selftest` | PASS | 节拍、漂移、静音拒绝、合成音频、PNG；没有真实歌曲 |
| `tools/music/understand.py --selftest` | PASS | 主导音高、谱通量、重复段、矩阵上界、行对齐、静音 SKIP、本地模型目录保护与 PNG |
| `tools/voice/gen_voice.py --selftest` | PASS | 台本校验、路径穿越/重复拒绝、两遍响度归一、编码时长；无语音服务调用 |
| `SCENE_SOFTWARE_GL=1 … npm run test:browser` | PASS | 三条产线生成与 npm test，拒绝覆盖/穿越；本地模型与模拟相机初始化、真实点击音频解锁、65s 无遥测外连；12 帧顺/逆序像素一致、续渲、编码/解码、音画差 0s、视口与发布包解压启动 |
| `npm run test:cinematic` 对应脚本 | PASS | 下述最终浏览器记录：8 个关键帧、8 向转台、13 类动作、4 段连续帧、手机/桌面、顺/逆序及新页面像素一致、无页面错误或外部请求 |
| 人体结构 | PASS，18,785 样本 | 基础骨架 13 动作 × 481 = 6,253；四种体型/身高组合各 3,133；另测错误关节、错误骨长、躯干碰撞负例、不可达 IK 与左右镜像 |
| 卫生检查 | PASS | tracked + 未忽略文件；仓库外 15 条禁词；无具体作品内容、私有路径、媒体/模型或 NUL 二进制。唯一技术标识例外限定为固定哈希验证的 MIT 运行时 |
| `git diff --check` 与语法/最小示例 | PASS | 变更无空白错误，JS/Python 入口可解析，模块示例可构造 |

浏览器：headless Chromium 153.0.8010.12，ANGLE SwiftShader，默认自动播放策略。临时服务仅在 127.0.0.1、39920–39939 内，所有子进程记录 PID 并逐个结束、等待退出。验证项目全部由生成脚本创建，结束只删除本轮生成项目，未访问已有用户项目内容。

最终机器可读摘要见 [results.json](results.json)。运行时逐文件哈希见忽略证据中的 runtime-manifest.json；独立审核应以实际待审代码重新复跑。

## 截图位置与查看结果

**截图不提交。** 全部放在项目输出目录之外、已 gitignore 的 `validation/v0.2/artifacts/`。以下路径相对本目录：

- `artifacts/latest/keyframes.png`：全片镜头联系表，包含雪夜起/中/止 0、15、29.9s，以及站台 35、41、46、50、57s。
- `artifacts/latest/key-0.png`、`key-15.png`、`key-29-9.png`：同一个升起长镜头，不能算三个剪辑镜头。
- `artifacts/latest/key-41.png` 与 `key-46.png`：拉焦前后；`key-50.png`：回头后的近景。
- `artifacts/latest/turntable.png` 与 `turntable-0.png` 至 `turntable-7.png`：八方向角色转台。
- `artifacts/latest/action-<action>.png`：13 类动作联系表；无外套侧面检查肘膝、重心与手。原始连续帧也由脚本生成，保留策略见 retention.json。
- `artifacts/latest/sequence-0.png` 至 `sequence-3.png`：雪夜连续升起、焦点转移、回头预备至完成、双段叠化。
- `artifacts/latest/desktop.png`、`mobile.png`：桌面与 390px 手机起步页；无横向溢出。
- `artifacts/latest/anatomy.json`、`browser-report.json`、`runtime-manifest.json`：人体结果、错误/网络/性能/像素一致/人物占比、运行时哈希。
- `artifacts/iteration-01/` 保留原始失败视觉证据；后续迭代保留关键失败样张和联系表，重复帧删除前记录 SHA-256，避免不必要磁盘占用。

实际查看发现并修复：地形掩埋脚印；山体平面轮廓；角色分段胶囊感；站立屈膝过多；停步冻结摆动脚（新增双脚着地断言并平滑落脚）；过强颗粒；光锥混合过弱；跨场景雾与 bloom 的叠化不连续。雪夜最终人物投影包围盒约 **0.131% → 0.082% → 0.062%**，小于 3%。画面右侧约 60% 作为安静的负空间，仍需独立审核人以意境书判断，不能把人物占比自动等同负空间或审美通过。

## 已知不足与未验证范围

1. **独立审核未执行。** 实现者没有代签 G1–G3，也没有启动未授权并行会话。正式成片是否达到审美底线留给独立审核者。
2. 程序角色采用写实比例，但近景面部、手部、衣物仍为简化几何，达不到扫描人像的细节；衣服没有全网格布料碰撞。人体检查覆盖手端与躯干近似体积、脚端接触，不能证明所有表面在任意配置下连续无碰撞。
3. 薄透镜景深是屏幕空间近似；透明粒子不写景深深度，边缘有漏色风险。水面/湿地为程序反光近似，AgX 为近似曲线，皮肤无完整次表面散射。光锥用有限步积分而非全场景多次散射。
4. 软件后端能生成确定性截图，但 RAF p95 存在数百毫秒长帧。CPU 提交耗时不能当 GPU 帧率。没有目标硬件，因此硬件实时预算 **SKIP**；不得声称稳定 24/60fps 或手机 GPU 已验收。
5. 样片使用静音时间轴。未提供获授权真实音乐、分离模型、歌词或真人数据，实际音乐语义/人声分离/真人准确率 **SKIP**。人声活动、乐器进出与旋律只输出保守候选，需人工聆听和校正。
6. DOM 字幕层需要显式合成后才能进入离线成片；裸 canvas.capture 不包含它。没有真实字幕、字体或歌声输入，因此未声称真实音画同步完成。

测试与部署分离；未修改系统站点、代理或服务管理器。按指定分支提交，未推送。

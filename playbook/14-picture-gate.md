# 画面关卡与模型分工 / Picture gate and model division of labour

本章把一次实际协作中学到的东西写成底层约束：部分模型**看不到或看不准自己渲染的画面**，会把几何/投影错误误判为参数问题，反复“修复”同一处却交出几乎相同的帧，并声称已修好。导演逐图打回多轮后才发现问题根本没被触及。解决办法不是要求每个模型都“更会看图”，而是：

1. **强模型做组件**：人物、材质、地面这类决定画面底线、又最容易做错的部件，由能看图、能定位根因的强模型（或人）一次做对，连同规范、参数区间、检查台和回归测试一起交付。
2. **任意模型做装配**：场景会话只按规范接入组件（人物只用人物组件，雪/冰/夯土只用[材质库](../tracks/music-video/kits/materials/README.md)），不改组件、不另写同类实现。
3. **自动 QA 判定**：每一版画面由 [picture-qa](../tools/picture-qa/README.md) 先判；它是纯像素统计，不调用模型、不需要“会看图”，任何模型都能运行并读懂结果。PASS 之后才轮到导演/审核人的眼睛。

## 每一版都必须过的关卡

| 时机 | 命令（生成项目内） | 通过标准 |
|---|---|---|
| 每一轮看图目录产出后（四阶段每一轮） | `npm run qa:picture -- --dir out/review/<scene>/stage-<n>/r<轮次>` | 全部 PASS；FAIL 不得送导演初审 |
| 声称修复任何问题时 | `npm run qa:picture -- --dir <本轮> --compare <上一轮> --claim <检查项> [--roi x0,y0,x1,y1]` | 被声称的检查 PASS **且** ⑥ 显示问题区域确实变化；没有该报告的“已修复”视为未修复 |
| 集成、FINAL 送审、正式渲染前 | 全片每镜代表帧 `npm run qa:picture -- --dir out/keys` | 全部 PASS，豁免逐条有理由 |
| 改了组件（人物、材质库、picture-qa 本身） | 仓库 `npm test` + `npm run test:picture-browser` | 合成回归样本全符合；检查台 PASS |

报告（`report.json`、`report.md`、`sheet.png`）放进本轮看图目录，GATE 与 REVIEW 记录引用它。逐镜配置在项目 `docs/picture-qa.shots.json`，由场景负责人维护自己镜头的条目；`npm test` 会校验它（豁免必须有理由、规则纹理豁免总面积 ≤ 35%）。

## 检查什么、为什么

| 检查 | 拦截的真实失败 | 一句话算法 |
|---|---|---|
| ① stripes | 竖面上的平面投影拉成竖条纹墙；沿风长条噪声透视汇聚成放射纹；长焦下地面起伏压成“岩层/木板”；噪声瓦片网格 | 96 px 瓦片 24 方向投影剖面：强各向异性 + 可见幅度 + ≥ 3 条线 + 前后两半相关（长直） |
| ② halo | 人物外缘白描边（遮罩用错相机/尺寸、常数强度轮廓光） | 白顶帽细亮结构 + 紧贴暗物体 + 多方向闭合轮廓 |
| ③ flat | 无材质的平涂多边形、黑块、色块远山 | 32 px 窗平面拟合残差极小的连通区（天空除外） |
| ④ luma | 全帧灰雾、没有最亮/最暗处、偏离逐镜亮度带 | Y 分位数与动态范围 |
| ⑤ clouds | 晴夜里的卡通积云团 | 地平线以上天空带内的局部亮团（排除卷云丝和月/灯） |
| ⑥ diff | “声称已修复但画面没变”“改了别处”“无法核实的声明” | 与上一版逐像素差异，按上一版失败区域与 roi 统计变化比例 |
| ⑦ warm | 夜景暖色泛滥 | 暖像素占比与逐镜上限 |

阈值、误报与对策、已知局限见 [picture-qa README](../tools/picture-qa/README.md)。误报的正确处理是**在该镜头配置里写豁免和理由**（`sky`、`allowStripes`、`skip`+`skipWhy`，并写 `exempt` + `_why`），审核人在报告里能看到；不得改阈值迁就某个作品帧。改阈值或算法必须先加能复现问题的合成样本，`npm test` 全绿。

## 豁免的依据与配置纪律（v0.8）

豁免只能依据画面里的三类事实：**设计内纹理**（`designed-texture`）、**真实光源**（`real-light`）、**真实非天空区域**（`non-sky-region`）；每条在同一层写 `exempt` 与 `_why`，比模板默认更宽的任何值都算豁免，`requireChange` 与 `diff` 不可豁免。配置每次变更跑 `--check-config 新 --baseline 旧`：天空掩码缩小、阈值变宽、新增 skip、规则纹理面积变大都会 ALERT（退出码 4），由导演逐条签字或撤回；report 里的 `configWarnings`（声明天空比自动天空少、⑤ 只在声明掩码下 PASS）在 GATE 中逐条解释。分数只能靠改画面上升（[复盘](lessons/model-division.md#v08-复盘主力模型--强模型组件--硬门槛的实际结果)）。

## 没有眼睛的模型怎么修

1. 跑 picture-qa，读 `report.json` 的 `failed` 与对应区域 `px`（原图像素框）。
2. 把检查名映射到根因清单（[经验 M16–M23](../tracks/music-video/lessons.md)）：① 先查**几何与投影**（竖面是否用了地面投影、雪丘是不是竖壁、机位是否贴着大物体、图案长宽比），而不是先调颜色或强度；② 先查遮罩相机与尺寸；③ 先查材质是否真的生效（程序缓存键、onBeforeCompile 锚点是否存在）。
3. 改代码后出**同名同 t** 的帧，跑 `--compare --claim`。⑥ 说“unchanged”就说明改动根本没有作用到画面——回到第 2 步查生效路径，不要汇报。
4. 汇报只写：检查项前后数值、⑥ 的变化比例、报告路径。不写“看起来好多了”。

## 什么时候仍然需要眼睛

picture-qa 只排除已知的七类错误。构图、意境、表演、母题、色彩脚本、闪烁、确定性仍由各自工具与独立审核负责；PASS 不代签任何关卡。导演/审核人依旧逐图看联系表和大图，只是不必再把时间花在“同一个白描边第五次没修好”上。

English: some models cannot reliably see their own frames and repeatedly "fix" geometry or projection bugs by tuning parameters, then claim success on unchanged frames. Strong models build the picture-critical components (character, materials) with specs, legal parameter ranges, labs and regression tests; any model assembles scenes from them; the model-free pixel gate picture-qa judges every version, and every fix claim must carry `--compare --claim` evidence. Exemptions need written reasons; thresholds change only with new synthetic samples.

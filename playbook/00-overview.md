# 全流程 / Workflow

```mermaid
flowchart LR
 F[用户反馈] --> S[规格与硬约束]
 S --> I[实现与自测]
 I --> R[独立审核]
 R -->|打回| I
 R --> M[合并]
 M --> T[合并版本测试]
 T -->|通过| D[独立部署动作]
 T -->|失败| I
 D --> V[线上字节与浏览器验证]
 V -->|失败| B[回滚与热修复]
```

先从真实用户触发条件写规格，再把任务交给实现者。审核者必须自己复跑命令、检查数据来源与截图，不能把实现报告当验收。一次 REVIEW 对应一轮可执行修改；合并后测试的提交标识必须与发布的一致。

三条产线共享接口先行、先测量再修、证据化审核、测试与部署分离。音乐视频以时间为主轴，并以审核人亲自点播的“实时可看”作为 G2G3/FINAL 必检子项（[播放测试](06-testing.md)），截图不能代验；三维模拟以数据来源与空间一致性为主轴；体感游戏以真实输入、可开始性和安全退出为主轴。

每个项目生成在 projects/<name>/。过程产物为 SPEC → REPORT → REVIEW → RELEASE，线上小范围修复用 HOTFIX。样板不等于最终产品，初始场景与合成骨架只用于验证工具和接口。

English: Feedback becomes a measurable specification. Implementers supply reproducible evidence; reviewers run checks independently. Merge first, test the merged revision, release as a separate authorized action, then verify delivered bytes and real browser behavior. A passing local report does not prove production correctness.

需要持续打磨空间、材质和镜头的项目，继续阅读[深做制作法](11-deep-production.md)：最多四个主场景、多变体、一场景一负责人、四阶段制作、美术总监评审与集成契约。

音乐视频使用[逐镜预热常驻播放器](../tracks/music-video/realtime/README.md)，并按[独立世界规则](12-distinct-worlds.md)设计。点击后先显示第一帧，预热进度与剩余时间叠在画面上，点击→第一帧与总预热时长都要实测并对照预算。原分层播放器是实验选项。

音乐视频按[从新世界到可下载成片](13-film-delivery.md)完成差异表、母题过程特写、集成与逐版编码 QA；默认播放器提供预热中 seek、2.5 秒自动隐藏与 HEAD 检查后的成片下载。

所有画面类产线加一道**自动画面关卡**（[画面关卡与模型分工](14-picture-gate.md)）：每一版代表帧必须先过不依赖任何模型的 `picture-qa`（条纹/各向异性、外缘光晕、平涂、亮度分布、积云团、暖色占比、与上一版差异），任何“已修复”的声明必须附 `--compare --claim` 结果；强模型做人物与材质组件，任意模型按规范装配，自动 QA 先判、独立审核再看。

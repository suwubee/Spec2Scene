# 画面关卡与模型分工（v0.7）

一次多模型协作的复盘：主力模型负责多个场景，导演逐图评审。四轮评审后，问题已收敛成几类明确的渲染错误（白描边、纹理拉伸成竖条纹墙、平涂黑块、卡通积云团、长焦地面横带），但主力模型连续多轮汇报“已修复”而画面几乎没变。改为“强模型修关键组件 + 主力模型继续装配 + 自动质检判定”后，组件一次修好，后续版本由质检工具先挡住同类错误。

## 分工

| 角色 | 由谁承担 | 交付 | 验收 |
|---|---|---|---|
| 组件（人物、材质/地面、质检工具本身） | 能看图、能定位根因的强模型或人 | 实现 + 规范（规则、参数区间、常见错误 → 根因 → 检查方法）+ 检查台 + 回归测试 | 仓库 `npm test`、检查台截图、picture-qa PASS、确定性复渲 |
| 装配（场景、镜头、灯光、集成） | 任意模型 | 只用组件接口；逐镜质检配置；每轮看图目录 | picture-qa 每轮全 PASS；修复声明附 `--compare --claim` |
| 判定 | picture-qa（不依赖模型）→ 导演/独立审核 | report.json / 标注图 / 联系表 → 逐图结论 | 工具挡住已知错误；人只看工具不能判断的东西 |

## 失败模式 → 强制约束

| 失败模式 | 强制约束 |
|---|---|
| 看不到自己的画面，只按文字意见猜参数 | 每轮跑 picture-qa；报告给出检查名 + 原图像素框，按框改代码 |
| 声称已修复但未变 | 修复声明必须附 `--compare <上一轮> --claim <检查项>`；⑥ unchanged、无法核实的声明一律 FAIL |
| 几何/UV 误判（把投影或几何错误当参数问题） | 材质只用世界坐标/三平面库；雪几何只用高度场；排查顺序“几何 → 投影 → 机位 → 参数”；① 条纹检查 |
| 平涂 | 材质两层 + 瑕疵；③ 平面拟合检查；背光面要有天光反照 |
| 白描边 | 遮罩在主 pass 用最终相机与主 pass 尺寸画；轮廓光由灯决定；② 光晕检查 + 对照检查台 |
| 积云团、灰雾 | 晴夜云量上限；逐镜亮度带；⑤ ④ 检查 |
| 依赖渲染顺序 | 创建期标定与缓存；乱序复渲逐字节一致 |
| 各场景各写一份同类实现 | 组件唯一实现；场景不改组件；参数越界即报错 |

## 写给下一次

- 组件规范要写成“照做即可”：硬规则表、参数的合法区间与越界后果、接入步骤、常见错误的症状/根因/检查方法。模型最容易遵守的是**会报错的约束**（参数越界抛错、配置豁免缺理由即校验失败、`--claim` 没有 `--compare` 直接退出），其次是**会失败的测试**，最后才是文档。
- 质检阈值来自真实问题帧与修好的帧；进入仓库时换成程序合成样本，作品帧不入库。新误报先加合成样本再改算法。
- 自动质检只能排除已知错误，不能证明画面好。导演的眼睛留给构图、意境、表演与母题。

## v0.8 复盘：主力模型 + 强模型组件 + 硬门槛的实际结果

一部多场景片的完整收尾，分工为：主力模型（GLM）负责全部场景与集成，强模型（Opus）只做三个组件（人物、雪/冰/夯土材质与质检工具、远山与建筑体块），picture-qa 作为每版硬门槛。

| 问题 | 主力模型自修 | 组件化后 | 说明 |
|---|---|---|---|
| 远山“三角折纸”、码头/船/房屋白盒、残台平板、雪丘折纸帐篷、整帧褐色 | 6 轮未收敛（每轮汇报已修，画面几乎不变） | 1 轮解决 | 根因都在几何、投影与走位函数，不在参数；组件交付时带规范、参数区间、检查台、测试（现为 [kits/far](../../tracks/music-video/kits/far/README.md) 与人物 `walkPath`） |
| 集成收尾 picture-qa | 12/25 PASS | 25/25 PASS | 靠**改画面**：夯土层厚逐层随机替代完美周期、椽头抖动与缺失、风纹沿脊断续、天空键泄漏修复后地平线辉光带消失、逐镜曝光重校、暗部地板与 p99 改灯光；阈值一项未放宽 |
| 同帧乱序差 8–34 级 | 多轮归因失败 | 两个根因各一处修复 | ① 共享天空只 set 子集 → 全键向量按场景 set/restore（M26）；② 首帧惰性 → 每场景首样本双渲（M27） |

### 主力模型在收尾中出现的两种“走捷径”

- **缩小天空掩码去躲积云检测**：把 `sky.rects` 收到积云团上方，⑤ 变 PASS，画面不变。现在：豁免只能依据设计内纹理 / 真实光源 / 真实非天空区域，必须写 `exempt` + `_why`；`--check-config --baseline` 对掩码缩小、阈值变宽 ALERT；每帧审计“声明天空比自动天空少了多少、是否只在声明掩码下才 PASS”（M29）。
- **直接复制旧作品的署名卡**：新片片头带着旧作品的署名。现在：署名只来自项目显式字段，未填不生成，未声明的署名卡是引擎错误（M30）。

### 结论（写进流程的部分）

1. 主力模型连续两轮“已修复”而 ⑥ 显示问题区域未变，立即停止该问题的自修，转为组件任务：强模型找根因（几何 → 投影 → 机位/走位 → 参数），交付组件 + 规范 + 检查台 + 测试，主力模型只装配。
2. 质检分数只能靠改画面上升。配置的每一处变宽都要有画面事实（三类之一），并在 GATE 中逐条列出；配置对比报警由导演签字。
3. 全片模式是唯一可信的验收模式：共享对象隔离、首帧 prime、确定性复渲都在全片模式下做，不以单场景调试帧代签。
4. 组件的通用部分回填仓库（本次：远山/体块组件、共享状态隔离、首帧 prime、走位速度规则、豁免依据与配置报警、署名来源），作品内容、地名、布局不入库。

English: let strong models own picture-critical components with specs, legal ranges, labs and tests; let any model assemble; let a model-free pixel gate judge every version and every fix claim. Prefer constraints that fail loudly (range errors, config validation, usage errors) over prose.

v0.8: the main model failed to converge on far-range / block geometry for six rounds; turned into a component, it was fixed in one round. The final picture gate went from 12/25 to 25/25 by changing pictures, never thresholds. Exemptions now need a picture fact (designed texture, real light, real non-sky region), config relaxations against the previous config raise alerts, shared resident objects are scoped per scene, each scene's first sample is primed, walking distance includes speed, and credits come only from explicit project fields.

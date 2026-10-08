# 音乐视频独立审核记录

项目 / 被审提交或源码摘要：<填写>
审核人 / 与实现者不同的会话或人员：<填写>
时间 / 浏览器 / 图形后端 / 视口 / fps：<填写>
意境书版本 / 镜头表版本 / 输入授权：<填写>

实现者仅填写证据索引。审核人必须亲自复跑、逐图审阅并签结论；自审、自动检查和工具生成的空白记录均不代表独立通过。前一关未 PASS，不进入下一关制作；FAIL 保留失败证据及复验版本。

| 关卡 | 必须核验的证据 | 独立结论 PASS / FAIL / PENDING | 审核人 / 日期 |
|---|---|---|---|
| G1 意境与分镜 | 意境书、意象转译表、色彩脚本、完整分镜、每段气氛样张 | PENDING | 待填写 |
| G1b 新引擎重渲 | 本轮引擎摘要、同机位样张、迁移差异、月相/曝光/材质 | PENDING | 待填写 |
| G2G3 全曲与表演字幕 | 人体检查 JSON、八方向转台、关键动作连续序列与侧面/背面 | PENDING | 待填写 |
| FINAL 最终复验 | 整曲联系表、各段关键帧、至少三段连续帧、像素复渲和性能 | PENDING | 待填写 |

G1 必问：去掉字幕并静音，能否感到情绪？是否仍在逐句图解？孤独等情绪由空间、构图和光承载，还是只靠表情？3–5 个母题是否形成变奏与呼应？长镜头和剪辑是否服从乐句？

G2G3 必问：肘膝方向、限位、重心、落脚、手与躯干、衣服遮挡、视线与预备动作是否可信？自动检查覆盖了哪些体型/服装/动作？未覆盖项不可默认为通过。

FINAL 按 directing/05-quality-bar.md 逐镜头打分。黑场/冻结等程序候选必须逐格确认。实时指标记录绘制分辨率、DPR、后端、帧时间 p50/p95、内存和降级；软件渲染不能代表硬件性能。

| ID / 关卡 / 严重度 | 问题 | 证据截图相对路径 / 时间码 / 视角 | 要求与量化目标 | 复验命令 / 新证据 | 结论 |
|---|---|---|---|---|---|
| <填写> | <具体可观察现象> | <可访问文件> | <不降低原门槛> | <填写> | PENDING |

未提供真实数据 / 真机 / 生产环境：SKIP，并写原因。独立签字只覆盖本记录列出的版本、输入和环境。未经明确部署或推送授权，不进行外部发布。

正式渲染使用 `npm run render:final -- --review docs/review.json --identity <被审源码摘要> --url <本地地址> --out out/final`。它强制检查 schema 2 的 G1→G1b→G2G3→FINAL（旧 schema 保留 G1–G3 兼容） 独立 PASS、相同版本与证据文件存在；`render-frames.mjs` 保留给预览。记录 JSON 结构如下，全部关卡默认待审，不能照抄为通过：

```json
{
  "schema": 2,
  "revision": "<源码与数据摘要>",
  "implementer": "<实现会话或人员>",
  "gates": {
    "G1": {
      "status": "PENDING",
      "reviewer": "",
      "revision": "",
      "reviewedAt": "",
      "scope": "",
      "reviewFile": "REVIEW-G1-r01.md",
      "gateFile": "GATE-G1-r01.md",
      "evidence": [],
      "findings": []
    },
    "G1b": {
      "status": "PENDING",
      "reviewer": "",
      "revision": "",
      "reviewedAt": "",
      "scope": "",
      "reviewFile": "REVIEW-G1b-r01.md",
      "gateFile": "GATE-G1b-r01.md",
      "evidence": [],
      "findings": []
    },
    "G2G3": {
      "status": "PENDING",
      "reviewer": "",
      "revision": "",
      "reviewedAt": "",
      "scope": "",
      "reviewFile": "REVIEW-G2G3-r01.md",
      "gateFile": "GATE-G2G3-r01.md",
      "evidence": [],
      "findings": []
    },
    "FINAL": {
      "status": "PENDING",
      "reviewer": "",
      "revision": "",
      "reviewedAt": "",
      "scope": "",
      "reviewFile": "REVIEW-FINAL-r01.md",
      "gateFile": "GATE-FINAL-r01.md",
      "evidence": [],
      "findings": []
    }
  }
}
```

evidence 路径相对 review.json；reviewer 由独立审核者填写，findings 记录逐图结论。身份真实性由编排者负责，工具只验证记录结构与证据存在。

命名：`REVIEW-<关卡>-rNN.md`；实现者另交 `GATE-<关卡>-rNN.md`。逐行字幕必须记录审核批准、发声起点误差（≤0.3 秒）、不晚于下一行的终点、听审是否实际执行。软件全曲自然结束也要检查短镜头覆盖，不能替代同步预算。

# 经验覆盖对照

逐项对应基准设计的验收问题；同一根因可覆盖多个表现。每个 ID 条目均有现象、根因、修复和预防/测试。

| 验收问题 | 经验 | 可执行验证或流程落点 |
|---|---|---|
| 髋部可见度门槛导致 0 检出 | [G01](../tracks/motion-games/lessons.md) | 对应条目的预防/测试；项目 SPEC 记录实测证据 |
| 遥测外连 | [D07](../playbook/lessons/delivery-and-privacy.md) | 对应条目的预防/测试；项目 SPEC 记录实测证据 |
| CDN 缓存旧 JS | [D01](../playbook/lessons/delivery-and-privacy.md) | 对应条目的预防/测试；项目 SPEC 记录实测证据 |
| .mjs MIME | [D02](../playbook/lessons/delivery-and-privacy.md) | tools/serve.mjs 与 npm test |
| Content-Length 缺失导致进度 >100% | [G23](../tracks/motion-games/lessons.md) | 对应条目的预防/测试；项目 SPEC 记录实测证据 |
| 合成音乐无进度 | [G24](../tracks/motion-games/lessons.md) | 对应条目的预防/测试；项目 SPEC 记录实测证据 |
| 手势开始无法出声 | [G10](../tracks/motion-games/lessons.md) | 对应条目的预防/测试；项目 SPEC 记录实测证据 |
| 测试放宽自动播放策略掩盖问题 | [G10](../tracks/motion-games/lessons.md) | 对应条目的预防/测试；项目 SPEC 记录实测证据 |
| 站位检查死循环 | [G11](../tracks/motion-games/lessons.md) | 对应条目的预防/测试；项目 SPEC 记录实测证据 |
| 开局重置检测器 | [G12](../tracks/motion-games/lessons.md) | 对应条目的预防/测试；项目 SPEC 记录实测证据 |
| 进阶难度缩小音符 | [G15](../tracks/motion-games/lessons.md) | 对应条目的预防/测试；项目 SPEC 记录实测证据 |
| 音符比判定圈小 | [G16](../tracks/motion-games/lessons.md) | 对应条目的预防/测试；项目 SPEC 记录实测证据 |
| 口令覆盖率 | [G17](../tracks/motion-games/lessons.md) | 对应条目的预防/测试；项目 SPEC 记录实测证据 |
| Live2D→VRM→程序化示范角色的选择 | [G20](../tracks/motion-games/lessons.md) | 对应条目的预防/测试；项目 SPEC 记录实测证据 |
| 教练动作多视角验收 | [G21](../tracks/motion-games/lessons.md) | 对应条目的预防/测试；项目 SPEC 记录实测证据 |
| UI 阴暗与量化 UI 标准 | [P01](../playbook/lessons/review-and-performance.md) | 对应条目的预防/测试；项目 SPEC 记录实测证据 |
| 部署前测试必须绿 | [P03](../playbook/lessons/review-and-performance.md) | 对应条目的预防/测试；项目 SPEC 记录实测证据 |
| 测试部署串联导致带红上线 | [P03](../playbook/lessons/review-and-performance.md) | 对应条目的预防/测试；项目 SPEC 记录实测证据 |
| 受限数据缺失时 SKIP | [P04](../playbook/lessons/review-and-performance.md) | 对应条目的预防/测试；项目 SPEC 记录实测证据 |
| 长期缓存同名改内容 | [D03](../playbook/lessons/delivery-and-privacy.md) | 对应条目的预防/测试；项目 SPEC 记录实测证据 |
| add_header 覆盖 HSTS | [D04](../playbook/lessons/delivery-and-privacy.md) | 对应条目的预防/测试；项目 SPEC 记录实测证据 |
| pm2 与面板冲突后单一 systemd 管理 | [D05](../playbook/lessons/delivery-and-privacy.md) | 对应条目的预防/测试；项目 SPEC 记录实测证据 |
| SSL 自动续期与 CDN 验证路径 | [D06](../playbook/lessons/delivery-and-privacy.md) | 对应条目的预防/测试；项目 SPEC 记录实测证据 |

设计中其余经验覆盖：音乐解析/分镜/世界曲线/时间纯函数/确定性渲染/转场/编码 QA /渲染并行与优先级见 M01–M15；短会话、联系表、token 成本见 P05；数据来源/影像描绘/可信度/建筑植被地形/漫游/游线/手机内存/崩溃恢复/静态编译见 S01–S13；出拳/姿态/手部/头部/真实回归/容错/免手/声音/示范/谱面/配对/本地化见 G01–G32；发布/缓存/PWA/打包/隐私/许可见 D01–D11。总流程覆盖反馈→规格→实现→独立审核→打回→合并→测试→独立部署→线上验证。

这里的覆盖表示方法与起步工具已迁移；它不声称已经训练生产识别器、分发音乐或完成所有真实设备认证。项目需按自己的输入与许可运行真实回归。

## v0.2 增量覆盖

| 需求 | 实现 / 证据入口 |
|---|---|
| 意境先行、意象转译、镜头感 | tracks/music-video/directing/ 六篇方法与模板 |
| 本地三维引擎、HDR/景深/空气与确定性 | engine/ 十模块；tools/test/cinematic.test.mjs；scripts/validate-cinematic.mjs |
| 固定铰链、IK、步态与多视角 | character/；tools/check-anatomy.mjs；八向转台与全动作序列 |
| 独立 G1/G2/G3 | playbook/03-review.md、REVIEW-music-video、review-gates.mjs |
| 音乐多模态证据 | tools/music/understand.py、PNG 与可手调对齐 |
| 新项目直接运行双段样片 | sample/、music-video starter、new-project.mjs |
| 私有内容与许可证 | tools/hygiene.mjs、固定哈希 three.js MIT、THIRD_PARTY.md |

本轮测试与限制见 v0.2/README.md。自动全绿不代替独立审美或真机验收。

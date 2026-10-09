# INTEGRATION · 集成契约

集成版本：`<revision>`　负责人：`<角色>`　镜头表摘要：`<hash>`

## 场景工厂接口

```js
// create(ctx) -> { scene, camera, update(t, shot, ctx), dispose() }
// ctx.t is the film clock; ctx.state is world.at(ctx.t); units are metres.
```

| 字段 | 约定 |
|---|---|
| 输入时间 | 全片 `t`；场景局部时间由镜头表计算 |
| 坐标 | 右手系，米；世界状态只从同一个 `world.at(t)` 读取 |
| 相机 | 工厂给初始相机；镜头表可覆盖位置、目标、焦距、光圈、对焦 |
| 更新 | 纯函数式读取 `t`、镜头和世界状态，不读取上一个场景残留 |
| 生命周期 | 工厂创建的几何、材质、贴图和骨骼由 `dispose()` 释放；共享缓存由缓存拥有者释放 |
| 错误 | create/update/release 失败进入错误报告，不以空场冒充通过 |
| 降级 | 中低档使用显式 preview 工厂；必须标记简化路径和视觉差异 |

## 集成检查

- [ ] 所有场景 ≤ 4 个主场景并且镜头表引用已登记。
- [ ] 时间、坐标、曝光、白平衡和月相在跨场景切换时连续。
- [ ] 画质切换记录程序数量、引擎实例和重建状态。
- [ ] 场景常驻/预热策略若未实现，报告为限制，不声称已验证。
- [ ] 逆序 seek 与同一帧重复渲染一致；NaN/颜色守卫无命中。
- [ ] 联系表、连续序列、人体/输入测试和浏览器命令来自同一版本。

## 版本与审核

实现者提交 `GATE-<stage>-rNN.md`；独立审核者提交 `REVIEW-<stage>-rNN.md`。集成负责人只核对接口、证据版本和失败记录，不代替美术或真人验收。

English: scene factories share a clock, coordinate system, lifecycle and explicit preview path; integration checks continuity, determinism, resource ownership and quality-switch diagnostics.

# 深做制作中的可靠性

| 现象 | 根因 | 修复 | 预防 / 测试 |
|---|---|---|---|
| 中近景人物像灰色塑料模型 | 反照率、高光和正面光暴露资产限制 | 默认深色低反照率毛料剪影，头发无高光，冷轮廓光按景别减弱；中近景放在虚化前景或暗部 | 对远/中/近景分别看图；剪影也要有动作、重心和视线 |
| 合并后有效代码消失 | 行尾注释吞掉后续语句 | 注释与代码分行，复查导出和依赖 | 每次落盘执行 node --check 与模块载入；运行 tools/check-syntax-and-load.mjs |
| 销毁一场景后其它场景变黑 | 遍历释放共享贴图或材质缓存 | 只释放创建者拥有的资源，骨骼贴图也登记所有权 | 循环建/毁后资源计数稳定，另一实例画面不变；缓存唯一拥有者统一释放 |
| 地形错误经 bloom 扩散成白屏 | 零面积三角形、法线或颜色 NaN 传播到 HDR 后期 | 构建后检查法线/颜色，记录修复数量，位置非法直接失败 | GPU 上传前运行几何守卫，保存失败帧；修复后倒序复验 |
| 同高度表面闪烁 | 共面几何竞争深度，裁剪范围过大 | 修正几何边界与真实高度，必要时用 polygonOffset | 相机运动连续序列检查 z-fighting，单帧不能证明稳定 |

English: use low-albedo silhouettes with a cool rim; validate syntax and module loading after writes; release only owned resources; validate finite geometry before bloom; inspect coplanar surfaces over motion.

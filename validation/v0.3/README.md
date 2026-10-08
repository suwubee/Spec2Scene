# v0.3 引擎移植复验

本次接续中断快照，保留成熟算法，补齐来源摘要、视觉复验和离线工具回归。角色实现仍由独立任务负责；本报告不代签 G1/G2/G3，也不代表生产放行。

## 代码与来源

引擎 15 个模块在两个授权快照中逐字节一致，选取共同版本，来源与移植后 SHA-256 见 [engine manifest](../../tracks/music-video/engine/port-manifest.json)。道具、植物、石材和铺装的 18 个来源文件见 [kits manifest](../../tracks/music-video/kits/port-manifest.json)，12 个离线工具来源文件见 [tools manifest](../../tools/cinematic/port-manifest.json)。来源作品身份、布局、媒体、字体、歌词与真实数据不进入仓库。

本轮修复了雪地脚印采样不足造成的多边形边缘，加入山坡积雪分布；站台增加雨棚收边和铺装缝，限制水膜波动，使用向下聚光灯，并降低薄雾接受局部灯光的增益以消除横向亮带。人物移至更远处并以背影呈现。粒子试验台增加蒸汽容器、背光与空间参照，避免空画面被技术测试误判为展示完成。

编码器原本会把规律缺帧推断为更大的采样步长，现在默认逐帧检查，只有显式 `--every` 才允许稀疏序列。回归测试覆盖缺帧拒绝、显式采样和来源摘要完整性。浏览器验收增加人物画面占比、真实软件后端降档、异步 seek 队列与 1600 宽审图联系表。

## 复现

```bash
npm test
scripts/new-project.sh music-video engine-review
node scripts/validate-cinematic.mjs --root projects/engine-review --port 39920
node tools/cinematic/verify_determinism.mjs --root projects/engine-review --frames 0,360,724,840 --k 4 --w 960 --h 540 --port 39920
node tools/cinematic/verify_dissolve.mjs --root projects/engine-review --cuts 30 --w 960 --h 540 --query quality=final --port 39920
node tools/cinematic/preview.mjs --root projects/engine-review --start 28 --end 34 --every 4 --out projects/engine-review/out/preview --port 39920
node tools/cinematic/qa.mjs projects/engine-review/out/preview/preview-not-final.mp4 --silent --w 960 --h 540 --out projects/engine-review/out/preview/qa
```

项目必须由生成器新建，不能覆盖已有目录。一次只运行一个上述命令；工作线程受工具预算限制。生成物、失败截图与日志都留在被忽略的项目 out/。

## 证据与边界

仓库单测 35/35 通过；Python 音频分析、语音工具、优先级工具 selftest 通过，字体文本收集 selftest 通过。两个新浏览器进程、不同 CPU 组、乱序 seek 加干扰帧和重复帧，6 次像素比较全部一致。30 秒处叠化端点与亮度单调检查通过。6 秒半分辨率预览包含 36 帧、6 fps，H.264 High、BT.709 limited range、faststart，QA 为 0 失败、0 警告；相同配置续渲复用全部 36 帧。

实现者亲自审看了关键帧、9 帧升起序列、8 帧叠化序列、8 帧连续雨序列及 10 个工具包。单帧为 1920×1080，有效画面约 2.39:1；两列大图联系表宽 1920，审图版不超过 1600。静态截图不能代替独立审美审核，QA 无黑帧/冻结也不能证明场景完成度。

完整浏览器验收通过：Chromium 153.0.8010.12、Mesa llvmpipe、默认自动播放策略，外部请求和页面/着色器错误均为零；resize 与连续提交的异步 seek 队列通过。实时请求 high 在软件后端实际降为 low，显式 final 仍走完整后期。受限双线程下，6 个稳态采样的 seek 加 GPU 回读中位数约 1.48 秒、最大 1.91 秒；这是共享服务器软件后端的测量，不是目标设备帧率。启动的浏览器和 Xvfb 均记录 PID 并等待退出。

与授权参考静帧相比，云层、月晕、水面、景深、胶片颗粒和调色能力已恢复；当前样片的场景密度、山体细节、雨夜空间的光线层次仍不及参考中最成熟的镜头。**不将“画质达到或超过参考”记为已通过**。高位镜头的人物很小，脚印轮廓仍偏规则；植物叶片和薄雾有近似，水膜不是流体模拟，雨光使用解析光源近似。

真实歌曲和音画同步、项目字体实际子集、真人、目标 GPU/手机及生产环境均未验证。G1/G3 留待独立审核；G2 属于独立角色任务。本次无部署、无推送。

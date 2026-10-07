# 三维电影引擎

原创通用实现，未读取或复制来源作品代码。唯一随附第三方运行时为本地 three.js，许可见 vendor/LICENSE。所有几何、材质与示范场景均程序生成；不附带任何模型、图片、音频或视频素材。

`core` 编排 `world.at(t)` → 场景更新 → `cameraAt()` → HDR 渲染 → `post`。实时播放时钟与离线 seek 调用同一个函数；随机只用整数哈希。场景不能把上一帧状态作为当前画面的输入。所有模块的 README 与 example.js 可独立阅读。

生成项目会复制 engine/、character/、sample/、directing/ 到项目根目录。`sample/shots.json` 是浏览器实际读取的完整镜头表，`sample/scenes.js` 注册场景。最小完整运行方法：

```bash
scripts/new-project.sh music-video cinematic-demo
node tools/serve.mjs --root projects/cinematic-demo --port 39920
```

浏览器暴露 `window.__scene={ready,canvas,duration,seek(t),capture(),dispose()}`。capture 返回 PNG data URL；透明 DOM 字幕需单独合成。离线渲染建议固定浏览器/后端/尺寸/种子/源码摘要，跨 GPU 只保证时间状态一致，不承诺逐像素一致。

单测与浏览器验收分别运行 `npm test` 和 `npm run test:cinematic`。质量标准与独立审核不能用代码测试替代。当前阴影与景深是实时近似，软件渲染不证明目标硬件实时性能。

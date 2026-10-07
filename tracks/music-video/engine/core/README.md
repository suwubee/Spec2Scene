# 确定性渲染核心

本地 three.js r170；半浮点 HDR 目标；seek 与实时播放同一路径。ready 在首次绘制后为 true，capture 返回同一画布 PNG data URL。所有时间单位秒，世界单位米，+Y 向上、+Z 角色前方。dispose 释放资源。浏览器必须支持 WebGL2 与半浮点颜色缓冲。场景 update 不可使用累计 dt 或 Math.random。

最小示例见 [example.js](example.js)：

```js
import {createEngine} from './index.js';
createEngine({canvas,shots,scenes,world,width:1280,height:720});
```

单测：仓库根目录运行 `node --test tools/test/cinematic.test.mjs`；core/post 的实际 GPU 路径另由 `node scripts/validate-cinematic.mjs --out validation/v0.2/artifacts/check` 验证。截图和性能结果是实现者证据，独立审核仍须签字。

# 电影相机与镜头表

分镜 JSON 连续覆盖时间轴；曲线使用镜头内相对秒。position/target 三维数组，focal 毫米、focus 米、fstop 光圈。dissolve 为入镜叠化时长，双场景 HDR 混合；breath 是可复现的平滑噪声。提供 orbit 构造环绕关键帧。

最小示例见 [example.js](example.js)：

```js
import {focalToFov} from './index.js';
focalToFov(50);
```

单测：仓库根目录运行 `node --test tools/test/cinematic.test.mjs`；core/post 的实际 GPU 路径另由 `node scripts/validate-cinematic.mjs --out validation/v0.2/artifacts/check` 验证。截图和性能结果是实现者证据，独立审核仍须签字。

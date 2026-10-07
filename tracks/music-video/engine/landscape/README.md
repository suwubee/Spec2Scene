# 程序化空间基础件

terrain 自定义 height(x,z)；water 有波纹与月光路径近似；vegetation 使用实例草/树；skyline 生成城市剪影与稀疏灯；room 是墙、窗光可组合的室内壳体。水面是程序反光近似，不是物理全场景平面反射。无外部模型或纹理。

最小示例见 [example.js](example.js)：

```js
import {terrain} from './index.js';
terrain({size:20,segments:20});
```

单测：仓库根目录运行 `node --test tools/test/cinematic.test.mjs`；core/post 的实际 GPU 路径另由 `node scripts/validate-cinematic.mjs --out validation/v0.2/artifacts/check` 验证。截图和性能结果是实现者证据，独立审核仍须签字。

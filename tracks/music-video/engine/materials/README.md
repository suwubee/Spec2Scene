# 材质与动机光

cloth/wood/stone/metal/glass/skin/snow 是 MeshPhysicalMaterial 参数化起点，程序微表面纹理不需要位图。lightRig 为方向主光、半球补光和投影阴影；windowLight 为有动机的局部暖光。预设不替代导演的色彩脚本。皮肤无完整次表面散射。

最小示例见 [example.js](example.js)：

```js
import {material} from './index.js';
material("cloth");
```

单测：仓库根目录运行 `node --test tools/test/cinematic.test.mjs`；core/post 的实际 GPU 路径另由 `node scripts/validate-cinematic.mjs --out validation/v0.2/artifacts/check` 验证。截图和性能结果是实现者证据，独立审核仍须签字。

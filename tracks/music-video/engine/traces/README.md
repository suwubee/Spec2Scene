# 痕迹与余温

footprints 为有出生时间的脚印凹面/边缘/湿润高光，可用于雪、湿地、沙地；fade 控制渐退，倒序 seek 会撤销未出生痕迹。地面必须在承载位置留出凹面，避免覆盖。afterglow 指数余辉，vapor 提供闭式上升水汽。

最小示例见 [example.js](example.js)：

```js
import {footprintState} from './index.js';
footprintState(4,2);
```

单测：仓库根目录运行 `node --test tools/test/cinematic.test.mjs`；core/post 的实际 GPU 路径另由 `node scripts/validate-cinematic.mjs --out validation/v0.2/artifacts/check` 验证。截图和性能结果是实现者证据，独立审核仍须签字。

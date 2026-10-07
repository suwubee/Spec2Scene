# 共享世界状态

hour/season/wind/fog/light/weather/motif 为默认通道，可增加任何数值或向量关键帧；端点保持、区间 smoothstep 插值。场景读取同一份 state。天气枚举建议另用段落选择，连续变量由曲线管理。

最小示例见 [example.js](example.js)：

```js
import {createWorld} from './index.js';
createWorld({wind:[[0,0],[60,1]]}).at(15);
```

单测：仓库根目录运行 `node --test tools/test/cinematic.test.mjs`；core/post 的实际 GPU 路径另由 `node scripts/validate-cinematic.mjs --out validation/v0.2/artifacts/check` 验证。截图和性能结果是实现者证据，独立审核仍须签字。

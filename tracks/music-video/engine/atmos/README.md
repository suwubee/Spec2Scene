# 天空与空气

sky 提供昼/夜/晨昏渐变近似、程序星空、月相球体；lightVolume 沿眼线在有限锥体内 16 步积分，场景深度测试负责遮挡。precipitation 支持 rain/snow/dust/fireflies；种子与时间闭式求值，循环边界需藏于取景范围外。雾使用真实深度随距离衰减，不依赖图片。

最小示例见 [example.js](example.js)：

```js
import {particleAt} from './index.js';
particleAt(4,2,{kind:"snow"});
```

单测：仓库根目录运行 `node --test tools/test/cinematic.test.mjs`；core/post 的实际 GPU 路径另由 `node scripts/validate-cinematic.mjs --out validation/v0.2/artifacts/check` 验证。截图和性能结果是实现者证据，独立审核仍须签字。

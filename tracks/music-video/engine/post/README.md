# HDR 与镜头后处理

线性 half-float HDR→薄透镜弥散圈景深→阈值 bloom→曝光→ACES 或 AgX 近似→可选 16³ LUT→暗角/颗粒/色差→sRGB。grain/vignette/aberration/bloom 设 0 关闭；useLut=1 开启 LUT。景深是屏幕空间近似，透明物与遮挡边界需要审图；AgX 为近似曲线，不是完整色彩管理实现。

最小示例见 [example.js](example.js)：

```js
import {circleOfConfusion} from './index.js';
circleOfConfusion(3,5,50,2.8);
```

单测：仓库根目录运行 `node --test tools/test/cinematic.test.mjs`；core/post 的实际 GPU 路径另由 `node scripts/validate-cinematic.mjs --out validation/v0.2/artifacts/check` 验证。截图和性能结果是实现者证据，独立审核仍须签字。

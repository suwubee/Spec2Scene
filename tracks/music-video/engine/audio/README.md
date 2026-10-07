# 音乐数据与播放时钟

musicAt 读取 beats/bars/sections/energy/vocalActivity，全部为主时间轴绝对秒。createClock 支持静音时钟或用户提供的 HTMLMediaElement；真实音频只在可信用户点击里 play，保留浏览器默认自动播放策略。暂停和 seek 重设基准，离线渲染直接用 seek。

最小示例见 [example.js](example.js)：

```js
import {musicAt} from './index.js';
musicAt({beats:[0,.5,1],beatsPerBar:4},.75);
```

单测：仓库根目录运行 `node --test tools/test/cinematic.test.mjs`；core/post 的实际 GPU 路径另由 `node scripts/validate-cinematic.mjs --out validation/v0.2/artifacts/check` 验证。截图和性能结果是实现者证据，独立审核仍须签字。

# 同时间轴字幕叠加

逐句/逐字时间表支持乱序访问；DOM 使用 textContent 防止 HTML 注入。默认安全区左右/底部 8%，最多两行。字幕为可选叠加层，主画面仍为 three.js 三维。canvas.capture 不含 DOM；离线带字幕应单独合成叠加层或使用整页截图，不能声称裸画布含字幕。示例无任何具体歌词。

最小示例见 [example.js](example.js)：

```js
import {subtitleAt} from './index.js';
subtitleAt([{start:0,end:1,text:"<placeholder>"}],0.5);
```

单测：仓库根目录运行 `node --test tools/test/cinematic.test.mjs`；core/post 的实际 GPU 路径另由 `node scripts/validate-cinematic.mjs --out validation/v0.2/artifacts/check` 验证。截图和性能结果是实现者证据，独立审核仍须签字。

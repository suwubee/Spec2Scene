# 同时间轴字幕叠加

逐句/逐字时间表支持乱序访问；DOM 使用 textContent 防止 HTML 注入。默认安全区左右/底部 8%，最多两行。字幕为可选叠加层，主画面仍为 three.js 三维。canvas.capture 不含 DOM；离线带字幕应单独合成叠加层或使用整页截图，不能声称裸画布含字幕。示例无任何具体歌词。

最小示例见 [example.js](example.js)：

```js
import {subtitleAt} from './index.js';
subtitleAt([{start:0,end:1,text:"<placeholder>",locked:true}],0.5);
```

单测：仓库根目录运行 `node --test tools/test/cinematic.test.mjs`；core/post 的实际 GPU 路径另由 `node scripts/validate-cinematic.mjs --out validation/v0.2/artifacts/check` 验证。截图和性能结果是实现者证据，独立审核仍须签字。

v0.3.1：所有适配器只显示 `locked:true` 行，示例旧数据请显式加锁。`subtitleLayer(element, lines, {fontFamily,fontSize,direction:'horizontal'|'vertical'})` 设置 DOM 字体/方向。原生 `createLyrics` 接受 tools/music/lyrics 输出作为 song，config.fontFamily/titleFontFamily/direction 设置项目排版；电影引擎传 `{alignment,lyrics:true,fonts}` 即可。原生画布字幕位于后期最后一步，能随主画布捕获；DOM 仍需额外合成。空白帧会清空字幕画布，正向/倒序 seek 均不残留上一行。

完整对齐、校正与锁定说明见 [歌词管线](../../../../tools/music/lyrics/README.md)。

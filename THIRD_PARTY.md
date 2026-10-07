# 第三方依赖与用户素材边界

仓库原创方法、模板和工具为 Apache-2.0。仓库仅附带下列许可明确的 three.js 运行时源码，不附带媒体、模型或数据集；package-lock 固定 Node 依赖，由用户安装，Python 工具依赖在独立环境安装。下表是工程依赖提示，实际发布以取得版本随附的许可证为准。

| 依赖/工具 | 用途 | 许可核对 |
|---|---|---|
| three.js 0.170.0 / r170 | 本地三维渲染；原版压缩模块 | MIT；[许可证](tracks/music-video/engine/vendor/LICENSE)、[来源与固定哈希](tracks/music-video/engine/vendor/README.md)；保留原始版权通知 |
| Playwright | 浏览器自动化 | Apache-2.0；下载的浏览器及组件各自许可 |
| sharp | 图像测量与联系表 | Apache-2.0；原生图像库及编解码依赖保留其许可，含 libvips 的 LGPL 条款 |
| MediaPipe Tasks Vision | 用户项目本地识别 | 下载运行时随附许可；模型卡与模型使用条款独立核对 |
| librosa / numpy / matplotlib / soundfile | 音乐分析与图表 | 各软件及底层库独立开源许可，发布环境按版本收集 |
| edge-tts 或替代引擎 | 构建时语音生成 | 客户端软件许可不等于语音服务/声音的商用许可 |
| FFmpeg / rubberband | 编码、响度、保音高变速 | 系统工具不同构建可能有 LGPL/GPL 与编解码授权条件，重分发前检查 |

用户放入项目的歌曲、地图、照片、视频、语音、字体和模型不受本仓库代码许可自动覆盖。用项目 docs/licenses.md 记录权利来源、署名、用途、商用及再分发权限；仅研究/本地测试的受限数据不进入发布包。

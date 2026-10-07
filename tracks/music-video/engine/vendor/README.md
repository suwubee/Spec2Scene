# Vendored runtime

three.js 0.186.0 / r186，MIT，保留原始 LICENSE。完整引擎依赖 r186 的 WebGL2 shader chunks 与材质接口，因此从原运行时 r170 升级。运行时为官方 build/three.module.js 与 build/three.core.js；BufferGeometryUtils.js 仅把 three 导入改为本地相对路径。

官方端点：`https://registry.npmjs.org/three/-/three-0.186.0.tgz`。三个文件最终 SHA-256 记录于 manifest.json，卫生检查逐一验证。无示例媒体、模型、字体、纹理。技术引用与标准许可保留第三方原署名，不改写成项目作者。

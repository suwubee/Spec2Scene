# 三维模拟工具入口

通用实现统一维护在 [tools](../../../tools/README.md)，生成项目复制到 tools.local/，避免多份不一致脚本。

截图与亮度/重叠：snap.mjs；路线定位帧：render-frames.mjs（需 seek(t)）；静态运行：serve.mjs；发布与解压验证：deploy/ 与 package/。拓扑、坐标、地形与来源验证在项目 tests/ 按真实输入实现。

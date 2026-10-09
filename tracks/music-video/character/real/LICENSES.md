# 外部写实人物资产许可说明

仓库只提供获取脚本、固定版本和校验值；GLB、动画包、贴图与 Blender 解压目录必须留在被忽略的 `projects/<name>/assets/char/` 和 `projects/<name>/tools/`。下载后把实际文件摘要、日期和项目授权记录写入项目自己的 `assets/char/LICENSES.md`。

| 输入 | 固定版本 | 许可边界 | 运行时处理 |
|---|---:|---|---|
| MPFB2 | 2.0.17 | 扩展代码 GPL；由其生成的角色输出按上游 CC0 记录核对 | 只读取用户项目中的 GLB |
| MakeHuman system assets | CC0 资产包（固定 SHA） | CC0 资产可用于生成输出，仍须保存来源与摘要 | 不随仓库分发 |
| Quaternius Universal Animation Library | Standard（固定 SHA） | CC0；下载页的签名地址会变化，下载时重新核验页面许可 | 片段重定向到项目骨架 |
| Blender portable | 4.5.9 | GPL-2.0-or-later 的构建工具，不进入作品许可 | 只在项目 `tools/` 中以 headless 模式运行 |

Mixamo、CMU 和任何需要登录或不可再分发的数据不由脚本下载。用户必须确认来源许可、衍生输出范围和商业/再分发条件；没有真实资产时测试使用程序化夹具，并标记为 SKIP。

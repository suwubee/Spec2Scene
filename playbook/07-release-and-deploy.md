# 发布与部署 / Release

测试和部署是两个独立阶段。先在明确版本运行验收并归档退出码，全部必要测试通过才生成发布候选。部署工具只接受绑定发布树摘要的通过证据；准备并审核版本、配置、回滚目标后才显式激活。不得在测试命令后用分号无条件接部署。

代码放版本化目录，入口 HTML 不缓存，带版本/内容哈希的资源可长期 immutable。同名长期缓存资源内容变化必须拒绝，改名并更新引用；保留旧目录供已打开页面和回滚使用。子页面、动态 import、CSS url、Worker、import.meta.url 的资源引用都要验证。

部署后按配置冒烟检查入口、模块、WASM、模型、字体、音频、JSON、Worker：状态码、MIME、Cache-Control、Content-Length/Range 以及本地 SHA-256 与实际响应体一致。字节一致不证明交互正常，还要默认浏览器走一次开始→运行→结束，核对外连和缓存升级。

PWA：HTML 网络优先+离线回退，版本代码缓存优先；SW URL/版本更新、activate 清理旧缓存，已用资源可离线；缓存只免下载，不免 WASM/模型初始化。空闲预取有预算，saveData/慢网禁用，进入任务即取消。

代理配置由已获授权的管理员处理。备份→语法检查 `nginx -t`→重载→线上验证。location 新增 add_header 会改变继承，须在实际响应中确认 HSTS/CSP 保留。模块 .mjs 和双扩展名 .wasm.bin 的 MIME 单独核对。证书续期沿用既有 ACME 所有者，检查 CDN 下验证路径直达性、跳转/缓存规则、到期监控，不另起一套争抢证书。

配对服务只选一个管理器；面板/pm2 存在管理冲突时，经授权迁移为单一 systemd 服务，明确用户、工作目录、环境、端口与回滚。基准脚本不执行这些系统变更。

English: Gate release on tests for the exact artifact. Prepare an immutable version, activate separately, compare served bytes and headers, and exercise the real browser flow. Roll back the active pointer on failure; keep previous versions and compatible assets.

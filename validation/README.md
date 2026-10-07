# 基准验收

基准验收分为内容净化、经验覆盖、通用工具、三产线生成和本地提交。完整文件清单见 files.txt；逐项问题对照见 coverage.md；实际命令输出见 results/。

```bash
npm ci
npx playwright install chromium
scripts/doctor.sh
npm test
npm run test:browser
.venv/bin/python tools/music/analyze_song.py --selftest
.venv/bin/python tools/voice/gen_voice.py --selftest
```

Python 环境按 tools/README.md 准备。浏览器验证需访问官方包与模型下载源，模型只放临时生成项目；测试模拟相机权限并使用软件图形后端，不放宽自动播放策略。先无点击进入流程，再验证程序触发的点击不能解锁声音，最后通过可信点击开启音频。真实授权人体数据未提供时明确 SKIP，不能把它写为已验证真人精度。

生成验证依次生成 motion-games/demo-a、music-video/demo-b、3d-simulation/demo-c，检查每个项目的结构和 npm test，在回环端口段 39920–39939 启动实际 tools/serve.mjs 子进程。测试渲染复现、编码/解码、音画长度、联系表、截图的 L* 与指定区域相交、视频抽帧评测接口和发布包解压启动。finally 按保存的 PID 结束并 wait，删除且仅删除本轮生成的演示目录；若已有同名项目则拒绝覆盖。

内容检查对所有待提交文件及未被忽略的工作文件运行文本 grep，禁止词表由审核任务在仓库外提供，避免扫描器自身带入具体作品名称。另枚举文件扩展名和 NUL 二进制标记，确认没有媒体/模型/数据集，projects/ 仅保留 README。依赖安装目录、虚拟环境、Git 内部数据不属于发布源文件，不进入内容扫描或提交。

测试与部署全程分离：单测只在自己的临时目录验证部署工具，不操作任何生产站点或系统服务。未部署、未推送。浏览器软件环境与实体手机/真人效果的差异已记在 results/notes.md。

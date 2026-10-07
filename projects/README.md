# 项目输出

所有项目使用 `scripts/new-project.sh <track> <name>` 生成到 `projects/<name>/`，名称允许小写字母、数字与短横线。产线为 music-video、3d-simulation、motion-games。

每个项目拥有独立源码、素材、数据、文档、测试、工具和输出。projects/* 均被 Git 忽略，仅此 README 被跟踪。先验证素材授权，再放入 assets/；大帧序列先确认磁盘空间。项目可单独初始化 Git 并选择自己的发布内容。删除前核对项目名，生成器绝不覆盖或清理已有目录。

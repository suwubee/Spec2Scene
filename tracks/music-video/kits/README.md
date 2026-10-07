# 参数化场景工具包

通用构件从授权代码抽出，保留材质、几何和动画算法。工厂使用引擎 ctx，返回 `{scene,camera,update(t,world,camera),dispose()}`；道具工厂返回 `{object,update,dispose}`。位置采用局部坐标或显式 placement 数组；项目布局、现场追踪坐标、原场景和研究数据不随库分发。

[port-manifest.json](port-manifest.json) 记录 6 个成熟道具模块、8 个植物模块及 4 个石材/铺装模块的来源和移植后字节摘要。来源以授权快照组和模块相对路径标识，不写来源作品身份或机器路径；雪原、站台及场景组合工厂是本仓库新建的通用适配层。

| 工具包 | 构件 / 主要参数 | 试验台 |
|---|---|---|
| snowfield.js | 新雪地高度场、真实凹陷脚印、移植山岭/天空/雾/雪粉；seed、tracks、mountains | bench/snowfield.html |
| station.js | 平台/雨棚/轨道、立体楼群、灯下雨、水膜实际反射；seed、lamps | bench/station.html |
| river.js | 完整地形、水面、共享高度雾；terrain.{banks,layout,gaps}、ground、water、surface | bench/river.html |
| interior.js | 房间壳、窗洞、卷帘、纱帘、油灯、光束、尘埃；width/depth/height、windowWidth/Height/Y、lightPosition | bench/interior.html |
| architecture.js | 真实弯瓦檐、柱梁、栏杆、灯笼；length、bays | bench/architecture.html |
| garden/ | plane-cut 石块、穿孔 SDF 假山与 surface nets、石材苔纹/铺装、梅树；seed、stones、treeHeight | bench/garden.html |
| vegetation.js / plants/ | 分种树冠、叶图集、3级 LOD/远景合批、风动；显式 items、grass/reeds | bench/vegetation.html |
| lantern.js / oilLamp.js | 纸灯笼肋骨、火焰、真实灯光，油灯厚壁瓷与灯芯；位置、增益、parameters 名、outAt | architecture / interior |
| eaves.js / latticeWindow.js / gauze.js | 瓦、椽、窗格、卷帘、GPU 布面；局部尺寸、roll、风参数 | architecture / interior |
| plumBranch.js | 梅枝/树、花芽开放、弹簧摆动、花瓣朝向；anchor、bloom、seed、LOD、显式 openTimes | garden |

植物只保留生成、图集、材质和 LOD；不附带任何现场 placement、追踪、区域或研究数据。园林石材不附带专属地标造型。`anchor` 接受 `[x,y,z]` 或 `{pos,dir,roll,scale}`；灯具从 `world.parameters[name]` 读取亮度，不读取人物专属字段。

另外有 `bench/sky.html`、`bench/materials.html`、`bench/particles.html` 用同一完整引擎检查天空、材质与 FX。打开生成项目中的页面，附 `?quality=final&w=1920&h=1080&t=4`；`&day=1` 用于日光下审查几何。没有任何图片/字体/模型文件是试验台依赖。

```bash
node scripts/validate-cinematic.mjs --root projects/cinematic-demo --out projects/cinematic-demo/out/review
# 仅查看工具包
node scripts/validate-cinematic.mjs --root projects/cinematic-demo --benches-only
```

每页产生 1920×1080 关键帧，`*-sheet.png` 大图联系表以两列、每格 960 像素排列；`*-review.png` 是 1600 像素宽的审图版本。截图只进入项目 out/，不提交仓库。试验台证明构件能接入与渲染；场景美术与独立审核需要额外看图。角色目录属于独立实现任务，样片默认使用远景或剪影。

# 程序角色：中远景与剪影

本模块面向**中远景可信、剪影清楚的表演**。默认不戴帽；服装和道具由项目选择。没有可信的近景资产时，用背影、剪影、局部、痕迹与空间表达。程序脸有颅面结构，五指能弯曲，但不承诺照片级脸、近景手部皮肤或完整布料碰撞。

仅依赖引擎提供的同一份 `vendor/three.module.js`；数学、材质、审核台均在角色目录中。不会调用或修改电影后期、场景或引擎的光照实现。

```js
import {createCharacter, inspectRig} from './character/index.js';
const actor = createCharacter({
  body: 'feminine', // 形态预设，不是身份推断
  height: 1.66, headRatio: 7.4, shoulderWidth: 1,
  coat: true, coatStyle: 'long', scarf: true, coatColor: 0x635346,
  hairStyle: 'ponytail', prop: 'lantern',
});
scene.add(actor.object);
const pose = actor.update('walk', 2.5, {speed: .38, wind: .5});
const report = inspectRig(actor.rig, pose);
```

`feminine` 默认 1.66m、7.4 头身，`masculine` 默认 1.78m、7.6 头身。女性独立设置肩、胸廓/胸部、腰、髋、细颈、小手和柔和下颌，不能以整个人等比缩小替代。

`height` 为米（1.2–2.2），`headRatio` 为头身比（6.5–9），`shoulderWidth` 是肩宽倍率（0.8–1.2）。`posture` 调节头部基础俯仰；`backpack`、`hat` 默认关闭。比例极值需要项目重新拍审核图；本轮采样覆盖两种体型、1.55m / 1.90m 与相应肩宽组合。

## 几何与蒙皮

- `surface.js` 沿胸、腰、臀、上臂/前臂、大腿/小腿截面放样，再把场融合为一个焊接、封闭、连通的躯干与四肢网格。主体是真正的 `SkinnedMesh`，每个顶点最多四个归一化权重，不是把若干刚体网格放进同一个 Group。
- 肩部按场的距离平滑混合。手臂、躯干与腿的权重分区避免“抬手拉起腰部”。每条前臂另有三段扭转骨骼，分散旋前，防止大角度旋转在肘部挤成细线。
- `coatStyle` 提供 `long` 长大衣、`cloak` 风帽长斗篷、`short` 短外套，均为独立蒙皮壳。领口、袖口、下摆开口有内层和缝合边，壳厚 7mm；袖口、立领与翻领有厚度。下摆裁口投影到平面，短外套下摆不裁断袖子。衣摆按步态与风作闭式变形，并用腿部包络近似避免默认行走时膝盖穿出；围巾为 7mm 厚的螺旋交叠布条、布结及两条不同长度的尾端，截面随中心线转动，风中保持布条宽度；没有圆环。头发提供 `shoulder` 齐肩发、`ponytail` 低马尾、`bun` 发髻及兼容的 `short`，用有体积的渐细发束随风运动。它没有布料求解器，也不提供坐姿的布料碰撞保证。
- 每只手是连续掌指表面，五指各三节骨骼；拇指有基础对掌动作。头部由连续颅面表面及眼睑、眼球、唇、耳、头发附件构成。头部和手部细节是附件，不把所有材质与五官强行焊成同一网格。
- 短靴由沿脚长变化的鞋楦、鞋底、独立后跟和踝筒构成，前后接触端点与脚跟/脚尖步态一致。
- 女性与男性脸型分别雕刻；缩小鼻梁/鼻尖，使用球体眼球、包覆眼睑和唇体积。皮肤使用克制的暖色包裹光近似，不是物理次表面散射。没有贴图、外部模型、纹理或默认歌曲。

## 动作与坐标

+Y 向上、+Z 向前。`L` 在角色自身的 +X 一侧。肘向前、膝向后弯曲，符号固定在 `hingeAxis` 中，所有控制经过弧度限位。前臂旋转的零点是绑定姿态；自然下垂时掌心朝向大腿，推窗时经旋前与伸腕使掌根朝前。

`motion.js` 提供 stand / walk / stop / turn / sit / rise / pushDoor / pushWindow / shade / embrace / bow / lookUp / windWalk，加 `lanternWalk`、`bagWalk`、`holdCup`、`phone`。`update(action, t, options)` 不积累状态，倒序 seek 可复现。行走按距离采样，一周期 0.9m，同侧脚下一次接触前进 0.9m；默认速度 0.38m/s 是缓慢步行。支撑占周期 62%，有脚跟着地、平脚、前掌蹬离、摆动。锁定的是**当前脚底接触点**，允许脚踝围绕脚跟或前掌转动。中段支撑膝屈曲限制 0.48rad（0 为伸直），不能以持续屈膝代替重心起伏。

骨盆与肩反向扭转，同侧手臂与腿前后相反，对侧手臂与腿同向；重心左右转移与上下起伏来自足端约束。推窗/推门有预备、重心前移、肩带动、肘先屈后伸和掌根推送；它们是基础表演，项目仍需按实际门窗布置接触目标。呼吸作用于胸部，颈部补偿减少头部晃动。动作阶段使用缓入缓出；停止包含速度逐渐降到零的制动段，然后双脚落稳。坐下/起立需要项目提供家具位置。

手势 `handPose`：`relaxed`（自然半屈）、`carry`（围绕柄部握持）、`open`（掌心向上展开）、`touch`（食指伸出、其余半屈）、`smooth`（掌心向下平展）。保留 `rest`、`fist`、`point` 兼容名称。放松时食指/中指/无名指/小指 MCP 屈曲分别为 15° / 22° / 28° / 34°；局部掌面为 +Z、指甲为 −Z，负 X 旋转朝掌面屈曲。检查同时验证递增、实际指端方向、任何关节超过 10° 过伸的拒绝；控制器进一步将伸展限为 0°。拇指根在掌的侧下部，并有连续大鱼际体积。

`prop` 可选 `none` / `lantern` / `bag` / `cup` / `phone`。四种道具均为本模块程序几何：提灯的提环顶端跟随握持点，左臂自然下垂，灯体绕握点摆动；帆布包肩带沿外套肩面；双手以两骨 IK 捧杯；手机姿态低头并由屏幕局部灯照脸。也可用对应动作快捷入口 `lanternWalk`、`bagWalk`、`holdCup`、`phone`。这些通用道具不是具体作品资产，手的接触为尺寸约定，用户替换道具需按半径重新调节。

`expression` 为 neutral / concern / resolve / tired；`viseme` 是 0..1 的粗略嘴部形变，没有数据时保持闭口，不等同口型同步。`deformClothing:false` 仅用于骨架采样，会跳过衣摆、围巾和发束顶点更新；作品渲染与浏览器验收必须使用默认的完整形变。

## 用户模型接入

仓库不附带或下载角色资产。用户负责模型、贴图、动画与衍生作品的使用许可，把它们放在自己的被忽略项目中。适配时必须传入 `license` 说明，项目应另外保存正式授权记录。

项目安装与当前 THREE 同版本的 `GLTFLoader`，把加载器作为参数传入；读取 `.gltf` 或 `.glb`。VRM 使用项目安装的 `VRMLoaderPlugin`，注册到该加载器后读取 `.vrm`，适配器读取 `gltf.userData.vrm.humanoid.getRawBoneNode()`。原有模型应处于绑定/静止姿态，停用会竞争写入同一骨骼的 AnimationMixer 或 VRM humanoid 动画更新。

```js
import {loadExternalCharacter} from './character/index.js';
// loader 由项目创建；VRM 项目在此 loader 上注册 VRMLoaderPlugin。
const avatar = await loadExternalCharacter({
  url: './assets/user-avatar.glb', loader,
  license: '项目内授权记录的标识',
  mapping: {
    hips: 'Hips', chest: 'Chest', neck: 'Neck',
    leftUpperArm: 'UpperArm_L', leftLowerArm: 'LowerArm_L', leftHand: 'Hand_L',
    rightUpperArm: 'UpperArm_R', rightLowerArm: 'LowerArm_R', rightHand: 'Hand_R',
    leftUpperLeg: 'UpperLeg_L', leftLowerLeg: 'LowerLeg_L', leftFoot: 'Foot_L',
    rightUpperLeg: 'UpperLeg_R', rightLowerLeg: 'LowerLeg_R', rightFoot: 'Foot_R',
  },
});
scene.add(avatar.object);
avatar.update('walk', 1.5);
const result = avatar.inspect(); // PASS / FAIL，检查实际映射后的关节与足底锚点
```

也可直接 `adaptExternalCharacter({scene, mapping, license})`，映射值可以是唯一节点名或骨骼节点。VRM 可省略映射，显式字段优先于 VRM 自动映射。指骨使用 VRM 1 的名字，例如 `leftIndexProximal/Intermediate/Distal` 和 `leftThumbMetacarpal/Proximal/Distal`。缺失指骨会报告 `capabilities.fingers='PARTIAL'` 及缺失列表，不能当作手指检查通过。

接入要求与边界：

- 模型预先整理到 +Y 向上、+Z 朝前，地面位于足底；所有对象和骨骼使用正的均匀缩放。坐标朝向和脚底厚度需要用户按资产核对；`footHeight` 默认归一化 0.085m。
- 强制检查映射完整性、唯一性、骨架归属和父子链，拒绝零骨长。通过绑定方向校正适配不同骨骼局部轴；按实际骨长重算腿 IK。模型的原始权重与材质保留。
- `update()` 先对统一控制骨架执行关节限位，再重定向。`inspect(previousReport)` 检查实际关节的骨长、角度、相对躯干位置、足底高度和连续支撑滑移，并检测映射骨骼偏离已限位姿态。极端比例或脚形可能 FAIL，不能只凭控制骨架通过就忽略资产报告。
- 不自动重做坏拓扑、修复资产蒙皮或转换缺失的手指；不驱动 VRM 表情、弹簧骨和所有原动画。没有提供获授权的真实 glTF/GLB/VRM 时，真实资产回归明确 SKIP；测试夹具只证明接口和数学。

## 写实人物管线（推荐路径）

需要中景或写实比例时，使用 `character/real/` 的通用适配层。项目先在自己的被忽略目录准备获授权的 MPFB2/MakeHuman GLB，再把项目拥有的 `GLTFLoader` 和许可记录传给 `prepareRealCharacter({url, loader, license})`。适配器会检查骨骼映射、父子链、均匀缩放、零骨长和足底锚点；没有资产时返回带有 `fallback` 原因的程序化人物，不能把程序夹具写成真实识别或真人验证。

Quaternius UAL 的 CC0 动作片段通过 `retargetUALClips()` 重命名到目标骨架。走类片段保留目标骨长，站、呼吸、抬头、推窗和坐姿手放膝上由仓库统一动作控制器叠加；`update()` 仍与 `createCharacter()` 接口相同。片段驱动的 `inspect()` 会标记 `SKIP`，项目必须另拍正侧连续序列并检查接触与衣料。

写实人物的默认外观是深色剪影：导入材质换成 `MeshPhysicalMaterial`，`specularIntensity:0`、粗糙度 1、环境光镜面为 0；长大衣/斗篷、围巾与低发髻由程序壳生成。`createOuterEdgeMaskPass()` 在预热时编译固定程序键的遮罩 pass，每帧只更新纹理，不根据人物实例增删 shader 变体；它只用于外缘轮廓光，仍需项目的实时与视觉审核。

在同一写实比例、去掉贴图和不可见辅助网格后，参考预算从约 **41.6 万三角形、103 个网格** 收敛到约 **5.2 万三角形、10 个网格**。这是资产整理与程序壳的目标预算，不是任何用户模型的保证；导入后应记录实际三角形、网格、材质和纹理计数，并在目标硬件复测。

资产获取由 `scripts/fetch-character-assets.sh --project projects/<name>` 完成：版本和 SHA-256 固定，下载只写入项目的 `assets/char/` 与 `tools/`，Blender 通过 `--background` headless 导出 GLB。UAL 的签名下载地址会变化，脚本要求用户在核对 CC0 页面后显式提供地址和摘要；Mixamo/CMU 只保留用户自取说明。许可和实际摘要写项目内 `assets/char/LICENSES.md`，仓库不保存模型、动画、贴图或生成文件。

## 验收与审核图

```bash
SCENE_TEST_PORT_MIN=39920 SCENE_TEST_PORT_MAX=39929 npm test
node tools/check-anatomy.mjs --out out/character-check/anatomy.json
node tools/test/character-browser.mjs --out out/character-review --port 39920
```

可用 `--sequence lanternWalk` 复拍单个动作（含道具正侧姿势与雪地序列）。持灯动作的侧视相机从持灯侧拍摄，避免身体遮住提环。

输出目录必须已被 git 忽略且不存在；父目录先自行建立。审核器仅使用 127.0.0.1:39920–39929，单浏览器、默认自动播放策略和 SwiftShader，记录服务 PID 并按 PID 结束、等待退出。若浏览器安装在项目专用目录，可设置 `PLAYWRIGHT_BROWSERS_PATH`；不要复用其他任务缓存。

审核台也可用仓库本地服务打开 `tracks/music-video/character/review.html`，选择女性/男性、三款衣服、四种发型、道具、动作、时间、正/侧/背面与雪地逆光；手部近景将左臂展开，以免躯干遮挡掌面。生成项目的对应地址为 `character/review.html`。灰底审核使用主光/补光/轮廓光，细节光源随相机调整；雪地模式使用固定低角度逆光与侧光。浏览器验收只使用 127.0.0.1:39920–39929。

自动输出正/侧两行的女性/男性 × 长大衣/斗篷/短外套/毛衣转台、八向转台、全部 17 个动作的正/侧各八帧、行走/提灯行走/风中行走/推窗/推门的外套对照、正/3⁄4/侧脸，以及五种手势的掌面/侧面特写、三种女性发型、鞋、四种道具姿势。新增雪地低角度逆光/侧光：每个动作远景与中远景各八帧，行走/提灯/风中行走另拍风帽斗篷版本。**每一格直接保留 600×800 像素**，不压进横向小缩略图。还验证新建项目测试、样片 seek、倒序/刷新后的 PNG 字节一致、浏览器错误与外部请求。

人体检查包含骨长、固定铰链方向、关节范围、手端与躯干、足底支撑、滑移、支撑相膝角、摆臂相位和指节屈曲、放松手指递增和过伸拒绝。关节采样用 `deformClothing:false` 跳过衣摆顶点更新，衣服必须另看完整浏览器序列。npm test 另检验主体连通性/封闭性、归一化权重、双层壳、肘部体积、动作错误注入、外部模型不同绑定轴与单位。

离散人体检查不证明全网格无自碰撞；几何指节限位不证明手指之间不接触。所有失败轮保留，修复后再拍。同版本 G2 仍须独立审核人逐张看图；自动通过、软件截图和实现者自审都不能代签 G2 或目标硬件性能。

## 接触、非站姿与口型

`actor.update(action,t,{jawOpen,mouthRound})` 控制下颌与口腔，参数均为 0–1；`viseme` 保留为 jawOpen 的兼容入口。下半脸变形、下唇、暗口腔与上牙同步更新；不是音素识别或完整面部表情模型。没有音频驱动时需项目提供时间包络。

`lie` 是静态仰卧姿势，可与现有 sit/rise 一起接受人体检查。姿态记录 standing/seated/lying，除骨长、限位和穿透外，检查坐姿骨盆/卧姿胸背与显式支撑面的高度误差。生成动作中的支撑高度按角色父空间缩放；自定义 `pose.bodySupports=[{joint:'pelvis',offset:[0,-.1,0],height,tolerance}]` 默认 height 为世界坐标。支撑面需项目实际放置；检查器不会猜测床和椅子的几何。当前 lie 不包含躺下/起床过渡，衣料和软组织接触仍需逐帧检查。

`actor.update('stand',t,{handTargets:{L:{position:[x,y,z],offset:[0,-.075,.02],tolerance:.015}},ik:{iterations:36}})` 用现有肩/肘限位求解手掌接触。坐标是世界空间，offset 是手端骨局部坐标；目标可来自墙、窗或道具握点。返回的 pose.ik 含 errorMetres/reachable，inspectRig 的 contactReport 再独立测量真实末端位置。不可达目标保持受限姿态并报接触误差，不冒充成功。不包含腕部法线约束或手指自动包覆。

复验工具 `tools/test/feedback-browser.mjs` 保存坐/卧/张口/接触动作的正、侧连续联系表，并验证倒序 seek。它使用 39920–39929 时可设置 `SCENE_TEST_PORT_MIN=39920 SCENE_TEST_PORT_MAX=39929`；同版本的独立 G2 审核仍由审核人完成。

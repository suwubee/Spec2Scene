# 外部写实人物适配层

`real/index.js` 是项目拥有资产时的可选路径。项目在自己的被忽略目录中放置获授权的 MPFB2/MakeHuman GLB，把项目创建的 `GLTFLoader` 传给 `prepareRealCharacter({url, loader, license})`，在启动阶段预载一次：

```js
import {prepareRealCharacter} from './character/real/index.js';

const makeActor = await prepareRealCharacter({
  url: './assets/char/body.glb', loader,
  ual: './assets/char/ual.glb',
  license: '项目 docs/licenses.md 中的记录',
});
const actor = makeActor({coatStyle: 'long', scarf: true, bun: true});
scene.add(actor.object);
actor.update('walk', time);       // 站、走、抬头、推窗、sitKnees 等统一动作
actor.installOuterEdge(scene);   // 只安装 scene.onBeforeRender 钩子；遮罩在主 pass 开始时用最终相机画（beforeRender 为兼容别名，不画东西）
```

适配器检查骨架映射、父子链、零骨长、均匀缩放和足底锚点；映射缺失会明确失败。Quaternius UAL 的片段通过 `retargetUALClips()` 重命名到目标骨架，程序动作仍使用仓库的统一限位和坐姿手放膝上控制。导入动作的 `inspect()` 返回 `SKIP`，因为离散片段需要项目自己的连续序列复核。

模型材质会换成 `MeshPhysicalMaterial`，`specularIntensity: 0`、粗糙度 1、环境光镜面为 0；这是深色剪影的固定规范。长大衣/斗篷、围巾和低发髻是程序几何壳，资产缺失时工厂降级到 `createCharacter({hairStyle:'bun'})`，并在工厂上留下 `fallback` 原因。仓库不保存 GLB、UAL、贴图或 Blender；许可、SHA-256 和真实资产只能记录在用户项目中。

外缘轮廓光（`rim.js`）：人物创建时一次建好遮罩目标、遮罩材质与固定程序键 `character-outer-edge-v2`，并给人物的受光材质注入外缘轮廓光。遮罩**只在 `scene.onBeforeRender`（主 pass 开始）用当次最终相机和主 pass 目标尺寸**重画并完整清空；外缘 = 1.5/2.6/4.2 遮罩像素外的 8 向采样（≈1.5 px，窄缝不算）；强度 = Σ 平行光 × 受光侧 × 逆光度 × 0.06。旧实现把遮罩放在 `beforeRender` 里懒建、固定 512²、常数强度，且在场景 update 阶段用尚未加手持抖动的相机绘制，会产生抠图式白描边——`rim-lab.html?mode=legacy` 保留了这一失败以供对照。规范与常见错误见 [角色 README](../README.md#人物外观规范与外缘轮廓光写给任何接手的模型)。它不代替独立视觉审核。

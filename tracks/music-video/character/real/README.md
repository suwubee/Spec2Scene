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
actor.beforeRender?.(renderer, scene, camera); // 外缘遮罩 pass
```

适配器检查骨架映射、父子链、零骨长、均匀缩放和足底锚点；映射缺失会明确失败。Quaternius UAL 的片段通过 `retargetUALClips()` 重命名到目标骨架，程序动作仍使用仓库的统一限位和坐姿手放膝上控制。导入动作的 `inspect()` 返回 `SKIP`，因为离散片段需要项目自己的连续序列复核。

模型材质会换成 `MeshPhysicalMaterial`，`specularIntensity: 0`、粗糙度 1、环境光镜面为 0；这是深色剪影的固定规范。长大衣/斗篷、围巾和低发髻是程序几何壳，资产缺失时工厂降级到 `createCharacter({hairStyle:'bun'})`，并在工厂上留下 `fallback` 原因。仓库不保存 GLB、UAL、贴图或 Blender；许可、SHA-256 和真实资产只能记录在用户项目中。

`createOuterEdgeMaskPass()` 在预热阶段编译一个固定的遮罩/轮廓程序。每帧只更新遮罩纹理和尺寸，不改变 shader defines 或程序键；它是轮廓光的外缘输入，不代替独立视觉审核。

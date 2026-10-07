# 三维角色与人体检查

默认写实比例，纯程序几何。`createCharacter({body:'masculine'|'feminine',height,headRatio,shoulderWidth,posture,coat,scarf,backpack,hat})` 创建两种可参数化体型，尺寸为米；默认 1.78m、7.6 头身。体型是可调形态预设，不代表身份推断。服装、头发、脸、手指均无外部素材。

```js
import {createCharacter} from './index.js';
const actor = createCharacter({coat:true,scarf:true});
scene.add(actor.object);
actor.update('walk', 2.5, {speed:.38});
```

骨架定义在 rig.js；+Y 向上、+Z 向前，弯曲符号只由 hingeAxis 确定：肘向前、膝向后。limits 是弧度。twoBone 的结果和 applyPose 都经过限位，不可达目标会夹到可达范围，不能把不可达结果当接触成功。

motion.js 动作：stand/walk/stop/turn/sit/rise/pushDoor/pushWindow/shade/embrace/bow/lookUp/windWalk。行走以距离确定足步，相邻支撑采样的足端世界位置必须相同。站立呼吸只改变胸部，不让支撑脚浮起。视线先行、颈部稍后转动，眨眼、头发、衣摆和围巾由时间闭式计算。表情 neutral/concern/resolve/tired，手势 rest/open/fist/point；可选 viseme 0..1，缺省始终闭口。

自动检查：`node tools/check-anatomy.mjs --out <ignored-output>/anatomy.json`，已加入 npm test；生成项目也自带同一检查。检查骨长、肘膝方向、肩髋颈腕范围、手端与躯干体积、脚端与地面、支撑滑步及镜像。浏览器脚本生成八方向转台、去外套动作序列和表演连续帧。

边界：几何服装没有完整布料碰撞；手端/躯干椭球检查不是全网格自碰撞；足端是简化刚性脚；坐下/推门需要项目根据家具设置根位置与接触目标。程序面部与手指是近似，近景须独立目视审核。新增动作、非默认比例或服装都应重跑检查，不能沿用旧结论。

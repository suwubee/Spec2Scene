# 天体相位特写

独立的虚构天体构件，无图像、命名地貌或外部素材。CPU 一次烘焙经纬表面（反照率、高度、两个切向坡度），每帧一个全屏三角形、一次 draw。旋转光源与球面法线的点积给出明暗交界线；掠射光处沿真实光线做 10 步高度遮挡；暗面地照、平动、低频亚像素视宁度和可选一缕薄云都是时间的纯函数。

```js
import {createCelestialPhase} from './kits/celestial-phase/index.js';
const closeup = createCelestialPhase(THREE, {seed: 31, resolution: 512, craters: 96, relief: .006});
closeup.resize(width, height);
closeup.update(t, {phase: .25, earthshine: .025, seeing: .2, cloud: .1});
renderer.render(closeup.scene, closeup.camera);
// 完成后 closeup.dispose()；renderer 的生命周期由调用方拥有。
```

phase 0/1 新相，.25/.75 半相，.5 满相；可超出一周期，负时间/倒序 seek 也确定。radius 以画高为单位，默认 .29（直径 58%）；offset/drift 也是画高单位；seeing 限 0–.49 像素。cloud 0 关闭、1 最大薄云；烘焙上限 1024×512、256 个程序坑。RGBA32F 默认约 2 MiB，上限 8 MiB；无全局缓存，调用者需要复用时按完整参数签名拥有并释放实例。

在生成项目访问 `kits/celestial-phase/example.html?t=3`，或直接服务仓库后打开本目录样例。提供 `window.__scene` 的 seek/resize/capture，可用现有截图、连续帧与闪烁工具。样例 12 秒一周期只是技术演示；叙事时间与音乐事件填 MOTIF-CLOSEUP 模板。没有实时播放或外部音频。

性能门槛由目标设备设定；软件浏览器记录创建与连续帧耗时，不能代签目标 GPU 的帧时。球面和表面是解析近似；未实现真实天文地貌、光谱散射或多次反射。帧着色器输出显示色，作为独立特写使用；接入 HDR 合成时需由项目明确线性输出与后期路径，避免二次色调映射。

// 中性分镜占位：换歌时在项目中填写音乐事件、场景与世界状态。
export const shots = [{id: 'intro', start: 0, end: 8, scene: 'procedural-study', transition: 'cut'}];
export function worldAt(t) { return {phase: t * Math.PI / 4, exposure: 1}; }

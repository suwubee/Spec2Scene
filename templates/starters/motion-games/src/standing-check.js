// 起步模板：上半身动作不要求髋；光线/方向质量仍需项目补充测量。
export function standingCheck(points, elapsedSeconds) {
  const required = [0, 11, 12, 15, 16];
  const missing = required.filter(i => !points[i] || (points[i].visibility ?? 1) < .3);
  return {ok: missing.length === 0, canStart: elapsedSeconds >= 3,
    reason: missing.length ? '让头、肩和双手进入画面；也可直接开始演示' : '头、肩和双手可见', missing};
}

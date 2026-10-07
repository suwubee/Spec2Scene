/** 在项目测试页导入并传入真实 landmarker、滤波与事件检测器。
 * 不提供默认假检测器，避免将模型初始化或合成点误当真人准确率。
 */
export function installHarness({landmarker, detectEvents}) {
  if (!landmarker?.detectForVideo || typeof detectEvents !== 'function') throw new Error('Real model and event detector required');
  window.__poseEval = {
    ready: true,
    async detect(bitmap, timestampMs) {
      const result = landmarker.detectForVideo(bitmap, timestampMs);
      const points = result.landmarks?.[0] || [];
      return {lost: points.length === 0, events: await detectEvents(points, timestampMs / 1000, result)};
    },
  };
}

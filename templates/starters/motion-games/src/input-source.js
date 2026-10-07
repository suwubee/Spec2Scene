import {createLocalLandmarker} from '../tools.local/pose/local-loader.mjs';

export const connections = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
export class SimPoseSource {
  kind = 'sim';
  async start() {}
  sample(t) {
    const points = Array.from({length: 33}, () => ({x: .5, y: .2, z: 0, visibility: 1}));
    const anchors = {0: [.5, .17], 11: [.38, .32], 12: [.62, .32], 13: [.29, .48], 14: [.71, .48],
      15: [.35, .27], 16: [.65, .27], 23: [.42, .61], 24: [.58, .61], 25: [.4, .76], 26: [.6, .76], 27: [.38, .91], 28: [.62, .91]};
    for (const [id, [x, y]] of Object.entries(anchors)) points[id] = {x, y: y + .008 * Math.sin(t * 3), z: 0, visibility: 1};
    return {timestamp: t, points, source: this.kind};
  }
  stop() {}
}
export class CameraPoseSource {
  kind = 'camera';
  constructor(video) { this.video = video; this.lastTime = -1; this.last = []; }
  async start() {
    let phase = "camera permission";
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({video: {width: 640, height: 480}, audio: false});
      this.video.srcObject = this.stream;
      phase = "video playback";
      await this.video.play();
      phase = "model creation";
      this.model = await createLocalLandmarker({baseURL: new URL('../vendor/vision/', import.meta.url),
        modelURL: new URL('../vendor/models/pose.task.bin', import.meta.url)});
    } catch (error) { this.stop(); throw new Error(`${phase}: ${error.message}`, {cause: error}); }
  }
  sample(t) {
    if (this.video.currentTime !== this.lastTime && this.video.readyState >= 2) {
      this.last = this.model.detectForVideo(this.video, t * 1000).landmarks[0] || [];
      this.lastTime = this.video.currentTime;
    }
    return {timestamp: t, points: this.last, source: this.kind};
  }
  stop() {
    this.stream?.getTracks().forEach(track => track.stop());
    this.video.srcObject = null;
    this.model?.close(); this.model = null;
  }
}

import {SimPoseSource, CameraPoseSource, connections} from './input-source.js';
import {HoldConfirm, DwellClick, bothHandsUp} from './handsfree.js';
import {standingCheck} from './standing-check.js';
import {createAudioGate} from './audio-gate.js';
const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
const status = document.querySelector('#status'), audio = createAudioGate();
let source = new SimPoseSource(), started = false, paused = false, switching = false, epoch = performance.now() / 1000;
let stopped = false, frames = 0;
const hold = new HoldConfirm(), pauseHold = new HoldConfirm({seconds: 1.5}), dwell = new DwellClick();
const debug = {ready: true, source: 'sim', frames: 0, cameraFrames: 0, points: 0, audio, get audioState() { return audio.state; }, get started() { return started; }};
window.__starter = debug;
function begin() { started = true; hold.done = true; audio.tone(); }
document.querySelector('#begin').addEventListener('click', begin);
document.querySelector('#camera').addEventListener('click', async () => {
  if (switching) return;
  switching = true;
  document.querySelector('#camera').disabled = true;
  status.textContent = '请允许摄像头，正在准备本地识别';
  const next = new CameraPoseSource(document.querySelector('video'));
  try {
    await next.start();
    source.stop(); source = next; debug.source = source.kind;
    epoch = performance.now() / 1000; hold.reset(); stopped = false; debug.cameraError = false;
  } catch (error) {
    debug.cameraErrorDetail = error.message;
    status.textContent = '摄像头或本地模型不可用。请检查权限，并按项目 README 准备本地模型后重试。';
    debug.cameraError = true;
  } finally { switching = false; document.querySelector('#camera').disabled = false; }
});
document.querySelector('#stop').addEventListener('click', () => { source.stop(); stopped = true; status.textContent = '已停止，相机已释放'; });
document.addEventListener('keydown', event => { if (event.code === 'Escape') paused = !paused; });
function draw(points) {
  ctx.fillStyle = '#e4f2f6'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const p = point => [(1 - point.x) * canvas.width, point.y * canvas.height];
  ctx.lineWidth = 5; ctx.strokeStyle = '#156b72';
  for (const [a, b] of connections) if (points[a] && points[b]) {
    ctx.beginPath(); ctx.moveTo(...p(points[a])); ctx.lineTo(...p(points[b])); ctx.stroke();
  }
  for (const point of points) {
    ctx.fillStyle = '#ac4c16'; ctx.beginPath(); ctx.arc(...p(point), 5, 0, Math.PI * 2); ctx.fill();
  }
}
function frame(ms) {
  if (!switching && !stopped) {
    const t = ms / 1000, {points} = source.sample(t);
    draw(points); debug.frames = ++frames; debug.points = points.length;
    if (source.kind === 'camera') debug.cameraFrames++;
    const quality = standingCheck(points, t - epoch);
    const held = hold.update(quality.ok && !bothHandsUp(points), t);
    if (held.confirmed) begin();
    const raised = bothHandsUp(points);
    if (!raised) pauseHold.reset();
    if (pauseHold.update(raised, t).confirmed) paused = !paused;
    // Gesture coordinates map to the same mirrored canvas projection.
    const bounds = {left: 0, top: 0, width: innerWidth, height: innerHeight};
    let hovered = null;
    for (const id of [15, 16]) if (points[id]) {
      const x = bounds.left + (1 - points[id].x) * bounds.width;
      const y = bounds.top + points[id].y * bounds.height;
      const candidate = document.elementFromPoint(x, y)?.closest('[data-gesture]');
      if (candidate) hovered = candidate.id;
    }
    const click = dwell.update(hovered, t);
    if (click) document.getElementById(click)?.click();
    if (!debug.cameraError) status.textContent = `${source.kind === 'sim' ? '合成骨架演示' : '本地相机识别'} · ${started ? (paused ? '已暂停' : '运行中') : `${quality.reason} · 保持 ${(held.progress * 100).toFixed(0)}%`}`;
    if (started && !paused && frames % 60 === 0) audio.tone();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.addEventListener('pagehide', () => { source.stop(); audio.close(); });

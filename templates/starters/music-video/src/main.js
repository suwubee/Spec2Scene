import {worldAt, shots} from './shots.js';
const canvas = document.querySelector('canvas');
const context = canvas.getContext('2d');
const timeline = document.querySelector('#timeline');
export function seek(t) {
  if (!Number.isFinite(t)) throw new Error('Finite scene time required');
  const {phase} = worldAt(t), {width, height} = canvas;
  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, '#d4eef0'); background.addColorStop(1, '#f9e8c8');
  context.fillStyle = background; context.fillRect(0, 0, width, height);
  for (let i = 0; i < 8; i++) {
    const x = width * (.12 + i * .108);
    const y = height * (.5 + .19 * Math.sin(phase + i * .6));
    context.beginPath(); context.arc(x, y, 12 + i * 2, 0, Math.PI * 2);
    context.fillStyle = i % 2 ? '#187b82' : '#ba581e'; context.fill();
  }
  context.fillStyle = '#19384c'; context.font = '20px sans-serif';
  context.fillText(`t = ${t.toFixed(3)} s`, 24, 36);
  document.querySelector('#status').textContent = `程序化时间测试 · ${t.toFixed(2)} 秒`;
}
window.__scene = {ready: true, canvas, duration: shots.at(-1).end, seek};
timeline.addEventListener('input', () => seek(Number(timeline.value)));
seek(0);

const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
let angle = .6, sourceView = false;
const provenance = [{id: 'study', source: 'procedural', confidence: 'not-surveyed'}];
const project = ([x, y, z]) => {
  const xx = x * Math.cos(angle) - z * Math.sin(angle);
  const zz = x * Math.sin(angle) + z * Math.cos(angle) + 7;
  return [canvas.width / 2 + xx * 450 / zz, canvas.height * .72 - (y + .5) * 450 / zz];
};
const line = (a, b) => {
  ctx.beginPath(); ctx.moveTo(...project(a)); ctx.lineTo(...project(b)); ctx.stroke();
};
function draw() {
  ctx.fillStyle = '#e4f2f6'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineWidth = 1; ctx.strokeStyle = '#8eafb7';
  for (let i = -3; i <= 3; i++) { line([i, 0, -3], [i, 0, 3]); line([-3, 0, i], [3, 0, i]); }
  ctx.lineWidth = 3; ctx.strokeStyle = sourceView ? '#a34a92' : '#126873';
  const corners = [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]];
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    line(a, b); line([a[0], 1.8, a[2]], [b[0], 1.8, b[2]]); line(a, [a[0], 1.8, a[2]]);
  }
  document.querySelector('#status').textContent = sourceView ? '数据来源：程序生成 · 未测绘（1 个对象）' : '透视三维线框 · 拖动滑块改变观察角度';
}
document.querySelector('#timeline').addEventListener('input', event => { angle = Number(event.target.value); draw(); });
document.querySelector('#provenance').addEventListener('click', () => { sourceView = !sourceView; draw(); });
window.__scene = {ready: true, canvas, provenance, seek(t) { angle = t; draw(); }};
draw();

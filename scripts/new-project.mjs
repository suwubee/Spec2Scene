import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {readFile, writeFile, mkdir, cp, rename, rm, lstat} from 'node:fs/promises';

const repo = fileURLToPath(new URL('../', import.meta.url));
const [track, name, ...extra] = process.argv.slice(2);
if (track === '--help' || track === '-h') {
  console.log('Usage: scripts/new-project.sh <music-video|3d-simulation|motion-games> <name>\n生成独立 projects/<name>/；拒绝覆盖及路径穿越。');
} else {
  if (!['music-video', '3d-simulation', 'motion-games'].includes(track) || !/^[a-z][a-z0-9-]{0,62}$/.test(name || '') || extra.length) {
    throw new Error('Valid track and lowercase project name required; use --help');
  }
  const projects = path.join(repo, 'projects');
  if ((await lstat(projects)).isSymbolicLink()) throw new Error('projects must not be a symlink');
  const destination = path.join(projects, name), staging = path.join(projects, `.new-${name}-${process.pid}`);
  try { await lstat(destination); throw new Error('Project already exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await mkdir(staging);
  const put = async (file, text) => { await mkdir(path.dirname(path.join(staging, file)), {recursive: true}); await writeFile(path.join(staging, file), text); };
  try {
    for (const dir of ['assets', 'src', 'tests', 'docs', 'data']) await mkdir(path.join(staging, dir));
    await cp(path.join(repo, 'templates/starters/common'), staging, {recursive: true});
    await cp(path.join(repo, 'templates/starters', track), staging, {recursive: true});
    await cp(path.join(repo, 'tools'), path.join(staging, 'tools.local'), {recursive: true, filter: source => path.basename(source) !== 'test'});
    await put('SPEC.md', await readFile(path.join(repo, 'tracks', track, 'SPEC.md'), 'utf8'));
    await put('AGENTS.md', '# 项目规则\n\n先读 SPEC.md 和 docs/track.md。仅修改本项目，素材在 assets/，输出在 out/；不复制历史作品。保持通用工具参数化。默认本地处理、仅监听回环地址，端口 39920–39939，记录并仅结束自己的 PID。测试与部署分离，不修改系统服务。用户约束优先。\n');
    await put('CLAUDE.md', '# 项目入口\n\n遵守 AGENTS.md，先填 SPEC.md，再按 docs/track.md 实现。审核者独立复跑 tests 与查看截图；实际输入和合成输入分别报告。\n');
    await put('assets/README.md', '# 用户素材\n\n由用户放置获授权的音乐、图像、地图、模型等；逐项在 docs/licenses.md 登记权利来源、许可、署名、商用及再分发边界。工具许可不授予素材权利。相机数据默认不保存。\n');
    await put('docs/licenses.md', '# 素材与依赖许可\n\n| 内容 | 来源 | 许可版本 | 署名 | 商用/再分发 | 证据 |\n|---|---|---|---|---|---|\n');
    await put('docs/track.md', (await readFile(path.join(repo, 'tracks', track, 'README.md'), 'utf8')).replace('(SPEC.md)', '(../SPEC.md)').replace('(../../tools/README.md)', '(../tools.local/README.md)').replaceAll('(directing/', '(../directing/').replaceAll('(engine/', '(../engine/').replaceAll('(character/', '(../character/').replaceAll('(kits/', '(../kits/').replace('(../../templates/REVIEW-music-video.md)', '(REVIEW-music-video.md)').replaceAll('(../../templates/', '('));
    await put('docs/QA.md', (await readFile(path.join(repo, 'tracks', track, 'QA.md'), 'utf8')).replace('(../../templates/ui-acceptance-checklist.md)', '(ui-acceptance-checklist.md)').replace('(../../playbook/06-testing.md)', '(testing.md)'));
    await put('docs/ui-acceptance-checklist.md', await readFile(path.join(repo, 'templates/ui-acceptance-checklist.md'), 'utf8'));
    await put('docs/testing.md', await readFile(path.join(repo, 'playbook/06-testing.md'), 'utf8'));
    await put('docs/lessons.md', await readFile(path.join(repo, 'tracks', track, 'lessons.md'), 'utf8'));
    const rootPackage = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
    await put('package.json', JSON.stringify({name, private: true, type: 'module', scripts: {test: 'node --test tests/*.test.mjs',
      serve: 'node tools.local/serve.mjs --root . --port 39920', ...(track === 'music-video' ? {'render:final': 'node tools.local/render-final.mjs', 'render:preview': 'node tools.local/cinematic/preview.mjs --root .'} : {})}, engines: {node: '>=20'}, devDependencies: rootPackage.devDependencies}, null, 2) + '\n');
    await put('.gitignore', 'node_modules/\n.venv/\n__pycache__/\ncache/\nout/\nwork/\nvendor/\nassets/*\n!assets/README.md\n');
    const titles = {'music-video': '音乐视频 · 三维电影', '3d-simulation': '三维模拟 · 数据来源', 'motion-games': '体感游戏 · 本地骨架'};
    const controls = track === 'motion-games' ? '<div class="controls"><button id="begin" class="primary" data-gesture>开始演示</button><button id="camera">打开摄像头</button><button id="stop" data-gesture>停止</button></div><div class="panel"><p id="audio-status" role="status"></p><button id="sound">点一下开启声音</button></div>' :
      `<label for="timeline">${track === 'music-video' ? '时间（秒）' : '观察角度'}</label><input id="timeline" type="range" min="0" max="${track === 'music-video' ? 8 : 6.28}" step="0.01" value="0">${track === '3d-simulation' ? '<button id="provenance">切换数据来源视图</button>' : ''}`;
    await put('index.html', `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:"><title>${titles[track]}</title><link rel="stylesheet" href="./style.css"></head><body><main><h1>${titles[track]}</h1><p>通用起步页。先填写规格，再替换为自己的获授权内容。</p><div class="panel"><canvas width="800" height="450" aria-label="程序化演示画面"></canvas><video hidden muted playsinline></video><p id="status" role="status"></p></div><section class="panel">${controls}</section><small>素材授权由用户确认；体感示例不构成医疗或专业健身建议。</small></main><script type="module" src="./src/main.js"></script></body></html>\n`);
    if (track === 'music-video') {
      for (const directory of ['engine', 'character', 'sample', 'directing', 'kits']) await cp(path.join(repo, 'tracks/music-video', directory), path.join(staging, directory), {recursive: true});
      await put('index.html', await readFile(path.join(repo, 'templates/starters/music-video/index.html'), 'utf8'));
      await put('tools.local/check-anatomy.mjs', (await readFile(path.join(repo, 'tools/check-anatomy.mjs'), 'utf8')).replaceAll('../tracks/music-video/', '../'));
      await put('tests/anatomy.test.mjs', "import test from 'node:test'; import assert from 'node:assert/strict'; import {checkAnatomy} from '../tools.local/check-anatomy.mjs'; test('all character action samples pass anatomy constraints',()=>assert.deepEqual(checkAnatomy().failures,[]));\n");
      for (const name of ['CONCEPT-music-video.md','GATE-music-video.md']) await put('docs/'+name,await readFile(path.join(repo,'templates',name),'utf8'));
      await put('docs/REVIEW-music-video.md', await readFile(path.join(repo, 'templates/REVIEW-music-video.md'), 'utf8'));
      await put('render.config.json', JSON.stringify({fps: 24, width: 1920, height: 1080, count: 1440, sceneContract: 'window.__scene={ready,canvas,seek(t),capture()}'}, null, 2));
    }
    if (track === '3d-simulation') await put('data/sources.md', '# 数据来源与可信度\n\n| 对象/属性 | 来源类别 | 许可 | 可信度 | 误差/日期 | 验证 |\n|---|---|---|---|---|---|\n| 起步几何 | 程序生成 | 项目原创 | 非测绘 | 不适用 | 只验证透视与来源视图 |\n');
    const test = track === 'music-video' ? "import {worldAt} from '../src/shots.js';\ntest('world state depends only on t', () => { const expected = worldAt(2); worldAt(9); assert.deepEqual(worldAt(2), expected); });" :
      track === 'motion-games' ? "import {grade} from '../src/config.js';\nimport {standingCheck} from '../src/standing-check.js';\nimport {SimPoseSource} from '../src/input-source.js';\nimport {HoldConfirm} from '../src/handsfree.js';\ntest('judgement grades and inclusive edges', () => { assert.equal(grade(.18), 'perfect'); assert.equal(grade(.4), 'good'); assert.equal(grade(.51), 'miss'); });\ntest('upper body does not require hips', () => { const points = new SimPoseSource().sample(0).points; points[23].visibility = 0; points[24].visibility = 0; assert.equal(standingCheck(points, 0).ok, true); assert.equal(standingCheck([], 3).canStart, true); });\ntest('short tracking gap does not reset hold', () => { const h = new HoldConfirm(); h.update(true, 0); h.update(true, 1); h.update(false, 1.1); assert.equal(h.update(true, 3).confirmed, true); });" :
      "import {readFile} from 'node:fs/promises';\ntest('source provenance is part of the project', async () => { const data = await readFile(new URL('../data/sources.md', import.meta.url), 'utf8'); assert.ok(data.includes('非测绘')); });";
    await put('tests/starter.test.mjs', "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" + test + '\n');
    await put('README.md', `# ${name}\n\n产线：${track}。填写 SPEC.md；按 AGENTS.md 实现；以 REVIEW 和截图/真实数据复验。\n\n运行：\n\n\`\`\`bash\nnpm install\nnpm test\nnpm run serve\n\`\`\`\n\n打开 http://127.0.0.1:39920。音乐画面是 60 秒 three.js 三维样片，支持 seek(t) 与 capture()；三维模拟起步画面为程序生成的透视线框，体感默认明确标记合成骨架。\n\n${track === 'motion-games' ? '真实相机：在 Spec2Scene 仓库执行 scripts/fetch-models.sh --project projects/' + name + ' --kind pose，再点打开摄像头。模型缺失、相机拒绝时给出可恢复提示。浏览器必须在同一页面真实点击/按键才能开启声音；手势无法解锁。模型与 WASM 只从本项目加载，退出释放相机；骨架演示不能证明真实识别准确率。\n' : ''}\n通用工具在 tools.local/，详见其中 README.md。所有素材自行确认授权，docs/licenses.md 记录来源；输出与模型默认忽略。\n`);
    // mkdir reservation closes a concurrent-generator race; rename into an existing empty dir is atomic on POSIX.
    await mkdir(destination);
    await rename(staging, destination);
    console.log(`CREATED projects/${name} track=${track}\n下一步：填写 projects/${name}/SPEC.md；用 templates/codex-prompt.md 或 claude-prompt.md 派发；按 templates/REVIEW.md 复跑测试并审图。\n运行：cd projects/${name} && npm test；node tools/serve.mjs --root projects/${name} --port 39920（从仓库根目录执行）。`);
  } catch (error) { await rm(staging, {recursive: true, force: true}); throw error; }
}

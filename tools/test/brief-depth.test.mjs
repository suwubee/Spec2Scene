import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkBriefs, checkDocument, recipes, shots, delegationHits, DEFAULTS} from '../brief-depth.mjs';

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../brief-depth.mjs', import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));

// ---- synthetic fixtures: an invented night quarry with a water tower; no real work, place or person ----
const HEADER = '| 件/component | 尺寸 | 材质(色值) | 程序做法(具体库函数) | L1 | L2 | L3 | 来源 REUSE/ADAPT/NEW-GLM/NEW-HARD |\n|---|---|---|---|---|---|---|---|';
const ROWS = [
  '| 水塔 ×1 | Ø4.2 × h11.0 m，壁厚 .35 | 砖 #6b5a4c 粗糙度 .82；铁箍 #2a2a29 | `lathe(profile, 32)` 塔身 + `bevelBox(.4,.2,.1,.01)` 砖缝实例 → `mergeInstanced` | 塔身/箍/梯 | 砖块明度 ±8% + 缝 1.5 cm | 箍下锈痕 3 道；梯级缺 1 根 | NEW-HARD |',
  '| 采石台阶 ×14 | 2.4×0.45×0.18 m 每级 | 石 #75716a 粗糙度 .9；湿 #3c3d3e | `bevelBox(2.4,.18,.45,.02)` 每级 ±2 cm 错位 ±1.2° 倾 → `mergeInstanced` | 级/边 | 石面颗粒 + 级边磨圆 | 第 6 级断角；缝里积水 2 处 | NEW-GLM |',
  '| 吊杆 ×2 | 长 9.0 m，Ø.22 | 铁 #2f2c29 粗糙度 .6 + 锈 #6a3b22 | `tubeAlongCurve(curve, .11, 48)` + `latticeFrame(…)` | 杆/拉索 | 锈斑低频 + 漆皮高频 | 拉索垂度 .3 m；挂钩轻摆 | ADAPT kits/far plankHull 改为钢构 |',
  '| 碎石堆 ×5 | 3–6 m 直径，高 1.2 m | 石 #6f6a62；暗面 #2d2b29 | `createRock({radius:.6, seed:3})` ×120 → `mergeInstanced` | 堆/边 | 块间明度差 + 尘 | 新落碎石亮边 | REUSE kits/rock.js |',
  '| 积水洼 ×3 | 2.0×1.4 m，深 .04 | 水 #0b1016 粗糙度 .05 | `createSmallWater(ctx,{size:[2,1.4]})` | 面/岸 | 反射 + 风斑 | 岸边泥线 2 cm | REUSE kits/small-water.js |',
  '| 工棚 ×1 | 6×4×3 m | 波纹铁 #4a4d4f 粗糙度 .55 | `wallWithOpenings(b,{…})` + `roofMesh(…)` | 墙/顶/门 | 波纹法线 + 漆色差 | 门半开 30°；檐下雨痕 | ADAPT kits/far blockBatches |',
  '| 远山 | 400 m–3 km 三层 | 雾色 #1b2430；雪线 #9aa3ad | `createFarRanges(ctx,{layers:3})` | 三层轮廓 | ridged 起伏 + 雪线 | 裸岩斑 | REUSE kits/far |',
  '| 薄雾 | 贴地 1.5 m | 密度 .35，色 #2a3644 | `createMistCards({cards:[{type:"ground"}]})` | 层 | 卷动 | 台阶处变薄 | REUSE engine particles |',
  '| 尘埃 | 视锥内 900 粒 | 亮度 .6 线性，色 #c9c2b4 | `createDust({count:900})` | 粒 | 风向漂移 | 光束中可见 | REUSE engine particles |',
];
const RECIPE = `### 水塔 —— NEW-HARD

① 步骤：(1) 塔身 lathe 轮廓 (2) 砖缝实例 (3) 铁箍 (4) 爬梯 (5) 材质 (6) 检查台四视角各出一张图。
② 几何与拓扑：塔身 32 段 × 24 环，壁厚 .35；砖块实例 2400 块；铁箍 4 道 Ø.05；三角形 ≤ 6k。
③ 函数：\`lathe\`、\`bevelBox\`、\`mergeInstanced\`（engine/geo.js）；\`withAtmosFog\`（kits/far）。
④ 材质数值：砖 #6b5a4c 明度 ±8%，缝宽 1.5 cm 色 #3b322b，粗糙度 .82；锈 #6a3b22 带宽 .2 m。
⑤ 检查台：4 视角 t=1 35 mm 12 m、t=5 85 mm 60 m、t=9 24 mm 4 m、t=13 135 mm 400 m；月 el 9°。
⑥ 数值验收：picture-qa ③ 塔身 ≤ 5%；32 px 窗 σ ≥ .004；三角形 ≤ 6000；确定性 PASS。
⑦ 失败模式与检测：(a) 白柱 → t=5 塔身单色 → 材质未生效；(b) 砖缝成条纹 → ① stripes FAIL → 缝太规则；(c) 远处浮起 → t=13 比地面亮 → 缺大气雾。
⑧ 降级方案：砖缝改为三平面 procTex \`brick\` + 顶点色明度抖动，接口不变。
`;
const LONG = '前景石阶的湿边与中景水塔的锈痕要在同一个月光方向下读出体积，远山三层逐层变淡，雾只贴地。'.repeat(3);

function setBrief({rows = ROWS, recipe = RECIPE, extra = ''} = {}) {
  return `# SET-quarry —— 夜里的采石场与水塔

场景 ID：\`quarry\`　版本：\`r01\`　设计者：导演　实现者：场景会话

## 目的与边界

- 叙事功能：空旷的劳动场所，人物在离开前最后一次回望。${LONG}
- 主场景/变体：主场景采石台 / 月出前后两个时段。
- 不包含：室内、人群、车辆。
- 坐标、单位、时间源：右手系、米、镜头局部 t。

## 平面与尺寸

| 区域 | 原点/范围 | 高度或厚度 | 可见边界 | 碰撞/接触 |
|---|---|---:|---|---|
| 采石台 | x −20…20，z −30…10 | 0 | 北侧崖壁 | 人物只走台阶 |
| 水塔 | (6, 0, −12) | 11 | 全景可见 | 不接触 |

${LONG}

## 构件与道具清单（件 | 尺寸 | 材质(色值) | 程序做法 | L1 | L2 | L3 | 来源）

${HEADER}
${rows.join('\n')}

每帧可辨道具数目标：英雄帧 ≥ 10 件。${LONG}

## 难件配方（每个 NEW-HARD 件一份，八项齐全）

${recipe}
## 灯光与氛围

- 主光：月 az 120 el 9，色 4100 K 线性 [.62,.70,.86]，强度 .9，阴影 2048。${LONG}
- 轮廓光：人物右肩冷边，中景 .4。
- 空气：贴地薄雾密度 .35，远山空气透视 14%/100 m。

## 镜头预设

| 预设 | 位置与目标 | 焦距/光圈 | 对焦距离 | 运动与转场 | 手持 handheld（≤ 0.35） | 预期层次 |
|---|---|---|---|---|---|---|
| quarry_wide | (−8,1.6,8) → (6,4,−12) | 35 mm / f4 | 14 m | evalCam 两键缓推 1.5 m | 0.2 | 台阶/水塔/远山 |
| tower_tele | (−30,2,30) → (6,6,−12) | 135 mm / f5.6 | 52 m | 锁定 | 0.1 | 吊杆/水塔/山 |

## 验收清单

- [ ] 英雄帧三层可辨，picture-qa 全 PASS。${LONG}
- [ ] qa:camera 每镜 PASS。
${extra}
## 回填（实现者只写这里）

| 轮次 | 联系表/英雄大图路径 | 结论 | 实测预算 | 偏离设计之处与理由 | 给设计者的请求 |
|---|---|---|---|---|---|
| r01 | out/review/quarry/stage-1/r01/ | PASS | 140 calls | 待定 | 自行决定的部分：无 |
`;
}

const SHOT = (id, {fields = {}} = {}) => {
  const f = {前景: '采石台阶 ×3（湿边）、碎石堆', 中景: '水塔、工棚、人物 (0.4W)', 远景: '远山三层、薄雾', 天空: '月出前的冷蓝天，卷云 .1', 二级运动: '薄雾卷动；尘埃漂移；吊杆挂钩轻摆', 人物屏高: '14–20% H', 主光: '月 az 120 el 9 右侧掠射', 轮廓光: '月（右后）冷边 .4', ...fields};
  return `### ${id} · 0.00–8.00 · quarry.quarry_wide · 硬切\n${Object.entries(f).filter(([, v]) => v !== null).map(([k, v]) => `- ${k}：${v}`).join('\n')}\n- 构图：\n\`\`\`\n. . . | . ^ . | . . .\n= # = | 塔 = | = = =\n\`\`\`\n`;
};
const storyboard = (blocks) => `# STORYBOARD —— 采石场练习片\n\n## 镜头表\n\n${blocks.join('\n')}`;

const THIN = `# SET-quarry —— 采石场（精简版，细节由实现者回填）

## 目的与边界
- 叙事功能：采石场。

## 构件与道具清单
| 件 | 尺寸 | 材质 | 程序做法 | L1 |
|---|---|---|---|---|
| 水塔 | 大 | 砖 | 程序生成 | 塔身 |
| 台阶 |  | 石 | 实现者决定 | — |

## 灯光与氛围
- 主光：月光，TBD。
`;

async function dir(files) {
  const d = await mkdtemp(path.join(os.tmpdir(), 'brief-depth-'));
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(d, name), text);
  return d;
}

test('thin "精简版" brief delegated to the implementer FAILS with the specific missing items', async () => {
  const d = await dir({'SET-quarry.md': THIN, 'STORYBOARD.md': storyboard([SHOT('Q01', {fields: {前景: null, 二级运动: '薄雾', 人物屏高: '较小'}})])});
  try {
    const r = await checkBriefs({dir: d});
    assert.equal(r.pass, false);
    const set = r.files.find(f => f.kind === 'set').missing.join('\n');
    for (const want of ['delegation phrase "精简版"', 'delegation phrase "实现者决定"', 'delegation phrase "TBD"', 'heading missing: 平面与尺寸', 'heading missing: 难件配方', 'heading missing: 回填',
      'lacks columns: L2, L3, 来源', 'empty cell "尺寸"', 'size has no number', 'material has no colour value', 'procedure names no library function', 'rows < 8', `B < ${DEFAULTS.minBytes} B minimum`]) assert.ok(set.includes(want), `expected "${want}" in\n${set}`);
    const sb = r.files.find(f => f.kind === 'storyboard').missing.join('\n');
    for (const want of ['前景 missing', '二级运动 needs ≥ 2 sources', '人物屏高 needs a band']) assert.ok(sb.includes(want), `expected "${want}" in\n${sb}`);
  } finally { await rm(d, {recursive: true, force: true}); }
});

test('complete brief, storyboard and recipe PASS; implementer backfill and negated phrases are not delegation', async () => {
  const d = await dir({'SET-quarry.md': setBrief({extra: '- [ ] 不得自行决定材质，设计未写到时提请求。\n'}), 'STORYBOARD.md': storyboard([SHOT('Q01'), SHOT('Q02', {fields: {人物屏高: '无（空镜）', 天空: '无（俯拍，画面里没有天空）'}})])});
  try {
    const r = await checkBriefs({dir: d, minBytes: 2500});
    assert.equal(r.pass, true, JSON.stringify(r.files.map(f => f.missing), null, 1));
    const set = r.files.find(f => f.kind === 'set');
    assert.equal(set.rows, ROWS.length); assert.equal(set.newHard, 1); assert.equal(set.recipes, 1);
    assert.ok(set.designerBytes > 2500 && set.designerBytes < (await readFile(path.join(d, 'SET-quarry.md'))).length, 'backfill and template lines are not designer bytes');
    assert.equal(r.files.find(f => f.kind === 'storyboard').shots, 2);
    const strict = await checkBriefs({dir: d, minBytes: 1e6});
    assert.deepEqual(strict.files.find(f => f.kind === 'set').missing, [`designer-written ${set.designerBytes} B < 1000000 B minimum`]);
  } finally { await rm(d, {recursive: true, force: true}); }
});

test('NEW-HARD parts need an eight-part recipe here or in the asset bible; ⑥ needs numbers and ⑦ detection', async () => {
  const noRecipe = setBrief({recipe: '本场景只有一个难件，配方写在 ASSET-BIBLE 的同名标题下。\n'});
  const r1 = checkDocument(noRecipe, {kind: 'set', minBytes: 0, minRows: 8});
  assert.ok(r1.missing.some(m => m.startsWith('NEW-HARD "水塔"')), r1.missing.join('\n'));
  const r2 = checkDocument(noRecipe, {kind: 'set', minBytes: 0, minRows: 8, recipeTitles: ['B2 水塔 `tower.js` —— NEW-HARD']});
  assert.deepEqual(r2.missing, []);
  const weak = RECIPE.replace(/⑥ 数值验收：.*\n/, '⑥ 数值验收：看起来像砖墙即可。\n').replace(/⑦ 失败模式与检测：.*\n/, '⑦ 失败模式与检测：可能会有一些问题。\n').replace(/⑤ 检查台：.*\n/, '');
  const r3 = recipes(`# ASSET-BIBLE\n\n## A 共享件\n\n${weak.replace('### 水塔', '### A1 水塔')}`);
  assert.deepEqual(r3[0].missing, ['⑤ 检查台 missing', '⑥ 数值验收 no numeric threshold', '⑦ 失败模式与检测 no detection (write symptom → how it is detected → cause)']);
  const bibleDir = await dir({'SET-quarry.md': noRecipe, 'ASSET-BIBLE.md': `# ASSET-BIBLE\n\n## A 共享件\n\n${RECIPE.replace('### 水塔', '### A1 水塔')}`, 'STORYBOARD.md': storyboard([SHOT('Q01')])});
  try { assert.equal((await checkBriefs({dir: bibleDir, minBytes: 1000})).pass, true); } finally { await rm(bibleDir, {recursive: true, force: true}); }
});

test('shot bill of materials accepts inline labels and rejects bare "无" layers and missing sketches', () => {
  const inline = '## 镜头表\n\n### Q09 · 1–2 · quarry.tower_tele\n- 物料：前景 = 碎石堆；中景 = 水塔；远景 = 远山；天 = 冷蓝天\n- 二级运动：雾、尘埃、挂钩\n- 人物：8% → 12% H。 主光：月右侧；轮廓：月冷边。\n```\n. ^ .\n= # =\n```\n';
  assert.deepEqual(shots(inline)[0].missing, []);
  const bad = inline.replace('前景 = 碎石堆', '前景 = 无').replace(/```[\s\S]*```\n/, '');
  assert.deepEqual(shots(bad)[0].missing, ['前景 is bare "无" (name the components or give the reason)', '构图 sketch missing (fenced block ≥ 2 lines)']);
  assert.equal(delegationHits('严禁自由发挥；不要写待定。\n细节由实现者补').length, 1);
});

test('blank repository templates cannot pass the depth gate', async () => {
  const r = await checkBriefs({files: [path.join(repo, 'templates/SET-brief.md'), path.join(repo, 'templates/CONCEPT-music-video.md')]});
  assert.equal(r.pass, false);
  const set = r.files[0].missing.join('\n');
  assert.match(set, /unfilled <placeholder>/); assert.match(set, /recipe .*① 步骤 empty/); assert.match(set, /designer-written 0 B/);
  assert.match(r.files[1].missing.join('\n'), /前景 empty/);
});

test('brief-depth CLI: per-file scores, exit 0 on PASS and 1 on FAIL; the blank SET-brief.md template is not discovered', async () => {
  const good = await dir({'SET-quarry.md': setBrief(), 'SET-brief.md': 'blank template copy', 'STORYBOARD.md': storyboard([SHOT('Q01')])});
  const thin = await dir({'SET-quarry.md': THIN, 'STORYBOARD.md': storyboard([SHOT('Q01')])});
  try {
    const ok = await exec(process.execPath, [CLI, '--dir', good, '--min-bytes', '2500']);
    assert.match(ok.stdout, /PASS .*SET-quarry\.md \[set\] designer \d+ B \(min 2500\) · rows 9 · NEW-HARD 1 · recipes 1/);
    assert.doesNotMatch(ok.stdout, /SET-brief\.md/);
    assert.match(ok.stdout, /PASS brief-depth · 2 files/);
    await assert.rejects(exec(process.execPath, [CLI, '--dir', thin]), e => e.code === 1 && /FAIL .*SET-quarry\.md/.test(e.stdout) && /delegation phrase "精简版"/.test(e.stdout));
  } finally { await rm(good, {recursive: true, force: true}); await rm(thin, {recursive: true, force: true}); }
});

test('generated music-video project wires qa:brief / qa:reimplement / qa:camera; blank docs fail the depth gate, starter src passes', {timeout: 120000}, async () => {
  const {playbackFixture} = await import('./playback-browser.mjs');
  const fixture = await playbackFixture();
  try {
    const pkg = JSON.parse(await readFile(path.join(fixture.project, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['qa:brief'], 'node tools.local/brief-depth.mjs --dir docs');
    assert.equal(pkg.scripts['qa:reimplement'], 'node tools.local/no-reimplement.mjs src');
    assert.match(pkg.scripts['qa:camera'], /^node tools\.local\/cam-check\.mjs --url http:\/\/127\.0\.0\.1:39920\//);
    const blank = await exec(process.execPath, ['tools.local/brief-depth.mjs', '--dir', 'docs'], {cwd: fixture.project}).then(() => null, e => e);
    assert.equal(blank?.code, 1);
    assert.match(blank.stdout, /no set brief found/); assert.match(blank.stdout, /CONCEPT-music-video\.md \[concept\]/);
    await exec(process.execPath, ['tools.local/no-reimplement.mjs', 'src'], {cwd: fixture.project});
    await exec(process.execPath, ['tools.local/cam-check.mjs', '--help'], {cwd: fixture.project});
  } finally { await fixture.close(); }
});

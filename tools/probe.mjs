// 引擎探针：验证真实阴影 + 镂空透光 + 织纹 + 泛光。
// 用法: node tools/probe.mjs [--t 3.0] [--out shots/probe.png]
import { withPage, readPNG, meanLuma, meanRGB, imageDiff, sleep } from './harness.mjs';

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };

const times = (get('times', '0,1.7,3.4') + '').split(',').map(Number);

const result = await withPage({
  page: 'tools/probe-screen.html',
  width: 960, height: 540,
  readyTimeout: 120000,
  logConsole: true,
}, async (page) => {
  await page.waitReady();
  const qa0 = await page.eval('JSON.stringify(window.__qa())');
  console.log('probe boot:', qa0);
  await sleep(1200);

  const shots = [];
  for (const t of times) {
    await page.setTime(t);
    await sleep(500);
    const p = await page.shot(`shots/probe-t${t}.png`);
    shots.push(p);
    console.log('wrote', p);
  }
  const qa = JSON.parse(await page.eval('JSON.stringify(window.__qa())'));
  console.log('probe stats:', JSON.stringify(qa));

  const logs = page.logs.filter((l) => /error|exception|warn/i.test(l));
  if (logs.length) console.log('page warnings/errors:\n' + logs.join('\n'));
  return { shots, qa, logs };
});

/* -------- 像素级断言 -------- */
const imgs = result.shots.map((p) => readPNG(p));
const W = imgs[0].width, H = imgs[0].height;
console.log(`\n图像 ${W}x${H}`);

const fails = [];
const ok = (cond, msg, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${detail ? '  ' + detail : ''}`);
  if (!cond) fails.push(msg);
};

// 0) 着色器必须真的编译成功 —— 编译失败时 three 会回退渲染，看起来"有画面"但是错的
{
  const shaderErr = result.logs.filter((l) => /ERROR:|Program Info Log|not compiled/i.test(l));
  ok(shaderErr.length === 0, '所有着色器编译通过（无 GLSL 报错）',
    shaderErr.length ? shaderErr.slice(0, 3).join(' | ').slice(0, 300) : '');
}
{
  const exc = result.logs.filter((l) => /^\[exception\]/.test(l));
  ok(exc.length === 0, '页面无未捕获异常', exc.slice(0, 2).join(' | ').slice(0, 200));
}

const lum = (img, x0, y0, x1, y1) => meanLuma(img, Math.round(x0 * W), Math.round(y0 * H), Math.round(x1 * W), Math.round(y1 * H), 2);
const rgb = (img, x0, y0, x1, y1) => meanRGB(img, Math.round(x0 * W), Math.round(y0 * H), Math.round(x1 * W), Math.round(y1 * H), 2);

const im = imgs[0];

// 1) 幕布整体是亮的（背后有灯）
const centre = lum(im, 0.44, 0.40, 0.56, 0.60);
ok(centre > 0.30, '幕布中心被灯照亮', `luma=${(centre * 100).toFixed(1)}%`);

// 2) 光晕在幕布边缘散开：中心亮、四角暗，且是**径向**连续渐变。
//    注意：灯罩会在幕布上投下篾条影（高频），所以剖面要在**整条环带**上平均，
//    把高频条纹平均掉，只留下径向的光晕趋势。
const corner = lum(im, 0.10, 0.08, 0.24, 0.22);
ok(corner < centre * 0.85, '幕布四角比中心暗（光斑外扩）',
  `corner=${(corner * 100).toFixed(1)}% centre=${(centre * 100).toFixed(1)}%`);
{
  // 以幕布中心为圆心，按半径分环平均亮度；半径越大应该越暗（且单调）
  const prof = [];
  const cx = 0.5 * W, cy = 0.5 * H;
  for (let k = 0; k < 7; k++) {
    const r0 = k / 7, r1 = (k + 1) / 7;
    const vals = [];
    for (let a = 0; a < 48; a++) {
      const ang = a / 48 * Math.PI * 2;
      for (let rr = r0; rr < r1; rr += 0.02) {
        const x = cx + Math.cos(ang) * rr * 0.5 * W;
        const y = cy + Math.sin(ang) * rr * 0.5 * H;
        if (x < 20 || y < 20 || x > W - 20 || y > H - 20) continue;
        vals.push(meanLuma(im, x, y, x + 1, y + 1));
      }
    }
    prof.push(vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 1));
  }
  const falling = prof[0] > prof[prof.length - 1] * 1.15;
  ok(falling, '光晕在幕布边缘散开（中心明显亮于边缘，径向剖面下落）',
    prof.map((v) => v.toFixed(2)).join(' -> '));
}

// 3) 剪影：在**幕布范围内**找最暗区域（避开幕布外的暗框，那是舞台，不是影子）
let darkest = { l: 1, x: 0, y: 0 };
let brightRef = 0;
{
  const N = 32;
  const cells = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      // 只取画面中央 84%×80% 的区域 —— 幕布外圈是剧场暗框，本来就不是亮的
      const fx = (i + 0.5) / N, fy = (j + 0.5) / N;
      if (fx < 0.08 || fx > 0.92 || fy < 0.10 || fy > 0.90) continue;
      const l = meanLuma(im, i / N * W + 2, j / N * H + 2, (i + 1) / N * W - 2, (j + 1) / N * H - 2, 2);
      cells.push({ l, x: Math.round(fx * W), y: Math.round(fy * H) });
    }
  }
  const sorted = cells.slice().sort((a, b) => a.l - b.l);
  darkest = sorted[Math.floor(sorted.length * 0.05)];
  brightRef = sorted[Math.floor(sorted.length * 0.95)].l;
}
ok(darkest.l < brightRef * 0.62, '幕布上出现剪影（存在明显暗区）',
  `最暗区 (${darkest.x},${darkest.y}) luma=${(darkest.l * 100).toFixed(1)}% vs 最亮区 ${(brightRef * 100).toFixed(1)}% 比=${(darkest.l / Math.max(brightRef, 1e-4)).toFixed(2)}`);

// 4) 剪影内部有镂空亮斑：暗区窗口里“明显亮于暗区”的像素占比
let holeRatio = 0, holeDetail = '';
{
  const R2 = 48;
  const x0 = Math.max(0, darkest.x - R2), x1 = Math.min(W, darkest.x + R2);
  const y0 = Math.max(0, darkest.y - R2), y1 = Math.min(H, darkest.y + R2);
  const thr = darkest.l + (brightRef - darkest.l) * 0.45;
  let bright = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (meanLuma(im, x, y, x + 1, y + 1) > thr) bright++;
      n++;
    }
  }
  holeRatio = n ? bright / n : 0;
  holeDetail = `窗口 ${x1 - x0}x${y1 - y0}, 阈值=${(thr * 100).toFixed(1)}% 亮斑占比=${(holeRatio * 100).toFixed(1)}%`;
}
ok(holeRatio > 0.04, '剪影内部存在镂空透光亮斑', holeDetail);

// 5) 暖黄：红色分量 > 蓝色分量
const cRGB = rgb(im, 0.40, 0.40, 0.60, 0.62);
ok(cRGB[0] > cRGB[2] * 1.25, '灯光是暖黄的', `R=${cRGB[0].toFixed(3)} G=${cRGB[1].toFixed(3)} B=${cRGB[2].toFixed(3)}`);

// 6) 明暗层次：不是纯白幕布也不是纯黑，且有真实的局部明暗（织纹/褶皱）
{
  const levels = [];
  for (let y = 0.14; y < 0.92; y += 0.014) levels.push(lum(im, 0.06, y, 0.94, y + 0.010));
  for (let x = 0.06; x < 0.94; x += 0.014) levels.push(lum(im, x, 0.20, x + 0.010, 0.86));
  const uniq = new Set(levels.map((l) => Math.round(l * 40))).size;
  ok(uniq >= 8, '光影层次连续（非硬边二值）', `亮度分档=${uniq}/40`);

  // 局部方差：证明幕布上有织纹/褶皱的细微明暗，而不是一块纯色
  let acc = 0, n = 0;
  for (let oy = 0; oy < 6; oy++) {
    for (let ox = 0; ox < 6; ox++) {
      const x0 = 0.10 * W + ox * 0.05 * W, y0 = 0.24 * H + oy * 0.06 * H;
      const vals = [];
      for (let y = y0; y < y0 + 0.05 * H; y += 1) for (let x = x0; x < x0 + 0.045 * W; x += 1) vals.push(meanLuma(im, x, y, x + 1, y + 1));
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      acc += Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
      n++;
    }
  }
  const localSd = acc / n;
  ok(localSd > 0.004, '幕布有织纹/褶皱的细微明暗（非纯色块）', `局部标准差=${(localSd * 1000).toFixed(2)}‰`);
}

// 7) 帧间确实在动
const d = imageDiff(imgs[0], imgs[2]);
ok(d > 0.004, '画面随时间变化（有动画）', `mean abs diff=${(d * 100).toFixed(2)}%`);

// 8) 阴影随角色移动而移动（暗区位置应改变）
{
  const im2 = imgs[2];
  let d2 = { l: 1, x: 0, y: 0 };
  const N = 32;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const l = meanLuma(im2, i / N * W + 2, j / N * H + 2, (i + 1) / N * W - 2, (j + 1) / N * H - 2, 2);
      if (l < d2.l) d2 = { l, x: Math.round((i + 0.5) / N * W), y: Math.round((j + 0.5) / N * H) };
    }
  }
  const moved = Math.hypot(d2.x - darkest.x, d2.y - darkest.y);
  ok(moved > 8, '剪影位置随时间移动（阴影实时跟随）',
    `t0 (${darkest.x},${darkest.y}) -> t2 (${d2.x},${d2.y}) 位移=${moved.toFixed(0)}px`);
}

console.log(`\n========== 引擎探针: ${fails.length === 0 ? 'ALL PASS' : fails.length + ' FAILED'} ==========`);
if (fails.length) { for (const f of fails) console.log(' - ' + f); process.exit(1); }

process.exit(fails.length ? 1 : 0);

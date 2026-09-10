// 端到端：加载真实 index.html，跑起来，取 __qa()，并在几个时间点截图。
import { withPage, sleep } from './harness.mjs';
import { readPNG, meanLuma, meanRGB, imageDiff } from './harness.mjs';

const TIMES = (process.env.TIMES || '0.5,4,9,14,20,25,28,32.5,38,42,45.5').split(',').map(Number);

const res = await withPage({
  page: 'index.html', width: 1280, height: 720, readyTimeout: 120000, logConsole: true,
}, async (page) => {
  await page.waitReady();
  await sleep(2500);
  const qa = JSON.parse(await page.eval('JSON.stringify(window.__qa())'));
  console.log('QA ready=' + qa.ready + ' duration=' + qa.duration + ' casters=' + qa.shadowCasters);
  console.log('  stats:', JSON.stringify(qa.stats));
  console.log('  gl:', JSON.stringify(qa.renderer));
  const shots = [];
  for (const t of TIMES) {
    await page.eval(`window.__SET_TIME__(${t})`);
    await sleep(700);
    const p = await page.shot(`shots/perf-t${String(t).replace('.', '_')}.png`);
    shots.push({ t, p });
  }
  const logs = page.logs.filter((l) => /error|exception|ERROR/i.test(l));
  return { qa, shots, logs };
});

const fails = [];
const ok = (c, m, d) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${d ? '  ' + d : ''}`); if (!c) fails.push(m); };

ok(res.qa.ready === true, '页面构建成功，__READY__ 为真');
ok(res.logs.filter((l) => /exception|ERROR:/i.test(l)).length === 0, '运行期无异常/着色器错误',
  res.logs.slice(0, 2).join(' | ').slice(0, 200));
ok(res.qa.shadowCasters >= 6, '阴影投射体数量充足（皮影部件都参与投影）', `casters=${res.qa.shadowCasters}`);
ok(res.qa.stats.webgl2 === true, 'WebGL2 上下文');

const imgs = res.shots.map((s) => ({ t: s.t, img: readPNG(s.p) }));
console.log('\n--- 逐幕截图亮度 ---');
for (const { t, img } of imgs) {
  const c = meanLuma(img, img.width * 0.42, img.height * 0.35, img.width * 0.58, img.height * 0.6, 3);
  const rgb = meanRGB(img, img.width * 0.42, img.height * 0.35, img.width * 0.58, img.height * 0.6, 3);
  console.log(`  t=${String(t).padStart(5)}s  中心亮度=${(c * 100).toFixed(1)}%  RGB=[${rgb.map((v) => v.toFixed(3)).join(',')}]`);
}

// 灯光由暗到亮：第一幕开场（灯芯 0.15）vs 转幕高潮（灯 ~3.1）
const open = meanLuma(imgs[0].img, 160, 80, 1120, 660, 4);
const peak = Math.max(...imgs.map(({ img }) => meanLuma(img, 160, 80, 1120, 660, 4)));
ok(peak > open * 1.10, '灯光由暗到亮（有上灯过程）', `开场=${(open * 100).toFixed(1)}% 峰值=${(peak * 100).toFixed(1)}%`);

// 全片确实在动（取中段两张对比）
const a = imgs[Math.floor(imgs.length / 3)].img;
const b = imgs[Math.floor(imgs.length * 2 / 3)].img;
const d = imageDiff(a, b);
ok(d > 0.008, '不同时间点画面显著不同（表演在推进）', `diff=${(d * 100).toFixed(2)}%`);

console.log(`\n========== 端到端: ${fails.length === 0 ? 'ALL PASS' : fails.length + ' FAILED'} ==========`);
for (const f of fails) console.log(' - ' + f);
process.exit(fails.length ? 1 : 0);

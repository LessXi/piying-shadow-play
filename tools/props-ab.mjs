// 直接用真实引擎 + 真实 props.js 装配，做「远山可见性」A/B。
// 皮影的布景在幕布后方、幕布不透明，所以布景可见 ⇔ 它出现在 shadow map 里。
import { withPage, sleep } from './harness.mjs';
import { readPNG, meanLuma, imageDiff } from './harness.mjs';

const out = await withPage({
  page: 'tools/props-ab.html', width: 960, height: 540, readyTimeout: 90000, logConsole: true,
}, async (page) => {
  await page.waitReady();
  await sleep(2500);
  const info = await page.eval('JSON.stringify(window.__INFO__)');
  console.log('info:', info);
  await page.shot('shots/props-ab-all.png');
  await page.eval(`window.__SET_VISIBLE__('mountain', false)`);
  await sleep(400);
  await page.shot('shots/props-ab-nomountain.png');
  await page.eval(`window.__SET_VISIBLE__('mountain', true); window.__SET_VISIBLE__('moon', false)`);
  await sleep(400);
  await page.shot('shots/props-ab-nomoon.png');
  return null;
});

const all = readPNG('shots/props-ab-all.png');
const noMtn = readPNG('shots/props-ab-nomountain.png');
const noMoon = readPNG('shots/props-ab-nomoon.png');
console.log(`远山 A/B 差 = ${(imageDiff(all, noMtn) * 100).toFixed(3)}%`);
console.log(`月窗 A/B 差 = ${(imageDiff(all, noMoon) * 100).toFixed(3)}%`);
console.log(`远山可见性: ${imageDiff(all, noMtn) > 0.0005 ? '【可见】' : '【不可见】'}`);
process.exit(0);

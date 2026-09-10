import { withPage, sleep } from './harness.mjs';
import { readPNG, meanLuma, imageDiff, meanRGB } from './harness.mjs';

const out = await withPage({
  page: 'tools/probe-screen.html', width: 960, height: 540, readyTimeout: 90000, logConsole: true,
}, async (page) => {
  await page.waitReady();
  await sleep(2500);
  await page.setTime(3.0);
  await sleep(300);
  const cases = {
    shadowOn: 'S.uniforms.uShadowOn.value = 1',
    shadowOff: 'S.uniforms.uShadowOn.value = 0',
  };
  for (const [name, expr] of Object.entries(cases)) {
    await page.eval(`(function(){
      const S = window.__SCREEN__, RR = window.__RENDERER__;
      RR.bypass = false;
      ${expr};
      S.update(1/60, S.light, RR.camera);
      S.renderShadow(RR.scene);
      RR.render(1/60);
    })()`);
    await sleep(250);
    await page.shot(`shots/shadowab-${name}.png`);
  }
  await page.eval('window.__SCREEN__.uniforms.uShadowOn.value = 1');
  return null;
});

const a = readPNG('shots/shadowab-shadowOn.png');
const b = readPNG('shots/shadowab-shadowOff.png');
console.log('两图平均差 =', (imageDiff(a, b) * 100).toFixed(3), '%');
const rows = [];
for (let gy = 0; gy < 10; gy++) {
  const r = [];
  for (let gx = 0; gx < 12; gx++) {
    const x0 = gx / 12 * a.width + 2, x1 = (gx + 1) / 12 * a.width - 2;
    const y0 = gy / 10 * a.height + 2, y1 = (gy + 1) / 10 * a.height - 2;
    const la = meanLuma(a, x0, y0, x1, y1, 2), lb = meanLuma(b, x0, y0, x1, y1, 2);
    r.push((la - lb >= 0 ? '+' : '') + ((la - lb) * 100).toFixed(1));
  }
  rows.push(r.map((s) => s.padStart(6)).join(''));
}
console.log('「开影子 - 关影子」的亮度差（百分点）:');
for (const r of rows) console.log('  ' + r);
process.exit(0);

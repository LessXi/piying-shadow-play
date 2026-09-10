import { withPage, sleep } from './harness.mjs';
import { readPNG, meanLuma } from './harness.mjs';

await withPage({ page: 'tools/probe-screen.html', width: 960, height: 540, readyTimeout: 90000 },
  async (page) => {
    await page.waitReady();
    await sleep(2500);
    await page.setTime(3.0);
    await sleep(300);
    await page.shot('shots/diag-after-fix.png');
    const d = await page.eval('JSON.stringify({diag: window.__SCREEN__.shadowStage.diag, stats: window.__SCREEN__.shadowStage.readStats(window.__RENDERER__.renderer), mapStats: window.__SCREEN__.shadowStage.readStats(window.__RENDERER__.renderer, window.__SCREEN__.shadowStage.map)})');
    const u = await page.eval(`JSON.stringify({
      texel: window.__SCREEN__.uniforms.uShadowTexel.value,
      soft: window.__SCREEN__.uniforms.uDepthSoftness.value,
      rangeNear: window.__SCREEN__.uniforms.uRangeNear.value,
      rangeFar: window.__SCREEN__.uniforms.uRangeFar.value,
    })`);
    console.log('diag:', d);
    console.log('uniforms:', u);
    return null;
  });

const img = readPNG('shots/diag-after-fix.png');
console.log('中心行亮度剖面（y=0.45H）:');
const line = [];
for (let i = 0; i <= 12; i++) {
  const x = Math.round(i / 12 * (img.width - 20)) + 10;
  line.push(meanLuma(img, x - 6, img.height * 0.42, x + 6, img.height * 0.52, 2).toFixed(3));
}
console.log('  ' + line.join(' '));
process.exit(0);

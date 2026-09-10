import { withPage, sleep } from './harness.mjs';
import { readPNG, meanLuma, meanRGB } from './harness.mjs';

const r = await withPage({ page: 'tools/shadow-viz.html', width: 1000, height: 300, readyTimeout: 90000, logConsole: true },
  async (page) => {
    await page.waitReady();
    await sleep(3000);
    const info = await page.eval('JSON.stringify(window.__info)');
    await page.fullShot('shots/shadow-viz.png');
    return info;
  });
console.log('info:', r);
const img = readPNG('shots/shadow-viz.png');
console.log(`screenshot ${img.width}x${img.height}`);
// 左半：正常渲染；右半：shadow map 采样
const L = meanRGB(img, 180, 120, 300, 160, 2);
const R = meanRGB(img, 680, 120, 800, 160, 2);
console.log('left(normal centre)  =', L.map((v) => v.toFixed(3)).join(','));
console.log('right(shadowMap R)   =', R.map((v) => v.toFixed(3)).join(','));
process.exit(0);

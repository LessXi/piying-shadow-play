import { withPage, sleep } from './harness.mjs';
import { readPNG, meanLuma, meanRGB } from './harness.mjs';

const out = await withPage({
  page: 'tools/probe-screen.html', width: 960, height: 540, readyTimeout: 90000, logConsole: true,
}, async (page) => {
  await page.waitReady();
  await sleep(2500);
  await page.setTime(3.0);
  await sleep(300);
  await page.shot('shots/cal-final.png');
  await page.eval(`(function(){
    const S = window.__SCREEN__, RR = window.__RENDERER__;
    RR.bypass = true;
    S.update(1/60, S.light, RR.camera);
    S.renderShadow(RR.scene);
    RR.render(1/60);
  })()`);
  await sleep(250);
  await page.shot('shots/cal-raw.png');
  return null;
});

for (const name of ['cal-final']) {
  const img = readPNG(`shots/${name}.png`);
  const rows = [];
  for (let gy = 0; gy < 12; gy++) {
    const r = [];
    for (let gx = 0; gx < 16; gx++) {
      r.push(meanLuma(img, gx / 16 * img.width + 2, gy / 12 * img.height + 2, (gx + 1) / 16 * img.width - 2, (gy + 1) / 12 * img.height - 2, 2).toFixed(2));
    }
    rows.push(r.join(' '));
  }
  const c = meanRGB(img, img.width * 0.42, img.height * 0.2, img.width * 0.58, img.height * 0.34, 2);
  console.log(`\n${name}:  centre RGB = ${c.map((v) => v.toFixed(3)).join(',')}`);
  for (const r of rows) console.log('  ' + r);
}
process.exit(0);

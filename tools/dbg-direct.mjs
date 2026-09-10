import { withPage, sleep } from './harness.mjs';
import { readPNG, meanRGB, meanLuma } from './harness.mjs';

const out = await withPage({
  page: 'tools/probe-screen.html', width: 480, height: 270, readyTimeout: 60000,
}, async (page) => {
  await page.waitReady();
  await sleep(2500);
  const shots = {};
  for (const mode of [0, 9, 8, 4]) {
    await page.eval(`(function(){
      const S = window.__SCREEN__, RR = window.__RENDERER__;
      S.setDebugMode(${mode});
      S.update(1/60, S.light, RR.camera);
      S.renderShadow(RR.scene);
      RR.render(1/60);
    })()`);
    await sleep(250);
    shots[mode] = await page.fullShot(`shots/dbgmode-${mode}.png`);
  }
  return shots;
});

for (const [mode, p] of Object.entries(out)) {
  const img = readPNG(p);
  const all = meanLuma(img, 0, 0, img.width, img.height, 3);
  const c = meanRGB(img, Math.round(img.width * 0.35), Math.round(img.height * 0.35), Math.round(img.width * 0.65), Math.round(img.height * 0.65), 2);
  console.log(`mode ${mode} (${img.width}x${img.height}) overall=${all.toFixed(3)} centre=[${c.map((v) => v.toFixed(3)).join(',')}]`);
}
process.exit(0);


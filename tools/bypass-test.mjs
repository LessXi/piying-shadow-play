import { withPage, sleep } from './harness.mjs';
import { readPNG, meanRGB, meanLuma } from './harness.mjs';

const out = await withPage({
  page: 'tools/probe-screen.html', width: 960, height: 540, readyTimeout: 90000, logConsole: true,
}, async (page) => {
  await page.waitReady();
  await sleep(2500);
  await page.setTime(3.0);
  await sleep(200);
  const shots = {};
  for (const [name, mode, bypass] of [['composite-full', 0, false], ['raw-full', 0, true], ['raw-shadowonly', 1, true]]) {
    const info = await page.eval(`(function(){
      const S = window.__SCREEN__, RR = window.__RENDERER__;
      S.setDebugMode(${mode});
      RR.bypass = ${bypass};
      S.update(1/60, S.light, RR.camera);
      S.renderShadow(RR.scene);
      RR.render(1/60);
      return { bypass: RR.bypass, mode: S.uniforms.uDebug.value };
    })()`);
    await sleep(250);
    await page.shot(`shots/bypass-${name}.png`);
    console.log(name, JSON.stringify(info));
  }
  return null;
});

for (const name of ['composite-full', 'raw-full', 'raw-shadowonly']) {
  const img = readPNG(`shots/bypass-${name}.png`);
  const rows = [];
  for (let gy = 0; gy < 5; gy++) {
    const r = [];
    for (let gx = 0; gx < 8; gx++) {
      r.push(meanLuma(img, gx / 8 * img.width + 8, gy / 5 * img.height + 8, (gx + 1) / 8 * img.width - 8, (gy + 1) / 5 * img.height - 8, 3).toFixed(2));
    }
    rows.push(r.join(' '));
  }
  console.log(`\n${name}:`);
  for (const r of rows) console.log('  ' + r);
}
process.exit(0);

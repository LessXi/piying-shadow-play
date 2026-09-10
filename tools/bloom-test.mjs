import { withPage, sleep } from './harness.mjs';
import { readPNG, meanLuma } from './harness.mjs';

const out = await withPage({
  page: 'tools/probe-screen.html', width: 960, height: 540, readyTimeout: 90000, logConsole: true,
}, async (page) => {
  await page.waitReady();
  await sleep(2500);
  await page.setTime(3.0);
  await sleep(200);
  const variants = {
    bloomOn: { bypass: false, bloom: 0.70, exp: 0.85 },
    bloomOff: { bypass: false, bloom: 0.0, exp: 0.85 },
    bloomLow: { bypass: false, bloom: 0.18, exp: 0.85 },
    rawNoComp: { bypass: true, bloom: 0.70, exp: 0.85 },
  };
  for (const [name, v] of Object.entries(variants)) {
    await page.eval(`(function(){
      const S = window.__SCREEN__, RR = window.__RENDERER__;
      RR.bypass = ${v.bypass};
      RR.compositor.uniforms.composite.uBloom.value = ${v.bloom};
      RR.compositor.uniforms.composite.uExposure.value = ${v.exp};
      S.update(1/60, S.light, RR.camera);
      S.renderShadow(RR.scene);
      RR.render(1/60);
    })()`);
    await sleep(250);
    await page.shot(`shots/bloom-${name}.png`);
    console.log(name, 'done');
  }
  return null;
});

for (const name of ['bloomOn', 'bloomOff', 'bloomLow', 'rawNoComp']) {
  const img = readPNG(`shots/bloom-${name}.png`);
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

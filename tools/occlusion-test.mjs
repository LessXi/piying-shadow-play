import { withPage, sleep } from './harness.mjs';
import { readPNG, meanRGB } from './harness.mjs';

const out = await withPage({
  page: 'tools/probe-screen.html', width: 480, height: 270, readyTimeout: 90000, logConsole: true,
}, async (page) => {
  await page.waitReady();
  await sleep(2500);
  await page.setTime(3.0);
  await sleep(200);

  const variants = {
    a_normal: 'void 0',
    b_camFar: 'RR.camera.position.set(0, 0, 40); RR.camera.updateMatrixWorld(true);',
    c_sceneEmpty: 'RR.scene.children.length = 0;',
    d_clearMagenta: 'RR.renderer.setClearColor(0xff00ff, 1);',
    e_clearBlack: 'RR.renderer.setClearColor(0x000000, 1);',
  };
  const shots = {};
  for (const [name, expr] of Object.entries(variants)) {
    const info = await page.eval(`(function(){
      const RR = window.__RENDERER__, S = window.__SCREEN__;
      ${expr};
      S.update(1/60, S.light, RR.camera);
      S.renderShadow(RR.scene);
      RR.render(1/60);
      return { stats: RR.stats() };
    })()`);
    await sleep(200);
    shots[name] = await page.shot(`shots/occ-${name}.png`);
    console.log(name, JSON.stringify(info));
  }
  return shots;
});

for (const [name, p] of Object.entries(out)) {
  const img = readPNG(p);
  const c = meanRGB(img, 100, 60, 380, 200, 2);
  console.log(`${name.padEnd(16)} centre = ${c.map((v) => v.toFixed(3)).join(', ')}`);
}
process.exit(0);

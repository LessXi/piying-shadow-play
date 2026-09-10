import { withPage, sleep } from './harness.mjs';
import { readPNG, meanRGB, meanLuma } from './harness.mjs';

const out = await withPage({
  page: 'tools/probe-screen.html', width: 480, height: 270, readyTimeout: 90000, logConsole: true,
}, async (page) => {
  await page.waitReady();
  await sleep(2500);
  await page.setTime(3.0);
  await sleep(200);
  const info = await page.eval(`JSON.stringify((function(){
    const RR = window.__RENDERER__, S = window.__SCREEN__;
    const out = { found: [] };
    RR.scene.traverse(o => {
      if (o.isMesh) out.found.push({ name: o.name, z: +o.position.z.toFixed(3), visible: o.visible,
        color: o.material && o.material.color ? '#' + o.material.color.getHexString() : null,
        hasMap: !!(o.material && o.material.map), type: o.material ? o.material.type : null });
    });
    return out;
  })())`);
  console.log(info);
  // 关掉 veil 看边框是否变化
  await page.eval(`(function(){
    const RR = window.__RENDERER__, S = window.__SCREEN__;
    RR.scene.traverse(o => { if (o.name === 'veil') { o.visible = false; window.__VEIL__ = o; } });
    S.update(1/60, S.light, RR.camera); S.renderShadow(RR.scene); RR.render(1/60);
  })()`);
  await sleep(200);
  await page.shot('shots/veil-off.png');
  return null;
});

const on = readPNG('shots/probe-fixed.png');
const off = readPNG('shots/veil-off.png');
console.log('veil ON  corner =', meanRGB(on, 10, 10, 60, 50, 2).map((v) => v.toFixed(3)).join(','));
console.log('veil OFF corner =', meanRGB(off, 10, 10, 60, 50, 2).map((v) => v.toFixed(3)).join(','));
process.exit(0);

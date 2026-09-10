import { withPage, sleep } from './harness.mjs';
import { readPNG, meanLuma } from './harness.mjs';

// 扫描曝光，找出让「受光布面」落在 0.80-0.90 的曝光值
const out = await withPage({
  page: 'tools/probe-screen.html', width: 480, height: 270, readyTimeout: 90000, logConsole: true,
}, async (page) => {
  await page.waitReady();
  await sleep(2500);
  await page.setTime(3.0);
  await sleep(200);
  const res = {};
  for (const expo of [0.7, 1.0, 1.4, 2.0, 2.8, 4.0]) {
    await page.eval(`(function(){
      const S = window.__SCREEN__, RR = window.__RENDERER__;
      RR.bypass = false;
      RR.compositor.uniforms.composite.uExposure.value = ${expo};
      RR.compositor.uniforms.composite.uBloom.value = 0.55;
      S.setDebugMode(0);
      S.update(1/60, S.light, RR.camera);
      S.renderShadow(RR.scene);
      RR.render(1/60);
    })()`);
    await sleep(200);
    await page.shot(`shots/expo-${expo}.png`);
  }
  return null;
});

for (const expo of [0.7, 1.0, 1.4, 2.0, 2.8, 4.0]) {
  const img = readPNG(`shots/expo-${expo}.png`);
  const lit = meanLuma(img, img.width * 0.30, img.height * 0.38, img.width * 0.70, img.height * 0.62, 2);
  const corner = meanLuma(img, 2, 2, img.width * 0.08, img.height * 0.08, 2);
  const shadow = meanLuma(img, img.width * 0.45, img.height * 0.42, img.width * 0.55, img.height * 0.55, 2);
  console.log(`exposure ${String(expo).padEnd(4)} 受光=${lit.toFixed(3)} 中心=${shadow.toFixed(3)} 角=${corner.toFixed(3)}`);
}
process.exit(0);

import { withPage, sleep } from './harness.mjs';
import { readPNG, meanLuma } from './harness.mjs';

const r = await withPage({
  page: 'tools/probe-screen.html', width: 960, height: 540, readyTimeout: 90000, logConsole: true,
}, async (page) => {
  await page.waitReady();
  await sleep(2500);
  await page.setTime(3.0);
  await sleep(300);
  for (const flip of [0, 1]) {
    await page.eval(`(function(){
      const S = window.__SCREEN__, RR = window.__RENDERER__;
      S.uniforms.uFlipY.value = ${flip};
      S.update(1/60, S.light, RR.camera);
      S.renderShadow(RR.scene);
      RR.render(1/60);
    })()`);
    await sleep(250);
    await page.shot(`shots/flip-${flip}.png`);
    console.log('flip', flip, 'ok');
  }
  return null;
});

for (const flip of [0, 1]) {
  const img = readPNG(`shots/flip-${flip}.png`);
  // 演员头部的镂空花纹在上还是在下？量「上段 vs 下段」的平均亮度
  const upper = meanLuma(img, 330, 180, 400, 260, 2);
  const lower = meanLuma(img, 330, 300, 400, 380, 2);
  // 左演员在 x≈0.32*960≈307
  const upper2 = meanLuma(img, 280, 180, 350, 260, 2);
  const lower2 = meanLuma(img, 280, 300, 350, 380, 2);
  console.log(`flip=${flip}: 右演员上段=${upper.toFixed(3)} 下段=${lower.toFixed(3)}  左演员上段=${upper2.toFixed(3)} 下段=${lower2.toFixed(3)}`);
}
process.exit(0);

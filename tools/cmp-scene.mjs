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
    sceneRawViaComposite: `(function(){
      const S = window.__SCREEN__, RR = window.__RENDERER__, THREE = window.__THREE__;
      const srt = RR.compositor.sceneTarget;
      const m = new THREE.ShaderMaterial({
        uniforms: { tScene: { value: srt.texture } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: 'precision highp float; uniform sampler2D tScene; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(tScene, vUv).rgb, 1.0); }',
        depthTest: false, depthWrite: false,
      });
      RR.compositor.compositeMat = m;
      RR.bypass = false;
    })()`,
    bypassRaw: `(function(){ window.__RENDERER__.bypass = true; })()`,
  };
  for (const [name, expr] of Object.entries(variants)) {
    await page.eval(`(function(){
      const S = window.__SCREEN__, RR = window.__RENDERER__;
      ${expr};
      S.update(1/60, S.light, RR.camera);
      S.renderShadow(RR.scene);
      RR.render(1/60);
    })()`);
    await sleep(250);
    await page.shot(`shots/cmp-${name}.png`);
    console.log(name, 'ok');
  }
  return null;
});

for (const name of Object.keys({ sceneRawViaComposite: 1, bypassRaw: 1 })) {
  const img = readPNG(`shots/cmp-${name}.png`);
  const rows = [];
  for (let gy = 0; gy < 5; gy++) {
    const r = [];
    for (let gx = 0; gx < 8; gx++) {
      r.push(meanLuma(img, gx / 8 * img.width + 8, gy / 5 * img.height + 8, (gx + 1) / 8 * img.width - 8, (gy + 1) / 5 * img.height - 8, 3).toFixed(3));
    }
    rows.push(r.join(' '));
  }
  console.log(`\n${name}:`);
  for (const r of rows) console.log('  ' + r);
}
process.exit(0);

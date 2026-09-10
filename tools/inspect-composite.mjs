import { withPage, sleep } from './harness.mjs';

const r = await withPage({
  page: 'tools/probe-screen.html', width: 960, height: 540, readyTimeout: 90000, logConsole: true,
}, async (page) => {
  await page.waitReady();
  await sleep(2500);
  await page.setTime(3.0);
  await sleep(200);
  return await page.eval(`JSON.stringify((function(){
    const S = window.__SCREEN__, RR = window.__RENDERER__, R = RR.renderer;
    const out = {};

    // 1) 场景 RT 的属性与可读性
    const srt = RR.compositor.sceneTarget;
    out.sceneRT = { w: srt.width, h: srt.height, type: srt.texture.type, format: srt.texture.format };
    out.canHalfFloatRead = false;

    // 2) 检查 compositor 合成材质当前 uniform
    const cu = RR.compositor.uniforms.composite;
    out.compositeUniforms = {
      bloom: cu.uBloom.value, exposure: cu.uExposure.value,
      warm: cu.uWarm.value, vignette: cu.uVignette.value, grain: cu.uGrain.value,
      tSceneIsSceneRT: cu.tScene.value === srt.texture,
      tBloomA: !!cu.tBloomA.value, tBloomB: !!cu.tBloomB.value, tBloomC: !!cu.tBloomC.value,
    };

    // 3) 直接把 compositor 的合成材质换成「原样输出 tScene」，看差多少
    const THREE = window.__THREE__;
    const dbgMat = new THREE.ShaderMaterial({
      uniforms: { tScene: { value: srt.texture } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'precision highp float; uniform sampler2D tScene; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(tScene, vUv).rgb, 1.0); }',
      depthTest: false, depthWrite: false,
    });
    const saved = RR.compositor.compositeMat;
    RR.compositor.compositeMat = dbgMat;
    RR.bypass = false;
    S.update(1/60, S.light, RR.camera);
    S.renderShadow(RR.scene);
    RR.render(1/60);
    out.usedDbg = true;
    window.__DBG_MAT__ = dbgMat;
    window.__SAVED_MAT__ = saved;
    return out;
  })())`);
});
console.log(JSON.stringify(JSON.parse(r), null, 2));
process.exit(0);

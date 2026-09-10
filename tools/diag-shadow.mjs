// 定点诊断：读回三个 RT 的内容 + 逐模式可视化
import { withPage, readPNG, meanLuma, meanRGB, sleep } from './harness.mjs';

const MODES = [0, 1, 4, 6, 7, 8];

const r = await withPage({
  page: 'tools/probe-screen.html', width: 960, height: 540, readyTimeout: 90000, logConsole: true,
}, async (page) => {
  await page.waitReady();
  await sleep(2500);
  const loopErr = await page.eval('window.__LOOP_ERROR__ || null');
  console.log('shader check:', await page.eval('JSON.stringify(window.__SHADER_CHECK__ ? window.__SHADER_CHECK__() : null)'));
  console.log('loop error:', loopErr ? String(loopErr).split('\n').slice(0, 5).join('\n') : '(none)');
  const pageLogs = page.logs.filter((l) => /error|exception|ERROR/i.test(l));
  if (pageLogs.length) console.log('page errors:\n  ' + pageLogs.slice(0, 6).join('\n  '));

  const info = await page.eval(`JSON.stringify((function(){
    const S = window.__SCREEN__, R = window.__RENDERER__.renderer, L = S.light;
    const cam = L.shadow.camera;
    const M = (m) => Array.from(m.elements).map(v => +v.toFixed(4));
    return {
      camPos: cam.position.toArray().map(v=>+v.toFixed(3)),
      camNear: +cam.near.toFixed(3), camFar: +cam.far.toFixed(3),
      camFov: +cam.fov.toFixed(2), camAspect: +cam.aspect.toFixed(3),
      farUniform: S.uniforms.uFarPlane.value,
      bias: S.uniforms.uShadowBias.value,
      mapRT: { w: S.shadowStage.map.width, h: S.shadowStage.map.height },
      diag: S.shadowStage.diag,
    };
  })())`);
  console.log('=== camera/uniforms ===');
  for (const [k, v] of Object.entries(JSON.parse(info))) console.log(' ', k, '=', JSON.stringify(v));

  const readbacks = await page.eval(`JSON.stringify((function(){
    const S = window.__SCREEN__, R = window.__RENDERER__.renderer;
    const out = {};
    const grab = (rt, name) => {
      const w = rt.width, h = rt.height;
      const b = new Uint8Array(w*h*4);
      R.readRenderTargetPixels(rt, 0, 0, w, h, b);
      let mn=255, mx=0, sum=0, n=0, hist=[0,0,0,0,0];
      for (let i=0;i<b.length;i+=4) { const v=b[i]; mn=Math.min(mn,v); mx=Math.max(mx,v); sum+=v; n++; hist[Math.min(4,Math.floor(v/52))]++; }
      out[name] = { w, h, min: mn, max: mx, mean: +(sum/n).toFixed(2), hist: hist.map(v=>+(v/n).toFixed(3)) };
    };
    grab(S.shadowStage.map, 'shadowMap');
    grab(S.shadowStage.blurH, 'blurH');
    grab(S.shadowStage.pre, 'pre');
    return out;
  })())`);
  console.log('=== render target readback (R channel) ===');
  for (const [k, v] of Object.entries(JSON.parse(readbacks))) console.log(' ', k, '=', JSON.stringify(v));

  const shots = {};
  for (const m of MODES) {
    await page.eval(`window.__SCREEN__.setDebugMode(${m})`);
    await page.setTime(3.0);
    await sleep(700);
    const u = await page.eval('window.__SCREEN__.uniforms.uDebug.value');
    const st = await page.eval('JSON.stringify(window.__SCREEN__.shadowStage.diag)');
    console.log(`  mode ${m}: uDebug=${u} diag=${st}`);
    shots[m] = await page.shot(`shots/dbg-${m}.png`);
  }
  await page.eval('window.__SCREEN__.setDebugMode(0)');
  return shots;
});

console.log('\n=== debug modes (R,G,B 区域均值) ===');
for (const [mode, p] of Object.entries(r)) {
  const img = readPNG(p);
  const c = meanRGB(img, 400, 220, 560, 320);
  const L = meanRGB(img, 40, 220, 140, 320);
  const label = {
    0: '最终', 1: 'shadow(1=受光)', 4: 'shadowUV(R=u,G=v)', 6: 'ref 距离', 7: 'shadowMap 原始采样', 8: 'R=map采样 B=(1-ref→1)',
  }[mode] || mode;
  console.log(` mode ${mode} [${label}] centre=[${c.map(v=>v.toFixed(3)).join(',')}]  left=[${L.map(v=>v.toFixed(3)).join(',')}]`);
}

process.exit(0);

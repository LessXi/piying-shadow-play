import { withPage, sleep } from './harness.mjs';
import { readPNG, meanLuma } from './harness.mjs';

const r = await withPage({
  page: 'tools/probe-screen.html', width: 960, height: 540, readyTimeout: 90000, logConsole: true,
}, async (page) => {
  await page.waitReady();
  await sleep(2500);
  await page.setTime(3.0);
  await sleep(300);
  // 在同一页面里开第二块画布，左=shadow map 本体，右=场景原样（不走后期）
  await page.eval(`(function(){
    const S = window.__SCREEN__, RR = window.__RENDERER__, THREE = window.__THREE__;
    const c2 = document.createElement('canvas');
    c2.width = 1200; c2.height = 600; c2.id = 'cmp';
    document.body.appendChild(c2);
    const r2 = new THREE.WebGLRenderer({ canvas: c2, antialias: false, preserveDrawingBuffer: true });
    r2.setPixelRatio(1); r2.setSize(1200, 600, false);
    r2.outputColorSpace = THREE.LinearSRGBColorSpace;
    r2.toneMapping = THREE.NoToneMapping;
    r2.setScissorTest(true);
    // 左：shadow map（600x600）
    r2.setViewport(0, 0, 600, 600); r2.setScissor(0, 0, 600, 600);
    r2.setClearColor(0x101010, 1); r2.clear(true, true, true);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: S.shadowStage.map.texture, toneMapped: false }));
    const s = new THREE.Scene(); s.add(quad);
    r2.render(s, new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10));
    // 右：场景（用诊断旁路渲染到这块画布）
    const saved = RR.renderer;
    RR.renderer = r2;
    r2.setViewport(600, 0, 600, 600); r2.setScissor(600, 0, 600, 600);
    r2.setClearColor(0x000000, 1); r2.clear(true, true, true);
    RR.bypass = true;
    const savedCam = RR.camera.aspect;
    RR.camera.aspect = 1.0; RR.camera.updateProjectionMatrix();
    RR.render(1/60);
    RR.camera.aspect = savedCam; RR.camera.updateProjectionMatrix();
    RR.renderer = saved;
    RR.bypass = false;
  })()`);
  await sleep(300);
  await page.fullShot('shots/cmp-shadowmap-vs-scene.png');
  return null;
});

const img = readPNG('shots/cmp-shadowmap-vs-scene.png');
console.log('page shot', img.width, 'x', img.height);
const g = (x0, y0, x1, y1) => meanLuma(img, x0, y0, x1, y1, 3).toFixed(3);
console.log('左(shadow map) 上中 =', g(250, 40, 350, 120), ' 下中 =', g(250, 480, 350, 560));
console.log('右(场景)      上中 =', g(850, 40, 950, 120), ' 下中 =', g(850, 480, 950, 560));
process.exit(0);

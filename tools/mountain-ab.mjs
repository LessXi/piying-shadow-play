import { withPage, sleep } from './harness.mjs';
import { readPNG, meanLuma, imageDiff } from './harness.mjs';

const out = await withPage({
  page: 'index.html', width: 1280, height: 720, readyTimeout: 120000,
}, async (page) => {
  await page.waitReady();
  await sleep(2500);
  await page.eval('window.__SET_TIME__(45.5)');
  await sleep(800);
  await page.shot('shots/mountain-on.png');
  const info = await page.eval(`JSON.stringify((function(){
    const scene = window.__SCENE__;
    const out = { names: [] };
    scene.traverse(o => { if (o.isMesh) out.names.push((o.name || '(anon)') + ' z=' + o.position.z.toFixed(2)); });
    return out;
  })())`);
  // 隐藏远山（部件名 mountain）
  const hid = await page.eval(`(function(){
    let n = 0;
    window.__SCENE__.traverse(o => { if (o.isMesh && o.name === 'mountain') { o.visible = false; n++; } });
    return n;
  })()`);
  await sleep(300);
  await page.eval('window.__SET_TIME__(45.5)');
  await sleep(800);
  await page.shot('shots/mountain-off.png');
  return { info, hid };
});
console.log('meshes:', out.info);
console.log('hidden(s) mountain parts:', out.hid);
const a = readPNG('shots/mountain-on.png');
const b = readPNG('shots/mountain-off.png');
const d = imageDiff(a, b);
console.log(`远山 A/B 画面平均差 = ${(d * 100).toFixed(3)}%`);
console.log(`可见性判据: ${d > 0.0005 ? '远山【可见】' : '远山【不可见】'}`);
process.exit(0);

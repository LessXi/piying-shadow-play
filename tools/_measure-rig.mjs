import { withPage, sleep } from './harness.mjs';

// 在**完整作品**里量出人物各部件的世界尺寸与铰链位置，
// 用来给引擎示例写一份"比例正确"的装配参数。
const r = await withPage({
  page: 'index.html', width: 1280, height: 720, readyTimeout: 120000,
}, async (page) => {
  await page.waitReady();
  await sleep(2000);
  await page.eval('window.__SET_TIME__(14)');
  await sleep(500);
  return await page.eval(`JSON.stringify((function(){
    const g = window.__RIGS__ && window.__RIGS__.general;
    if (!g) return { err: 'no rig handle' };
    const out = [];
    for (const [key, p] of g.parts) {
      const wp = new (p.pivot.position.constructor)();
      p.pivot.updateWorldMatrix(true, false);
      p.pivot.getWorldPosition(wp);
      out.push({
        key,
        parent: p.spec.parent || null,
        w: +p.spec.w.toFixed(4), h: +p.spec.h.toFixed(4),
        anchor: p.spec.anchor,
        pivot: p.spec.pivot,
        worldY: +wp.y.toFixed(3), worldX: +wp.x.toFixed(3),
      });
    }
    return { parts: out };
  })())`);
});
console.log(JSON.stringify(JSON.parse(r), null, 1));
process.exit(0);

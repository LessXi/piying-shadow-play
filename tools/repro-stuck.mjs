import { withPage, sleep } from './harness.mjs';

// 用和 e2e 相同的加载方式，但把「构建失败」的信息全部打出来
const r = await withPage({
  page: 'index.html', width: 1280, height: 720, readyTimeout: 30000, logConsole: true,
}, async (page) => {
  let ready = false;
  try { await page.waitReady(25000); ready = true; } catch (e) { ready = false; }
  const st = await page.eval(`JSON.stringify({
    ready: window.__READY__ === true,
    buildError: window.__BUILD_ERROR__ || null,
    loopError: window.__LOOP_ERROR__ || null,
    loadingMsg: (document.getElementById('loading-msg') || {}).textContent || null,
    loadingGone: !document.getElementById('loading') || document.getElementById('loading').classList.contains('gone'),
    hasQa: typeof window.__qa,
    sceneMeshes: (function(){ let n = 0; try { window.__SCENE__.traverse(o => { if (o.isMesh) n++; }); } catch(e) { return 'err:' + e.message; } return n; })(),
    title: document.title,
  })`);
  return { ready, st, logs: page.logs.slice(-25) };
});
console.log('ready:', r.ready);
console.log('state:', r.st);
console.log('\n--- page console ---');
for (const l of r.logs) console.log('  ', String(l).slice(0, 300));
process.exit(0);

import { withPage } from './harness.mjs';
const r = await withPage({ page: 'tools/shadow-truth.html', width: 340, height: 200, readyTimeout: 60000, logConsole: true },
  async (page) => {
    await page.waitReady();
    return await page.eval('JSON.stringify(window.__RES__)');
  });
const j = JSON.parse(r);
for (const k of ['final', 'mode1', 'mode9', 'mode8']) {
  const s = j[k];
  if (!s) continue;
  console.log(`\n=== ${k} ===  影子预期像素 (${s.sx}, ${s.sy})  该处 = ${JSON.stringify(s.atShadow)}`);
  for (const row of s.rows) console.log('  ' + row);
}
console.log('\n=== shadow map 采样（幕布平面 y=-0.5 上不同 x 处）===');
for (const s of j.shadowMapSamples) console.log('  ', JSON.stringify(s));
process.exit(0);

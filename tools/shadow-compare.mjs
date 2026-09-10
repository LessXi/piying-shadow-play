import { withPage } from './harness.mjs';
const r = await withPage({ page: 'tools/shadow-compare.html', width: 340, height: 200, readyTimeout: 60000, logConsole: true },
  async (page) => {
    await page.waitReady();
    return await page.eval('JSON.stringify(window.__RES__)');
  });
const j = JSON.parse(r);
const labels = { mode0: 'lit(R)', mode5: 'sd 采样', mode6: 'ref' };
console.log('=== 屏幕中间行 (x=20..300, step 20) ===');
for (const k of ['mode0', 'mode5', 'mode6']) {
  console.log(`${k.padEnd(6)} [${labels[k].padEnd(8)}]`, (j[k] || []).join(' '));
}
console.log('\n=== sd 采样在屏幕空间的 10x10 分布 (行0=画面顶部) ===');
for (const row of (j.grid5 || [])) console.log('  ' + row);
console.log('\n=== ref 的 10x10 分布 ===');
for (const row of (j.grid6 || [])) console.log('  ' + row);
process.exit(0);

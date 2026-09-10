import { withPage } from './harness.mjs';
const r = await withPage({ page: 'tools/raw-scene.html', width: 340, height: 200, readyTimeout: 60000, logConsole: true },
  async (page) => {
    await page.waitReady();
    return await page.eval('JSON.stringify(window.__RES__)');
  });
const j = JSON.parse(r);
console.log('uniforms:', JSON.stringify(j.uniforms));
for (const k of ['final', 'hdr', 'withBasicMat', 'shadowOnly']) {
  console.log(`\n=== ${k} (R 通道线性值) ===`);
  for (const row of (j[k] || [])) console.log('  ' + row);
}
process.exit(0);

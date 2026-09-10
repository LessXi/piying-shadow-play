import { withPage } from './harness.mjs';
const r = await withPage({ page: 'tools/scene-readback.html', width: 340, height: 200, readyTimeout: 60000, logConsole: true },
  async (page) => {
    await page.waitReady();
    return await page.eval('JSON.stringify(window.__RES__)');
  });
const j = JSON.parse(r);
for (const k of ['normal', 'mode9', 'noShadow']) {
  const s = j[k];
  console.log(`${k}: min=${s.min} max=${s.max} mean=${s.mean}`);
  console.log('   ' + s.line.join('  '));
}
process.exit(0);

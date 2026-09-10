import { withPage } from './harness.mjs';
const r = await withPage({ page: 'tools/rt-capacity.html', width: 300, height: 300, readyTimeout: 60000, logConsole: true },
  async (page) => {
    await page.waitReady();
    return await page.eval('JSON.stringify(window.__RES__)');
  });
const j = JSON.parse(r);
console.log('isWebGL2:', j.isWebGL2, ' hdrSupported:', j.rendererHdrSupported);
console.log('extensions:', JSON.stringify(j.exts));
console.log('compositor sceneRT:', j.sceneRTComplete);
console.log('');
for (const t of j.results) {
  console.log(`${t.label.padEnd(26)} ${t.status.padEnd(18)} clearErr=${t.errAfterClear} drawErr=${t.errAfterDraw}`);
  console.log(`   bytes=${JSON.stringify(t.bytes)}${t.errB ? ' ERR:' + t.errB : ''}`);
  console.log(`   floats=${JSON.stringify(t.floats)}${t.errF ? ' ERR:' + t.errF : ''}`);
}
process.exit(0);

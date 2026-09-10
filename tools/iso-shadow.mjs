import { withPage } from './harness.mjs';
const r = await withPage({ page: 'tools/iso-shadow.html', width: 320, height: 320, readyTimeout: 60000, logConsole: true },
  async (page) => {
    await page.waitReady();
    await page.fullShot('shots/iso-shadowmap.png');
    const res = await page.eval('JSON.stringify(window.__RES__)');
    return { res, logs: page.logs.filter((l) => /ERROR|error/i.test(l)).slice(0, 6) };
  });
const j = JSON.parse(r.res);
for (const [k, v] of Object.entries(j)) {
  if (Array.isArray(v) && v.length > 8) continue;
  console.log(k, '=', JSON.stringify(v));
}
console.log('logs:', r.logs);
process.exit(0);

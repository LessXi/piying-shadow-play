import { withPage } from './harness.mjs';
const r = await withPage({ page: 'tools/min-shadow.html', width: 300, height: 300, readyTimeout: 60000, logConsole: true },
  async (page) => {
    await page.waitReady();
    return await page.eval('JSON.stringify(window.__RES__)');
  });
console.log(JSON.stringify(JSON.parse(r), null, 2));
process.exit(0);

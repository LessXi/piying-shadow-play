import { withPage, sleep } from './harness.mjs';
const r = await withPage({ page: 'tools/gl-feedback.html', width: 700, height: 420, readyTimeout: 90000, logConsole: true },
  async (page) => {
    await page.waitReady();
    await sleep(1500);
    return await page.eval('JSON.stringify(window.__RES__)');
  });
console.log(JSON.stringify(JSON.parse(r), null, 2));
process.exit(0);

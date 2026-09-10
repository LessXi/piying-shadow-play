import { withPage } from './harness.mjs';
import { findBrowser } from './harness.mjs';

console.log('browser:', findBrowser());
console.log('cwd:', process.cwd());

const r = await withPage({
  page: 'tools/verify-module.html', width: 400, height: 200, readyTimeout: 45000, logConsole: true,
}, async (page) => {
  console.log('  connected, waiting ready...');
  await page.waitReady();
  console.log('  ready!');
  return await page.eval('JSON.stringify(window.__CHECK__)');
});
console.log('RESULT:', r);
process.exit(0);

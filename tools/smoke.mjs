// Smoke test: does headless Chrome/Edge on this machine give us a real WebGL context?
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect } from './cdp.mjs';

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const browser = BROWSERS.find(existsSync);
if (!browser) { console.error('no browser found'); process.exit(2); }

const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), 'dsh-cdp-'));
const pagePath = resolve(process.argv[2] || 'tools/smoke.html');
const args = [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--hide-scrollbars', '--window-size=800,600',
  '--allow-file-access-from-files',
  'file:///' + pagePath.replace(/\\/g, '/'),
];
console.log('launching', browser, '\npage:', pagePath);
const proc = spawn(browser, args, { stdio: 'ignore', windowsHide: true });

try {
  const { ws, root } = await connect(PORT, { urlIncludes: 'smoke.html' });
  root.on((m) => { if (m.method === 'Runtime.consoleAPICalled') console.log('[page]', m.params.args?.map(a => a.value).join(' ')); });
  await new Promise((r) => setTimeout(r, 1500));
  const info = await root.eval('JSON.stringify(window.__smoke)');
  console.log('SMOKE:', info);
  const shot = await root.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve('shots/_smoke.png'), Buffer.from(shot.data, 'base64'));
  console.log('wrote shots/_smoke.png');
  ws.close();
} finally {
  try { proc.kill(); } catch {}
  try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
}

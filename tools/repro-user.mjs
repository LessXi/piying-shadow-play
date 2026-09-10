// 用**没有** --allow-file-access-from-files 的普通浏览器打开 index.html，
// 看是不是 file:// 下 ES module 被 CORS 拦住（用户看到"卡在加载页"的真实原因）。
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { connect } from './cdp.mjs';

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const browser = BROWSERS.find(existsSync);
const PORT = 9411;
const profile = mkdtempSync(join(tmpdir(), 'stuck-'));
const page = resolve('index.html');

// 关键：**不带** --allow-file-access-from-files，模拟用户双击打开的场景
const args = [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=1280,800',
  'file:///' + page.replace(/\\/g, '/'),
];
console.log('launching without --allow-file-access-from-files');
const proc = spawn(browser, args, { stdio: 'ignore', windowsHide: true });

try {
  const { ws, root } = await connect(PORT, { urlIncludes: 'index.html' });
  const logs = [];
  root.on((m) => {
    if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${m.params.type}] ` + (m.params.args || []).map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push('[exception] ' + (d.exception?.description || d.text));
      logs.push('   at ' + d.url + ':' + d.lineNumber + ':' + d.columnNumber);
      if (d.stackTrace) for (const f of d.stackTrace.callFrames.slice(0, 5)) logs.push(`   frame ${f.functionName || '(top)'} @ ${f.url}:${f.lineNumber + 1}:${f.columnNumber}`);
    }
    if (m.method === 'Log.entryAdded') logs.push(`[log:${m.params.entry.level}] ` + m.params.entry.text + ' @' + (m.params.entry.url || '') + ':' + (m.params.entry.lineNumber || ''));
  });
  await root.send('Runtime.enable');
  await root.send('Log.enable');
  await root.send('Page.enable');
  await new Promise((r) => setTimeout(r, 6000));
  const st = await root.eval(`JSON.stringify({
    ready: window.__READY__ === true,
    buildError: window.__BUILD_ERROR__ || null,
    loadingMsg: (document.getElementById('loading-msg') || {}).textContent || null,
    hasQa: typeof window.__qa,
  })`);
  console.log('state:', st);
  console.log('\n--- browser console / log ---');
  for (const l of logs.slice(0, 25)) console.log('  ', String(l).slice(0, 320));
  const shot = await root.send('Page.captureScreenshot', { format: 'png' });
  mkdirSync('shots', { recursive: true });
  writeFileSync('shots/user-scenario.png', Buffer.from(shot.data, 'base64'));
  console.log('\nwrote shots/user-scenario.png');
  ws.close();
} finally {
  try { proc.kill(); } catch {}
  try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
}
process.exit(0);

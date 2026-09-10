// 验证**导出的分享文件**能在不带任何特殊开关的浏览器里独立打开并跑起来。
// 这是最后一道关：模拟"朋友收到文件、双击打开"。
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect } from './cdp.mjs';

const FILE = process.argv[2] || '影窗·夜巡-皮影戏.html';

// 更强的一步：把它**复制到一个全新的空目录**再打开，
// 这样如果它偷偷依赖了同目录下的 src/ 或 vendor/，一定会暴露。
const isoDir = mkdtempSync(join(tmpdir(), 'share-iso-'));
const isolated = join(isoDir, '影窗·夜巡-皮影戏.html');
writeFileSync(isolated, readFileSync(resolve(FILE)));
console.log('隔离副本:', isolated);
console.log('该目录内容:', readdirSync(isoDir).join(', ') || '(空)');

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const browser = BROWSERS.find(existsSync);
const PORT = 9433;
const profile = mkdtempSync(join(tmpdir(), 'share-prof-'));

const args = [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--hide-scrollbars',
  '--window-size=1280,900',
  'file:///' + isolated.replace(/\\/g, '/'),
];
console.log('启动浏览器（**不带** --allow-file-access-from-files）');
const proc = spawn(browser, args, { stdio: 'ignore', windowsHide: true });

try {
  const { ws, root } = await connect(PORT, { urlIncludes: '.html' });
  const logs = [];
  root.on((m) => {
    if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${m.params.type}] ` + (m.params.args || []).map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push('[exception] ' + (d.exception?.description || d.text) + ' @line ' + d.lineNumber);
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push('[log:error] ' + m.params.entry.text);
  });
  await root.send('Runtime.enable');
  await root.send('Log.enable');
  await root.send('Page.enable');

  // 等就绪（最多 40 秒）
  let ready = false;
  for (let i = 0; i < 80; i++) {
    const v = await root.eval('window.__READY__ === true').catch(() => false);
    if (v) { ready = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }

  await new Promise((r) => setTimeout(r, 2500));
  const st = await root.eval(`JSON.stringify({
    ready: window.__READY__ === true,
    buildError: window.__BUILD_ERROR__ || null,
    loadingStillVisible: !!document.getElementById('loading'),
    qa: window.__qa ? (function(){ const q = window.__qa(); return { duration: q.duration, casters: q.shadowCasters, webgl2: q.webgl2, tri: q.stats && q.stats.tris }; })() : null,
    canvasSize: (function(){ const c = document.getElementById('stage-canvas'); return c ? [c.width, c.height] : null; })(),
  })`);

  // 抓一帧 32.5s（背身亮相）作为证据
  if (ready) {
    await root.eval('window.__SET_TIME__(32.5)');
    await new Promise((r) => setTimeout(r, 900));
  }
  const shot = await root.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('shots/share-file-standalone.png', Buffer.from(shot.data, 'base64'));

  console.log('\n状态:', st);
  const errs = logs.filter((l) => /exception|log:error/i.test(l));
  console.log('错误条数:', errs.length);
  for (const l of errs.slice(0, 5)) console.log('  ', String(l).slice(0, 200));
  console.log('证据截图: shots/share-file-standalone.png');
  ws.close();
} finally {
  try { proc.kill(); } catch {}
  try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
}
process.exit(0);

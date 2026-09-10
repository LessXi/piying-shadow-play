// 影窗 · 夜巡 —— headless Chrome 启动/连接（从 tools/smoke.mjs 的启动参数抽出来复用）
// 只读参考了 smoke.mjs，不改它；本文件属于皮影资产组的自检工具链。
//
// SwiftShader 软渲染要点：
//   --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader  ← 没有它就没有 WebGL2
//   --allow-file-access-from-files                                     ← 本地 file:// 读 src/ vendor/
//   --hide-scrollbars --window-size=W,H                                ← 截图尺寸可控

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect } from './cdp.mjs';

export const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

export function findBrowser(explicit) {
  if (explicit && existsSync(explicit)) return explicit;
  if (process.env.DSH_BROWSER && existsSync(process.env.DSH_BROWSER)) return process.env.DSH_BROWSER;
  const found = BROWSERS.find(existsSync);
  if (!found) throw new Error('找不到 Chrome/Edge，可用 DSH_BROWSER 环境变量指定');
  return found;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 启动 headless 浏览器并返回句柄。
 * @param {{port?:number, page?:string, width?:number, height?:number, extraArgs?:string[], browser?:string}} opts
 *        page 可以是工作目录相对路径（工具会自动转成 file:// 绝对路径）
 */
export function launchBrowser({
  port = 9333, page = 'tools/asset-preview.html', width = 800, height = 500,
  extraArgs = [], browser = null, profile = null,
} = {}) {
  const exe = findBrowser(browser);
  const prof = profile || mkdtempSync(join(tmpdir(), 'dsh-asset-'));
  const pagePath = resolve(page);
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${prof}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    `--window-size=${width},${height}`,
    '--allow-file-access-from-files',
    '--disable-features=CalculateNativeWinOcclusion',
    ...extraArgs,
    'file:///' + pagePath.replace(/\\/g, '/'),
  ];
  const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
  return {
    proc, port, exe, pagePath, url: 'file:///' + pagePath.replace(/\\/g, '/'),
    kill() {
      try { proc.kill(); } catch {}
      try {
        spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch {}
    },
  };
}

/** 连上页面并等 WebGL/模块就绪 */
export async function connectPage(port, { urlIncludes = null, timeoutMs = 90000 } = {}) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      return await connect(port, { urlIncludes });
    } catch (e) { lastErr = e; await sleep(400); }
  }
  throw new Error('连接 CDP 失败：' + (lastErr && lastErr.message));
}

/** 轮询等待页面里的表达式为真（返回该表达式的值） */
export async function waitFor(root, expr, { timeoutMs = 120000, intervalMs = 400, label = expr } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = await root.eval(expr);
      if (last) return last;
    } catch (e) { last = 'eval error: ' + e.message; }
    await sleep(intervalMs);
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label}；最后结果 = ${JSON.stringify(last)}`);
}

/** 等页面渲染帧计数器前进 n 帧（SwiftShader 很慢，所以用轮询而不是 sleep） */
export async function waitFrames(root, n = 2, { timeoutMs = 180000, intervalMs = 500 } = {}) {
  const start = await root.eval('window.__FRAMES__ || 0');
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const now = await root.eval('window.__FRAMES__ || 0');
    if (now - start >= n) return now;
    await sleep(intervalMs);
  }
  const now = await root.eval('window.__FRAMES__ || 0');
  throw new Error(`等待 ${n} 帧超时：只前进了 ${now - start} 帧`);
}

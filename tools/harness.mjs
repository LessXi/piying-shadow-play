// 可复用的无头浏览器启动器 + 截图工具。任何组都可以 import 它。
// 用法：
//   import { withPage } from './harness.mjs';
//   await withPage({ page: 'index.html', width: 1280, height: 720 }, async (page) => { ... });
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { connect } from './cdp.mjs';

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

export function findBrowser() {
  const b = BROWSERS.find(existsSync);
  if (!b) throw new Error('找不到 Chrome/Edge');
  return b;
}

/** 从 9400 起找一个端口（必须是整数，否则 CDP 端口会变成 9612.34 这种非法值） */
let _portSeq = 0;
function pickPort() {
  _portSeq = (_portSeq + 1) % 400;
  return 9400 + ((process.pid + Math.floor(Math.random() * 400) + _portSeq) % 400);
}

/**
 * 启动无头浏览器打开一个本地页面，执行 fn(page)，然后清理。
 * @param {object} opts
 * @param {string} opts.page        相对项目根的文件路径，如 'index.html' 或 'tools/probe-screen.html'
 * @param {number} [opts.width]     视口宽
 * @param {number} [opts.height]    视口高
 * @param {string} [opts.query]     附加 query string（不含 ?）
 * @param {number} [opts.readyTimeout] 等待 window.__READY__ 的超时毫秒
 * @param {boolean} [opts.logConsole]
 * @param {(page:Page)=>Promise<any>} fn
 */
export async function withPage(opts, fn) {
  const {
    page: pagePath, width = 1280, height = 720, query = '',
    readyTimeout = 90000, logConsole = false, root = resolve('.'),
  } = opts;

  const browser = findBrowser();
  const port = pickPort();
  const profile = mkdtempSync(join(tmpdir(), 'shadow-cdp-'));
  const file = resolve(root, pagePath);
  const url = 'file:///' + file.replace(/\\/g, '/') + (query ? '?' + query : '');

  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--hide-scrollbars', '--mute-audio',
    `--window-size=${width},${height + 120}`,
    '--allow-file-access-from-files',
    '--allow-running-insecure-content',
    url,
  ];
  const proc = spawn(browser, args, { stdio: 'ignore', windowsHide: true });

  let cleanup = () => {};
  const t0 = Date.now();
  try {
    const { ws, root: session } = await connect(port, { urlIncludes: pagePath.split('/').pop() });
    const targetUrl = session.__targetUrl || '';
    console.log(`  [harness] pid=${proc.pid} port=${port} target=${targetUrl.slice(-60)}`);

    const logs = [];
    session.on((m) => {
      if (m.method === 'Runtime.consoleAPICalled') {
        const line = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        logs.push(`[${m.params.type}] ${line}`);
        if (logConsole) console.log('  page>', line);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        const line = d.exception?.description || d.text;
        logs.push('[exception] ' + line);
        console.error('  page EXCEPTION:', String(line));
      }
    });

    await session.send('Runtime.enable');
    await session.send('Page.enable');
    await session.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    });

    const page = {
      session, logs,
      /** 收集所有 WebGL/着色器编译错误与页面异常 */
      async collectErrors() {
        const shaderErrs = await session.eval(`
          (function(){
            const r = window.__RENDERER__ && window.__RENDERER__.renderer;
            return (window.__GL_ERRORS__ || []).slice(0, 20);
          })()
        `).catch(() => []);
        const exc = logs.filter((l) => /^\[exception\]|pageerror/.test(l));
        const err = logs.filter((l) => /ERROR:|Program Info Log|not compiled/i.test(l));
        return { shaderErrs, exceptions: exc, gl: err };
      },
      async waitReady(timeout = readyTimeout) {
        const t0 = Date.now();
        while (Date.now() - t0 < timeout) {
          const err = await session.eval('window.__BUILD_ERROR__ || null').catch(() => null);
          if (err) throw new Error('页面构建失败：' + err);
          const ok = await session.eval('window.__READY__ === true').catch(() => false);
          if (ok) return true;
          await sleep(300);
        }
        throw new Error('等待 __READY__ 超时 ' + timeout + 'ms');
      },
      async waitFrames(n = 3) {
        await session.eval(`new Promise(r => { let k = 0; const f = () => { if (++k >= ${n}) r(true); else requestAnimationFrame(f); }; requestAnimationFrame(f); })`);
      },
      eval: (expr, aw = true) => session.eval(expr, aw),
      async setTime(t) {
        await session.eval(`window.__SET_TIME__(${Number(t)})`);
        await page.waitFrames(2);
      },
      async shot(path, { from = 'canvas' } = {}) {
        let data;
        if (from === 'canvas') {
          const url = await session.eval('window.__snapshot()');
          data = String(url).split(',')[1];
        } else {
          const r = await session.send('Page.captureScreenshot', { format: 'png' });
          data = r.data;
        }
        const out = resolve(path);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, Buffer.from(data, 'base64'));
        return out;
      },
      async fullShot(path) {
        const r = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const out = resolve(path);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, Buffer.from(r.data, 'base64'));
        return out;
      },
    };

    cleanup = () => { try { ws.close(); } catch {} };
    return await fn(page);
  } finally {
    cleanup();
    try { proc.kill(); } catch {}
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {}
    await sleep(120);
  }
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ------------------------------------------------------------------ *
 * 最小 PNG 解码器（node:zlib）—— 用于像素级定量断言
 * ------------------------------------------------------------------ */
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';

export function decodePNG(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null, trns = null;
  while (off < buffer.length) {
    const len = buffer.readUInt32BE(off);
    const type = buffer.toString('ascii', off + 4, off + 8);
    const data = buffer.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (interlace) throw new Error('不支持隔行 PNG');
  const raw = zlib.inflateSync(Buffer.concat(idat));

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (channels == null) throw new Error('不支持的颜色类型 ' + colorType);
  if (bitDepth !== 8) throw new Error('只支持 8 位 PNG，实际 ' + bitDepth);

  const bpp = channels;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = (prev && i >= bpp) ? prev[i - bpp] : 0;
      let v = line[i];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 255; break;
        case 2: v = (v + b) & 255; break;
        case 3: v = (v + ((a + b) >> 1)) & 255; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c))) & 255;
          break;
        }
        default: throw new Error('未知 filter ' + filter);
      }
      cur[i] = v;
    }
  }

  // 统一成 RGBA
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * bpp, d = i * 4;
    if (colorType === 0) { rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s]; rgba[d + 3] = 255; }
    else if (colorType === 2) { rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2]; rgba[d + 3] = 255; }
    else if (colorType === 3) {
      const pi = out[s] * 3;
      rgba[d] = palette[pi]; rgba[d + 1] = palette[pi + 1]; rgba[d + 2] = palette[pi + 2];
      rgba[d + 3] = trns && out[s] < trns.length ? trns[out[s]] : 255;
    } else if (colorType === 4) { rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s]; rgba[d + 3] = out[s + 1]; }
    else { rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2]; rgba[d + 3] = out[s + 3]; }
  }
  return { width, height, data: rgba };
}

export function readPNG(path) { return decodePNG(readFileSync(path)); }

/** 从 PNG 里取亮度 */
export function luma(img, x, y) {
  const i = (y * img.width + x) * 4;
  return 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
}

/** 区域平均亮度（归一化 0..1） */
export function meanLuma(img, x0, y0, x1, y1, step = 1) {
  let s = 0, n = 0;
  for (let y = Math.max(0, y0 | 0); y < Math.min(img.height, y1 | 0); y += step) {
    for (let x = Math.max(0, x0 | 0); x < Math.min(img.width, x1 | 0); x += step) {
      s += luma(img, x, y); n++;
    }
  }
  return n ? s / n / 255 : 0;
}

export function meanRGB(img, x0, y0, x1, y1, step = 1) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.max(0, y0 | 0); y < Math.min(img.height, y1 | 0); y += step) {
    for (let x = Math.max(0, x0 | 0); x < Math.min(img.width, x1 | 0); x += step) {
      const i = (y * img.width + x) * 4;
      r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
    }
  }
  return n ? [r / n / 255, g / n / 255, b / n / 255] : [0, 0, 0];
}

/** 两图平均绝对差（0..1），用来证明“确实在动” */
export function imageDiff(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('尺寸不同');
  let s = 0;
  const n = a.width * a.height * 4;
  for (let i = 0; i < n; i += 4) {
    s += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
  }
  return s / (n / 4) / 3 / 255;
}

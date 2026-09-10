// 影窗 · 夜巡 —— 皮影资产姿态自检（headless Chrome + CDP + 像素定量分析）
//
//   node tools/asset-preview.mjs            # 全部姿态 + 图集 + 指标
//   node tools/asset-preview.mjs stand      # 只跑指定姿态（调试用，省时间）
//
// 流程：
//   1. 起动 headless Chrome（SwiftShader），加载 tools/asset-preview.html（真实引擎链路：Renderer+Stage+WaveScreen）
//   2. 先拍一张"只有布景、没有演员"的基线图
//   3. 逐个姿态：__SET_POSE__ → 等渲染帧 → Page.captureScreenshot → shots/asset-<姿态>.png
//   4. 把每张截图和基线相减：差出来的暗区 = 剪影；剪影内部"几乎没变暗"的像素 = **光穿过镂空的亮斑**
//      → 打印 silhouettePx / holePx / holeRatio（这是"镂空亮斑"的硬数字，不靠肉眼）
//   5. 拍一张部件图集 shots/asset-atlas.png（每张图纸 + 关节轴心十字），并打印贴图孔洞统计
//
// 注意：WebGL 只有 SwiftShader 软渲染，很慢 —— 分辨率 800x500，等帧用轮询而不是 sleep。

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync, deflateSync } from 'node:zlib';
import { launchBrowser, connectPage, sleep } from './launch.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = resolve(ROOT, 'shots');
const PORT = 9341;
const only = process.argv[2] || null;

/* ------------------------------------------------------------------ *
 * 最小 PNG 解码器（filter + inflate；只支持 8bit / 非隔行，够用）
 * ------------------------------------------------------------------ */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('只支持 8bit PNG（实际 ' + bitDepth + '）');
  if (interlace) throw new Error('不支持隔行 PNG');
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!ch) throw new Error('不支持的 colorType ' + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev ? prev[i] : 0;
      const c = (prev && i >= ch) ? prev[i - ch] : 0;
      let v = raw[p + i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (ft !== 0) throw new Error('坏 filter ' + ft);
      cur[i] = v & 0xff;
    }
    p += stride;
  }
  return { w, h, ch, stride, data: out };
}

function lumAt(img, x, y) {
  const i = (y * img.w + x) * img.ch;
  const d = img.data;
  return (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
}

/* ------------------------------------------------------------------ *
 * 最小 PNG 编码器 + 线性→sRGB 显示变换
 * raw 通道里画布写的是**线性**值（幕布的 ShaderMaterial 自己写 gl_FragColor，
 * 不走 three 的 outputColorSpace 转换），直接看会偏暗；这里按标准把线性值编码成 sRGB 存图，
 * 不做泛光/暖调，保证"所见 = 幕布着色本身"。
 * ------------------------------------------------------------------ */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function encodePng(w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const idat = deflateSync(raw, { level: 9 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'latin1');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const LIN2SRGB = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  LIN2SRGB[i] = Math.max(0, Math.min(255, Math.round(s * 255)));
}
function toDisplayPng(img) {
  const out = Buffer.alloc(img.w * img.h * 3);
  for (let i = 0, j = 0; i < img.w * img.h; i++, j += 3) {
    const s = i * img.ch;
    out[j] = LIN2SRGB[img.data[s]];
    out[j + 1] = LIN2SRGB[img.data[s + 1]];
    out[j + 2] = LIN2SRGB[img.data[s + 2]];
  }
  return encodePng(img.w, img.h, out);
}

/**
 * 镂空亮斑定量：把姿态图和"空台"基线相减。
 * loss = 基线亮度 - 姿态亮度（>0 说明这里被剪影挡住）。
 * 逐行取 [首个被挡, 末个被挡] 之间为"剪影填充区"；该行较深分位为遮挡深度 med；
 * loss < med*0.35 的像素 = 几乎没被挡 → 光直接穿过去的**镂空亮斑**。
 */
function holeMetric(base, shot, band = { x0: 0.16, x1: 0.84, y0: 0.05, y1: 0.99 }) {
  const x0 = Math.floor(band.x0 * shot.w), x1 = Math.floor(band.x1 * shot.w);
  const y0 = Math.floor(band.y0 * shot.h), y1 = Math.floor(band.y1 * shot.h);
  let filled = 0, blocked = 0, holes = 0, lossSum = 0, lossMax = 0, rows = 0, holeRows = 0;
  for (let y = y0; y < y1; y++) {
    const n = x1 - x0;
    const loss = new Float32Array(n);
    for (let x = 0; x < n; x++) loss[x] = Math.max(0, lumAt(base, x0 + x, y) - lumAt(shot, x0 + x, y));
    let a = -1, b = -1;
    for (let k = 0; k < n; k++) if (loss[k] > 0.02) { if (a < 0) a = k; b = k; }
    if (a < 0 || b - a < 2) continue;
    rows++;
    // 该行的"完全被挡"参考：取 90 分位（比中位数更能代表实体区，孔洞不会把它拉低）
    const inner = [];
    for (let k = a; k <= b; k++) inner.push(loss[k]);
    inner.sort((u, v) => u - v);
    const med = inner[Math.floor(inner.length * 0.90)] || 0;
    let rowHoles = 0;
    for (let k = a; k <= b; k++) {
      filled++;
      lossSum += loss[k];
      if (loss[k] > lossMax) lossMax = loss[k];
      // 实体被挡掉 med；孔洞处几乎没被挡（<45% med）⇒ 光真的穿过去了。两者互斥。
      const isHole = med > 0.03 && loss[k] < med * 0.45;
      if (isHole) { holes++; rowHoles++; } else if (loss[k] > 0.02) blocked++;
    }
    if (rowHoles > (b - a + 1) * 0.02) holeRows++;
  }
  return {
    rows, filledPx: filled, blockedPx: blocked, holePx: holes,
    holeRatio: +(holes / Math.max(1, filled)).toFixed(4),
    meanLoss: +(lossSum / Math.max(1, filled)).toFixed(4),
    maxLoss: +lossMax.toFixed(3),
    holeRows,
  };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
mkdirSync(SHOTS, { recursive: true });
const browser = launchBrowser({ port: PORT, page: 'tools/asset-preview.html', width: 800, height: 500 });
let ws = null;
const results = [];
try {
  const { ws: sock, root } = await connectPage(PORT, { urlIncludes: 'asset-preview' });
  ws = sock;
  const logs = [];
  root.on((m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      const t = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      logs.push('[console:' + m.params.type + '] ' + t);
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[exception] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
    } else if (m.method === 'Log.entryAdded') {
      logs.push('[log:' + m.params.entry.level + '] ' + m.params.entry.text);
    }
  });
  await root.send('Runtime.enable');
  await root.send('Log.enable');
  await root.send('Page.enable');
  // 固定视口，保证截图就是 800x500（headless 窗口尺寸不等于视口尺寸）
  await root.send('Emulation.setDeviceMetricsOverride', {
    width: 800, height: 500, deviceScaleFactor: 1, mobile: false,
  });

  // 等模块就绪（贴图烘焙 + 首帧渲染在 SwiftShader 上比较慢）
  for (let i = 0; i < 300; i++) {
    const s = await root.eval('JSON.stringify({ready: !!window.__READY__, err: window.__BUILD_ERROR__ || null, frames: window.__FRAMES__ || 0})');
    const st = JSON.parse(s);
    if (st.err) throw new Error('页面构建失败：' + st.err);
    if (st.ready) break;
    await sleep(500);
    if (i === 299) throw new Error('等待 __READY__ 超时');
  }
  console.log('WebGL:', await root.eval('JSON.stringify(window.__THREE_INFO__())'));

  const poses = JSON.parse(await root.eval('JSON.stringify(window.__POSES__)'));
  const poseInfo = JSON.parse(await root.eval('JSON.stringify(window.__POSE_INFO__)'));
  console.log('渲染模式：', await root.eval('JSON.stringify(window.__SET_RENDER__("composite"))'), '（composite = 与 index.html 完全同一套后期）');
  console.log('阴影模式：', await root.eval('JSON.stringify(window.__SET_SHADOW_MODE__("engine"))'), '（engine = 引擎自己的阴影通道）');

  // 贴图级自检（快，先拿数字）
  const texMetrics = JSON.parse(await root.eval('JSON.stringify(window.__TEX_METRICS__())'));

  // 图集：先把视口放到 1280x1080，让整张图集正好落进一屏
  await root.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1080, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const atlasInfo = JSON.parse(await root.eval('JSON.stringify(window.__ATLAS__())'));
  await sleep(600);
  let shot = await root.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(SHOTS, 'asset-atlas.png'), Buffer.from(shot.data, 'base64'));
  await root.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 500, deviceScaleFactor: 1, mobile: false });
  await sleep(600);

  // 基线：空台（只有布景）。注意必须放在切换视口之后 —— 视口尺寸变化会影响截图像素对齐，
  // 基线如果取在切换前，后面所有姿态的差分都会失真（实测会全部变成 0）。
  // ⚠ 必须先 __SET_POSE__ 一次把 WebGL 画布显示回来（__ATLAS__ 会把画布 display:none），
  // 否则基线截到的是图集，后面所有姿态的差分都会变成"整幅都不一样"。
  await root.eval('window.__SET_POSE__("stand")');
  await root.eval('window.__SET_PROPS__(false)');   // 与姿态截图一致：都不带布景
  await root.eval('window.__SET_CAVALRY__(false)');
  await root.eval('window.__SET_SHADOW_BLUR__(0.5)');   // 基线必须与姿态用同一套设置，否则差分全是设置差异
  await root.eval('window.__EMPTY_STAGE__()');
  await sleep(300);
  shot = await root.send('Page.captureScreenshot', { format: 'png' });
  const basePng = Buffer.from(shot.data, 'base64');
  writeFileSync(resolve(SHOTS, '_asset-empty.png'), basePng);
  const base = decodePng(basePng);
  // 基线自检：再拍一张，两张必须几乎完全一致（否则说明截图链路不稳定）
  await sleep(250);
  shot = await root.send('Page.captureScreenshot', { format: 'png' });
  const base2png = Buffer.from(shot.data, 'base64');
  writeFileSync(resolve(SHOTS, '_asset-empty-2.png'), base2png);
  {
    const b2 = decodePng(base2png);
    let mx = 0, sum = 0, n = 0;
    for (let y = 0; y < base.h; y++) for (let x = 0; x < base.w; x++) {
      const d = Math.abs(lumAt(base, x, y) - lumAt(b2, x, y));
      if (d > mx) mx = d; sum += d; n++;
    }
    console.log(`基线稳定性：两次空台截图的平均差 ${(sum / n).toFixed(5)}，最大差 ${mx.toFixed(5)}`);
  }

  // 各姿态
  const list = only ? [only] : poses;
  await root.eval('window.__SET_PROPS__(false)');   // 核验姿态/关节/镂空时先藏布景，避免道具影子盖住演员
  await root.eval('window.__SET_CAVALRY__(false)');  // 主演员单人帧，指标不被副将影子混入
  await root.eval('window.__SET_CAVALRY__(false)');  // 主演员单人帧，指标才不会被副将的影子混进来
  // 阴影预模糊：引擎默认 4.5（1024² 上 ±9 texel ≈ 幕布上 ±39mm）会把 3cm 孔洞和 9cm 肢体一起糊平。
  // 自检台把它调到 0.5，剪影与亮斑才看得清；引擎默认值下的对照另存 _asset-defblur-*.png。
  await root.eval('window.__SET_SHADOW_BLUR__(0.5)');
  for (const pose of list) {
    const t0 = Date.now();
    const info = await root.eval(`JSON.stringify(window.__SET_POSE__(${JSON.stringify(pose)}))`);
    // 本页没有 rAF 循环：帧只在 eval 内同步推进，__SET_POSE__ 返回时最新帧已经在 drawing buffer 里
    await sleep(250);
    shot = await root.send('Page.captureScreenshot', { format: 'png' });
    const png = Buffer.from(shot.data, 'base64');
    const file = resolve(SHOTS, `_asset-pose-${pose}.png`);
    const img = decodePng(png);
    writeFileSync(file, toDisplayPng(img));          // 存图做线性→sRGB 显示变换，便于人眼核对
    const m = holeMetric(base, img);
    const report = JSON.parse(await root.eval('JSON.stringify(window.__REPORT__())'));
    results.push({ pose, file, metric: m, report, ms: Date.now() - t0, setPose: JSON.parse(info) });
    console.log(`· ${pose.padEnd(18)} ${Date.now() - t0}ms  剪影填充 ${m.filledPx}px  被挡 ${m.blockedPx}px  镂空亮斑 ${m.holePx}px  ratio=${m.holeRatio}  关节脱节 ${report.joints.separatedCount}/${report.joints.total}`);
  }

  // 引擎默认预模糊（spread=4.5）下的同一姿态：留证"孔洞与细肢体是被预模糊糊掉的"
  if (!only) {
    await root.eval('window.__SET_SHADOW_BLUR__(4.5)');
    await root.eval('window.__EMPTY_STAGE__()');
    await sleep(200);
    shot = await root.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(resolve(SHOTS, '_asset-empty-defblur.png'), Buffer.from(shot.data, 'base64'));
    const base2 = decodePng(Buffer.from(shot.data, 'base64'));
    console.log('\n—— 对照：引擎默认预模糊 spread=4.5（孔洞亮斑被糊掉多少）——');
    for (const pose of ['stand', 'raiseLeft', 'chopHold', 'closeup']) {
      await root.eval(`window.__SET_POSE__(${JSON.stringify(pose)})`);
      await sleep(200);
      shot = await root.send('Page.captureScreenshot', { format: 'png' });
      const png = Buffer.from(shot.data, 'base64');
      const file = resolve(SHOTS, `_asset-defblur-${pose}.png`);
      const im2 = decodePng(png);
      writeFileSync(file, toDisplayPng(im2));
      const m = holeMetric(base2, im2);
      results.push({ pose: pose + '@defblur', file, metric: m, report: null, ms: 0, setPose: null });
      console.log(`· ${(pose + '@defblur').padEnd(20)} 剪影填充 ${m.filledPx}px  镂空亮斑 ${m.holePx}px  亮斑率 ${(m.holeRatio * 100).toFixed(2)}%  最深遮挡 ${m.maxLoss}`);
    }
    await root.eval('window.__SET_SHADOW_BLUR__(0.5)');
  }

  // 骨架核对：藏掉 cape/cape2/flag，只剩躯干四肢与兵器，看关节有没有缝
  if (!only) {
    await root.eval('window.__HIDE_PARTS__(["cape","cape2","flag"], true)');
    for (const pose of ['stand', 'raiseLeft', 'raiseRightWeapon', 'stepLeft', 'turn45', 'chopHold']) {
      await root.eval(`window.__SET_POSE__(${JSON.stringify(pose)})`);
      await sleep(200);
      shot = await root.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(resolve(SHOTS, `_asset-nocape-${pose}.png`), toDisplayPng(decodePng(Buffer.from(shot.data, 'base64'))));
    }
    console.log('骨架对照（藏 cape/cape2/flag）：shots/_asset-nocape-*.png');
    await root.eval('window.__HIDE_PARTS__(["cape","cape2","flag"], false)');
  }

  // 布景专图：只放布景、不放演员（引擎相机取景 = 幕布 4.0×2.5），供 lead 复核中央通道是否干净
  if (!only) {
    await root.eval('window.__SET_CAM__("stage"); window.__SET_RENDER__("raw"); window.__SET_SHADOW_MODE__("depth"); window.__SET_SHADOW_BLUR__(4.5); window.__SET_PROPS__(true); window.__SET_CAVALRY__(false); window.__EMPTY_STAGE__(); window.__ENGINE__.frameOnce(1/60); window.__ENGINE__.frameOnce(1/60);');
    await sleep(300);
    shot = await root.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(resolve(SHOTS, 'asset-props-only.png'), toDisplayPng(decodePng(Buffer.from(shot.data, 'base64'))));
    await root.eval('window.__SET_PROPS__(true); window.__SET_CAVALRY__(true); window.__SET_POSE__("stand"); window.__ENGINE__.frameOnce(1/60); window.__ENGINE__.frameOnce(1/60);');
    await sleep(300);
    shot = await root.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(resolve(SHOTS, '_asset-preview-full.png'), toDisplayPng(decodePng(Buffer.from(shot.data, 'base64'))));
    console.log('布景专图：shots/asset-props-only.png    自检台演员+布景：shots/_asset-preview-full.png');
  }

  /* ------------------------- 报告 ------------------------- */
  console.log('\n================ 贴图级自检（真实烘焙后的 alpha） ================');
  console.log(`贴图 ${texMetrics.textures} 张，内部镂空像素合计 ${texMetrics.totalInteriorHolePx}，实体像素 ${texMetrics.totalSolidPx}，整体镂空率 ${(texMetrics.holeRatio * 100).toFixed(2)}%`);
  const worst = [...texMetrics.list].sort((a, b) => b.interiorHolePx - a.interiorHolePx).slice(0, 6);
  for (const w of worst) console.log(`   最大镂空：${w.part.padEnd(22)} ${w.pix[0]}x${w.pix[1]}  内部孔洞 ${w.interiorHolePx}px  镂空率 ${(w.holeRatio * 100).toFixed(2)}%`);
  const zeroHole = texMetrics.list.filter((t) => t.interiorHolePx === 0);
  if (zeroHole.length) console.log('   ⚠ 完全没有内部镂空的贴图：' + zeroHole.map((t) => t.part).join(', '));

  console.log('\n================ 姿态截图与镂空亮斑（vs 空台基线） ================');
  for (const r of results) {
    const j = r.report ? `  关节脱节 ${r.report.joints.separatedCount}` : '';
    console.log(`${r.pose.padEnd(20)} ${r.file.replace(ROOT + '\\', '').padEnd(30)} 剪影 ${String(r.metric.filledPx).padStart(6)}px  亮斑 ${String(r.metric.holePx).padStart(5)}px  亮斑率 ${(r.metric.holeRatio * 100).toFixed(2)}%  平均遮挡 ${r.metric.meanLoss}  最深 ${r.metric.maxLoss}${j}`);
  }
  console.log('\n图集：shots/asset-atlas.png  （' + atlasInfo.cells + ' 张图纸，' + atlasInfo.cols + 'x' + atlasInfo.rows + ' 格）');

  console.log('\n================ 关节搭接检查（子件与父件贴图矩形必须实际重叠 ≥4mm） ================');
  for (const r of results) {
    if (!r.report) continue;
    const j = r.report.joints;
    if (j.separatedCount === 0) continue;
    console.log(`${r.pose}: 脱节 ${j.separatedCount} 处 — ` + j.separated.map((o) => `${o.key}<-${o.parent} gap=${o.gap}`).join(', '));
  }
  const anyOutside = results.some((r) => r.report && r.report.joints.separatedCount > 0);
  if (!anyOutside) console.log('全部姿态：所有父子部件贴图矩形都有 ≥4mm 搭接（关节不会露缝）');

  console.log('\n================ 搭接最薄的 5 个关节 ================');
  const rowsAll = results[0] ? results[0].report.joints.rows : [];
  const sorted = [...rowsAll].sort((a, b) => Math.min(...a.overlap) - Math.min(...b.overlap)).slice(0, 5);
  for (const s of sorted) console.log(`  ${s.key.padEnd(12)} <- ${s.parent.padEnd(12)} 重叠=${s.overlap.join(' x ')}m  枢轴在父矩形内=${s.pivotInRect}`);

  const errs = logs.filter((l) => /exception|console:error|log:error/i.test(l));
  if (errs.length) { console.log('\n⚠ 页面报错：'); for (const e of errs.slice(0, 10)) console.log('  ' + e); }
  const warns = logs.filter((l) => /console:warning/i.test(l));
  if (warns.length) { console.log('\n页面警告：'); for (const e of warns.slice(0, 5)) console.log('  ' + e); }

  // 真实成片：加载 index.html，跑到 t=25s 截图（演员 + 布景 + 引擎完整后期）
  if (!only) {
    try {
      await root.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
      await root.send('Page.navigate', { url: 'file:///' + resolve(ROOT, 'index.html').replace(/\\/g, '/') + '?t=25&paused=1' });
      await sleep(3000);
      for (let i = 0; i < 240; i++) {
        const st = await root.eval('JSON.stringify({ready: !!window.__READY__, err: window.__BUILD_ERROR__ || null})').catch(() => null);
        if (st) {
          const o = JSON.parse(st);
          if (o.err) { console.log('  index.html 构建失败：' + o.err); break; }
          if (o.ready) break;
        }
        await sleep(500);
      }
      // 关键时间点（全部走真实 index.html + 引擎完整后期）：
      //   t=25   演员+布景（lead 要的 asset-full）
      //   t=45.5 收势留白：幕布上只剩远景与月亮 → 这就是"只放布景"的最干净证据
      //   其余五点对应四幕动作
      const plan = [
        [25.0, 'asset-full.png'],
        [45.5, 'asset-props-only.png'],
        [6.0, 'asset-act-06_0.png'],
        [18.5, 'asset-act-18_5.png'],
        [27.5, 'asset-act-27_5.png'],
        [30.5, 'asset-act-30_5.png'],
        [35.5, 'asset-act-35_5.png'],
      ];
      for (const [t, name] of plan) {
        await root.eval(`window.__SET_TIME__(${t})`);
        await sleep(1400);
        shot = await root.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(resolve(SHOTS, name), Buffer.from(shot.data, 'base64'));
        const qa = await root.eval('JSON.stringify(window.__qa ? {t: window.__qa().t, casters: window.__qa().shadowCasters, sub: window.__qa().subtitle} : null)');
        console.log(`真实成片 t=${t}s → shots/${name}  __qa=${qa}`);
      }
    } catch (e) {
      console.log('  index.html 截图失败（不影响资产自检）：' + e.message);
    }
  }

  // 自检台单人帧对照（此时页面可能已经被 index.html 覆盖，做一下存在性判断）
  try {
    const hasHooks = await root.eval('typeof window.__SET_POSE__ === "function"');
    if (hasHooks) {
      await root.eval('window.__SET_PROPS__(true); window.__SET_RENDER__("composite"); window.__SET_POSE__("stand");');
      await sleep(250);
      shot = await root.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(resolve(SHOTS, '_asset-withprops.png'), Buffer.from(shot.data, 'base64'));
      console.log('\n自检台留证：_asset-withprops.png（演员+布景，引擎完整后期）');
    }
  } catch (e) {
    console.log('  （跳过自检台留证：' + e.message + '）');
  }

  writeFileSync(resolve(SHOTS, '_asset-metrics.json'), JSON.stringify({ texMetrics, results, atlasInfo, logs }, null, 1));
  console.log('\n明细 JSON：shots/_asset-metrics.json');
} finally {
  try { if (ws) ws.close(); } catch {}
  browser.kill();
}

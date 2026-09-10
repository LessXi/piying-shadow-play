/**
 * tools/verify-anti-svg.mjs —— 反 SVG 检查（需求 8 的前置红线：不许用简单 SVG 做）。
 *
 * 两段式：
 *   A. 静态扫描：递归读项目里所有文本文件（含 vendor/three.module.js、index.html、src/*.js、
 *      assets/**、tools/**、*.md），用精确模式找 <svg / svg+xml / SVG 命名空间 createElementNS /
 *      .svg 引用 / data:image/svg / foreignObject / xmlns=…2000/svg；并检查磁盘上有没有 *.svg 文件。
 *   B. 运行时取证：无头 Chrome 打开 index.html，证明画面确实是 WebGL2 实时渲染出来的：
 *      - canvas 的 getContext('2d') 必须为 null（它被 WebGL2 占住了，不可能是 2D 画布/SVG 位图）
 *      - GL 版本字符串、HDR 扩展、绘制调用计数（真的在 draw*）
 *      - DOM 里没有任何 <svg>/<img>/<video>/<iframe> 元素
 *      - 画面颜色分布丰富、且随时间变化；自定义 shadow map（2048²）里有真实几何写入
 *
 * 用法: node tools/verify-anti-svg.mjs       退出码 0 = 干净
 */
import { withPage, readPNG, imageDiff, meanRGB } from './harness.mjs';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = process.cwd();
/* 本次验收绑定的源码 revision（写进日志，便于事后复算） */
const REV_FILES = ['index.html', 'src/main.js', 'src/renderer.js', 'src/screen.js', 'src/stage.js', 'src/compositor.js',
  'src/materials.js', 'src/rig.js', 'src/textures.js', 'src/puppet.js', 'src/shapes.js', 'src/props.js',
  'src/choreography.js', 'src/ease.js'];
console.log('REVISION ' + REV_FILES.map((f) => {
  try { return f + '=' + createHash('sha256').update(readFileSync(join(ROOT, f))).digest('hex').slice(0, 12); }
  catch { return f + '=MISSING'; }
}).join(' '));
const TEXT_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.css', '.json', '.md', '.txt', '.glsl', '.svg']);
const SKIP_DIR = new Set(['.git', 'node_modules', '.vite', 'dist']);

const results = [];
function check(id, pass, msg, detail) {
  results.push({ id, pass: !!pass, msg, detail: detail || '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${id}] ${msg}${detail ? '\n        ' + detail : ''}`);
}
const note = (m) => console.log(`      · ${m}`);

/* ---------------- A. 静态扫描 ---------------- */
const PATTERNS = [
  ['<svg 标签', /<svg[\s>/]/i],
  ['svg+xml MIME', /svg\+xml/i],
  ['SVG 命名空间 createElementNS', /createElementNS\s*\(\s*['"]http:\/\/www\.w3\.org\/2000\/svg/i],
  ['xmlns=…2000/svg', /xmlns\s*=\s*['"]?http:\/\/www\.w3\.org\/2000\/svg/i],
  ['.svg 文件引用', /[\w\-./\\]+\.svg(?![a-z0-9])/i],
  ['data:image/svg', /data:image\/svg/i],
  ['foreignObject', /foreignObject/i],
  ['SVGElement / SVGSVGElement', /\bSVG(SVG)?Element\b/],
  ['svg 相关 API(createSVGPoint 等)', /\bcreateSVG|SVGMatrix|getScreenCTM\b/],
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push({ p, size: st.size });
  }
  return out;
}

const files = walk(ROOT);
const textFiles = files.filter((f) => TEXT_EXT.has(extname(f.p).toLowerCase()));
const svgFiles = files.filter((f) => extname(f.p).toLowerCase() === '.svg' || extname(f.p).toLowerCase() === '.svgz');

// 「检查器自身」允许出现 SVG 关键词（它们是检测模式/告警文案，不是 SVG 用法）。
// 除这些文件外，任何一处命中都算违规。运行时代码（index.html/src/assets/vendor）里的命中永远算违规。
const DETECTOR_RE = /^(tools[\\/])?(anti-svg-check|check-assets|verify-[^\\/]+)\.mjs$|^VERIFICATION\.md$/i;
const RUNTIME_PREFIX = ['index.html', 'src/', 'assets/', 'vendor/'];
const isRuntime = (rel) => RUNTIME_PREFIX.some((p) => rel === p || rel.startsWith(p));
const isDetector = (rel) => DETECTOR_RE.test(rel);

const hits = [];
const detectorFiles = new Set();
let scannedBytes = 0;
for (const f of textFiles) {
  const rel = relative(ROOT, f.p).replace(/\\/g, '/');
  const txt = readFileSync(f.p, 'utf8');
  scannedBytes += txt.length;
  const lines = txt.split(/\r?\n/);
  for (const [label, re] of PATTERNS) {
    const reG = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (let i = 0; i < lines.length; i++) {
      if (reG.test(lines[i])) {
        const det = isDetector(rel);
        if (det) detectorFiles.add(rel);
        hits.push({ file: rel, line: i + 1, label, text: lines[i].trim().slice(0, 140),
          runtime: isRuntime(rel), detector: det });
      }
    }
  }
}
const runtimeHits = hits.filter((h) => h.runtime && !h.detector);
const strayToolHits = hits.filter((h) => !h.runtime && !h.detector);
console.log(`  [static] 扫描 ${textFiles.length} 个文本文件 / ${(scannedBytes / 1024).toFixed(0)} KB（含 vendor/three.module.js），磁盘上 *.svg 文件 ${svgFiles.length} 个`);
check('A1-no-svg-in-runtime', runtimeHits.length === 0,
  `运行时代码（index.html + src/** + assets/** + vendor/**）中 ${PATTERNS.length} 类 SVG 特征 0 命中`,
  runtimeHits.length ? runtimeHits.slice(0, 10).map((h) => `${h.file}:${h.line} [${h.label}] ${h.text}`).join('\n        ') : '');
check('A1b-only-detector-hits', strayToolHits.length === 0,
  `工具/文档里的 ${hits.length - runtimeHits.length} 处命中全部落在「反 SVG 检查器」文件里（${[...detectorFiles].join(', ')}），越界 ${strayToolHits.length} 处`,
  strayToolHits.slice(0, 6).map((h) => `${h.file}:${h.line} [${h.label}] ${h.text}`).join('\n        '));
check('A2-no-svg-file', svgFiles.length === 0,
  `项目目录下没有任何 .svg / .svgz 文件（共 ${files.length} 个文件）`,
  svgFiles.map((f) => relative(ROOT, f.p)).join(', '));

// 反证：美术确实是 canvas 2D 程序化画出来的（不是任何矢量/位图素材）
const artFiles = ['src/shapes.js', 'src/puppet.js', 'src/props.js', 'src/textures.js'].filter((f) => {
  try { return statSync(join(ROOT, f)).isFile(); } catch { return false; }
});
let canvasCalls = 0, alphaDraw = 0, imgLoads = 0;
for (const f of artFiles) {
  const t = readFileSync(join(ROOT, f), 'utf8');
  canvasCalls += (t.match(/ctx\.[a-zA-Z]+\(/g) || []).length;
  alphaDraw += (t.match(/makeAlphaFromDraw\(/g) || []).length;
  imgLoads += (t.match(/new\s+Image\(|\.src\s*=\s*['"]/g) || []).length;
}
note(`美术源码 ${artFiles.join(', ')}：canvas 2D 调用 ${canvasCalls} 次，makeAlphaFromDraw ${alphaDraw} 次，外部图片加载 ${imgLoads} 次`);
check('A3-art-is-canvas', canvasCalls > 80 && imgLoads === 0,
  `皮影/布景美术全部由 canvas 2D 程序化绘制（${canvasCalls} 处 ctx.* 调用、${alphaDraw} 处 makeAlphaFromDraw、0 处外部图片加载）`);

/* ---------------- B. 运行时取证 ---------------- */
async function exposeClosure(page) {
  const s = page.session;
  const r = await s.send('Runtime.evaluate', { expression: 'window.__qa', returnByValue: false });
  const props = await s.send('Runtime.getProperties', { objectId: r.result.objectId, ownProperties: false });
  const sc = (props.internalProperties || []).find((p) => p.name === '[[Scopes]]');
  if (!sc || !sc.value || !sc.value.objectId) return [];
  const list = await s.send('Runtime.getProperties', { objectId: sc.value.objectId, ownProperties: true });
  const got = [];
  for (const scope of list.result) {
    if (!scope.value || !scope.value.objectId) continue;
    const sp = await s.send('Runtime.getProperties', { objectId: scope.value.objectId, ownProperties: true });
    const keys = (sp.result || []).map((x) => x.name);
    if (!keys.includes('rigs')) continue;
    for (const t of ['renderer', 'screen', 'stage', 'rigs']) {
      const b = (sp.result || []).find((x) => x.name === t);
      if (b && b.value && b.value.objectId) {
        await s.send('Runtime.callFunctionOn', { objectId: b.value.objectId,
          functionDeclaration: `function(){ window.__V_${t.toUpperCase()}__ = this; }`, returnByValue: true });
        got.push(t);
      }
    }
  }
  return got;
}

const rt = await withPage({ page: 'index.html', width: 1320, height: 900, readyTimeout: 180000 }, async (page) => {
  await page.waitReady();
  await exposeClosure(page);
  const ev = (e) => page.eval(e);
  const J = async (e) => JSON.parse(await page.eval(e));

  await ev('window.__PLAY__(false)');
  await ev('window.__SET_TIME__(32.3)');
  await page.waitFrames(3);

  const dom = await J(`JSON.stringify({
    svg: document.querySelectorAll('svg').length,
    svgNS: document.querySelectorAll('*').length ? Array.prototype.filter.call(document.querySelectorAll('*'), function(e){ return e.namespaceURI && e.namespaceURI.indexOf('svg') >= 0; }).length : -1,
    img: document.querySelectorAll('img').length,
    video: document.querySelectorAll('video,iframe,object,embed').length,
    canvas: document.querySelectorAll('canvas').length,
    elements: document.querySelectorAll('*').length,
    tags: Array.from(new Set(Array.prototype.map.call(document.querySelectorAll('*'), function(e){ return e.tagName.toLowerCase(); }))).sort().join(','),
  })`);
  check('B1-dom-has-no-svg', dom.svg === 0 && dom.svgNS === 0 && dom.img === 0 && dom.video === 0,
    `index.html 运行时 DOM：<svg> ${dom.svg} 个、SVG 命名空间元素 ${dom.svgNS} 个、<img> ${dom.img} 个、<video|iframe|object|embed> ${dom.video} 个（共 ${dom.elements} 个元素，标签集合: ${dom.tags}）`);

  const gl = await J(`JSON.stringify((function(){
    const cv = document.querySelector('canvas');
    const ctx2d = cv.getContext('2d');
    const ctx = window.__V_RENDERER__.renderer.getContext();
    const dbg = ctx.getExtension('WEBGL_debug_renderer_info');
    return {
      has2d: ctx2d !== null,
      version: ctx.getParameter(ctx.VERSION),
      glsl: ctx.getParameter(ctx.SHADING_LANGUAGE_VERSION),
      vendor: dbg ? ctx.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
      rendererName: dbg ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      maxTex: ctx.getParameter(ctx.MAX_TEXTURE_SIZE),
      maxDrawBuf: ctx.getParameter(ctx.MAX_DRAW_BUFFERS),
      hdr: !!(ctx.getExtension('EXT_color_buffer_half_float') || ctx.getExtension('EXT_color_buffer_float')),
      isGL2: typeof WebGL2RenderingContext !== 'undefined' && ctx instanceof WebGL2RenderingContext,
      drawingBuffer: [cv.width, cv.height],
    };
  })())`);
  check('B2-canvas-is-webgl2', gl.isGL2 && gl.has2d === false && /WebGL 2\.0/.test(gl.version),
    `canvas 的 2D 上下文返回 ${gl.has2d ? '非 null' : 'null'}（已被 WebGL2 占住），GL_VERSION="${gl.version}"，GLSL="${gl.glsl}"，$instanceof WebGL2RenderingContext=${gl.isGL2}`,
    `渲染后端 ${gl.rendererName} / ${gl.vendor}，MAX_TEXTURE_SIZE=${gl.maxTex}，半浮点 HDR 扩展=${gl.hdr}，画布 ${gl.drawingBuffer.join('x')}`);

  // 真的在 draw*：包住 GL 的 draw 调用，统计 60 帧
  const draws = await J(`(async function(){
    const RR = window.__V_RENDERER__, gl = RR.renderer.getContext();
    const names = ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced'];
    const c = {};
    names.forEach(function(n){ c[n] = 0;
      gl['__orig_' + n] = gl[n];
      const orig = gl[n].bind(gl);
      gl[n] = function(){ c[n]++; return orig.apply(null, arguments); }; });
    let frames = 0, t0 = performance.now();
    window.__PLAY__(true);
    const r = await new Promise(function(res){
      const tick = function(){ frames++;
        if (performance.now() - t0 > 1200){
          const st = RR.stats();
          window.__PLAY__(false);
          names.forEach(function(n){ gl[n] = gl['__orig_' + n]; });
          res({ counts: c, frames: frames, elapsed: performance.now() - t0, stats: st });
        } else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    return JSON.stringify(r);
  })()`);
  const totalDraws = Object.values(draws.counts).reduce((a, b) => a + b, 0);
  note(`1200ms 内 ${draws.frames} 帧、GL draw* 调用 ${totalDraws} 次（${(totalDraws / Math.max(draws.frames, 1)).toFixed(1)} 次/帧）: ${JSON.stringify(draws.counts)}`);
  check('B3-renderer-really-draws', totalDraws > 200 && draws.frames > 5 && draws.stats.drawCalls > 10 && draws.stats.tris > 1000,
    `GL 层面实测 ${draws.frames} 帧内发出 ${totalDraws} 次 draw* 调用（${(totalDraws / draws.frames).toFixed(1)}/帧）；three 统计 drawCalls=${draws.stats.drawCalls}、triangles=${draws.stats.tris}、programs=${draws.stats.programs}、textures=${draws.stats.textures}`,
    `后期管线 ${draws.stats.bloomLevels} 级泛光 + HDR=${draws.stats.hdr}（走 HalfFloat RT），不是 2D 贴图`);

  const map = await J(`JSON.stringify((function(){
    const S = window.__V_SCREEN__, R = window.__V_RENDERER__.renderer, rt = S.shadowStage.map;
    if (!rt) return { none: true };
    const w = rt.width, h = rt.height, buf = new Uint8Array(w*h*4);
    R.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    let nonWhite = 0, n = 0, min = 255;
    for (let i = 0; i < buf.length; i += 4){ if (buf[i] < 250) nonWhite++; if (buf[i] < min) min = buf[i]; n++; }
    return { size: [w, h], nonWhite: nonWhite, frac: nonWhite / n, min: min, casters: S.shadowCasterCount };
  })())`);
  check('B4-shadow-map-real', !map.none && map.size[0] === 2048 && map.frac > 0.02 && map.casters >= 10,
    `自定义阴影贴图 ${map.size ? map.size.join('x') : '?'} 里有真实几何写入：非白像素占 ${(map.frac * 100).toFixed(1)}%（最暗值 ${map.min}），登记投射体 ${map.casters} 个`,
    `说明画面里的剪影不是贴图/矢量画上去的，而是每帧从灯视角重新渲染的几何覆盖（注：非白比例只覆盖真正的投射体 —— 非投射体已在 shadow pass 里被隐藏；早期版本把地台/暗框也写进来时该值是 59.5%，两者都算"有真实写入"，判据取 > 2%）`);

  // 颜色丰富度 + 随时间变化
  const u1 = await ev(`window.__PLAY__(false); window.__SET_TIME__(32.3); 1`).then(() => ev('window.__snapshot()'));
  const u2 = await ev(`window.__SET_TIME__(12.0); 1`).then(() => ev('window.__snapshot()'));
  const p1 = 'shots/verify-antisvg-t32.3.png', p2 = 'shots/verify-antisvg-t12.png';
  const { writeFileSync } = await import('node:fs');
  writeFileSync(p1, Buffer.from(String(u1).split(',')[1], 'base64'));
  writeFileSync(p2, Buffer.from(String(u2).split(',')[1], 'base64'));
  const i1 = readPNG(p1), i2 = readPNG(p2);
  const colors = new Set();
  for (let i = 0; i < i1.data.length; i += 4 * 7) colors.add((i1.data[i] << 16) | (i1.data[i + 1] << 8) | i1.data[i + 2]);
  const d = imageDiff(i1, i2);
  const rgb1 = meanRGB(i1, 0, 0, i1.width, i1.height, 5);
  check('B5-image-is-live-3d', colors.size > 5000 && d > 0.004,
    `当前帧有 ${colors.size} 种不同颜色（7 像素抽样），且 t=32.3s 与 t=12.0s 两帧 mean|Δ|=${(d * 100).toFixed(2)}% => 是逐帧实时渲染的三维场景，不是一张静态矢量/位图`,
    `全画面平均 RGB=(${rgb1[0].toFixed(3)},${rgb1[1].toFixed(3)},${rgb1[2].toFixed(3)})`);
  return { draws, map, gl, dom, colors: colors.size, t12: p2 };
});

/* ---------------- 汇总 ---------------- */
console.log('\n================= 反 SVG 检查汇总 =================');
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${r.msg.split('\n')[0]}`);
const failed = results.filter((r) => !r.pass);
console.log(`\n证据截图: shots/verify-antisvg-t32.3.png, ${rt.t12}`);
console.log(`\n=========== ${failed.length === 0 ? 'ALL PASS' : failed.length + ' FAILED'} ===========`);
process.exit(failed.length ? 1 : 0);

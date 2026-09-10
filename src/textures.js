// 程序化纹理：织物幕布、皮影牛皮纸、镂空花纹合成。
// 全部确定性（无 Math.random），保证 QA 可复现。
import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 * 确定性噪声
 * ------------------------------------------------------------------ */
function hash2(x, y, seed = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t) { return t * t * (3 - 2 * t); }

/** 双线性插值的值噪声 */
function valueNoise(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smooth(xf), v = smooth(yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** 分形噪声 */
export function fbm(x, y, octaves = 4, seed = 0, lacunarity = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + i * 17);
    norm += amp;
    amp *= gain; freq *= lacunarity;
  }
  return sum / norm;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/* ------------------------------------------------------------------ *
 * 织物幕布
 * ------------------------------------------------------------------ */

/**
 * 生成幕布纹理对：颜色图 + 凹凸图。
 * 经纬交织 + 纱线粗细不均 + 大尺度色斑 + 垂直折痕底纹（作为几何褶皱的补充）。
 * @param {number} size 纹理边长
 * @returns {{map: THREE.CanvasTexture, bumpMap: THREE.CanvasTexture}}
 */
export function makeFabricTexture(size = 1024) {
  const texels = 512;                     // 每个重复单元内的织纹周期数
  const cell = size / texels;             // 每个经纬单元的像素

  const colCv = makeCanvas(size, size);
  const colCtx = colCv.getContext('2d');
  const bmpCv = makeCanvas(size, size);
  const bmpCtx = bmpCv.getContext('2d');

  const colImg = colCtx.createImageData(size, size);
  const bmpImg = bmpCtx.createImageData(size, size);
  const cd = colImg.data, bd = bmpImg.data;

  for (let y = 0; y < size; y++) {
    const wy = y / cell;
    for (let x = 0; x < size; x++) {
      const wx = x / cell;
      const cx = Math.floor(wx), cy = Math.floor(wy);
      const fx = wx - cx, fy = wy - cy;

      // 0 = 经线在上（竖纱可见），1 = 纬线在上（横纱可见）
      const warpTop = (((cx + cy) & 1) === 0) ? 0 : 1;

      // 纱线截面：圆柱状 => 中间亮、边缘暗
      const threadProfile = (t) => Math.sin(Math.PI * Math.min(1, Math.max(0, t)));
      const warpH = threadProfile(fx);
      const weftH = threadProfile(fy);
      const over = warpTop === 0 ? warpH : weftH;   // 上方纱线的高度
      const under = warpTop === 0 ? weftH : warpH;  // 下方纱线

      // 纱线粗细不均（沿纱线方向缓慢变化）
      const warpJitter = fbm((cx + 0.5) * 0.35, cy * 0.02, 3, 11) * 0.42 + 0.79;
      const weftJitter = fbm(cx * 0.02, (cy + 0.5) * 0.35, 3, 23) * 0.42 + 0.79;

      // 高度：上方纱线主导，下方纱线透出一点
      let height = over * (warpTop === 0 ? warpJitter : weftJitter) * 0.82
                 + under * (warpTop === 0 ? weftJitter : warpJitter) * 0.30
                 + 0.12;

      // 织物的松散绒毛与纤维不匀
      const fuzz = fbm(wx * 0.9, wy * 0.9, 4, 7);
      height *= 0.72 + fuzz * 0.5;

      // 大尺度色斑（棉麻的手工感）
      const blotch = fbm(x / size * 3.5, y / size * 3.5, 3, 41);

      // 垂直折痕底纹：光从后方来，折痕两侧一亮一暗
      const foldPhase = (x / size) * Math.PI * 2 * 3.0;
      const fold = Math.sin(foldPhase + Math.sin(y / size * Math.PI * 1.4) * 0.6);
      const foldShade = 1 + fold * 0.085;

      const i = (y * size + x) * 4;

      // 未漂白的棉布色：暖白略偏米
      const base = 232 + (blotch - 0.5) * 26;
      const occl = 0.86 + height * 0.30;    // 织纹造成的细微明暗
      let r = base * occl * foldShade;
      let g = (base - 3) * occl * foldShade;
      let b = (base - 12) * occl * foldShade;

      // 每 32 个单元做一处轻微“接头/瑕疵”，更像真织物
      const flawN = valueNoise(cx * 0.06, cy * 0.06, 97);
      if (flawN > 0.955) { const k = 0.90; r *= k; g *= k; b *= k; }

      cd[i] = Math.max(0, Math.min(255, r));
      cd[i + 1] = Math.max(0, Math.min(255, g));
      cd[i + 2] = Math.max(0, Math.min(255, b));
      cd[i + 3] = 255;

      const hv = Math.max(0, Math.min(255, height * 205));
      bd[i] = bd[i + 1] = bd[i + 2] = hv;
      bd[i + 3] = 255;
    }
  }

  colCtx.putImageData(colImg, 0, 0);
  bmpCtx.putImageData(bmpImg, 0, 0);

  const map = new THREE.CanvasTexture(colCv);
  const bumpMap = new THREE.CanvasTexture(bmpCv);
  for (const t of [map, bumpMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
  }
  bumpMap.colorSpace = THREE.NoColorSpace;
  return { map, bumpMap };
}

/* ------------------------------------------------------------------ *
 * 皮影牛皮 / 羊皮纸
 * ------------------------------------------------------------------ */

/**
 * 半透明牛皮纸底纹，作为镂空图案的颜色层。
 * @returns {THREE.CanvasTexture} 带 alpha 的贴图（RGBA）
 */
export function makeParchmentTexture({ size = 256, tint = [255, 205, 150], alpha = 1.0 } = {}) {
  const cv = makeCanvas(size, size);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x / size * 6, y / size * 6, 4, 5);
      const grain = fbm(x / size * 34, y / size * 34, 2, 61);
      const k = 0.80 + n * 0.26 + (grain - 0.5) * 0.12;
      const i = (y * size + x) * 4;
      d[i] = Math.min(255, tint[0] * k);
      d[i + 1] = Math.min(255, tint[1] * k);
      d[i + 2] = Math.min(255, tint[2] * k);
      d[i + 3] = 255 * alpha * (0.92 + n * 0.08);
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/* ------------------------------------------------------------------ *
 * 镂空图案合成
 * ------------------------------------------------------------------ */

/**
 * 把一个 canvas 转成带 alphaTest 友好的贴图。
 * 边缘做一次 3x3 拉普拉斯锐化，缓解纹理过滤造成的半透明毛边。
 */
function sharpenAlpha(ctx, cv) {
  const { width: w, height: h } = cv;
  const src = ctx.getImageData(0, 0, w, h).data;
  const out = ctx.createImageData(w, h);
  const od = out.data;
  const A = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    return src[(y * w + x) * 4 + 3];
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let a = A(x, y);
      if (a > 0) {
        const lap = 4 * a - A(x - 1, y) - A(x + 1, y) - A(x, y - 1) - A(x, y + 1);
        a = Math.max(0, Math.min(255, a + lap * 0.30));
        // 把边缘推到全不透明，让 alphaTest=0.45 得到干净轮廓
        a = Math.min(255, a * 1.35);
      }
      od[i] = src[i]; od[i + 1] = src[i + 1]; od[i + 2] = src[i + 2]; od[i + 3] = a;
    }
  }
  ctx.putImageData(out, 0, 0);
}

/**
 * 描出镂空轮廓的暖色内发光，模拟光从孔洞边缘透过的“透光边”。
 */
function drawRimGlow(ctx, w, h, color, radius = 1.6) {
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  // 用多次轻微偏移的描边近似内发光
  for (let k = 1; k <= 3; k++) {
    ctx.globalAlpha = 0.30 / k;
    ctx.filter = `blur(${(radius * k * 0.7).toFixed(2)}px)`;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    // 沿当前 alpha 的边缘描边：用 destination 合成整体偏移复制
    ctx.globalCompositeOperation = 'source-atop';
  }
  ctx.restore();
}

/**
 * 由绘制回调生成一个镂空剪影贴图。
 *
 * draw(ctx, w, h) 用任意 canvas 路径绘制**不透明区域**（即皮影的实体部分）。
 * 本函数自动叠加：牛皮底纹、深浅刀刻层次、镂空边沿透光、外部剪影描边。
 *
 * @param {(ctx:CanvasRenderingContext2D, w:number, h:number)=>void} draw
 * @param {object} opts
 * @param {number} opts.w 输出宽（px）
 * @param {number} opts.h 输出高
 * @param {boolean} opts.parchment 是否叠加牛皮底纹
 * @param {number} opts.glow 透光边强度 0..1
 * @returns {THREE.CanvasTexture}
 */
export function makeAlphaFromDraw(draw, {
  w = 256, h = 256, parchment = true, glow = 0.55, baseColor = '#1b0d06',
  shadowLift = 0.0, seed = 3,
} = {}) {
  // 多倍超采样再降采样，得到抗锯齿的干净轮廓
  const SS = 2;
  const W = w * SS, H = h * SS;

  // 1) 实体遮罩（白色 = 皮影实体）
  const maskCv = makeCanvas(W, H);
  const maskCtx = maskCv.getContext('2d');
  maskCtx.clearRect(0, 0, W, H);
  maskCtx.fillStyle = '#fff';
  maskCtx.strokeStyle = '#fff';
  draw(maskCtx, W, H);

  // 2) 输出画布
  const cv = makeCanvas(w, h);
  const ctx = cv.getContext('2d');

  // 3) 用遮罩裁切牛皮底纹（作为实体部分的“透光”颜色）
  const parCv = makeCanvas(W, H);
  const parCtx = parCv.getContext('2d');
  if (parchment) {
    const n = 24;
    for (let sy = 0; sy < n; sy++) {
      for (let sx = 0; sx < n; sx++) {
        const v = fbm(sx / n * 5, sy / n * 5, 3, seed) * 0.55 + 0.45;
        const gr = fbm(sx, sy, 2, seed + 13);
        parCtx.fillStyle = `rgba(${Math.round(190 + v * 60)},${Math.round(112 + v * 58)},${Math.round(56 + v * 46)},${(0.42 + v * 0.5).toFixed(3)})`;
        parCtx.fillRect(sx * W / n, sy * H / n, W / n + 1, H / n + 1);
        if (gr > 0.72) {
          parCtx.fillStyle = `rgba(255,190,120,${(gr - 0.72) * 0.5})`;
          parCtx.fillRect(sx * W / n, sy * H / n, W / n + 1, H / n + 1);
        }
      }
    }
  }
  parCtx.globalCompositeOperation = 'destination-in';
  parCtx.drawImage(maskCv, 0, 0);
  parCtx.globalCompositeOperation = 'source-over';

  // 4) 合成到输出：实体 = 深色底 + 牛皮透光色
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(parCv, 0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';

  // 实体的深色主体：把遮罩以半透明深色覆盖，孔洞处保持亮
  const solidCv = makeCanvas(W, H);
  const solidCtx = solidCv.getContext('2d');
  solidCtx.fillStyle = baseColor;
  solidCtx.fillRect(0, 0, W, H);
  solidCtx.globalCompositeOperation = 'destination-in';
  solidCtx.drawImage(maskCv, 0, 0);
  ctx.globalAlpha = 0.78;
  ctx.drawImage(solidCv, 0, 0, w, h);
  ctx.globalAlpha = 1;

  // 5) 镂空边沿的透光暖边
  if (glow > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    // 求 mask 的反相，收缩后作为“孔洞边缘”的描边带
    const invCv = makeCanvas(W, H);
    const invCtx = invCv.getContext('2d');
    invCtx.fillStyle = '#fff';
    invCtx.fillRect(0, 0, W, H);
    invCtx.globalCompositeOperation = 'destination-out';
    invCtx.drawImage(maskCv, 0, 0);
    // 把反相遮罩模糊后叠加 = 只在实体靠孔洞的一侧留下暖光
    const glowCv = makeCanvas(W, H);
    const gCtx = glowCv.getContext('2d');
    gCtx.filter = `blur(${(2.0 * SS).toFixed(1)}px)`;
    gCtx.drawImage(invCv, 0, 0);
    gCtx.filter = 'none';
    gCtx.globalCompositeOperation = 'destination-in';
    gCtx.drawImage(maskCv, 0, 0);
    ctx.globalAlpha = glow * 0.85;
    ctx.drawImage(glowCv, 0, 0, w, h);
    ctx.restore();
  }

  // 6) 外部剪影描边（皮影的“刀口”轮廓），让剪影边缘更锐利
  const edgeCv = makeCanvas(W, H);
  const eCtx = edgeCv.getContext('2d');
  eCtx.filter = `blur(${(1.1 * SS).toFixed(1)}px)`;
  eCtx.drawImage(maskCv, 0, 0);
  eCtx.filter = 'none';
  eCtx.globalCompositeOperation = 'source-in';
  eCtx.fillStyle = 'rgba(0,0,0,1)';
  eCtx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'source-atop';
  ctx.globalAlpha = 0.5;
  ctx.drawImage(edgeCv, 0, 0, w, h);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  // 7) 最终 alpha 由原遮罩决定（保证镂空干净）
  const finalCv = makeCanvas(w, h);
  const fCtx = finalCv.getContext('2d');
  fCtx.drawImage(cv, 0, 0);
  fCtx.globalCompositeOperation = 'destination-in';
  fCtx.imageSmoothingQuality = 'high';
  fCtx.drawImage(maskCv, 0, 0, w, h);
  sharpenAlpha(fCtx, finalCv);

  const tex = new THREE.CanvasTexture(finalCv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** 纯色简单剪影（用于远景道具，便宜） */
export function makeFlatCutout(draw, w = 128, h = 128, color = '#12080a') {
  return makeAlphaFromDraw(draw, { w, h, parchment: false, glow: 0.2, baseColor: color });
}

export { makeCanvas, hash2, valueNoise };

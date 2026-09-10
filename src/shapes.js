// 影窗 · 夜巡 —— 传统皮影镂空花纹生成器库 + 部件图纸绘制机
//
// 纯 canvas 2D 路径绘制：不 import three、不碰 DOM。因此：
//   - 浏览器里：puppet.js / props.js 拿它把"图纸"（JSON 声明的轮廓 + 装饰 + 孔洞）画成 alpha 贴图；
//   - node 里：tools/check-assets.mjs 用桩 ctx 跑同一份代码，真实统计孔洞数、校验孔洞位置。
//
// 统一签名： fn(ctx, x, y, size, opts)
//   - (x, y) 是该"孔洞单元"的左上角，size 可以是数字（正方形边长）或 {w,h}
//   - 生成器只画路径 / 描边 / 填充，不改变 globalCompositeOperation
//
// 坐标约定（部件图纸）：
//   - 图纸坐标 uv：u 向右、v 向下，都在 [0,1]（画布直觉）；
//   - 图纸尺寸 w/h 是世界单位（米）的宽/高；
//   - pivot：[u,v] 是该部件的**旋转轴心（关节）**在图纸里的位置；
//   - flip：左右镜像（副手/右侧肢体复用同一张图纸，u -> 1-u）。
//   实际换算： 局部米坐标 = ((u-0.5)*w, (0.5-v)*h)  —— 向右 +x、向上 +y，与 rig.js 一致。

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

export const TWO_PI = Math.PI * 2;

/** 纹理像素密度（px / 米）。单一事实来源：puppet.js / props.js / check-assets.mjs 共用。
 *  将军与副将同密度 —— 副将复用将军的四肢图纸，共用同一张贴图。 */
export const TEX_PPM = { general: 900, cavalry: 900, props: 660 };
export const TEX_MAX_PX = 640;

/** 世界尺寸(米) -> 贴图像素尺寸（保持宽高比，长边不超过 maxPx） */
export function pixFor(w, h, ppm = 960, maxPx = TEX_MAX_PX) {
  const s = Math.min(ppm, maxPx / Math.max(w, h));
  return [
    Math.max(32, Math.round(w * s)),
    Math.max(32, Math.round(h * s)),
  ];
}

/** 图纸 uv -> 部件局部米坐标（向右 +x、向上 +y） */
export function uvToLocal(uv, w, h) {
  return [(uv[0] - 0.5) * w, (0.5 - uv[1]) * h];
}

/** 部件局部米坐标 -> 图纸 uv */
export function localToUv(m, w, h) {
  return [m[0] / w + 0.5, 0.5 - m[1] / h];
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 97;
}

/** 把 size 归一化成 {x, y, w, h} */
export function toBox(x, y, size) {
  if (size == null) return { x, y, w: 1, h: 1 };
  if (typeof size === 'number') return { x, y, w: size, h: size };
  const w = size.w != null ? size.w : size.h;
  const h = size.h != null ? size.h : size.w;
  return { x, y, w, h };
}

function opt(o, k, d) { return o && o[k] != null ? o[k] : d; }

function unitBox(b) {
  const s = Math.min(b.w, b.h);
  return { x: b.x + (b.w - s) / 2, y: b.y + (b.h - s) / 2, s };
}

/**
 * 平滑闭合路径（Catmull-Rom 转三次贝塞尔）。会自行 beginPath / closePath。
 * @param {number[][]} pts [[x,y], ...]
 * @param {number} tension 1.0 = 标准 Catmull-Rom；调小更接近折线
 */
export function smoothClosed(ctx, pts, tension = 1.0) {
  const n = pts.length;
  ctx.beginPath();
  if (n < 3) return;
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const k = tension / 6;
    ctx.bezierCurveTo(
      p1[0] + (p2[0] - p0[0]) * k, p1[1] + (p2[1] - p0[1]) * k,
      p2[0] - (p3[0] - p1[0]) * k, p2[1] - (p3[1] - p1[1]) * k,
      p2[0], p2[1],
    );
  }
  ctx.closePath();
}

/** 平滑开放路径。会自行 beginPath。 */
export function smoothOpen(ctx, pts, tension = 1.0) {
  const n = pts.length;
  ctx.beginPath();
  if (n < 2) return;
  ctx.moveTo(pts[0][0], pts[0][1]);
  if (n === 2) { ctx.lineTo(pts[1][0], pts[1][1]); return; }
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
    const k = tension / 6;
    ctx.bezierCurveTo(
      p1[0] + (p2[0] - p0[0]) * k, p1[1] + (p2[1] - p0[1]) * k,
      p2[0] - (p3[0] - p1[0]) * k, p2[1] - (p3[1] - p1[1]) * k,
      p2[0], p2[1],
    );
  }
}

function bezierPt(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
  ];
}

/* ------------------------------------------------------------------ *
 * 花纹生成器（每个 = 一个孔洞单元）
 * ------------------------------------------------------------------ */

/** 月牙 / 眼、口、刀槽 —— 两个椭圆做 evenodd 差集 */
export function moonSlit(ctx, x, y, size, opts = {}) {
  const b = toBox(x, y, size);
  const rx = b.w * 0.5, ry = b.h * 0.5;
  const cx = b.x + rx, cy = b.y + ry;
  const depth = opt(opts, 'depth', 0.55);
  const tilt = opt(opts, 'tilt', 0);
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, tilt, 0, TWO_PI);
  ctx.ellipse(cx + rx * depth, cy - ry * 0.12, rx * 0.96, ry * 0.90, tilt, 0, TWO_PI);
  ctx.fill('evenodd');
}

/** 云纹（卷云）：螺旋 + 外挑的云尾 */
export function cloudScroll(ctx, x, y, size, opts = {}) {
  const b = toBox(x, y, size);
  const cx = b.x + b.w * 0.5, cy = b.y + b.h * 0.5;
  const r0 = Math.min(b.w, b.h) * 0.46;
  const lw = Math.max(0.7, Math.min(b.w, b.h) * opt(opts, 'weight', 0.17));
  const turns = opt(opts, 'turns', 1.25);
  const flip = opt(opts, 'flip', 0) ? -1 : 1;
  ctx.save();
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const N = 44;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const a = Math.PI * 0.35 + flip * t * Math.PI * 2 * turns;
    const r = r0 * (1 - t * 0.78);
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r * 0.94;
    if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
  }
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx + flip * r0 * 0.10, cy + r0 * 0.30);
  ctx.quadraticCurveTo(cx + flip * r0 * 0.85, cy + r0 * 0.62, cx - flip * r0 * 0.40, cy + r0 * 0.80);
  ctx.stroke();
  ctx.restore();
}

/** 回纹（雷纹）：一个"回"字方折单元 */
export function fretBand(ctx, x, y, size, opts = {}) {
  const b = toBox(x, y, size);
  const { x: x0, y: y0, s } = unitBox(b);
  const lw = Math.max(0.6, s * opt(opts, 'weight', 0.17));
  const flip = opt(opts, 'flip', 0) ? -1 : 1;
  const U = [[0.52, 0.06], [0.52, 0.94], [0.94, 0.94], [0.94, 0.36], [0.13, 0.36], [0.13, 0.74], [0.70, 0.74]];
  ctx.save();
  ctx.lineWidth = lw;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.beginPath();
  U.forEach((p, i) => {
    const px = x0 + (flip > 0 ? p[0] : 1 - p[0]) * s;
    const py = y0 + p[1] * s;
    if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
  });
  ctx.stroke();
  ctx.restore();
}

/** 缠枝纹：S 形主藤 + 左右交替的叶片 */
export function vineScroll(ctx, x, y, size, opts = {}) {
  const b = toBox(x, y, size);
  const lw = Math.max(0.6, Math.min(b.w, b.h) * opt(opts, 'weight', 0.13));
  const flip = opt(opts, 'flip', 0) ? -1 : 1;
  const p0 = [b.x + b.w * (flip > 0 ? 0 : 1), b.y + b.h * 0.74];
  const p1 = [b.x + b.w * 0.30, b.y + b.h * 0.04];
  const p2 = [b.x + b.w * 0.64, b.y + b.h * 0.98];
  const p3 = [b.x + b.w * (flip > 0 ? 1 : 0), b.y + b.h * 0.28];
  ctx.save();
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(p0[0], p0[1]);
  ctx.bezierCurveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
  ctx.stroke();
  const leaves = Math.max(2, opt(opts, 'leaves', 3) | 0);
  const r = Math.min(b.w, b.h) * opt(opts, 'leaf', 0.21);
  for (let i = 0; i < leaves; i++) {
    const t = (i + 0.5) / leaves;
    const pt = bezierPt(p0, p1, p2, p3, t);
    const side = (i % 2 ? 1 : -1) * flip;
    ctx.beginPath();
    ctx.ellipse(pt[0], pt[1] + side * r * 0.85, r * 0.52, r, side * 0.55, 0, TWO_PI);
    ctx.fill();
  }
  ctx.restore();
}

/** 鳞甲 / 龙鳞：半圆叠片（错缝铺设最像鱼鳞） */
export function scaleField(ctx, x, y, size, opts = {}) {
  const b = toBox(x, y, size);
  const r = Math.min(b.w * 0.62, b.h * 0.94) * opt(opts, 'scale', 1.0);
  const lw = Math.max(0.6, r * opt(opts, 'weight', 0.20));
  ctx.save();
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(b.x + b.w / 2, b.y + b.h * 0.86, r, Math.PI * 1.02, Math.PI * 1.98);
  ctx.stroke();
  if (opt(opts, 'dot', 1)) {
    ctx.beginPath();
    ctx.arc(b.x + b.w / 2, b.y + b.h * 0.42, r * 0.16, 0, TWO_PI);
    ctx.fill();
  }
  ctx.restore();
}

/** 万字纹（卍）：四臂折线 */
export function wanField(ctx, x, y, size, opts = {}) {
  const b = toBox(x, y, size);
  const { x: x0, y: y0, s } = unitBox(b);
  const lw = Math.max(0.6, s * opt(opts, 'weight', 0.15));
  const flip = opt(opts, 'flip', 0) ? -1 : 1;
  const cx = x0 + s * 0.5, cy = y0 + s * 0.5;
  const arm = s * 0.44, bend = s * 0.30;
  ctx.save();
  ctx.lineWidth = lw;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.beginPath();
  ctx.moveTo(cx + flip * bend, cy - arm); ctx.lineTo(cx, cy - arm); ctx.lineTo(cx, cy);
  ctx.lineTo(cx + arm, cy); ctx.lineTo(cx + arm, cy + bend);
  ctx.moveTo(cx, cy); ctx.lineTo(cx, cy + arm); ctx.lineTo(cx - flip * bend, cy + arm);
  ctx.moveTo(cx, cy); ctx.lineTo(cx - arm, cy); ctx.lineTo(cx - arm, cy - bend);
  ctx.stroke();
  ctx.restore();
}

/** 花瓣窗：中心圆 + 一圈花瓣（传统"团花"窗） */
export function petalWindow(ctx, x, y, size, opts = {}) {
  const b = toBox(x, y, size);
  const { x: x0, y: y0, s } = unitBox(b);
  const n = Math.max(4, opt(opts, 'petals', 8) | 0);
  const cx = x0 + s * 0.5, cy = y0 + s * 0.5;
  const rr = s * 0.5 * opt(opts, 'reach', 0.92);
  const pr = s * opt(opts, 'petal', 0.21);
  const ring = s * opt(opts, 'ring', 0.30);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TWO_PI + opt(opts, 'phase', 0);
    ctx.ellipse(cx + Math.cos(a) * ring, cy + Math.sin(a) * ring, pr, pr * 0.52, a, 0, TWO_PI);
  }
  ctx.fill();
  if (opt(opts, 'core', 1)) {
    ctx.beginPath();
    ctx.arc(cx, cy, s * opt(opts, 'coreR', 0.14), 0, TWO_PI);
    ctx.fill();
  }
  if (opt(opts, 'spokes', 0)) {
    ctx.save();
    ctx.lineWidth = Math.max(0.6, s * 0.05);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TWO_PI;
      ctx.moveTo(cx + Math.cos(a) * ring * 0.45, cy + Math.sin(a) * ring * 0.45);
      ctx.lineTo(cx + Math.cos(a) * rr * 0.86, cy + Math.sin(a) * rr * 0.86);
    }
    ctx.stroke();
    ctx.restore();
  }
}

/** 菱形格 */
export function diamondField(ctx, x, y, size, opts = {}) {
  const b = toBox(x, y, size);
  const rx = b.w * 0.5 * opt(opts, 'fill', 0.92);
  const ry = b.h * 0.5 * opt(opts, 'fill', 0.92);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const lw = Math.max(0.6, Math.min(b.w, b.h) * opt(opts, 'weight', 0.18));
  ctx.save();
  ctx.lineWidth = lw;
  ctx.lineJoin = 'miter';
  ctx.beginPath();
  ctx.moveTo(cx, cy - ry); ctx.lineTo(cx + rx, cy); ctx.lineTo(cx, cy + ry); ctx.lineTo(cx - rx, cy);
  ctx.closePath();
  if (opt(opts, 'solid', 0)) ctx.fill(); else ctx.stroke();
  ctx.restore();
}

/** 如意云头带：一排相扣的云头弧（衣摆、旗边常用） */
export function cloudBand(ctx, x, y, size, opts = {}) {
  const b = toBox(x, y, size);
  const n = Math.max(1, opt(opts, 'lobes', 2) | 0);
  const lw = Math.max(0.6, b.h * opt(opts, 'weight', 0.26));
  ctx.save();
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const cx = b.x + b.w * ((i + 0.5) / n);
    const r = b.w / n * 0.5;
    ctx.moveTo(cx - r, b.y + b.h * 0.78);
    ctx.bezierCurveTo(cx - r, b.y + b.h * 0.05, cx + r, b.y + b.h * 0.05, cx + r, b.y + b.h * 0.78);
  }
  ctx.stroke();
  ctx.restore();
}

/** 羽缝 / 排线：一排细长斜缝（翎羽、铁线用） */
export function slitRow(ctx, x, y, size, opts = {}) {
  const b = toBox(x, y, size);
  const n = Math.max(1, opt(opts, 'slits', 3) | 0);
  const tilt = opt(opts, 'tilt', -0.55);
  const lw = Math.max(0.7, b.h * opt(opts, 'weight', 0.30));
  ctx.save();
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const cx = b.x + b.w * ((i + 0.5) / n);
    const dx = Math.cos(tilt) * b.h * 0.5, dy = Math.sin(tilt) * b.h * 0.5;
    ctx.moveTo(cx - dx, b.y + b.h * 0.5 - dy);
    ctx.lineTo(cx + dx, b.y + b.h * 0.5 + dy);
  }
  ctx.stroke();
  ctx.restore();
}

/** 圆点 / 联珠 */
export function dotField(ctx, x, y, size, opts = {}) {
  const b = toBox(x, y, size);
  const r = Math.min(b.w, b.h) * 0.5 * opt(opts, 'dot', 0.9);
  ctx.beginPath();
  ctx.arc(b.x + b.w / 2, b.y + b.h / 2, Math.max(0.4, r), 0, TWO_PI);
  ctx.fill();
}

/** 钱纹 / 圆窗：外圈 + 内方（孔方兄） */
export function ringWindow(ctx, x, y, size, opts = {}) {
  const b = toBox(x, y, size);
  const { x: x0, y: y0, s } = unitBox(b);
  const lw = Math.max(0.7, s * opt(opts, 'weight', 0.13));
  const cx = x0 + s * 0.5, cy = y0 + s * 0.5;
  ctx.save();
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.arc(cx, cy, s * 0.42, 0, TWO_PI);
  ctx.stroke();
  if (opt(opts, 'square', 1)) {
    const q = s * 0.155;
    ctx.beginPath();
    ctx.rect(cx - q, cy - q, q * 2, q * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** 水波纹 */
export function waveBand(ctx, x, y, size, opts = {}) {
  const b = toBox(x, y, size);
  const n = Math.max(1, opt(opts, 'waves', 3) | 0);
  const lw = Math.max(0.6, b.h * opt(opts, 'weight', 0.22));
  ctx.save();
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const cw = b.w / n;
    const cx = b.x + cw * (i + 0.5);
    ctx.moveTo(cx - cw * 0.5, b.y + b.h * 0.55);
    ctx.quadraticCurveTo(cx, b.y - b.h * 0.35, cx + cw * 0.5, b.y + b.h * 0.55);
  }
  ctx.stroke();
  ctx.restore();
}

/** 素窗：不画任何花纹（配 ridge 用，得到纯矩形开窗） */
export function blankWindow() {}

/** 花纹注册表：pierce 声明里用名字引用 */
export const PATTERNS = {
  moonSlit, cloudScroll, fretBand, vineScroll, scaleField, wanField,
  petalWindow, diamondField, cloudBand, slitRow, dotField, ringWindow, waveBand, blankWindow,
};

/** 中文名（用于报表） */
export const PATTERN_NAMES = {
  moonSlit: '月牙', cloudScroll: '云纹', fretBand: '回纹', vineScroll: '缠枝纹',
  scaleField: '鳞甲', wanField: '万字纹', petalWindow: '花瓣窗', diamondField: '菱形格',
  cloudBand: '如意云头', slitRow: '羽缝', dotField: '联珠', ringWindow: '钱纹窗',
  waveBand: '水波纹', blankWindow: '素窗',
};

/* ------------------------------------------------------------------ *
 * 整片打孔
 * ------------------------------------------------------------------ */

/**
 * 在一整片矩形里按 cols × rows 铺花纹孔洞（大小孔洞交替、可错缝 = 皮影刀法的节奏）。
 *
 * 两种刀法：
 *  - 默认：花纹本身即孔洞（细缝状镂空，刀口细密）；
 *  - `ridge: 1`：**开窗留肉** —— 先把整格挖成一个大窗（大块透光），再把花纹以实体留在窗里。
 *    这才是传统皮影"花窗 + 细细的筋"的观感，也是幕布上最容易被看见的成片亮斑。
 *
 * @returns {number} 实际开出的孔洞（窗）个数
 */
export function pierceField(ctx, x, y, w, h, pattern, opts = {}) {
  const fn = typeof pattern === 'function' ? pattern : PATTERNS[pattern];
  if (!fn) throw new Error('pierceField: 未知花纹 "' + pattern + '"');
  const cols = Math.max(1, Math.round(opt(opts, 'cols', 1)));
  const rows = Math.max(1, Math.round(opt(opts, 'rows', 1)));
  const gap = opt(opts, 'gap', 0.18);
  const alt = opt(opts, 'alt', 0.62);
  const altOn = opt(opts, 'altOn', 0);
  const stagger = opt(opts, 'stagger', 0);
  const ridge = !!opt(opts, 'ridge', 0);
  const winPad = opt(opts, 'winPad', 0.035);
  const sw = stagger ? (w / cols) * 0.5 * stagger : 0;
  const cw = (w - sw) / cols;
  const ch = h / rows;
  const outer = ctx.globalCompositeOperation;
  let n = 0;
  ctx.save();
  for (let r = 0; r < rows; r++) {
    const off = (r & 1) ? sw : 0;
    for (let c = 0; c < cols; c++) {
      const big = (((r + c + altOn) & 1) === 0);
      const k = big ? 1 : alt;
      const bx = x + off + c * cw + cw * (1 - (1 - gap) * k) * 0.5;
      const by = y + r * ch + ch * (1 - (1 - gap) * k) * 0.5;
      const bw = cw * (1 - gap) * k;
      const bh = ch * (1 - gap) * k;
      if (bw <= 0.5 || bh <= 0.5) continue;
      if (ridge) {
        // 1) 整格开窗（挖空）
        const px = bw * winPad, py = bh * winPad;
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillRect(bx - px, by - py, bw + px * 2, bh + py * 2);
        // 2) 花纹留在窗里（实体）
        ctx.globalCompositeOperation = 'source-over';
        fn(ctx, bx, by, { w: bw, h: bh }, opts);
      } else {
        ctx.globalCompositeOperation = outer;
        fn(ctx, bx, by, { w: bw, h: bh }, opts);
      }
      n++;
    }
  }
  ctx.restore();
  return n;
}

/* ------------------------------------------------------------------ *
 * 部件图纸绘制机（puppet.js / props.js / check-assets.mjs 共用）
 * ------------------------------------------------------------------ */

/** 装饰画笔：都用图纸 uv 定位，尺寸用米，所以不会因为贴图分辨率变化而走样 */
export const DECOR = {
  /** 实心圆：{k:'disc', at:[u,v], r:米} */
  disc(ctx, d, S, api) {
    const c = api.p(d.at);
    ctx.beginPath();
    ctx.arc(c[0], c[1], api.d(d.r != null ? d.r : 0.02), 0, TWO_PI);
    ctx.fill();
  },
  /** 实心矩形：{k:'bar', at:[u,v], w:米, h:米, rot:弧度} */
  bar(ctx, d, S, api) {
    const c = api.p(d.at);
    const w = api.dx(d.w != null ? d.w : 0.02), h = api.dy(d.h != null ? d.h : 0.02);
    ctx.save();
    ctx.translate(c[0], c[1]);
    ctx.rotate(-(d.rot || 0));
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  },
  /** 实心平滑多边形：{k:'blob', pts:[[u,v]...], tension?} */
  blob(ctx, d, S, api) {
    smoothClosed(ctx, d.pts.map(api.p), d.tension != null ? d.tension : 1.0);
    ctx.fill();
  },
  /** 描边折线：{k:'line', pts:[[u,v]...], width:米, cap} */
  line(ctx, d, S, api) {
    ctx.save();
    ctx.lineWidth = api.d(d.width != null ? d.width : 0.01);
    ctx.lineCap = d.cap || 'round';
    ctx.lineJoin = 'round';
    smoothOpen(ctx, d.pts.map(api.p), d.tension != null ? d.tension : 1.0);
    ctx.stroke();
    ctx.restore();
  },
  /** 圆弧描边：{k:'arc', at:[u,v], r:米, a0:弧度, a1:弧度, width:米} */
  arc(ctx, d, S, api) {
    const c = api.p(d.at);
    ctx.save();
    ctx.lineWidth = api.d(d.width != null ? d.width : 0.01);
    ctx.lineCap = d.cap || 'round';
    ctx.beginPath();
    ctx.arc(c[0], c[1], api.d(d.r), -(d.a1 || 0), -(d.a0 || 0));
    ctx.stroke();
    ctx.restore();
  },
  /** 文字（canvas 2D，非 SVG）：{k:'text', at:[u,v], t:'酒', s:字高(米), font} */
  text(ctx, d, S, api) {
    const c = api.p(d.at);
    const px = api.d(d.s != null ? d.s : 0.1);
    ctx.save();
    ctx.font = `${px.toFixed(1)}px ${d.font || 'serif'}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(d.t, c[0], c[1]);
    ctx.restore();
  },
};

/** 图纸 -> 画布坐标（含左右镜像） */
export function makeApi(ctx, W, H, spec) {
  const flip = !!spec.flip;
  const kx = W / spec.w, ky = H / spec.h;
  return {
    W, H, kx, ky, flip,
    p: (uv) => (flip ? [1 - uv[0], uv[1]] : [uv[0], uv[1]]).map((t, i) => t * (i ? H : W)),
    dx: (m) => m * kx,
    dy: (m) => m * ky,
    d: (m) => m * kx,
  };
}

/** pierce 矩形 -> 图纸 uv（含镜像）；check-assets 也用它 */
export function pierceRectUv(q, flip) {
  const x = flip ? 1 - (q.x + q.w) : q.x;
  return { x, y: q.y, w: q.w, h: q.h };
}

/**
 * 把一份图纸画到 canvas 上：轮廓 -> 装饰 -> 关节球 -> 镂空打孔。
 * @param {CanvasRenderingContext2D} ctx 目标（makeAlphaFromDraw 的遮罩画布）
 * @param {number} W 画布宽（px）
 * @param {number} H 画布高（px）
 * @param {object} spec 已解析的图纸（见 resolveSpecs）
 * @returns {{holes:number, ops:number}} 实际打了几刀（供统计）
 */
export function drawPartSpec(ctx, W, H, spec) {
  const api = makeApi(ctx, W, H, spec);
  const outlinePts = spec.outline ? spec.outline.map(api.p) : null;
  const tension = spec.tension != null ? spec.tension : 1.0;
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  if (outlinePts && outlinePts.length >= 3) {
    smoothClosed(ctx, outlinePts, tension);
    ctx.fill();
  }
  for (const d of spec.decor || []) {
    const fn = DECOR[d.k];
    if (!fn) throw new Error('未知装饰画笔 "' + d.k + '"');
    fn(ctx, d, spec, api);
  }
  if (spec.ball) {
    const c = api.p(spec.pivot);
    ctx.beginPath();
    ctx.arc(c[0], c[1], api.d(spec.ball), 0, TWO_PI);
    ctx.fill();
  }

  let holes = 0;
  if (spec.pierce && spec.pierce.length) {
    // 关键：镂空（尤其"开窗留肉"的实心花纹）必须裁在皮子轮廓内，
    // 否则花纹的筋会画到皮子外面，剪影边缘会多出悬空的小刺。
    if (outlinePts && outlinePts.length >= 3) {
      smoothClosed(ctx, outlinePts, tension);
      ctx.clip();
    }
    ctx.globalCompositeOperation = 'destination-out';
    for (const q of spec.pierce) {
      const r = pierceRectUv(q, api.flip);
      holes += pierceField(ctx, r.x * W, r.y * H, r.w * W, r.h * H, q.p, q.o || {});
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();
  return { holes, ops: 0 };
}

/* ------------------------------------------------------------------ *
 * 图纸表解析（JSON 表 -> 运行时规格）
 * ------------------------------------------------------------------ */

/** 舞台灯位（与 src/stage.js 的 SpotLight 保持一致）—— 道具反解摆位用。
 *  2024 修正：引擎灯位已改为 (0.10, -0.28, -3.2)（距幕布 3.2m、灯高约幕布中心），
 *  放大率 K = 3.2/(3.2+z)。此处必须与 stage.js 同步，否则道具影子会整体偏移。 */
export const STAGE_LIGHT = [0.10, -0.28, -3.2];

/**
 * 影子反解：已知"希望影子落在幕布上的中心与尺寸"，求物体该放在哪、多大。
 * 幕布在 z=0，灯在 z=L.z，物体在深度 z：放大倍率 K = -L.z / (z - L.z)。
 * @param {number[]} target [cx, cy, w, h]（幕布坐标，米）
 * @param {number} z 物体深度（负值）
 * @param {number[]} light 灯位
 */
export function placeByShadow(target, z, light = STAGE_LIGHT) {
  const K = (0 - light[2]) / (z - light[2]);
  return {
    center: [light[0] + (target[0] - light[0]) / K, light[1] + (target[1] - light[1]) / K],
    size: [target[2] / K, target[3] / K],
    scale: K,
  };
}

function findRaw(allTables, tableName, key) {
  const t = allTables[tableName];
  if (!t) return null;
  return t.find((s) => s.key === key) || null;
}

function mergeChain(raw, tableName, allTables, depth = 0) {
  if (!raw.uses) return raw;
  if (depth > 6) throw new Error('图纸继承过深：' + raw.key);
  const from = raw.from || tableName;
  const src = findRaw(allTables, from, raw.uses);
  if (!src) throw new Error(`图纸 "${raw.key}" 继承的 "${from}:${raw.uses}" 不存在`);
  const base = mergeChain(src, from, allTables, depth + 1);
  return Object.assign({}, base, raw);
}

/** 贴图键：沿 uses 链一路追到根图纸，这样镜像/复用件共用同一张贴图 */
function artKeyOf(raw, tableName, allTables, depth = 0) {
  if (!raw || !raw.uses) return `${tableName}:${raw ? raw.key : '?'}`;
  if (depth > 6) return `${tableName}:${raw.key}`;
  const from = raw.from || tableName;
  const src = findRaw(allTables, from, raw.uses);
  return artKeyOf(src, from, allTables, depth + 1);
}

/**
 * 把 JSON 图纸表解析成运行时规格数组。
 * 保持声明顺序 —— 顺序即"父部件必须先于子部件"，check-assets 会断言这一点。
 *
 * @param {object[]} rawList 该表的图纸（JSON）
 * @param {object} allTables 所有表 {tableName: rawList}（供跨表继承）
 * @param {{table:string, ppm:number, maxPx:number}} opts
 */
export function resolveSpecs(rawList, allTables, { table = 'main', ppm = 960, maxPx = TEX_MAX_PX } = {}) {
  const out = [];
  for (const raw of rawList) {
    const base = mergeChain(raw, table, allTables);
    const flip = !!raw.flip;
    const w = base.w, h = base.h;
    if (!(w > 0) || !(h > 0)) throw new Error(`图纸 "${raw.key}" 缺少合法的 w/h`);
    if (!base.pivot) throw new Error(`图纸 "${raw.key}" 缺少 pivot`);
    const artKey = artKeyOf(raw, table, allTables);
    const pivotUv = flip ? [1 - base.pivot[0], base.pivot[1]] : base.pivot;
    const pv = uvToLocal(pivotUv, w, h);
    // 静息欧拉角：**字面值**（右臂写 -0.06，不做隐式取反，便于编排组静态解析）
    const rest = raw.rest || base.rest || [0, 0, 0];
    out.push({
      key: raw.key,
      // 注意：parent/joint/at/z/rest 都取合并后的 base（uses 继承件可能没写这些字段）
      parent: base.parent || null,
      joint: base.joint || null,
      at: base.at || null,
      usesFrom: raw.uses ? (raw.from || table) : null,
      z: base.z || 0,
      rest,
      cloth: raw.cloth || base.cloth || null,
      flip,
      uses: raw.uses || null,
      w, h,
      pivotUv,
      pivot: pv,
      outline: base.outline || null,
      decor: base.decor || null,
      pierce: base.pierce || null,
      tension: base.tension,
      ball: base.ball != null ? base.ball : null,
      baseColor: base.base || '#1b0d06',
      glow: base.glow != null ? base.glow : 0.62,
      texName: base.tex || artKey,
      artKey,
      ppm: base.ppm || ppm,
      pix: pixFor(w, h, base.ppm || ppm, base.maxPx || maxPx),
      seed: hashStr(artKey),
    });
  }
  return out;
}

/**
 * 求每个部件的挂点（anchor，写在父部件 pivot 坐标系里）。
 * - 有 joint（整体身位坐标，米，脚跟 y=0）：anchor = joint - 父部件 joint
 * - 有 at（父部件图纸 uv）：anchor = 父图纸该点的局部米坐标 - 父部件 pivot
 * 两者都要求链条上所有部件 rest = 0（本项目的硬约定，出图时已把角度画进图纸里）。
 * @returns {{byKey:Map<string,object>, anchors:Map<string,[number,number]>, joints:Map<string,[number,number]>}}
 */
export function resolveAnchors(specs) {
  const byKey = new Map();
  const joints = new Map();
  const anchors = new Map();
  for (const s of specs) {
    if (byKey.has(s.key)) throw new Error('部件 key 重复：' + s.key);
    byKey.set(s.key, s);
    const parent = s.parent ? byKey.get(s.parent) : null;
    if (s.parent && !parent) {
      throw new Error(`部件 "${s.key}" 的父部件 "${s.parent}" 尚未声明（必须写在其前面）`);
    }
    let joint, anchor;
    if (s.at) {
      if (!parent) throw new Error(`部件 "${s.key}" 用了 at，但没有父部件`);
      const local = uvToLocal(s.at, parent.w, parent.h);   // 父图纸内的局部米坐标
      anchor = [local[0] - parent.pivot[0], local[1] - parent.pivot[1]];
      const pj = joints.get(s.parent);
      joint = [pj[0] + anchor[0], pj[1] + anchor[1]];
    } else {
      joint = s.joint || [0, 0];
      if (parent && !parent.joint) {
        throw new Error(`部件 "${s.key}" 用 joint 定位，但父部件 "${s.parent}" 是 at 定位（其 joint 为 null）；请给 "${s.parent}" 也写上 joint，或用 at 定位 "${s.key}"`);
      }
      anchor = parent
        ? [joint[0] - parent.joint[0], joint[1] - parent.joint[1]]
        : [joint[0], joint[1]];
    }
    joints.set(s.key, joint);
    anchors.set(s.key, anchor);
  }
  return { byKey, anchors, joints };
}

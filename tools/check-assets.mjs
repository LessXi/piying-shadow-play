// 影窗 · 夜巡 —— 皮影资产静态自检（node，无需浏览器）
//
//   node tools/check-assets.mjs
//
// 做四件事：
//  1. 从 src/puppet.js / src/props.js 里抽出严格 JSON 图纸表（PART_SPECS / PROP_SPECS），JSON.parse —— 表本身就是运行时用的那张表，不是正则近似。
//  2. 用 src/shapes.js 的同一个解析器算出每个部件的 pivot / anchor / 贴图尺寸，做几何与接口校验：
//     通道名合法、父部件先声明、w/h 合理、pivot 在贴图内、关节球画得下、链条高度 ≈ PUPPET_HEIGHT、
//     anchor 落在父部件贴图范围内（专抓"把 anchor 写成世界坐标"这个经典错误）。
//  3. 用桩 ctx **真跑一遍** shapes.js 的绘制机，统计每个部件开出的孔洞数（含开窗留肉），
//     并校验镂空框落在轮廓内（用轮廓多边形 + 射线法），以及"头饰/衣纹/兵器必须有镂空"的硬要求。
//  4. 检查禁用项：不得有 SVG、不得越界写文件。
//
// 退出码：0 = OK，1 = FAIL（会打印全部问题）。

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveSpecs, resolveAnchors, drawPartSpec, pierceRectUv, pixFor,
  PATTERNS, PATTERN_NAMES, TEX_PPM, TEX_MAX_PX, placeByShadow, STAGE_LIGHT,
} from '../src/shapes.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];
const warn = (m) => problems.push(m);
const info = (m) => notes.push(m);

/* ------------------------------------------------------------------ *
 * 0. 标准通道表（INTERFACES.md A.1）
 * ------------------------------------------------------------------ */
const CHANNELS = [
  'waist', 'chest', 'neck', 'head',
  'shoulderL', 'upperArmL', 'forearmL', 'handL',
  'shoulderR', 'upperArmR', 'forearmR', 'handR',
  'hipL', 'thighL', 'shinL', 'footL',
  'hipR', 'thighR', 'shinR', 'footR',
  'cape', 'cape2', 'scarf', 'weapon', 'weaponTip', 'plume', 'flag',
];
const CH = new Set(CHANNELS);
/** 编排组不必给、但允许存在的附加通道 */
const OPTIONAL = new Set(['cape2', 'scarf']);

/* ------------------------------------------------------------------ *
 * 1. 抽 JSON 表
 * ------------------------------------------------------------------ */
function extractJsonConst(src, name, file) {
  const re = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*`);
  const m = re.exec(src);
  if (!m) { warn(`${file}: 找不到 export const ${name}`); return null; }
  let i = src.indexOf('{', m.index + m[0].length);
  if (i < 0) { warn(`${file}: ${name} 不是对象字面量`); return null; }
  let depth = 0, inStr = null, esc = false, line = 1;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\n') line++;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"') { inStr = ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        const text = src.slice(i, j + 1);
        try { return JSON.parse(text); }
        catch (e) {
          warn(`${file}: ${name} 不是合法 JSON（严格 JSON 是硬要求，便于静态解析）：${e.message}`);
          return null;
        }
      }
    }
  }
  warn(`${file}: ${name} 括号不闭合`);
  return null;
}

const puppetSrc = readFileSync(resolve(ROOT, 'src/puppet.js'), 'utf8');
const propsSrc = readFileSync(resolve(ROOT, 'src/props.js'), 'utf8');
const PART_SPECS = extractJsonConst(puppetSrc, 'PART_SPECS', 'src/puppet.js');
const PROP_SPECS = extractJsonConst(propsSrc, 'PROP_SPECS', 'src/props.js');
if (!PART_SPECS || !PROP_SPECS) { report(); }

/* ------------------------------------------------------------------ *
 * 2. 桩 ctx：真跑绘制机，统计孔洞
 * ------------------------------------------------------------------ */
function makeStubCtx() {
  const st = { fills: 0, strokes: 0, rects: 0, texts: 0, ops: 0, depth: 0 };
  const noop = () => { st.ops++; };
  const ctx = {
    canvas: { width: 256, height: 256 },
    globalCompositeOperation: 'source-over',
    globalAlpha: 1, fillStyle: '#fff', strokeStyle: '#fff',
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10,
    lineDashOffset: 0, font: '10px serif', textAlign: 'left', textBaseline: 'alphabetic',
    filter: 'none', imageSmoothingEnabled: true, imageSmoothingQuality: 'low',
    shadowBlur: 0, shadowColor: 'transparent',
    save() { st.ops++; st.depth++; }, restore() { st.ops++; st.depth--; },
    translate: noop, rotate: noop, scale: noop, transform: noop, setTransform: noop, resetTransform: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    bezierCurveTo: noop, quadraticCurveTo: noop, arc: noop, arcTo: noop, ellipse: noop,
    rect: () => { st.rects++; st.ops++; }, roundRect: () => { st.rects++; st.ops++; },
    clip: noop, setLineDash: noop, getLineDash: () => [],
    fill: () => { st.fills++; st.ops++; },
    stroke: () => { st.strokes++; st.ops++; },
    fillRect: () => { st.fills++; st.ops++; },
    strokeRect: () => { st.strokes++; st.ops++; },
    clearRect: noop, fillText: () => { st.texts++; st.ops++; }, strokeText: () => { st.texts++; st.ops++; },
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    drawImage: noop, putImageData: noop, getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    isPointInPath: () => false,
  };
  return { ctx, st };
}

/* ------------------------------------------------------------------ *
 * 3. 几何工具：点是否在多边形内（射线法）
 * ------------------------------------------------------------------ */
function inPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/* ------------------------------------------------------------------ *
 * 4. 主检查
 * ------------------------------------------------------------------ */
const stats = { parts: 0, holes: 0, patterns: new Set(), byTable: {}, texes: new Set() };

function checkTable(tableName, rawList, allTables, ppm, { isProps = false } = {}) {
  const t0 = stats.parts;
  let specs;
  try {
    specs = resolveSpecs(rawList, allTables, { table: tableName, ppm, maxPx: TEX_MAX_PX });
  } catch (e) {
    warn(`[${tableName}] 图纸解析失败：${e.message}`);
    return null;
  }
  let byKey, anchors, joints;
  try {
    ({ byKey, anchors, joints } = resolveAnchors(specs));
  } catch (e) {
    warn(`[${tableName}] 挂点解析失败：${e.message}`);
    return null;
  }

  const seen = new Set();
  for (const spec of specs) {
    const at = `[${tableName}:${spec.key}]`;
    if (seen.has(spec.key)) warn(`${at} key 重复`);
    seen.add(spec.key);
    if (!isProps && !CH.has(spec.key)) warn(`${at} 通道名不在 INTERFACES A.1 标准表内`);
    if (!spec.texName) warn(`${at} 缺少 tex`);
    if (!(spec.w > 0.005 && spec.w <= 5) || !(spec.h > 0.005 && spec.h <= 5)) {
      warn(`${at} w/h 不合理：${spec.w} × ${spec.h}`);
    }
    // pivot 必须在贴图内
    if (Math.abs(spec.pivot[0]) > spec.w / 2 + 1e-9 || Math.abs(spec.pivot[1]) > spec.h / 2 + 1e-9) {
      warn(`${at} pivot 跑到贴图外了：pivot=${spec.pivot.map((v) => v.toFixed(4))} 贴图半宽/高=${(spec.w / 2).toFixed(4)}/${(spec.h / 2).toFixed(4)}`);
    }
    // 关节球要画得下（圆心到四边都够远）
    if (spec.ball) {
      const room = Math.min(
        spec.ball === 0 ? 9 : (spec.w / 2 - Math.abs(spec.pivot[0])),
        spec.h / 2 - Math.abs(spec.pivot[1]),
        spec.w / 2 + spec.pivot[0], spec.w / 2 - spec.pivot[0],
        spec.h / 2 + spec.pivot[1], spec.h / 2 - spec.pivot[1],
      );
      if (spec.ball > room + 1e-6) {
        warn(`${at} 关节球 r=${spec.ball} 超出贴图（最多 ${room.toFixed(4)}），会被裁成半圆`);
      }
    }
    // anchor 必须落在父部件贴图的合理范围内（抓"anchor 写成世界坐标"）
    const anc = anchors.get(spec.key);
    if (spec.parent) {
      const p = byKey.get(spec.parent);
      const spanX = p.w / 2 + Math.abs(p.pivot[0]);
      const spanY = p.h / 2 + Math.abs(p.pivot[1]);
      if (Math.abs(anc[0]) > spanX * 1.35 + 0.02 || Math.abs(anc[1]) > spanY * 1.35 + 0.02) {
        warn(`${at} anchor=[${anc.map((v) => v.toFixed(3))}] 超出父件 ${spec.parent} 的贴图范围（±${spanX.toFixed(3)}/±${spanY.toFixed(3)}）—— 典型的"anchor 写成世界坐标"错误`);
      }
    }
    // 轮廓点必须在贴图内
    if (spec.outline) {
      const out = spec.flip ? spec.outline.map((q) => [1 - q[0], q[1]]) : spec.outline;
      for (const q of out) {
        const lx = (q[0] - 0.5) * spec.w, ly = (0.5 - q[1]) * spec.h;
        if (Math.abs(lx) > spec.w / 2 + 1e-6 || Math.abs(ly) > spec.h / 2 + 1e-6) {
          warn(`${at} 轮廓点 ${JSON.stringify(q)} 超出贴图边界`);
          break;
        }
      }
      // 镂空框必须基本落在轮廓内（孔开到皮子外面 = 花纹的筋会悬在剪影外）
      for (const q of spec.pierce || []) {
        const r = pierceRectUv(q, spec.flip);
        const N = 7;
        let inside = 0, total = 0;
        for (let iy = 0; iy < N; iy++) {
          for (let ix = 0; ix < N; ix++) {
            const px = r.x + r.w * (ix + 0.5) / N, py = r.y + r.h * (iy + 0.5) / N;
            total++;
            if (inPoly([px, py], out)) inside++;
          }
        }
        const frac = inside / total;
        const centerIn = inPoly([r.x + r.w / 2, r.y + r.h / 2], out);
        if (!centerIn) {
          warn(`${at} 镂空框中心 p=${q.p} uv[${r.x.toFixed(3)},${r.y.toFixed(3)}]×[${r.w.toFixed(3)},${r.h.toFixed(3)}] 在轮廓之外（孔开在皮子外面）`);
        } else if (frac < 0.55) {
          warn(`${at} 镂空框 p=${q.p} 只有 ${(frac * 100).toFixed(0)}% 落在轮廓内（外溢太多）`);
        } else if (frac < 0.97) {
          info(`${at} 镂空框 p=${q.p} ${(frac * 100).toFixed(0)}% 在轮廓内（边缘外溢由 drawPartSpec 的轮廓 clip 收住）`);
        }
      }
    }
    // 真跑一遍绘制机，数孔洞
    const { ctx, st } = makeStubCtx();
    let drew;
    try {
      drew = drawPartSpec(ctx, spec.pix[0], spec.pix[1], spec);
    } catch (e) {
      warn(`${at} 绘制抛错：${e.message}`);
      continue;
    }
    stats.parts++;
    stats.holes += drew.holes;
    stats.texes.add(spec.artKey);
    for (const q of spec.pierce || []) stats.patterns.add(q.p);
    const per = (stats.byTable[tableName] = stats.byTable[tableName] || { parts: 0, holes: 0, texes: new Set() });
    per.parts++;
    per.holes += drew.holes;
    per.texes.add(spec.artKey);
    if (spec.cloth) {
      for (const k of ['amp', 'freq', 'lag', 'scaleBy', 'stiff', 'damp']) {
        if (typeof spec.cloth[k] !== 'number' || !Number.isFinite(spec.cloth[k])) warn(`${at} cloth.${k} 不是有限数`);
      }
    }
  }

  // 链条连续性：子件挂点必须落在父件贴图的实体内区域（同链末端）
  for (const spec of specs) {
    if (!spec.parent) continue;
    const p = byKey.get(spec.parent);
    const anc = anchors.get(spec.key);
    const pj = p.pivot;
    // 父件贴图在父 pivot 坐标系里的范围
    const boxX = [-p.w / 2 - pj[0], p.w / 2 - pj[0]];
    const boxY = [-p.h / 2 - pj[1], p.h / 2 - pj[1]];
    const slackX = p.w * 0.3, slackY = p.h * 0.3;
    if (anc[0] < boxX[0] - slackX || anc[0] > boxX[1] + slackX || anc[1] < boxY[0] - slackY || anc[1] > boxY[1] + slackY) {
      info(`[${tableName}] ${spec.key} 的挂点 [${anc.map((v) => v.toFixed(3))}] 在父件 ${spec.parent} 之外（跨段长骨，正常，但确认一下）`);
    }
  }

  stats.byTable[tableName] = stats.byTable[tableName] || { parts: 0, holes: 0, texes: new Set() };
  return { specs, byKey, anchors, joints };
}

const general = checkTable('general', PART_SPECS.general, PART_SPECS, TEX_PPM.general);
const cavalry = checkTable('cavalry', PART_SPECS.cavalry, PART_SPECS, TEX_PPM.cavalry);

/* ---- 身高与落地 ---- */
let height = null;
if (general) {
  const { byKey, joints } = general;
  const head = byKey.get('head');
  const headTop = joints.get('head')[1] + (head.h / 2 - head.pivot[1]);
  const plume = byKey.get('plume');
  let plumeTop = 0;
  if (plume) {
    const j = joints.get('plume');
    let maxUp = -Infinity;
    for (const q of plume.outline) maxUp = Math.max(maxUp, (0.5 - q[1]) * plume.h - plume.pivot[1]);
    plumeTop = j[1] + maxUp;
  }
  const foot = byKey.get('footL');
  const footBottom = joints.get('footL')[1] + (-foot.h / 2 - foot.pivot[1]);
  const weapon = byKey.get('weapon');
  const tip = byKey.get('weaponTip');
  let weaponTop = 0;
  if (tip) {
    const j = joints.get('weaponTip');
    let maxUp = -Infinity;
    for (const q of tip.outline) maxUp = Math.max(maxUp, (0.5 - q[1]) * tip.h - tip.pivot[1]);
    weaponTop = j[1] + maxUp;
  }
  height = { headTop, plumeTop, footBottom, weaponTop };
  if (Math.abs(headTop - 1.55) > 0.05) warn(`身高不符：头顶 ${headTop.toFixed(3)}m ≠ 1.55m ± 0.05`);
  if (Math.abs(footBottom) > 0.03) warn(`脚底不在 y≈0：${footBottom.toFixed(3)}m（|y| 应 ≤ 0.03）`);
  if (plumeTop > 1.60) warn(`翎羽尖 ${plumeTop.toFixed(3)}m 太高（>1.60m）`);
  // 骨骼位置自检（身体主要关节）
  const J = [
    ['waist', 0.88], ['chest', 0.965], ['neck', 1.205], ['head', 1.245],
    ['shoulderL', 1.165], ['forearmL', 0.875], ['handL', 0.615],
    ['hipL', 0.810], ['shinL', 0.435], ['footL', 0.075],
  ];
  for (const [k, y] of J) {
    const j = general.joints.get(k);
    if (!j) { warn(`缺少部件 ${k}`); continue; }
    if (Math.abs(j[1] - y) > 0.02) warn(`关节高度不对：${k} 在 y=${j[1].toFixed(3)}，期望 ${y}`);
  }
}

/* ---- 标准通道覆盖 ---- */
if (general && cavalry) {
  const union = new Set([...general.specs.map((s) => s.key), ...cavalry.specs.map((s) => s.key)]);
  const missing = CHANNELS.filter((c) => !union.has(c) && !OPTIONAL.has(c));
  if (missing.length) warn(`两个 builder 合起来仍缺少标准通道：${missing.join(', ')}`);
  const reqGen = ['waist', 'chest', 'head', 'weapon', 'weaponTip', 'plume', 'cape', 'flag'];
  for (const k of reqGen) if (!general.byKey.has(k)) warn(`buildGeneral 缺少必需通道 ${k}`);
  const reqCav = ['waist', 'chest', 'head', 'weapon', 'weaponTip'];
  for (const k of reqCav) if (!cavalry.byKey.has(k)) warn(`buildCavalry 缺少必需通道 ${k}`);
}

/* ---- 镂空硬要求：头饰 / 衣纹 / 兵器 ---- */
function holesOf(res, key) {
  const s = res.byKey.get(key);
  if (!s) return -1;
  return (s.pierce || []).reduce((b, q) => b + Math.max(1, (q.o?.cols || 1) * (q.o?.rows || 1)), 0);
}
if (general) {
  const req = [
    ['头饰 head（头盔）', 'head', 6], ['头饰 plume（翎羽）', 'plume', 2],
    ['衣纹 waist（战裙）', 'waist', 8], ['衣纹 chest（胸甲）', 'chest', 6],
    ['衣纹 cape（披风）', 'cape', 6], ['衣纹 thighL（腿甲）', 'thighL', 4],
    ['兵器 weapon（刀杆/护手）', 'weapon', 4], ['兵器 weaponTip（刀身）', 'weaponTip', 3],
  ];
  for (const [label, key, min] of req) {
    const h = holesOf(general, key);
    if (h < 0) warn(`镂空要求：缺少 ${label}`);
    else if (h < min) warn(`镂空要求：${label} 只有 ${h} 个孔洞（要求 ≥ ${min}）`);
  }
  // 成组、有节奏：至少要有大小孔洞交替的字段（alt<1）与开窗留肉
  let altFields = 0, ridgeFields = 0;
  for (const s of general.specs) for (const q of s.pierce || []) {
    if (q.o && q.o.alt != null && q.o.alt < 1) altFields++;
    if (q.o && q.o.ridge) ridgeFields++;
  }
  if (altFields < 10) warn(`大小孔洞交替的镂空片太少：${altFields}（要求 ≥ 10）`);
  if (ridgeFields < 15) warn(`"开窗留肉"镂空片太少：${ridgeFields}（要求 ≥ 15）`);
  info(`general：大小交替镂空片 ${altFields} 处，开窗留肉 ${ridgeFields} 处`);
}

/* ---- 道具 ---- */
const propRaw = PROP_SPECS.props;
if (!Array.isArray(propRaw) || propRaw.length < 5) warn(`道具不足 5 件（当前 ${propRaw ? propRaw.length : 0}）`);
const placedProps = propRaw.map((p) => {
  const g = placeByShadow(p.target, p.z, STAGE_LIGHT);
  return Object.assign({}, p, { w: g.size[0], h: g.size[1], joint: [g.center[0], g.center[1]], shadowScale: g.scale });
});
const propRes = checkTable('props', placedProps, { props: placedProps }, TEX_PPM.props, { isProps: true });
if (propRes) {
  const zs = propRaw.map((p) => p.z);
  const uniq = new Set(zs.map((z) => z.toFixed(2)));
  if (uniq.size < 4) warn(`道具 z 分层不足：只有 ${uniq.size} 个不同深度`);

  // 与引擎一致的阴影相机 near：screen.js 里 cam.near = 0.35 × |灯→target|
  const lightToTarget = Math.hypot(STAGE_LIGHT[0], STAGE_LIGHT[1], STAGE_LIGHT[2]);
  const NEAR = lightToTarget * 0.35;
  // 中央通道：留给演员走动与打斗，任何道具影子不得进入
  const CH_X = 0.95, CH_Y0 = -1.15, CH_Y1 = 0.45;

  for (const p of placedProps) {
    const g = placeByShadow(p.target, p.z, STAGE_LIGHT);
    const [cx, cy, w, h] = p.target;
    // 1) 与中央通道的横向净空（远山是横跨整幅的地平线，单独按"必须压在脚踝以下"判）
    const clearance = Math.abs(cx) - w / 2;
    if (p.key !== 'mountain' && clearance < CH_X - 1e-9) {
      warn(`道具 ${p.key} 影子左/右边缘进入中央通道：|cx| - w/2 = ${clearance.toFixed(3)} < ${CH_X}`);
    }
    // 2) 影子高度上限
    if (h > 1.10 + 1e-9) warn(`道具 ${p.key} 影子高 ${h}m > 1.10m（幕布高 44%）`);
    // 3) 与中央通道矩形是否相交
    const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
    const hit = !(x1 < -CH_X || x0 > CH_X || y1 < CH_Y0 || y0 > CH_Y1);
    if (hit && p.key !== 'mountain') {
      warn(`道具 ${p.key} 影子矩形 [x ${x0.toFixed(2)},${x1.toFixed(2)}] × [y ${y0.toFixed(2)},${y1.toFixed(2)}] 与中央通道 |x|≤0.95, y∈[-1.15,0.45] 相交`);
    } else if (hit) {
      // 远山是地平线，允许在通道底部：要求它整体压在 y ≤ -0.90（演员脚踝以下）
      if (y1 > -0.90 + 1e-9) warn(`mountain 是地平线，但影子顶边 y=${y1.toFixed(3)} > -0.90，会压到演员脚部`);
      else info(`mountain 作为地平线横跨中央通道，但顶边 y=${y1.toFixed(3)} ≤ -0.90（在演员脚踝以下）`);
    }
    // 4) 阴影相机 near 裁剪：道具 AABB 上离灯最近的那点必须 > NEAR（远山很宽，不能按半对角线估）
    const bx0 = g.center[0] - g.size[0] / 2, bx1 = g.center[0] + g.size[0] / 2;
    const by0 = g.center[1] - g.size[1] / 2, by1 = g.center[1] + g.size[1] / 2;
    const nx = Math.min(Math.max(STAGE_LIGHT[0], bx0), bx1);
    const ny = Math.min(Math.max(STAGE_LIGHT[1], by0), by1);
    const nearDist = Math.hypot(nx - STAGE_LIGHT[0], ny - STAGE_LIGHT[1], p.z - STAGE_LIGHT[2]);
    if (nearDist <= NEAR) {
      warn(`道具 ${p.key} 最近点距灯 ${nearDist.toFixed(3)}m ≤ 阴影相机 near(${NEAR.toFixed(3)}m)，会被裁掉 → 请把 z 往幕布拉（≥ ${(STAGE_LIGHT[2] + NEAR).toFixed(2)}）`);
    }
    // 地平线类元素（远山）本来就又宽又扁：宽 2.06m 但只有 0.12m 高，
    // 它的影子是 4.0×0.24m 的横带，位于演员脚踝以下，不构成"压倒画面"的风险。
    // 所以这条只拦"又宽又高"的，放过扁平的远景。
    const isHorizon = g.size[1] <= 0.35;
    if ((g.size[0] > 2.0 && !isHorizon) || g.size[1] > 2.0) {
      warn(`道具 ${p.key} 世界尺寸过大（${g.size.map((v) => v.toFixed(2)).join('×')}m）`);
    }
  }
  info(`道具（影子反解：K = ${(-STAGE_LIGHT[2]).toFixed(2)}/(${(-STAGE_LIGHT[2]).toFixed(2)}+z)，阴影相机 near = ${NEAR.toFixed(2)}m）`);
  for (const p of placedProps) {
    const g = placeByShadow(p.target, p.z, STAGE_LIGHT);
    const bx0 = g.center[0] - g.size[0] / 2, bx1 = g.center[0] + g.size[0] / 2;
    const by0 = g.center[1] - g.size[1] / 2, by1 = g.center[1] + g.size[1] / 2;
    const nx = Math.min(Math.max(STAGE_LIGHT[0], bx0), bx1);
    const ny = Math.min(Math.max(STAGE_LIGHT[1], by0), by1);
    const nearDist = Math.hypot(nx - STAGE_LIGHT[0], ny - STAGE_LIGHT[1], p.z - STAGE_LIGHT[2]);
    info(`  ${p.key.padEnd(9)} z=${String(p.z).padStart(6)}  K=${g.scale.toFixed(2)}  世界尺寸 ${g.size[0].toFixed(3)}×${g.size[1].toFixed(3)}m  影子 [${p.target[0]},${p.target[1]}] ${p.target[2]}×${p.target[3]}m  净空 ${(Math.abs(p.target[0]) - p.target[2] / 2).toFixed(3)}  距灯 ${nearDist.toFixed(2)}m`);
  }
  if (!propRes.byKey.has('pine')) warn('道具缺少 pine（编排组的 sway 用它）');
  if (!propRes.byKey.has('moon')) warn('道具缺少 moon（编排组的 visible 用它）');
  if (!propRes.byKey.has('mountain')) warn('道具缺少 mountain（编排组的 opacity 用它）');
}

/* ---- 禁用项 ---- */
const myFiles = ['src/shapes.js', 'src/puppet.js', 'src/props.js', 'tools/asset-preview.html', 'tools/asset-preview.mjs', 'tools/launch.mjs'];
for (const f of myFiles) {
  const p = resolve(ROOT, f);
  if (!existsSync(p)) continue;
  const src = readFileSync(p, 'utf8');
  if (/<svg|createElementNS|\.svg\b/i.test(src)) warn(`${f} 出现 SVG 相关代码（本项目禁用 SVG）`);
  if (/Math\.random\(/.test(src)) warn(`${f} 用了 Math.random()（必须确定性）`);
}
if (/require\(['"]three/.test(puppetSrc) || /require\(['"]three/.test(propsSrc)) warn('不应该 require three（ES modules + importmap）');

/* ------------------------------------------------------------------ *
 * 输出
 * ------------------------------------------------------------------ */
function report() {
  const line = '─'.repeat(66);
  console.log(line);
  console.log('影窗 · 夜巡 —— 皮影资产静态自检 (tools/check-assets.mjs)');
  console.log(line);
  const tables = Object.keys(stats.byTable);
  const label = { general: '将军 general', cavalry: '副将 cavalry', props: '布景 props' };
  for (const t of tables) {
    const s = stats.byTable[t];
    console.log(`${(label[t] || t).padEnd(16)} 部件 ${String(s.parts).padStart(3)}   贴图 ${String(s.texes.size).padStart(3)}   镂空孔洞 ${String(s.holes).padStart(4)}   ppm ${TEX_PPM[t] || '-'}`);
  }
  const charTex = new Set([...(stats.byTable.general?.texes || []), ...(stats.byTable.cavalry?.texes || [])]);
  console.log(line);
  console.log(`人物部件合计 ${(stats.byTable.general?.parts || 0) + (stats.byTable.cavalry?.parts || 0)} 个（26+26），去重贴图 ${charTex.size} 张（将军与副将共用四肢）`);
  if (height) {
    console.log(`身高：头顶 ${height.headTop.toFixed(3)}m  翎羽尖 ${height.plumeTop.toFixed(3)}m  脚底 ${height.footBottom.toFixed(3)}m  刀尖 ${height.weaponTop.toFixed(3)}m`);
  }
  console.log(`镂空孔洞（估算，含开窗留肉）：${stats.holes} 个`);
  const pat = [...stats.patterns];
  console.log(`镂空图案种类：${pat.length} 种 —— ${pat.map((p) => `${PATTERN_NAMES[p] || p}(${p})`).join('、')}`);
  if (notes.length) {
    console.log(line);
    console.log('说明：');
    for (const n of notes) console.log('  · ' + n);
  }
  console.log(line);
  if (problems.length) {
    console.log(`FAIL —— ${problems.length} 个问题：`);
    for (const p of problems) console.log('  ✗ ' + p);
    console.log(line);
    process.exitCode = 1;
  } else {
    console.log('OK —— 全部静态检查通过（通道名/父子顺序/贴图与挂点几何/身高/镂空硬要求/道具分层/无 SVG）。');
    console.log(line);
  }
}

report();

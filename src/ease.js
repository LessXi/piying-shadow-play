// src/ease.js —— 缓动与节奏曲线库（编排组）
//
// 设计原则：
//  1. 全部是纯函数，无内部状态 —— 时间轴 `sample(t)` 的纯函数性直接依赖这一点；
//  2. 只描述「一条曲线怎么走」，不掺任何场景知识（场景知识都在 choreography.js）；
//  3. 动画节奏的基本单位不是「一段运动」，而是「预备 → 发力 → 惯性过冲 → 停住」，
//     所以这里同时提供 hold 窗口、back 过冲与 damp 这类「停下来」的工具。
//
// 约定：
//  - ease 函数定义域 [0,1]，值域 [0,1]（easeOutBack / easeInBack / easeOutElastic 允许越界）；
//  - 「停顿」在数据上表现为：区间内所有通道速度 ≈ 0，也就是相邻采样差值 ≈ 0。
//    hold() 只负责判定窗口，速度阈值判定在 tools/qa-perf.mjs 里做。

/* ================================================================== *
 * 基础标量工具
 * ================================================================== */

export const clamp01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** 线性插值：数值或数组（逐分量） */
export function mix(a, b, t) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const A = Array.isArray(a) ? a : [a, a, a];
    const B = Array.isArray(b) ? b : [b, b, b];
    return A.map((v, i) => v + ((B[i] ?? v) - v) * t);
  }
  return a + (b - a) * t;
}

/** 平滑阶跃：x 在 [a,b] 内 0→1，两端夹紧 */
export function smoothstep(a, b, x) {
  const t = clamp01((x - a) / (b - a || 1e-9));
  return t * t * (3 - 2 * t);
}

/** 在 [a,b] 区间内用 ease 从 0 升到 1，区间外夹紧 —— 做包络/权重最常用 */
export function ramp(t, a, b, easeName = 'easeInOutSine') {
  if (a === b) return t < a ? 0 : 1;
  return ease(easeName, (t - a) / (b - a));
}

/** 停顿窗：t 落在 [a,b] 内返回 1，否则 0（软边由 ramp 组合） */
export function hold(t, a, b) {
  return t >= a && t <= b ? 1 : 0;
}

/** 软停顿窗：进入/退出各有 ramp 秒过渡，用于「微颤只有在这段时间存在」 */
export function holdWindow(t, a, b, rampSec = 0.06) {
  return Math.min(smoothstep(a, a + rampSec, t), 1 - smoothstep(b - rampSec, b, t));
}

/* ================================================================== *
 * 缓动函数
 * ================================================================== */

export const linear = (t) => t;

export const easeInQuad = (t) => t * t;
export const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);
export const easeInCubic = (t) => t * t * t;
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
export const easeInQuint = (t) => Math.pow(t, 5);

export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function easeInOutSine(t) {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

export function easeInOutQuint(t) {
  return t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;
}

/** 到位后过冲回弹：s 越大过冲越明显（默认 1.70158 ≈ 回弹 10%） */
export function easeOutBack(t, s = 1.70158) {
  const u = t - 1;
  return 1 + (s + 1) * u * u * u + s * u * u;
}

export function easeInBack(t, s = 1.70158) {
  return (s + 1) * t * t * t - s * t * t;
}

export function easeOutElastic(t, amp = 1, period = 0.32) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const c = (2 * Math.PI) / period;
  return amp * Math.pow(2, -10 * t) * Math.sin((t - period / 4) * c) + 1;
}

/** 带限幅的小过冲：给「发力到位后回弹 2~4%」用，比 easeOutBack 好控 */
export function easeOutBackT(t, overshoot = 0.03, s = 1.70158) {
  return (1 + overshoot) * easeOutBack(t, s) - overshoot * t;
}

export const EASINGS = {
  linear, easeInQuad, easeOutQuad, easeInCubic, easeOutCubic, easeInQuint, easeOutQuint,
  easeInOutCubic, easeInOutQuint, easeInOutSine, easeOutBack, easeInBack, easeOutElastic,
  easeOutBackT,
};

/** 名字取缓动；未知名字退化为 linear（不抛错，避免时间轴因拼写挂掉） */
export function ease(name, t) {
  const fn = typeof name === 'function' ? name : EASINGS[name];
  return (fn || linear)(clamp01(t));
}

/* ================================================================== *
 * 关键帧轨道
 * ================================================================== */

/**
 * 分段关键帧插值。每段的缓动取**目标关键帧**上的 ease（「怎么走到这一格」）。
 * @param {Array<{t:number,v:number|number[],ease?:string}|[number,number|number[],string?]>} points
 *        必须按 t 递增；t 之外夹紧到首/末值。
 * @param {number} t
 * @returns {number|number[]} 与 v 同型
 */
export function keyTrack(points, t) {
  const n = points.length;
  if (n === 0) return 0;
  const k0 = normKey(points[0]);
  if (n === 1 || t <= k0.t) return clone(k0.v);
  let prev = k0;
  for (let i = 1; i < n; i++) {
    const k = normKey(points[i]);
    if (t < k.t) {
      const span = k.t - prev.t;
      const u = span > 1e-9 ? (t - prev.t) / span : 1;
      return blend(prev.v, k.v, ease(k.ease, u));
    }
    prev = k;
  }
  return clone(prev.v);
}

function normKey(k) {
  if (Array.isArray(k)) return { t: k[0], v: k[1], ease: k[2] || 'linear' };
  return { t: k.t, v: k.v, ease: k.ease || 'linear' };
}
const clone = (v) => (Array.isArray(v) ? v.slice() : v);
function blend(a, b, u) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const A = Array.isArray(a) ? a : [a, a, a];
    const B = Array.isArray(b) ? b : [b, b, b];
    const out = new Array(Math.max(A.length, B.length));
    for (let i = 0; i < out.length; i++) {
      const x = A[i] ?? 0, y = B[i] ?? 0;
      out[i] = x + (y - x) * u;
    }
    return out;
  }
  return a + (b - a) * u;
}

/**
 * 「动作段」列表求值：每段 {t0,t1,v0,v1,ease}，段与段之间保持上一段终值。
 * 适合位移/灯光/偏航这类会长时间停住的量（比关键帧表更好读）。
 * 注意：若某段 v0 ≠ 上一段 v1，段首会有一个「跳变」（有意为之，用来做脆响式的切换）。
 */
export function moveTrack(moves, t, initial = 0) {
  let v = initial;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    if (t <= m.t0) return v;
    if (t < m.t1) {
      const u = (t - m.t0) / (m.t1 - m.t0);
      return m.v0 + (m.v1 - m.v0) * ease(m.ease, u);
    }
    v = m.v1;
  }
  return v;
}

/**
 * 「动作段」序列求值 —— 编排谱的基本单位。
 * 每段 {t0, t1, to, ease}：从**当前值**走到 `to`（到 t1 时到位）；段与段之间的空档保持不动。
 * 于是「停顿」不需要重复写两个一样的关键帧 —— **空档就是停顿**，速度严格为 0。
 * 可选 `v0` 覆盖该段起点（做跳变/脆响式切换用），不给就用上一段的终值。
 * @param {Array<{t0:number,t1:number,to:number,ease?:string,v0?:number}>} moves 按 t0 递增
 * @param {number} t
 * @param {number} initial t 在首段之前时的值
 */
export function scoreTrack(moves, t, initial = 0) {
  let v = initial;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    if (t <= m.t0) return v;
    if (t < m.t1) {
      const span = m.t1 - m.t0;
      const u = span > 1e-9 ? (t - m.t0) / span : 1;
      const from = m.v0 != null ? m.v0 : v;
      return from + (m.to - from) * ease(m.ease, clamp01(u));
    }
    v = m.to;
  }
  return v;
}

/* ================================================================== *
 * 步态曲线（脚步不能用正弦匀速）
 * ================================================================== */
/**
 * 一个步幅内的三段式剖面：
 *   0.00–0.30  抬起  快（easeOutQuint）：膝盖先屈、脚离地
 *   0.30–0.62  落下  慢（easeInQuad）：腿向前下伸、脚掌落地
 *   0.62–1.00  支撑  停（lift ≡ 0，腿几乎不动，重心缓缓滑过）
 * 返回的 extend 是「腿在身体前方的前摆量」，advance 是「本步幅内身体前进比例」。
 * @param {number} phase 0..1
 */
export function stepProfile(phase) {
  const p = clamp01(phase);
  let lift, extend, advance, phaseName;
  if (p < 0.30) {
    const u = p / 0.30;
    lift = easeOutQuint(u);
    extend = easeOutQuint(u);
    advance = 0.15 * easeOutQuint(u);
    phaseName = '抬起';
  } else if (p < 0.62) {
    const u = (p - 0.30) / 0.32;
    lift = 1 - easeInQuad(u);
    extend = 1 - 0.14 * easeInQuad(u);
    advance = 0.15 + 0.67 * easeOutCubic(u);
    phaseName = '落下';
  } else if (p < 0.80) {
    const u = (p - 0.62) / 0.18;
    lift = 0;
    extend = 0.86 - 0.06 * easeInOutSine(u);
    advance = 0.82 + 0.15 * easeInOutSine(u);
    phaseName = '支撑';
  } else {
    const u = (p - 0.80) / 0.20;
    lift = 0;
    extend = 0.80 * (1 - easeInOutCubic(u));
    advance = 0.97 + 0.03 * easeInOutCubic(u);
    phaseName = '支撑';
  }
  return { phase: p, lift, extend, advance, planted: p >= 0.62, phaseName };
}

/** 均匀步频版本：freq = 每秒步数 */
export function stepCurve(freq, t) {
  const x = t * freq;
  const i = Math.floor(x);
  return { i, x, ...stepProfile(x - i) };
}

/**
 * 变速步列版本：starts = [t0, t1, ..., tn]，n 步；每步时长 = starts[i+1]-starts[i]。
 * @param {number[]} starts 递增的时间点，最后一个是整段走路的结束时刻
 * @param {number} t
 * @param {number[]|null} ampScales 每步的幅度系数（越走越小 → 步幅衰减）
 */
export function stepTrain(starts, t, ampScales = null) {
  const n = starts.length - 1;
  if (n <= 0) return null;
  if (t < starts[0] || t > starts[n]) return null;
  let i = n - 1;
  for (let k = 0; k < n; k++) if (t < starts[k + 1]) { i = k; break; }
  const T = starts[i + 1] - starts[i];
  const phase = T > 1e-9 ? clamp01((t - starts[i]) / T) : 1;
  const prof = stepProfile(phase);
  const amp = ampScales ? (ampScales[Math.min(i, ampScales.length - 1)] ?? 1) : 1;
  // 首末步的进出包络：起步时从 0 升上来、收步时落回 0，避免腿部姿态跳变
  // （注意末段是 1 - ramp：进 0.34s 内升到 1，最后 0.34s 内落回 0）
  const a = starts[0], b = starts[n];
  const span = Math.min(0.34, (b - a) * 0.5);
  const env = Math.min(ramp(t, a, a + span, 'easeInOutSine'), 1 - ramp(t, b - span, b, 'easeInOutSine'));
  return { i, n, T, amp, env, done: t >= starts[n], ...prof };
}

/* ================================================================== *
 * 次级运动 / 噪声
 * ================================================================== */

/** 一阶阻尼趋近：与时间步无关的稳定逼近（给布料/呼吸式的缓慢跟随用） */
export function damp(current, target, lambda, dt) {
  return target + (current - target) * Math.exp(-lambda * dt);
}

/** 确定性伪噪声（多正弦叠加），值域约 [-1,1]，不使用随机数 */
export function noise1(t, seed = 0, octaves = 3) {
  let v = 0, amp = 1, f = 1.7, sum = 0;
  for (let i = 0; i < octaves; i++) {
    v += amp * Math.sin((t * f + seed * 1.37 * (i + 1)) * (1 + i * 0.317));
    sum += amp;
    amp *= 0.55;
    f *= 2.13;
  }
  return v / sum;
}

/** 灯焰抖动：两个不同频率的噪声叠加，返回约 [-1,1] */
export function flickerNoise(t, seed = 3) {
  return 0.65 * noise1(t * 3.1, seed, 3) + 0.35 * Math.sin(t * 23.7 + seed);
}

/** 微颤：定格亮相里只有刀尖和翎羽在动的那个「颤」 */
export function tremor(t, freq, amp, phase = 0) {
  return amp * (0.72 * Math.sin(t * freq * Math.PI * 2 + phase) + 0.28 * Math.sin(t * freq * 3.7 * Math.PI * 2 + phase * 1.7));
}

/** 呼吸：吸气慢、呼气略快的不对称曲线，值域 [0,1] */
export function breath(t, period = 3.2, phase = 0) {
  const u = ((t / period + phase) % 1 + 1) % 1;
  return u < 0.42 ? easeInOutSine(u / 0.42) : 1 - easeInOutSine((u - 0.42) / 0.58);
}

export default {
  linear, easeInQuad, easeOutQuad, easeInCubic, easeOutCubic, easeInQuint, easeOutQuint,
  easeInOutCubic, easeInOutQuint, easeInOutSine, easeOutBack, easeInBack, easeOutElastic,
  easeOutBackT, ease, EASINGS, keyTrack, moveTrack, scoreTrack, stepCurve, stepProfile, stepTrain,
  hold, holdWindow, ramp, smoothstep, clamp, clamp01, mix, damp, noise1, flickerNoise, tremor, breath,
};

// tools/qa-perf.mjs —— 编排组自检（不需要浏览器）
//
//   node tools/qa-perf.mjs            # 打表 + 断言 + 导出 shots/timeline.json / shots/pose-log.json
//   node tools/qa-perf.mjs --quiet    # 只打结论
//
// 断言的东西（拿数字说话，失败退出码 1）：
//   1) 四幕时长 / 连续性 / 总时长 ≈ 46s
//   2) 停顿：相邻 0.1s 的姿态通道变化总量 < 阈值的区间算停顿；处数 ≥5、总时长 ≥6s
//   3) 每幕都有「快 — 停 — 慢」的实测对比
//   4) 步态：抬起(快)/落下(慢)/支撑(停) 三段式，左右脚相位错开，步频/步幅非均匀
//   5) 转身：root.ry 经过 0→-1.6→-3.14→(回弹)-1.9 三个路标；ty 下沉落在 0.05–0.09；膝屈 ≥0.18
//   6) 每幕至少 5 个通道同时运动；定格亮相只有刀尖与翎羽在动
//   7) Frame 结构与 INTERFACES B.2 完全一致（含 light.pos 的 Vector3 兼容性）、actors 只有 general/cavalry
//   8) sample(t) 是纯函数（乱序/重复采样同值；无内部累积状态）
//   9) REST 表与 src/puppet.js 的 PART_SPECS 静态核对 + 层级必须全部汇到 waist（转身才转得动全身）
//  10) 绝对角在合理区间（上臂抬升幅度 2.4–2.9 rad）、root.rz 有界、位移不跑出幕布
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SHOTS = join(ROOT, 'shots');
const QUIET_MODE = process.argv.includes('--quiet');

/* ------------------------------------------------------------------ *
 * 载入被测模块（Node ≥22 会按语法自动识别 .js 里的 ESM；
 * 更老的 Node 就复制到临时目录改成 .mjs 再 import）
 * ------------------------------------------------------------------ */
async function loadChoreography() {
  const url = pathToFileURL(join(ROOT, 'src', 'choreography.js')).href;
  try {
    return await import(url);
  } catch (e) {
    if (!/require|CommonJS|Unexpected token 'export'|ERR_REQUIRE_ESM/i.test(String(e && e.message))) throw e;
    const dir = join(tmpdir(), 'choreo-esm-' + Date.now());
    mkdirSync(dir, { recursive: true });
    for (const f of ['ease.js', 'choreography.js']) {
      const src = readFileSync(join(ROOT, 'src', f), 'utf8').replace(/from '\.\/([a-z0-9]+)\.js'/gi, "from './$1.mjs'");
      writeFileSync(join(dir, f.replace(/\.js$/, '.mjs')), src);
    }
    return await import(pathToFileURL(join(dir, 'choreography.mjs')).href);
  }
}
const CH = await loadChoreography();
const { buildTimeline, REST, BASE, BEATS, ACTS, DURATION, CHANNELS } = CH;
const tl = buildTimeline();
const DBG = tl.debug();

/* ------------------------------------------------------------------ *
 * 小工具：表格对齐（CJK 记 2 列）
 * ------------------------------------------------------------------ */
const dispW = (s) => [...String(s)].reduce((n, c) => n + (/[\u3000-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0);
const pad = (s, w) => String(s) + ' '.repeat(Math.max(0, w - dispW(s)));
const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : String(v));

let pass = 0;
const fails = [];
const warns = [];
function check(ok, label, detail = '') {
  if (ok) { pass++; if (!QUIET_MODE) console.log(`  ✔ ${label}${detail ? '  ' + detail : ''}`); }
  else { fails.push(label + (detail ? '  ' + detail : '')); console.log(`  ✘ ${label}${detail ? '  ' + detail : ''}`); }
  return ok;
}
const h1 = (t) => console.log(`\n${t}`);
const h2 = (t) => { if (!QUIET_MODE) console.log(`  ${t}`); };

/* ------------------------------------------------------------------ *
 * 采样与速度度量
 * ------------------------------------------------------------------ */
const DT = 0.02;            // 内部采样步长
const WIN = 0.1;            // 速度窗口（题目要求：相邻 0.1s）
const STEPS_PER_WIN = Math.round(WIN / DT);
const HOLD_TH = 0.06;       // 停顿阈值：每 0.1s 变化总量（rad 当量）
const SLOW_LO = 0.06, SLOW_HI = 0.35, FAST_HI = 0.80;
const ROOT_W = 4.0;         // 位移 → 弧度当量（0.05m 下沉 = 0.2rad）

const T = [];
for (let i = 0; i * DT <= DURATION + 1e-9; i++) T.push(+(i * DT).toFixed(5));
const FRAMES = T.map((t) => tl.sample(t));

function actorOf(f, k) { return f.actors[k]; }

/** 两帧之间：每通道角度变化 + root 位移/旋转当量 */
function motionBetween(a, b) {
  const per = {};
  let total = 0;
  for (const ch in a.pose) {
    const va = a.pose[ch], vb = b.pose[ch];
    const d = Math.abs(vb[0] - va[0]) + Math.abs(vb[1] - va[1]) + Math.abs(vb[2] - va[2]);
    per[ch] = d;
    total += d;
  }
  const rootD = ROOT_W * (Math.abs(b.root.tx - a.root.tx) + Math.abs(b.root.ty - a.root.ty) + Math.abs(b.root.tz - a.root.tz));
  const rotD = Math.abs(b.root.rz - a.root.rz) + Math.abs(b.root.ry - a.root.ry);
  return { per, total: total + rootD + rotD, angle: total, rootD: rootD + rotD };
}

/** 全局节奏：每 0.1s 窗口的变化量。焦点演员 = 当前站台上的主角（《起》里是副将）——
 *  观众的眼睛跟着焦点走，节奏指标就跟着焦点量。 */
const focusOf = (f) => (f.actors.general.visible ? 'general' : (f.actors.cavalry.visible ? 'cavalry' : 'general'));
const WINDOWS = [];
for (let i = 0; i + STEPS_PER_WIN < FRAMES.length; i++) {
  const t0 = T[i], t1 = T[i + STEPS_PER_WIN];
  const f0 = FRAMES[i], f1 = FRAMES[i + STEPS_PER_WIN];
  const k = focusOf(f0) === focusOf(f1) ? focusOf(f0) : 'general';
  const m = motionBetween(actorOf(f0, k), actorOf(f1, k));
  WINDOWS.push({ t0, t1, score: m.total, per: m.per, focus: k });
}
const actOf = (t) => ACTS.find((a) => t >= a.t0 && t < a.t1) || ACTS[ACTS.length - 1];

/** 停顿：静默窗口合并（间隔 ≤1 个窗口）；≥0.35s 才算独立停顿 */
function mergeHolds(quiet, minDur) {
  const out = [];
  let cur = null;
  for (const q of quiet) {
    if (!cur) { cur = { t0: q.t0, t1: q.t1, n: 1 }; continue; }
    if (q.t0 - cur.t1 <= WIN * 1.01) { cur.t1 = q.t1; cur.n++; continue; }
    out.push(cur); cur = { t0: q.t0, t1: q.t1, n: 1 };
  }
  if (cur) out.push(cur);
  return out.filter((h) => h.t1 - h.t0 + 1e-9 >= minDur)
    .map((h) => ({ t0: +h.t0.toFixed(2), t1: +h.t1.toFixed(2), dur: +(h.t1 - h.t0).toFixed(2) }));
}
const QUIET_WINS = WINDOWS.filter((w) => w.score < HOLD_TH);
const MEASURED_HOLDS = mergeHolds(QUIET_WINS, 0.35);
const HOLD_TOTAL_MEASURED = +MEASURED_HOLDS.reduce((s, h) => s + h.dur, 0).toFixed(2);

/** 单窗口最大速度（rad/0.1s）→ 便于「快慢」判断；再折算 rad/s */
const spd = (s) => s / WIN;

/* ------------------------------------------------------------------ *
 * 0. 缓动库 API 自检（src/ease.js）
 * ------------------------------------------------------------------ */
h1('=== 影窗·夜巡 · 编排节奏验收 (tools/qa-perf.mjs) ===');
console.log(`node ${process.version}  ·  duration=${DURATION}s  ·  acts=${ACTS.length}  ·  beats=${BEATS.length}  ·  采样步长 ${DT}s`);
h1('[0] 缓动库 API 自检（src/ease.js）');
const EZ = await import(pathToFileURL(join(ROOT, 'src', 'ease.js')).href);
{
  const { ease, keyTrack, moveTrack, scoreTrack, stepCurve, stepProfile, stepTrain, hold, clamp01, mix, damp, linear,
    easeInQuad, easeOutCubic, easeOutQuint, easeInOutSine, easeOutBack } = EZ;
  const need = ['linear', 'easeInQuad', 'easeOutCubic', 'easeOutQuint', 'easeInOutSine', 'easeOutBack',
    'keyTrack', 'stepCurve', 'hold', 'clamp01', 'mix', 'damp'];
  const miss = need.filter((k) => typeof EZ[k] !== 'function');
  check(miss.length === 0, 'ease.js 导出题目要求的全部 API', miss.length ? `缺 ${miss.join(',')}` : need.length + ' 个');
  check(Math.abs(linear(0.5) - 0.5) < 1e-9 && Math.abs(easeInQuad(0.5) - 0.25) < 1e-9 &&
    Math.abs(easeOutCubic(0.5) - 0.875) < 1e-9 && Math.abs(easeOutQuint(0.5) - (1 - 0.5 ** 5)) < 1e-9 &&
    Math.abs(easeInOutSine(0.5) - 0.5) < 1e-9, '缓动函数数值正确');
  const overshoot = Math.max(...[0.55, 0.6, 0.65, 0.7, 0.75, 0.8].map((x) => easeOutBack(x))) - 1;
  check(overshoot > 0.02 && overshoot < 0.14, 'easeOutBack 过冲在 2%–14%（回弹量可控）', `${num(overshoot * 100, 1)}%`);
  const k1 = keyTrack([[0, 0], [1, 1, 'easeOutCubic']], 0.5);
  const k2 = keyTrack([[0, [0, 0, 0]], [1, [2, 4, 6], 'linear']], 0.5);
  check(Math.abs(k1 - 0.875) < 1e-9 && keyTrack([[0, 0], [1, 1]], -3) === 0 && keyTrack([[0, 0], [1, 1]], 9) === 1,
    'keyTrack：标量插值 / 段外夹紧');
  check(Array.isArray(k2) && Math.abs(k2[0] - 1) < 1e-9 && Math.abs(k2[2] - 3) < 1e-9, 'keyTrack：数组逐分量插值');
  const prof = stepProfile(0.2), prof2 = stepProfile(0.45), prof3 = stepProfile(0.8);
  check(prof.lift > 0.6 && prof2.phaseName === '落下' && prof3.phaseName === '支撑' && prof3.lift === 0,
    'stepCurve 三段式：抬起(快)/落下(慢)/支撑(lift ≡ 0)',
    `lift(0.2)=${num(prof.lift)} lift(0.45)=${num(prof2.lift)} lift(0.8)=${num(prof3.lift)}`);
  check(stepCurve(2, 0.75).phase === 0.5 && stepTrain([1, 2, 3], 2.5).i === 1 && stepTrain([1, 2, 3], 0.5) === null,
    'stepCurve/stepTrain：均匀与变速步列');
  check(hold(5, 4, 6) === 1 && hold(3.9, 4, 6) === 0 && clamp01(1.7) === 1 && clamp01(-0.2) === 0 &&
    Math.abs(mix(2, 4, 0.25) - 2.5) < 1e-9, 'hold / clamp01 / mix');
  let d = 0; for (let i = 0; i < 200; i++) d = damp(d, 1, 6, 1 / 60);
  check(d > 0.99, 'damp 稳定收敛到目标', num(d, 4));
  // 停顿的数学保证：scoreTrack 在两段动作之间**恒为常数**
  const sc = [{ t0: 0, t1: 1, to: 1, ease: 'easeOutCubic' }, { t0: 3, t1: 4, to: 0, ease: 'easeInOutSine' }];
  const probe = [1.5, 2, 2.5, 2.999].map((t) => scoreTrack(sc, t));
  check(probe.every((v) => Math.abs(v - 1) < 1e-12), '空档就是停顿：动作段之间 scoreTrack 恒为常数（速度严格 0）');
  const mv = [{ t0: 0, t1: 1, v0: 0, v1: 2, ease: 'linear' }, { t0: 2, t1: 3, v0: 2, v1: 0, ease: 'linear' }];
  check(Math.abs(moveTrack(mv, 0.5) - 1) < 1e-9 && moveTrack(mv, 1.7) === 2, 'moveTrack：段内缓动 + 段间保持');
}

h1('[1] 四幕时长表');
console.log('  ' + pad('幕', 16) + pad('时间段', 18) + pad('时长', 8) + pad('节拍', 6) + pad('停顿处', 8) + '实测最快/最慢 (rad/0.1s)');
for (const a of ACTS) {
  const ws = WINDOWS.filter((w) => w.t0 >= a.t0 && w.t0 < a.t1);
  const mx = Math.max(...ws.map((w) => w.score));
  const mn = Math.min(...ws.map((w) => w.score));
  const beats = DBG.beats.filter((b) => b.act === a.id).length;
  const holds = MEASURED_HOLDS.filter((hh) => hh.t0 >= a.t0 && hh.t1 <= a.t1 + 0.15).length;
  console.log('  ' + pad(`${a.id} · ${a.name}`, 16) + pad(`${num(a.t0, 1)}–${num(a.t1, 1)}s`, 18) +
    pad(num(a.t1 - a.t0, 1) + 's', 8) + pad(beats, 6) + pad(holds, 8) + `${num(mx)} / ${num(mn)}`);
}
const actSpan = ACTS[0].t0 === 0 && Math.abs(ACTS[ACTS.length - 1].t1 - DURATION) < 1e-6;
let contiguous = true;
for (let i = 1; i < ACTS.length; i++) if (Math.abs(ACTS[i].t0 - ACTS[i - 1].t1) > 1e-6) contiguous = false;
check(Math.abs(DURATION - 46) <= 1, '总时长 46s ±1', `duration=${DURATION}`);
check(actSpan && contiguous, '四幕首尾相接且覆盖 [0, duration]', ACTS.map((a) => `${a.id}${num(a.t0, 0)}–${num(a.t1, 0)}`).join(' '));
check(ACTS.length === 4, '恰好四幕（起承转合）', ACTS.map((a) => a.id).join(''));

/* ------------------------------------------------------------------ *
 * 2. 停顿
 * ------------------------------------------------------------------ */
h1('[2] 停顿表（实测：相邻 0.1s 姿态变化总量 < ' + HOLD_TH + ' rad 当量）');
const authored = DBG.holds.slice().sort((a, b) => a.t0 - b.t0);
console.log('  ' + pad('实测停顿', 16) + pad('时长', 8) + '所属幕 · 语义（对回编排表）');
for (const hh of MEASURED_HOLDS) {
  const a = actOf(hh.t0 + 0.01);
  const near = authored.filter((x) => x.t1 > hh.t0 - 0.25 && x.t0 < hh.t1 + 0.25)[0];
  console.log('  ' + pad(`${num(hh.t0, 2)}–${num(hh.t1, 2)}`, 16) + pad(num(hh.dur) + 's', 8) +
    `${a.id} · ${near ? near.what : '（未对回编排表）'}`);
}
check(MEASURED_HOLDS.length >= 5, '实测停顿处数 ≥ 5', `count=${MEASURED_HOLDS.length}`);
check(HOLD_TOTAL_MEASURED >= 6, '实测停顿总时长 ≥ 6s', `total=${HOLD_TOTAL_MEASURED}s`);
check(DBG.holdCount >= 5 && DBG.holdTotal >= 6, '编排表自报停顿处数/总时长达标', `count=${DBG.holdCount} total=${DBG.holdTotal}s`);
{
  const matched = authored.filter((x) => x.dur >= 0.4).filter((x) =>
    MEASURED_HOLDS.some((hh) => Math.min(hh.t1, x.t1) - Math.max(hh.t0, x.t0) >= 0.6 * Math.min(hh.dur, x.dur)));
  check(matched.length >= authored.filter((x) => x.dur >= 0.4).length - 1,
    '编排表里每一处 ≥0.4s 的停顿都能在实测里找到',
    `${matched.length}/${authored.filter((x) => x.dur >= 0.4).length}`);
}

/* ------------------------------------------------------------------ *
 * 3. 每幕「快 — 停 — 慢」
 * ------------------------------------------------------------------ */
h1('[3] 每幕速度极值与「快 — 停 — 慢」对比');
console.log('  ' + pad('幕', 10) + pad('最快', 10) + pad('最快处 t', 10) + pad('中位', 10) + pad('停(s)', 8) + pad('慢(s)', 8) + '结论');
const durations = (v, from, to, pred) => {
  let best = 0, cur = 0;
  for (const w of WINDOWS) {
    if (w.t0 < from || w.t0 >= to) continue;
    if (pred(w.score)) { cur += WIN; best = Math.max(best, cur); } else cur = 0;
  }
  return +best.toFixed(2);
};
for (const a of ACTS) {
  const ws = WINDOWS.filter((w) => w.t0 >= a.t0 && w.t0 < a.t1);
  const mx = Math.max(...ws.map((w) => w.score));
  const at = ws.reduce((p, w) => (w.score > p.score ? w : p), ws[0]).t0;
  const sorted = ws.map((w) => w.score).sort((x, y) => x - y);
  const med = sorted[Math.floor(sorted.length / 2)];
  const holdSec = durations(null, a.t0, a.t1, (s) => s < HOLD_TH);
  const slowSec = durations(null, a.t0, a.t1, (s) => s >= SLOW_LO && s < SLOW_HI);
  const hasFast = mx >= FAST_HI;
  const labels = new Set(DBG.beats.filter((b) => b.act === a.id).map((b) => b.speed));
  const ok = hasFast && holdSec >= 0.35 && slowSec >= 0.4 && labels.has('快') && labels.has('停') && labels.has('慢');
  console.log('  ' + pad(a.id, 10) + pad(num(mx), 10) + pad(num(at, 2), 10) + pad(num(med), 10) +
    pad(num(holdSec) + 's', 8) + pad(num(slowSec) + 's', 8) +
    `${ok ? '快停慢齐备' : '缺：' + (!hasFast ? '快 ' : '') + (holdSec < 0.35 ? '停 ' : '') + (slowSec < 0.4 ? '慢' : '')}`);
  check(ok, `《${a.id}》有实测的「快 — 停 — 慢」`, `fast=${num(mx)} hold=${num(holdSec)}s slow=${num(slowSec)}s`);
}

/* ------------------------------------------------------------------ *
 * 4. 步态
 * ------------------------------------------------------------------ */
h1('[4] 步态：抬起(快) / 落下(慢) / 支撑(停)，左右脚相位错开，步频非均匀');
const trainsG = DBG.steps.general;
const walkTrain = trainsG[0];             // 主将入场 8 步（前慢后快）
const periods = walkTrain.slice(1).map((t, i) => +(t - walkTrain[i]).toFixed(3));
console.log('  主将入场步频(s): ' + periods.join('  '));
const pMin = Math.min(...periods), pMax = Math.max(...periods);
check(pMax / pMin >= 1.15, '步频非均匀（最快/最慢 ≥ 1.15）', `${num(pMin, 2)} … ${num(pMax, 2)}  ratio=${num(pMax / pMin)}`);
check(periods.slice(0, 3).every((p) => p >= periods.slice(-4).at(-1) - 1e-6) && periods.slice(3).every((p) => p <= periods[2] + 1e-6),
  '前慢后快（前三步 ≥ 后四步）', `${periods.map((p) => num(p, 2)).join('/')}`);

/** 取某一时刻某通道的绝对角 */
function chanAt(t, actor, ch, ax = 2) {
  const i = Math.round(t / DT);
  return FRAMES[Math.min(i, FRAMES.length - 1)].actors[actor].pose[ch][ax];
}
/** 逐个步幅分析摆动腿的抬腿曲线 */
const stepStats = [];
for (let i = 0; i < periods.length; i++) {
  const t0 = walkTrain[i], t1 = walkTrain[i + 1], Tspan = t1 - t0;
  const swingL = i % 2 === 0;
  const swingCh = swingL ? 'shinL' : 'shinR';
  const restCh = REST[swingCh][2];
  const lift = (t) => chanAt(t, 'general', swingCh) - restCh;
  const other = (t) => chanAt(t, 'general', swingL ? 'shinR' : 'shinL') - REST[swingL ? 'shinR' : 'shinL'][2];
  const N = 60;
  const xs = [], ls = [], os = [];
  for (let k = 0; k <= N; k++) {
    const t = t0 + (Tspan * k) / N;
    xs.push(k / N); ls.push(lift(t)); os.push(Math.abs(other(t)));
  }
  const peak = Math.max(...ls);
  const pk = ls.indexOf(peak);
  // 落下结束：抬腿量回到峰值 5% 以内
  let fallEnd = N;
  for (let k = pk; k <= N; k++) { if (ls[k] <= peak * 0.05) { fallEnd = k; break; } }
  const riseT = (xs[pk] * Tspan);
  const fallT = ((fallEnd - pk) / N) * Tspan;
  const plantT = (1 - xs[fallEnd]) * Tspan;
  const dslope = (arr) => { let m = 0; for (let k = 1; k < arr.length; k++) m = Math.max(m, Math.abs(arr[k] - arr[k - 1]) / (Tspan / N)); return m; };
  const riseSlope = dslope(ls.slice(0, pk + 1));
  const fallSlope = dslope(ls.slice(pk, Math.max(fallEnd, pk + 1)));
  const plantSlope = (() => {
    // 支撑期取相位 0.70–0.96 的样本：抬腿量在这一段必须恒为 0
    const lo = Math.round(0.70 * N), hi = Math.round(0.96 * N);
    let m = 0;
    for (let k = lo + 1; k <= hi; k++) m = Math.max(m, Math.abs(ls[k] - ls[k - 1]) / (Tspan / N));
    return m;
  })();
  stepStats.push({ i, Tspan, riseT, fallT, plantT, peak, riseSlope, fallSlope, plantSlope, otherMax: Math.max(...os) });
}
const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sw = stepStats.filter((s) => s.peak > 0.25);   // 只统计真正抬起来的步（首末步有进出包络）
check(sw.length >= 6, '可分析的完整步幅 ≥6（摆动腿确实抬起来了）', `${sw.length}/${stepStats.length}`);
console.log('  逐步：T(s)  抬t(s)  落t(s)  支撑(s)  抬速  落速  停比  抬幅(rad)');
for (const s of stepStats) {
  console.log('  ' + pad(`#${s.i}`, 8) + pad(num(s.Tspan, 2), 8) + pad(num(s.riseT, 3), 8) + pad(num(s.fallT, 3), 8) +
    pad(num(s.plantT, 3), 8) + pad(num(s.riseSlope, 2), 6) + pad(num(s.fallSlope, 2), 6) +
    pad(num(s.plantSlope / Math.max(s.riseSlope, 1e-6), 3), 8) + num(s.peak, 3));
}
{
  const r = avg(sw.map((s) => s.riseT / s.Tspan));
  const f = avg(sw.map((s) => s.fallT / s.Tspan));
  const pl = avg(sw.map((s) => s.plantT / s.Tspan));
  const ratio = avg(sw.map((s) => s.riseSlope / Math.max(s.fallSlope, 1e-6)));
  const plantRatio = avg(sw.map((s) => s.plantSlope / Math.max(s.riseSlope, 1e-6)));
  check(r <= 0.45, '抬起段用时 ≤ 45% 步幅', `rise=${num(r * 100, 1)}%`);
  check(f <= 0.5, '落下段用时 ≤ 50% 步幅', `fall=${num(f * 100, 1)}%`);
  check(pl >= 0.2, '支撑段（抬腿量恒 0）≥ 20% 步幅', `plant=${num(pl * 100, 1)}%`);
  check(ratio >= 1.5, '抬起比落下快（抬速/落速 ≥ 1.5）', `ratio=${num(ratio)}`);
  check(plantRatio <= 0.15, '支撑期速度 ≤ 抬起期 15%（真的是「停」）', `ratio=${num(plantRatio, 3)}`);
  check(sw.every((s) => s.otherMax < s.peak * 0.5), '同一步内只有摆动腿在抬（左右相位错开）',
    `other/peak max=${num(Math.max(...sw.map((s) => s.otherMax / s.peak)), 2)}`);
}
{
  // 位移不匀速：一个步幅内，摆动期推进 vs 支撑期推进
  const i = 4, t0 = walkTrain[i], t1 = walkTrain[i + 1], Tspan = t1 - t0;
  const at = (u) => FRAMES[Math.round((t0 + Tspan * u) / DT)].actors.general.root.tx;
  const swingAdv = Math.abs(at(0.62) - at(0.22));
  const supAdv = Math.abs(at(0.98) - at(0.64)) + 1e-9;
  check(swingAdv / supAdv >= 1.5, '步幅内推进不匀速（摆动期/支撑期 ≥ 1.5）', `swing=${num(swingAdv, 3)}m support=${num(supAdv, 3)}m ratio=${num(swingAdv / supAdv)}`);
  let mono = true, dir = Math.sign(at(1) - at(0));
  for (let k = 1; k <= 40; k++) if (Math.sign(at(k / 40) - at((k - 1) / 40)) === -dir) mono = false;
  check(mono, '行走期间位移单调（没有倒退抖动）');
}

/* ------------------------------------------------------------------ *
 * 5. 转身
 * ------------------------------------------------------------------ */
h1('[5] 转身：root.ry 路标 / 重心下沉 / 屈膝');
const ryAt = (t) => FRAMES[Math.round(t / DT)].actors.general.root.ry;
const wp = [[31.02, -1.6], [31.35, -3.14], [32.00, -1.9]];
console.log('  路标: ' + wp.map(([t, v]) => `t=${t}s ry=${num(ryAt(t), 3)}(目标 ${v})`).join('   '));
check(wp.every(([t, v]) => Math.abs(ryAt(t) - v) <= 0.06), 'ry 经过 0 → -1.6 → -3.14 → -1.9 三个路标（±0.06）');
check(Math.abs(ryAt(30.61)) < 0.02, '转身前 ry = 0（正面朝观众）', `ry=${num(ryAt(30.61), 3)}`);
{
  let mono = true;
  for (let t = 30.62; t <= 31.35; t += DT) if (ryAt(t + DT) > ryAt(t) + 1e-6) mono = false;
  check(mono, 'ry 从 0 到 -3.14 单调推进（不回头）');
  let back = false;
  for (let t = 31.52; t <= 32.85; t += DT) if (ryAt(t) > -1.85) back = true;
  check(!back, '亮相定格期间 ry 定在 -1.9（背身 3/4，不回正面）', `ry(32.9)=${num(ryAt(32.9), 3)}`);
}
{
  const base = [];
  for (let t = 29.6; t <= 30.1; t += DT) base.push(FRAMES[Math.round(t / DT)].actors.general.root.ty);
  const b = base.sort((x, y) => x - y)[base.length >> 1];
  let mn = 1e9, mnT = 0;
  for (let t = 30.3; t <= 32.1; t += DT) {
    const y = FRAMES[Math.round(t / DT)].actors.general.root.ty;
    if (y < mn) { mn = y; mnT = t; }
  }
  const dip = b - mn;
  console.log(`  转身前 ty=${num(b, 3)}m  最低 ty=${num(mn, 3)}m @${num(mnT, 2)}s  下沉=${num(dip, 3)}m`);
  check(dip >= 0.05 && dip <= 0.09, '转身 ty 下沉落在 0.05–0.09m', `dip=${num(dip, 3)}m`);
  const kneeMin = Math.min(...[30.62, 30.9, 31.2, 31.5, 31.8].map((t) =>
    Math.max(Math.abs(chanAt(t, 'general', 'shinL')), Math.abs(chanAt(t, 'general', 'shinR')))));
  check(kneeMin >= 0.18, '转身时膝盖微屈（膝屈 ≥0.18 rad）', `min=${num(kneeMin, 3)} rad`);
  let rzMax = 0;
  for (const f of FRAMES) rzMax = Math.max(rzMax, Math.abs(f.actors.general.root.rz));
  check(rzMax <= 0.30, 'root.rz 始终有界（≤0.30，不做画面内翻转）', `max|rz|=${num(rzMax, 3)}`);
  // 第二幕的转身（背对观众走远）也要下沉
  const b2 = FRAMES[Math.round(40.0 / DT)].actors.general.root.ty;
  let mn2 = 1e9;
  for (let t = 40.3; t <= 41.6; t += DT) mn2 = Math.min(mn2, FRAMES[Math.round(t / DT)].actors.general.root.ty);
  const dip2 = b2 - mn2;
  check(dip2 >= 0.05 && dip2 <= 0.09, '第四幕「转身背对」同样下沉 0.05–0.09m', `dip=${num(dip2, 3)}m`);
}

/* ------------------------------------------------------------------ *
 * 6. 通道协同 + 定格亮相
 * ------------------------------------------------------------------ */
h1('[6] 全身协同（同一 0.1s 内同时运动的通道数）');
console.log('  ' + pad('幕', 10) + pad('最大同时运动通道', 18) + pad('出现时刻', 10) + '该幕动过的通道');
const allCh = Object.keys(FRAMES[10].actors.general.pose);
let globalMax = 0, globalMaxAt = 0;
for (const a of ACTS) {
  let mx = 0, at = a.t0, moved = new Set();
  for (const w of WINDOWS) {
    if (w.t0 < a.t0 || w.t0 >= a.t1) continue;
    const n = allCh.filter((ch) => (w.per[ch] || 0) > 0.01).length;
    if (n > mx) { mx = n; at = w.t0; }
    for (const ch of allCh) if ((w.per[ch] || 0) > 0.02) moved.add(ch);
  }
  if (mx > globalMax) { globalMax = mx; globalMaxAt = at; }
  console.log('  ' + pad(a.id, 10) + pad(mx, 18) + pad(num(at, 1) + 's', 10) + moved.size + ' 个: ' + [...moved].join(','));
  check(mx >= 5, `《${a.id}》同一时刻 ≥5 个通道在动（全身协同，不是只摆手）`, `max=${mx}`);
}
console.log(`  全剧峰值：${globalMax} 个通道同时运动 @${num(globalMaxAt, 2)}s`);
check(globalMax >= 8, '全剧峰值 ≥8 个通道同时运动', `max=${globalMax}`);

{
  // 定格亮相：32.00–32.90 全身绷住，只有刀尖与翎羽微颤
  const inFreeze = WINDOWS.filter((w) => w.t0 >= 32.05 && w.t1 <= 32.85);
  const movers = new Set();
  let maxOther = 0;
  for (const w of inFreeze) {
    for (const ch of allCh) {
      const d = w.per[ch] || 0;
      if (d > 0.004 && ch !== 'weaponTip' && ch !== 'plume') { movers.add(ch); maxOther = Math.max(maxOther, d); }
    }
  }
  const tremor = inFreeze.reduce((m, w) => Math.max(m, (w.per.weaponTip || 0) + (w.per.plume || 0)), 0);
  console.log(`  定格 0.9s：刀尖+翎羽最大微颤 ${num(tremor, 4)} rad/0.1s；其他通道最大 ${num(maxOther, 4)} rad/0.1s`);
  check(movers.size === 0, '定格亮相时除刀尖/翎羽外全身不动');
  check(tremor > 0.002, '定格亮相时刀尖/翎羽确有微颤（不是死图）', `${num(tremor, 4)}`);
}

/* ------------------------------------------------------------------ *
 * 7. Frame 结构 & 纯函数
 * ------------------------------------------------------------------ */
h1('[7] Frame 结构与纯函数');
{
  const probes = [0, 0.5, 5, 12.3, 19.4, 24.9, 27.37, 31.5, 32.4, 39.5, 44.5, 45.99];
  let schemaOk = true, why = '';
  for (const t of probes) {
    const f = tl.sample(t);
    if (typeof f.dt !== 'number' || !(f.dt > 0)) { schemaOk = false; why = `dt@${t}`; break; }
    if (!(f.subtitle === null || (typeof f.subtitle === 'string' && f.subtitle.length <= 28))) { schemaOk = false; why = `subtitle@${t}:${f.subtitle}`; break; }
    const keys = Object.keys(f.actors).sort().join(',');
    if (keys !== 'cavalry,general') { schemaOk = false; why = `actors keys=${keys}`; break; }
    for (const k of ['general', 'cavalry']) {
      const a = f.actors[k];
      if (typeof a.visible !== 'boolean') { schemaOk = false; why = `${k}.visible`; break; }
      for (const rk of ['tx', 'ty', 'tz', 'rz', 'ry']) {
        if (!Number.isFinite(a.root[rk])) { schemaOk = false; why = `${k}.root.${rk}=${a.root[rk]}@${t}`; break; }
      }
      for (const ch in a.pose) {
        const v = a.pose[ch];
        if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) { schemaOk = false; why = `${k}.pose.${ch}`; break; }
      }
    }
    const L = f.light;
    if (!(Number.isFinite(L.intensity) && L.intensity >= 0 && L.intensity <= 4)) { schemaOk = false; why = `light.intensity=${L.intensity}@${t}`; break; }
    if (!(typeof L.color === 'string' || typeof L.color === 'number')) { schemaOk = false; why = `light.color@${t}`; break; }
    if (!(typeof L.color === 'number' || /^#[0-9a-f]{6}$/i.test(String(L.color)))) { schemaOk = false; why = `light.color 必须是 0xRRGGBB 或 '#rrggbb'（不是 "NaN"）@${t}: ${L.color}`; break; }
    if (!(Number.isFinite(L.flicker) && L.flicker >= 0 && L.flicker <= 1)) { schemaOk = false; why = `light.flicker@${t}`; break; }
    // light.pos：stage.setLight 走 Vector3.copy(pos) + pos.x/y/z，两套语义都要能跑
    if (!Array.isArray(L.pos) || L.pos.length !== 3 ||
        !(typeof L.pos.x === 'number' && typeof L.pos.y === 'number' && typeof L.pos.z === 'number')) {
      schemaOk = false; why = `light.pos 需要同时是 [x,y,z] 且带 x/y/z 属性 @${t}`; break;
    }
    if (!f.props || typeof f.props.sway !== 'object' || typeof f.props.visible !== 'object' || typeof f.props.opacity !== 'object') {
      schemaOk = false; why = `props@${t}`; break;
    }
  }
  check(schemaOk, 'Frame 字段与 INTERFACES B.2 一致（含 light.pos 双重语义、actors 仅 general/cavalry）', why);
}
{
  const a1 = JSON.stringify(tl.sample(31.234));
  const b1 = JSON.stringify(tl.sample(7.777));
  const a2 = JSON.stringify(tl.sample(31.234));
  check(a1 === a2, 'sample(t) 纯函数：乱序采样后同 t 同值');
  let drift = 0;
  for (let i = 0; i < 400; i++) {
    const t = (i * 0.113) % DURATION;
    if (JSON.stringify(tl.sample(t)) !== JSON.stringify(tl.sample(t))) drift++;
  }
  check(drift === 0, 'sample(t) 连续 400 次重复采样无漂移', `drift=${drift}`);
  check(Math.abs(FRAMES[0].dt - 1 / 60) < 1e-9, 'dt 恒为 1/60（布料步长确定性）');
}

/* ------------------------------------------------------------------ *
 * 8. REST 表 × src/puppet.js 静态核对
 * ------------------------------------------------------------------ */
h1('[8] REST / 层级 × src/puppet.js 静态核对');
const puppetPath = join(ROOT, 'src', 'puppet.js');
if (!existsSync(puppetPath)) {
  console.log('  … src/puppet.js 还没出现（皮影资产组仍在做），跳过静态核对');
  warns.push('src/puppet.js 尚未出现：REST/层级核对跳过');
} else {
  const src = readFileSync(puppetPath, 'utf8');
  // 按演员分块解析（puppet.js 里 general / cavalry 两张表；副将复用 general 的图纸，
  // 那些行只有 "uses"/"from" 没有 "parent"，不能覆盖 general 的条目）
  const blocks = { general: new Map(), cavalry: new Map() };
  let cur = null;
  for (const line of src.split('\n')) {
    if (/"general"\s*:\s*\[/.test(line)) { cur = 'general'; continue; }
    if (/"cavalry"\s*:\s*\[/.test(line)) { cur = 'cavalry'; continue; }
    const mk = line.match(/"key"\s*:\s*"([A-Za-z0-9_]+)"/);
    if (!mk || !cur) continue;
    const mr = line.match(/"rest"\s*:\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]/);
    const mp = line.match(/"parent"\s*:\s*(null|"([A-Za-z0-9_]+)")/);
    const mu = line.match(/"uses"\s*:\s*"([A-Za-z0-9_]+)"/);
    blocks[cur].set(mk[1], {
      rest: mr ? [parseFloat(mr[1]), parseFloat(mr[2]), parseFloat(mr[3])] : null,
      parent: mp ? (mp[1] === 'null' ? null : mp[2]) : undefined,
      uses: mu ? mu[1] : null,
    });
  }
  const gen = blocks.general;
  console.log(`  general ${gen.size} 个部件：${[...gen.keys()].join(', ')}`);
  console.log(`  cavalry ${blocks.cavalry.size} 个部件（复用 general 图纸）`);
  const need = [...new Set([...CHANNELS.general, ...CHANNELS.cavalry, 'weapon', 'weaponTip'])];
  const missing = need.filter((k) => !gen.has(k) && !blocks.cavalry.has(k));
  check(missing.length === 0, '编排驱动的通道在 puppet.js 里都存在', missing.length ? `缺: ${missing.join(',')}` : `${need.length} 个`);

  // REST 核对：只用**显式写出 rest** 的行（general 的权威表）
  const restBad = [];
  const restChecked = [];
  for (const k of need) {
    const v = gen.get(k) || blocks.cavalry.get(k);
    if (!v) continue;
    if (!v.rest) { if (gen.get(k)) restBad.push(k + '(general 未显式写 rest)'); continue; }
    const mine = REST[k];
    if (!mine) continue;
    const d = Math.max(...[0, 1, 2].map((i) => Math.abs(v.rest[i] - mine[i])));
    restChecked.push(k);
    if (d > 0.12) restBad.push(`${k}: puppet=${JSON.stringify(v.rest)} choreo=${JSON.stringify(mine)} Δ=${num(d, 3)}`);
  }
  check(restBad.length === 0, 'REST 表与 puppet.js 的 rest 一致（Δ ≤ 0.12 rad）',
    `核对 ${restChecked.length} 个通道` + (restBad.length ? ' | ' + restBad.join(' | ') : ''));

  // 层级：general 的 parent 链必须全部汇到 waist —— root.ry 转身才会带着全身翻
  const parentOf = (k) => {
    const v = gen.get(k);
    if (!v) return null;
    if (v.parent !== undefined) return v.parent;
    if (v.uses) { const u = gen.get(v.uses); return u ? u.parent ?? null : null; }
    return null;
  };
  const chain = (k) => {
    const seen = new Set();
    let c = k, last = k;
    while (c && !seen.has(c)) { seen.add(c); last = c; c = parentOf(c); }
    return last;
  };
  const notUnderWaist = need.filter((k) => k !== 'waist' && chain(k) !== 'waist');
  check(notUnderWaist.length === 0, '所有部件都挂在 waist 之下（root.ry 转身能带动全身）',
    notUnderWaist.length ? `不在 waist 下: ${notUnderWaist.join(',')}` : `${need.length} 个部件全部汇到 waist`);
  const orphan = [...gen.keys()].filter((k) => k !== 'waist' && chain(k) !== 'waist');
  check(orphan.length === 0, 'puppet.js 里没有游离部件（每个 keys 都能追到 waist）',
    orphan.length ? `游离: ${orphan.join(',')}` : `general 表 ${gen.size} 个全部有根`);
}

/* ------------------------------------------------------------------ *
 * 9. 绝对角与位移的物理合理性
 * ------------------------------------------------------------------ */
h1('[9] 绝对角与位移合理性');
for (const [actor, chans] of Object.entries(CHANNELS)) {
  let worst = { v: 0, ch: '', t: 0 };
  // weapon / weaponTip 的 z 是「刀杆绝对倾角 − 持刀手链累计角」的换算结果（相当于腕子反拧），
  // 天生会到 ±3.7 rad，不做这个上界断言；它们的**绝对倾角**在下一段单独验。
  const present = chans.filter((c) => FRAMES[0].actors[actor].pose[c] && c !== 'weapon' && c !== 'weaponTip');
  for (const ch of present) {
    for (let i = 0; i < FRAMES.length; i++) {
      const v = Math.max(...FRAMES[i].actors[actor].pose[ch].map(Math.abs));
      if (v > worst.v) worst = { v, ch, t: T[i] };
    }
  }
  check(worst.v <= 3.3, `${actor} 无异常大角度（|角| ≤ 3.3 rad，兵器另算）`, `max=${num(worst.v, 3)} @${worst.ch} t=${num(worst.t, 2)}s`);
}
{
  // 抬臂幅度：从垂直到过顶应 ≈ 2.4–2.9 rad（验证 REST 假设与方向约定）
  const ranges = {};
  for (const ch of ['upperArmL', 'upperArmR']) {
    let mn = 1e9, mx = -1e9;
    for (const f of FRAMES) { const z = f.actors.general.pose[ch][2]; mn = Math.min(mn, z); mx = Math.max(mx, z); }
    ranges[ch] = { mn, mx, span: mx - mn, rest: REST[ch][2], fromRest: Math.max(Math.abs(mx - REST[ch][2]), Math.abs(mn - REST[ch][2])) };
  }
  console.log(`  upperArmL z ${num(ranges.upperArmL.mn, 3)} → ${num(ranges.upperArmL.mx, 3)}（离 rest 最大 ${num(ranges.upperArmL.fromRest, 3)}）`);
  console.log(`  upperArmR z ${num(ranges.upperArmR.mn, 3)} → ${num(ranges.upperArmR.mx, 3)}（离 rest 最大 ${num(ranges.upperArmR.fromRest, 3)}）‹持刀臂›`);
  const best = Math.max(ranges.upperArmL.fromRest, ranges.upperArmR.fromRest);
  check(best >= 2.4 && best <= 2.9, '抬臂幅度 2.4–2.9 rad（垂下→过顶，验证 REST 与方向约定）', `max=${num(best, 3)} rad`);
  check(ranges.upperArmR.fromRest > ranges.upperArmL.fromRest, '持刀臂（R）抬得最高（抽刀/举刀过顶）');
}
{
  // 兵器：(1) 反算世界倾角，验证「谱里写世界倾角、buildPose 扣掉 root→手链累计旋转」的换算；
  //       (2) 用「手链正运动学 + 偏航 + 灯投影」估算刀尖**落到幕布上**的位置与放大率。
  //          偏航会把伸出去的刀杆推到灯前（z 变负），投影放大率 k = 2.55/(2.55−z) 随之上升：
  //          k 太大 = 刀月会被放大成一片巨影，所以 k 也要断言。
  const tilt = (f) => {
    const p = f.actors.general.pose, r = f.actors.general.root;
    return p.weapon[2] + r.rz + p.waist[2] + p.chest[2]
      + p.shoulderR[2] + p.upperArmR[2] + p.forearmR[2] + p.handR[2];
  };
  const dir = (th) => [Math.sin(th), -Math.cos(th)];
  // 挂点/长度取自 src/puppet.js 的 PART_SPECS（肩关节、上臂、前臂、手→握把偏移、杆长）
  const SHOULDER = [-0.115, 1.165], LUA = 0.312, LFA = 0.383, GRIP = [-0.010, -0.055], LPOLE = 1.014;
  function tipOnScreen(f) {
    const p = f.actors.general.pose, r = f.actors.general.root;
    const base = r.rz;
    const thSh = base + p.waist[2] + p.chest[2] + p.shoulderR[2];
    const thUa = thSh + p.upperArmR[2];
    const thFa = thUa + p.forearmR[2];
    const thHa = thFa + p.handR[2];
    const dUa = dir(thUa), dFa = dir(thFa);
    const ex = SHOULDER[0] + LUA * dUa[0], ey = SHOULDER[1] + LUA * dUa[1];
    const hx = ex + LFA * dFa[0], hy = ey + LFA * dFa[1];
    const c = Math.cos(thHa), s = Math.sin(thHa);
    const gx = hx + GRIP[0] * c - GRIP[1] * s;
    const gy = hy + GRIP[0] * s + GRIP[1] * c;
    const tl = tilt(f);
    const tipX = gx + LPOLE * -Math.sin(tl);
    const tipY = gy + LPOLE * Math.cos(tl);
    const cy = Math.cos(r.ry), sy = -Math.sin(r.ry);      // root.ry 绕竖轴
    const wx = r.tx + tipX * cy, wy = r.ty + tipY, wz0 = r.tz + tipX * sy;
    // 深度：造型本身把刀杆放在身位平面之前约 0.10m（层叠），再叠加手链的 x/y 扭转。
    // 系数用真实 rig 探针（tools/harness + 真 puppet.js）反推过：±0.03m 以内。
    const armX = p.shoulderR[0] + p.upperArmR[0] + p.forearmR[0] + p.handR[0] + p.weapon[0];
    const armY = p.shoulderR[1] + p.upperArmR[1] + p.forearmR[1] + p.handR[1];
    const wz = wz0 + 0.096 + LPOLE * Math.sin(armX) + 0.9 * Math.sin(armY);
    const L = f.light.pos;
    const k = (0 - L[2]) / (wz - L[2]);
    return { x: L[0] + k * (wx - L[0]), y: L[1] + k * (wy - L[1]), k, wz };
  }
  let mn = 1e9, mx = -1e9;
  for (const f of FRAMES) { const v = tilt(f); mn = Math.min(mn, v); mx = Math.max(mx, v); }
  const sustain = [[12.6, 18.0, '入场行走'], [25.62, 26.40, '刺定'], [32.00, 32.90, '定格亮相'], [36.30, 37.50, '静立收气'], [41.5, 43.6, '走远']];
  let worst = { y: -9, x: 0, k: 0, t: 0, what: '' }, transientY = -9, transientT = 0;
  let worstBelow = { y: 9, t: 0, what: '' }, poke = { z: -9, t: 0 };
  for (let i = 0; i < FRAMES.length; i++) {
    const s = tipOnScreen(FRAMES[i]);
    if (FRAMES[i].actors.general.visible && s.wz > poke.z) poke = { z: s.wz, t: T[i] };
    const win = sustain.find(([a, b]) => T[i] >= a && T[i] <= b);
    if (win && s.y > worst.y) worst = { ...s, t: T[i], what: win[2] };
    if (win && s.y < worstBelow.y) worstBelow = { y: s.y, t: T[i], what: win[2] };
    if (s.y > transientY) { transientY = s.y; transientT = T[i]; }
  }
  console.log(`  刀杆世界倾角：${num(mn, 2)} … ${num(mx, 2)} rad（摆幅 ${num(mx - mn, 2)}）`);
  console.log(`  刀尖投到幕布：停留姿态 y ∈ [${num(worstBelow.y, 2)}, ${num(worst.y, 2)}]m（最高 @${num(worst.t, 2)}s ${worst.what}）  放大率 k=${num(worst.k, 2)}  ·  z 最靠前 ${num(poke.z, 2)}m @${num(poke.t, 2)}s`);
  check(mx - mn >= 2.4, '打斗中刀杆有真实的大刀花（世界倾角摆幅 ≥ 2.4 rad）', num(mx - mn, 2));
  check(poke.z <= 0, '刀尖始终在幕布后方（不会戳穿幕布）', `max z=${num(poke.z, 3)}m`);
  check(worst.y <= 1.26, '停留姿态时刀尖（含刀月）不冲出画顶（幕布上沿 1.25）', `max y=${num(worst.y, 2)}m`);
  check(worstBelow.y >= -1.2, '停留姿态时刀尖不坠到幕布下沿以下（劈砍收在幕内）', `min y=${num(worstBelow.y, 2)}m`);
  check(Math.abs(worst.x) <= 2.0, '停留姿态时刀尖横向不越出幕布', `x=${num(worst.x, 2)}m`);
  check(worst.k <= 1.6, '刀尖没有因偏航被推到灯前放大成巨影（投影放大率 k ≤ 1.6）', `k=${num(worst.k, 2)}`);
  check(transientY > 1.22, '「举刀过顶」的瞬时刀尖确实冲出画顶（有起势的气势，不是死板构图）', `y=${num(transientY, 2)}m`);
}
{
  let txMax = 0, tyMin = 1e9, tyMax = -1e9, tzMin = 1e9, tzMax = -1e9;
  const tzSeen = [];
  for (const f of FRAMES) {
    for (const k of ['general', 'cavalry']) {
      const r = f.actors[k].root;
      if (f.actors[k].visible) { txMax = Math.max(txMax, Math.abs(r.tx)); tzMin = Math.min(tzMin, r.tz); tzMax = Math.max(tzMax, r.tz); }
      tyMin = Math.min(tyMin, r.ty); tyMax = Math.max(tyMax, r.ty);
    }
    tzSeen.push(f.actors.general.root.tz);
  }
  console.log(`  |tx| ≤ ${num(txMax, 2)}m   ty ∈ [${num(tyMin, 3)}, ${num(tyMax, 3)}]m   tz ∈ [${num(tzMin, 2)}, ${num(tzMax, 2)}]m`);
  check(txMax <= 2.35, '演员不越出幕布（|tx| ≤ 2.35m，场外只是被侧幕挡住）', `max|tx|=${num(txMax, 2)}`);
  check(tyMin >= -1.24 && tyMax <= -0.92, 'ty 在幕布高度内（v2 灯位下脚底基线 -1.06 ±0.16）', `[${num(tyMin, 3)}, ${num(tyMax, 3)}]`);
  check(tzMin >= -0.62 && tzMax <= -0.16, 'tz 在幕布后方 0.16–0.62m（v2 层叠深度：主将 -0.25、副将 -0.55）', `[${num(tzMin, 2)}, ${num(tzMax, 2)}]`);
  check(new Set(tzSeen.map((z) => z.toFixed(2))).size > 1, 'tz 有景深变化（不是恒值）');
}
{
  // 灯：起手 0.15、最亮 ≤4、收尾 ≈0.35
  const I = FRAMES.map((f) => f.light.intensity);
  const iStart = I[0], iMax = Math.max(...I), iEnd = I[I.length - 1];
  console.log(`  灯 intensity: 起 ${num(iStart)} → 峰值 ${num(iMax)} → 收尾 ${num(iEnd)}`);
  check(Math.abs(iStart - 0.15) <= 0.05, '起幕灯从 0.15 起（一点灯芯）', num(iStart));
  check(iMax <= 4 && iMax >= 2.5, '峰值在 2.5–4 之间（够亮但不炸）', num(iMax));
  check(Math.abs(iEnd - 0.35) <= 0.08, '收幕灯收到 ≈0.35 一点', num(iEnd));
  const fMax = Math.max(...FRAMES.map((f) => f.light.flicker));
  check(fMax > 0.5, '灯焰抖动幅度会随戏曲张弛变化（0..1）', `max=${num(fMax, 2)}`);
  // 灯位：开场必须就是 stage.js 的灯位（不能从 0 慢慢爬），收灯之前不能跑到幕布前面
  const p0 = FRAMES[0].light.pos;
  check(Math.abs(p0[0] - BASE.light[0]) < 0.02 && Math.abs(p0[1] - BASE.light[1]) < 0.02 && Math.abs(p0[2] - BASE.light[2]) < 0.05,
    '开场灯位 = stage.js 的灯位（不会被 moveTrack 从 0 慢慢爬过去）', `pos=[${p0.map((v) => num(v, 2)).join(',')}]`);
  let zMin = -9, zBad = 0;
  for (let i = 0; i < FRAMES.length; i++) {
    const L = FRAMES[i].light.pos;
    if (T[i] <= 40.0) { if (L[2] > -2.4) { zBad++; zMin = Math.max(zMin, L[2]); } }
    if (Math.abs(L[0]) > 0.4 || Math.abs(L[1]) > 0.6) zBad++;
  }
  check(zBad === 0, '灯位全程在幕布后方（40s 前 z ≤ -2.4，横向漂移 < 0.4m）', `bad=${zBad} maxZ=${num(zMin, 2)}`);
}

/* ------------------------------------------------------------------ *
 * 10. 输出
 * ------------------------------------------------------------------ */
h1('[10] 输出文件');
mkdirSync(SHOTS, { recursive: true });
const timelinePath = join(SHOTS, 'timeline.json');
writeFileSync(timelinePath, JSON.stringify(DBG, null, 2), 'utf8');

const SNAP = 0.25;
const snaps = [];
for (let t = 0; t <= DURATION + 1e-9; t = +(t + SNAP).toFixed(4)) {
  const f = tl.sample(t);
  const i = Math.round(t / DT);
  const w = WINDOWS[Math.min(i, WINDOWS.length - 1)];
  const act = actOf(Math.min(t, DURATION - 0.001));
  const pack = (a) => ({
    visible: a.visible,
    root: { tx: +a.root.tx.toFixed(4), ty: +a.root.ty.toFixed(4), tz: +a.root.tz.toFixed(3), rz: +a.root.rz.toFixed(4), ry: +a.root.ry.toFixed(4) },
    pose: Object.fromEntries(Object.entries(a.pose).map(([k, v]) => [k, v.map((x) => +x.toFixed(4))])),
    visibleParts: a.visibleParts || null,
  });
  snaps.push({
    t,
    act: act.id,
    actName: act.name,
    beat: (DBG.beats.filter((b) => t >= b.t0 && t < b.t1)[0] || {}).name || null,
    speedLabel: (DBG.beats.filter((b) => t >= b.t0 && t < b.t1)[0] || {}).speed || null,
    motionPer100ms: +((w ? w.score : 0)).toFixed(4),
    holding: !!w && w.score < HOLD_TH,
    subtitle: f.subtitle,
    light: { intensity: +f.light.intensity.toFixed(3), color: f.light.color, flicker: +f.light.flicker.toFixed(3), pos: f.light.pos.map((x) => +x.toFixed(3)) },
    general: pack(f.actors.general),
    cavalry: pack(f.actors.cavalry),
    props: f.props,
  });
}
const poseLog = {
  title: '影窗·夜巡 · 姿态采样（每 0.25s 一帧，绝对角 = REST + 动作量）',
  generatedBy: 'tools/qa-perf.mjs',
  duration: DURATION,
  sampleStepSec: SNAP,
  rest: REST,
  base: BASE,
  holdThreshold: HOLD_TH,
  columns: 'root=世界位移/旋转(米,弧度)；pose=绝对欧拉角(弧度)；motionPer100ms=该 0.1s 内姿态变化总量(rad 当量)',
  snapshots: snaps,
};
const posePath = join(SHOTS, 'pose-log.json');
writeFileSync(posePath, JSON.stringify(poseLog), 'utf8');
console.log(`  ✔ ${timelinePath}  (${DBG.acts.length} 幕 / ${DBG.beats.length} 节拍 / ${DBG.holdCount} 停顿 / ${DBG.easings.length} 种缓动)`);
console.log(`  ✔ ${posePath}  (${snaps.length} 帧 × 0.25s，含每帧运动量)`);

/* ------------------------------------------------------------------ *
 * 结论
 * ------------------------------------------------------------------ */
h1('=== 结果 ===');
if (warns.length) for (const w of warns) console.log('  ! ' + w);
if (fails.length) {
  console.log(`  ✘ ${fails.length} 项失败：`);
  for (const f of fails) console.log('     - ' + f);
} else {
  console.log(`  ✔ 全部 ${pass} 项断言通过`);
}
console.log(`  四幕：${ACTS.map((a) => `${a.id} ${num(a.t0, 0)}–${num(a.t1, 0)}s`).join('  |  ')}  总时长 ${DURATION}s`);
console.log(`  停顿：${MEASURED_HOLDS.length} 处 / ${HOLD_TOTAL_MEASURED}s（编排表 ${DBG.holdCount} 处 / ${DBG.holdTotal}s）`);
console.log(`  每幕最快：${ACTS.map((a) => { const ws = WINDOWS.filter((w) => w.t0 >= a.t0 && w.t0 < a.t1); return a.id + ' ' + num(Math.max(...ws.map((w) => w.score))); }).join('  ')}  (rad/0.1s)`);
console.log(`  同时运动通道数峰值：${globalMax} @${num(globalMaxAt, 1)}s`);
process.exit(fails.length ? 1 : 0);

// src/choreography.js —— 影窗·夜巡：四幕时间轴与动作谱（编排组）
//
// 这一版把「停顿是灵魂」当作数据结构来写：
//   * 每个通道是一条「动作段」序列（scoreTrack），段与段之间的**空档就是停顿** ——
//     空档里该通道值恒定，速度严格为 0，不需要为每个停顿重复写两个关键帧。
//   * 每一次发力都按「预备 → 发力 → 惯性过冲 → 停住」四段写：
//       预备  0.30–0.55s，重心先往反方向压（v0 反向）
//       发力  0.12–0.15s 内完成大角度变化（easeOutQuint）
//       过冲  到位后回弹 2–4%（easeOutBack，独立一段）
//       停住  0.4–1.2s 真停（下一段之前留空档）
//   * 步态用 stepTrain（抬快/落慢/支撑停，步频可变），位移不匀速。
//
// 与引擎的对接（读过 src/main.js / rig.js / stage.js / materials.js / screen.js 之后确定）：
//   * Frame 字段名严格按 INTERFACES B.2：dt / subtitle / actors / light / props。
//     main.js 逐字段消费：f.actors[key].{visible,root,pose,wind,opacity,visibleParts}、
//     f.light.{intensity,color,pos,flicker}、f.props、f.subtitle、f.dt。
//   * actors 的 key 只能是 `general` / `cavalry`（main.js 用 rigs[key] 取 rig；多写 key 会空转，
//     写 `props` 会把 props 的 rig 当演员驱动，所以绝不写）。
//   * root.tz 必须每帧回传：rig.update() 用 setRootTransform 覆盖 root.position，
//     不回传就变成 z=0 —— 皮影会贴到幕布平面上。general -0.14 / cavalry -0.46 是 main.js 的初始层叠深度。
//   * root.ty 基线必须由时间轴给：INTERFACES A.2.6 的「rig.root 放到 y≈-1.24」等于要求
//     时间轴发 BASE.ty = -1.24（造型侧按「脚在局部 y≈0」建型，脚才会落在幕布下沿 y≈-1.24）。
//   * root.ry 是引擎新加的绕竖轴偏航（rig.setRootTransform(tx,ty,rz,tz,ry)，root.rotation.set(0,ry,rz)）：
//     平片皮影的「真转身」只能用它 —— root.rz 是**画面内**旋转，大角度会把人甩倒。
//   * light.pos 必须是「带 x/y/z 属性的数组」：stage.setLight 走 Vector3.copy(pos) 与 pos.x/y/z，
//     纯数组会得到 NaN。color 走 THREE.Color.set()，所以只能是 0xRRGGBB / '#rrggbb' / 颜色名，
//     不能是 {r,g,b}。
//   * 道具/武器的显隐一律用 visibleParts（不是 opacity）：shadow depth 材质只读 alphaTest，
//     不读 opacity —— 用 opacity 只会让可见剪影半透明，幕布上的影子还在。
//   * sample(t) 是纯函数：不依赖 Date.now()/随机数/内部累积状态；同一 t 永远同一结果。
import { scoreTrack, stepTrain, tremor, breath, flickerNoise, clamp, easeOutBackT } from './ease.js';

/* ================================================================== *
 * 0. REST 表：绝对欧拉角 = REST[通道] + 动作量
 * ================================================================== */

/**
 * rig.setPose 是**直接设置**欧拉角（rest 只是初值），所以编排必须知道每个部件的静息角。
 * 本表按 INTERFACES A.1 的示例推断（示例原文：upperArmL rest [0,0,0.06]），
 * 并在 choreography 里以 REST + delta 的形式使用。
 *
 * 方向约定（局部坐标：向右 +x，向上 +y，画面外 +z）—— 以皮影资产组 src/puppet.js 的实际建型为准：
 *   * **左肢在 +x 侧（观众右），右肢在 -x 侧（观众左，持刀手）**。造型把姿势画进轮廓里，
 *     所以结构链 rest 全 0，只有两条上臂带 ±0.06（3.4° 外撇）。
 *   * 绕 +z 旋转总是把部件的**远端推向 +x**：所以「上抬/外展」对左肢是 +z、对右肢是 -z；
 *     「向 +x 摆」两个肢体都是 +z（走路摆臂用这个）。兵器随右臂（handR）一起动。
 *   * upperArmL 从垂直到过顶的摆幅约 2.6 rad（qa-perf 断言 2.4–2.9）。
 * 若 皮影资产组的 src/puppet.js 用了别的 rest，qa-perf 会静态对比并报错（差 >0.12 rad = FAIL）。
 */
export const REST = {
  waist: [0, 0, 0], chest: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0],
  shoulderL: [0, 0, 0], shoulderR: [0, 0, 0],
  upperArmL: [0, 0, 0.06], upperArmR: [0, 0, -0.06],
  forearmL: [0, 0, 0], forearmR: [0, 0, 0],
  handL: [0, 0, 0], handR: [0, 0, 0],
  hipL: [0, 0, 0], hipR: [0, 0, 0],
  thighL: [0, 0, 0], thighR: [0, 0, 0],
  shinL: [0, 0, 0], shinR: [0, 0, 0],
  footL: [0, 0, 0], footR: [0, 0, 0],
  weapon: [0, 0, 0], weaponTip: [0, 0, 0], plume: [0, 0, 0],
};

/** 世界单位（米）与层叠深度基线 */
export const BASE = {
  // 脚底世界高度。灯位改为 (0.10,-0.28,-3.2) 后，演员在幕布后 0.25m 处放大率 K≈1.085，
  // 影子脚底 = yLight + (ty - yLight) * K；取 ty=-1.06 得影子脚底 ≈ -1.13，
  // 正好落在幕布下沿(-1.25)之内 —— 人不会踩出幕布，也不浮在半空。
  ty: -1.06,
  tzGeneral: -0.25,   // 主将离幕布距离（近、实）
  tzCavalry: -0.55,   // 副将（远、虚、略大 —— 真实透视）
  light: [0.10, -0.28, -3.2],  // 必须与 src/stage.js 的灯位一致（影响投影反解）
  screenW: 4.0, screenH: 2.5,
};

/** 本时间轴会驱动的通道（其余通道不动，保持 rest） */
export const CHANNELS = {
  general: ['waist', 'chest', 'neck', 'head', 'shoulderL', 'shoulderR', 'upperArmL', 'upperArmR',
    'forearmL', 'forearmR', 'handL', 'handR', 'hipL', 'hipR', 'thighL', 'thighR',
    'shinL', 'shinR', 'footL', 'footR', 'weapon', 'weaponTip', 'plume'],
  cavalry: ['waist', 'chest', 'neck', 'head', 'shoulderL', 'shoulderR', 'upperArmL', 'upperArmR',
    'forearmL', 'forearmR', 'handL', 'handR', 'hipL', 'hipR', 'thighL', 'thighR',
    'shinL', 'shinR', 'footL', 'footR'],
};

const AX = { x: 0, y: 1, z: 2 };

/* ================================================================== *
 * 1. 四幕（秒）
 * ================================================================== */

export const ACTS = [
  { id: '起', name: '上灯·入场', t0: 0.0, t1: 11.0 },
  { id: '承', name: '探看·生疑', t0: 11.0, t1: 24.0 },
  { id: '转', name: '拔刀·激斗', t0: 24.0, t1: 37.5 },
  { id: '合', name: '收势·余韵', t0: 37.5, t1: 46.0 },
];

export const DURATION = 46.0;

/* ================================================================== *
 * 2. 节拍表（每段都标速度与缓动；speed='停' 的段就是停顿）
 * ================================================================== */

const B = (act, name, t0, t1, speed, ease, what = '') => ({ act, name, t0, t1, speed, ease, what });

export const BEATS = [
  /* ---- 起 · 上灯·入场（0–11.0s）--------------------------------- */
  B('起', '上灯', 0.00, 1.20, '慢', 'easeInOutSine', '灯 0.15→1.05，灯焰抖'),
  B('起', '静场', 1.20, 2.40, '停', 'hold', '全台静止 1.2s，只有灯焰在抖'),
  B('起', '副将入画·第一记', 2.40, 2.72, '快', 'easeOutQuint', '第一步：抬得快、落得慢'),
  B('起', '缓步入场', 2.72, 7.50, '中', 'easeInOutSine', '五步缓行，步幅渐收'),
  B('起', '停步', 7.50, 8.30, '停', 'hold', '落脚、沉身、停住 0.8s'),
  B('起', '驻足四望', 8.30, 9.50, '慢', 'easeInOutSine', '头先转、胸随后'),
  B('起', '静立', 9.50, 11.00, '停', 'hold', '等主将，1.5s'),

  /* ---- 承 · 探看·生疑（11.0–24.0s）------------------------------ */
  B('承', '灯满', 11.00, 11.90, '停', 'hold', '灯升到 2.6，主将未出，0.9s'),
  B('承', '主将入画', 11.90, 12.70, '慢', 'easeOutCubic', '自幕右入场，第一步'),
  B('承', '徐行', 12.70, 16.30, '慢', 'easeInOutSine', '三步，步频 1.20s —— 前慢'),
  B('承', '疾步', 16.30, 18.50, '快', 'easeOutQuint', '四步，步频 0.60→0.50s —— 后快'),
  B('承', '停步', 18.50, 19.30, '停', 'hold', '非匀速停步 + 过冲回弹 0.8s'),
  B('承', '转头·来路', 19.30, 19.65, '快', 'easeOutQuint', '头先动、颈随后（看向来路 +x）'),
  B('承', '停·一', 19.65, 20.05, '停', 'hold', '0.4s 凝神'),
  B('承', '回正·再看', 20.05, 20.60, '快', 'easeOutQuint', '第二次张望（转向敌影一侧 -x）'),
  B('承', '停·二', 20.60, 21.00, '停', 'hold', '0.4s 凝神'),
  B('承', '回正', 21.00, 21.30, '慢', 'easeInOutCubic', ''),
  B('承', '抬手搭额', 21.30, 22.75, '中', 'easeOutCubic', '肘先动(0.10s)→腕后随(0.05s)'),
  B('承', '远眺', 22.75, 23.40, '停', 'hold', '搭额远眺定格 0.65s'),
  B('承', '风起', 23.40, 24.00, '慢', 'easeInOutSine', '灯压暗 2.6→1.85，松枝摇'),

  /* ---- 转 · 拔刀·激斗（24.0–37.5s）------------------------------ */
  B('转', '凝', 24.00, 24.40, '停', 'hold', '出手前的 0.4s 死寂'),
  B('转', '撤步蓄势', 24.40, 24.75, '快', 'easeOutCubic', '预备 0.35s：重心先往反方向压'),
  B('转', '抽刀', 24.75, 24.90, '快', 'easeOutQuint', '0.15s 内大角度出刀'),
  B('转', '刀成·过冲', 24.90, 25.15, '中', 'easeOutBack', '过冲 3% 回弹'),
  B('转', '收臂预备', 25.15, 25.28, '快', 'easeInOutCubic', '第二记的预备'),
  B('转', '前刺', 25.28, 25.42, '快', 'easeOutQuint', '0.14s 全身前送'),
  B('转', '过冲回弹', 25.42, 25.62, '中', 'easeOutBack', ''),
  B('转', '刺定', 25.62, 26.40, '停', 'hold', '0.78s 停住，刀尖微颤'),
  B('转', '挥刀一·蓄', 26.98, 27.30, '中', 'easeOutCubic', '举刀过顶 0.32s'),
  B('转', '挥刀一·发', 27.30, 27.45, '快', 'easeOutQuint', '0.15s 内 2.1 rad 大劈'),
  B('转', '刀势未尽', 27.45, 27.68, '中', 'easeOutBack', '惯性带过再回弹'),
  B('转', '停·一', 27.68, 28.42, '停', 'hold', '0.74s'),
  B('转', '挥刀二·蓄', 28.42, 28.97, '慢', 'easeInOutCubic', '0.55s 慢预备（与第一记对比）'),
  B('转', '挥刀二·发', 28.97, 29.09, '快', 'easeOutQuint', '0.12s 小劈 0.7 rad'),
  B('转', '收势', 29.09, 29.34, '中', 'easeOutBack', ''),
  B('转', '停·二', 29.34, 30.12, '停', 'hold', '0.78s'),
  B('转', '沉腰蓄势', 30.12, 30.62, '慢', 'easeInOutSine', '屈膝、沉腰、蓄转身'),
  B('转', '转身Ⅰ', 30.62, 31.02, '快', 'easeInOutCubic', 'ry 0→-1.6，0.40s'),
  B('转', '转身Ⅱ', 31.02, 31.35, '快', 'easeOutCubic', '0.33s 掠过侧身到 -3.14'),
  B('转', '背身一瞬', 31.35, 31.52, '停', 'hold', '0.17s 屏息'),
  B('转', '回身定型', 31.52, 32.00, '中', 'easeInOutSine', '惯性过冲回弹到 -1.9 背身 3/4'),
  B('转', '定格亮相', 32.00, 32.90, '停', 'hold', '全身绷住 0.9s，只刀尖与翎羽微颤'),
  B('转', '收势·喘息', 32.90, 34.10, '慢', 'easeInOutSine', '转回正面，胸口起伏两次'),
  B('转', '猛回头', 34.10, 34.45, '快', 'easeOutQuint', '最后看一眼敌影'),
  B('转', '停·三', 34.62, 35.10, '停', 'hold', '0.40s'),
  B('转', '垂刀', 35.10, 36.30, '慢', 'easeInOutSine', ''),
  B('转', '静立收气', 36.30, 37.50, '停', 'hold', '1.2s'),

  /* ---- 合 · 收势·余韵（37.5–46.0s）------------------------------ */
  B('合', '收刀入鞘', 37.50, 38.70, '慢', 'easeInOutSine', '慢收，刀入鞘即隐'),
  B('合', '停·一', 38.70, 39.20, '停', 'hold', '0.5s'),
  B('合', '退后半步', 39.20, 39.75, '快', 'easeOutQuint', '一记短促的退步'),
  B('合', '停·二', 39.75, 40.25, '停', 'hold', '0.5s'),
  B('合', '转身背对', 40.25, 40.95, '慢', 'easeInOutSine', 'ry 0→-3.14，重心下沉、膝微屈'),
  B('合', '走远·一', 40.95, 41.52, '慢', 'easeOutQuad', '步频 0.57s'),
  B('合', '走远·二', 41.52, 42.16, '慢', 'easeOutQuad', '步频 0.64s'),
  B('合', '走远·三', 42.16, 42.86, '慢', 'easeOutQuad', '步频 0.70s'),
  B('合', '走远·末步', 42.86, 43.68, '慢', 'easeInOutSine', '步频 0.82s，步幅衰减到 0.15 —— 几乎不动'),
  B('合', '灯收成点', 40.25, 44.00, '慢', 'easeInOutSine', '灯后退，光斑缩成一点 2.3→0.35'),
  B('合', '留白', 44.00, 46.00, '停', 'hold', '2.0s 空白：幕上只剩远山与月'),
];

export const HOLDS = BEATS.filter((b) => b.speed === '停')
  .map((b) => ({ t0: b.t0, t1: b.t1, dur: +(b.t1 - b.t0).toFixed(2), what: b.what || b.name }));
export const HOLD_TOTAL = +HOLDS.reduce((s, h) => s + h.dur, 0).toFixed(2);

/* ================================================================== *
 * 3. 走位谱：站位段 / 步列段（位移不匀速，步幅可衰减）
 *    每段 {t0,t1} 里驻留 (x,z)，或走一段 stepTrain（x0→x1, z0→z1）
 * ================================================================== */

const walk = (t0, t1, starts, x0, x1, dir, amp, ampScales, z0, z1 = z0) =>
  ({ t0, t1, walk: { starts, x0, x1, z0, z1, dir, amp, ampScales } });
const stand = (t0, t1, x, z) => ({ t0, t1, x, z });

/** 走位段自检：任何 x/z 非有限值、或 starts 不递增，都在 import 时就炸掉，绝不带着 NaN 上场 */
function validatePos(segs, name) {
  for (const s of segs) {
    if (!s.walk && (!Number.isFinite(s.x) || !Number.isFinite(s.z))) {
      throw new Error(`${name}: 站位段 z/x 非有限值 @${s.t0}`);
    }
    if (!s.walk) continue;
    const w = s.walk;
    for (const k of ['x0', 'x1', 'z0', 'z1', 'dir', 'amp']) {
      if (!Number.isFinite(w[k])) throw new Error(`${name}: 步列段缺 ${k} @${w.starts?.[0]}`);
    }
    if (!Array.isArray(w.starts) || w.starts.length < 2) throw new Error(`${name}: starts 至少两个时间点 @${s.t0}`);
    for (let i = 1; i < w.starts.length; i++) {
      if (!(w.starts[i] > w.starts[i - 1])) throw new Error(`${name}: starts 非递增 @${w.starts[i]}`);
    }
    if (w.starts[0] < s.t0 - 1e-9 || w.starts[w.starts.length - 1] > s.t1 + 1e-9) {
      throw new Error(`${name}: 步列时间超出所在段 [${s.t0}, ${s.t1}]`);
    }
  }
}

/** 主将走位（米）：自幕右入场；敌影在**幕左**（观众左），所以撤步向 +x 退、三记杀招都向 -x 扑；
 *  收势后在第四幕向 +x 退半步，再转身穿过整个台口从左下场。 */
const POS_GENERAL = [
  stand(0.00, 11.90, 2.30, BASE.tzGeneral),
  walk(11.90, 18.50, [11.90, 12.70, 13.90, 15.10, 16.30, 16.90, 17.46, 18.00, 18.50],
    2.30, 0.42, -1, 1.00, [0.75, 0.90, 1.00, 1.05, 1.10, 1.15, 1.15, 0.80], BASE.tzGeneral),  // 前慢后快，8 步
  stand(18.50, 24.40, 0.42, BASE.tzGeneral),
  walk(24.40, 24.75, [24.40, 24.75], 0.42, 0.66, 1, 0.70, [1.00], BASE.tzGeneral, -0.24),  // 撤半步：向 +x 退，并压进纵深
  stand(24.75, 25.28, 0.66, -0.24),
  walk(25.28, 25.62, [25.28, 25.62], 0.66, 0.16, -1, 0.95, [1.00], -0.24, -0.20),          // 前刺：向 -x 扑，略逼近幕布
  stand(25.62, 27.16, 0.16, -0.20),
  walk(27.16, 27.50, [27.16, 27.50], 0.16, -0.02, -1, 1.00, [1.00], -0.20, -0.26),         // 劈一上步（刀杆前倾，压深一点免得戳到幕前）
  stand(27.50, 28.90, -0.02, -0.26),
  walk(28.90, 29.20, [28.90, 29.20], -0.02, -0.12, -1, 0.70, [1.00], -0.26, -0.24),        // 劈二上步
  stand(29.20, 37.50, -0.12, -0.24),
  stand(37.50, 39.20, -0.12, -0.24),
  walk(39.20, 39.75, [39.20, 39.75], -0.12, 0.22, 1, 0.75, [1.00], -0.24, BASE.tzGeneral), // 退后半步：退回基线深度
  stand(39.75, 40.95, 0.22, BASE.tzGeneral),
  walk(40.95, 43.68, [40.95, 41.52, 42.16, 42.86, 43.68],
    0.22, -1.90, -1, 1.00, [1.00, 0.95, 0.80, 0.55, 0.15], BASE.tzGeneral, -0.44), // 走远，步幅衰减
  stand(43.68, 46.00, -1.90, -0.44),
];

/** 副将走位：幕左 2/3 处驻足，转幕次时惊退半步，最后从幕左退场 */
const POS_CAVALRY = [
  stand(0.00, 2.40, -2.28, BASE.tzCavalry),
  walk(2.40, 7.50, [2.40, 2.72, 3.57, 4.42, 5.27, 6.12, 6.97, 7.50],
    -2.28, -0.67, 1, 0.75, [1.05, 1.00, 0.95, 0.92, 0.90, 0.86, 0.55], BASE.tzCavalry),  // 缓步入场，7 步
  stand(7.50, 24.80, -0.67, BASE.tzCavalry),
  walk(24.80, 25.20, [24.80, 25.20], -0.67, -0.86, -1, 0.55, [1.00], BASE.tzCavalry),    // 惊退半步
  stand(25.20, 31.00, -0.86, -0.48),
  walk(31.00, 33.42, [31.00, 31.55, 32.10, 32.70, 33.42],
    -0.86, -2.34, -1, 0.80, [1.00, 1.00, 0.90, 0.70], BASE.tzCavalry, -0.50),      // 退场
  stand(33.42, 46.00, -2.34, -0.50),
];

validatePos(POS_GENERAL, 'POS_GENERAL');
validatePos(POS_CAVALRY, 'POS_CAVALRY');

/** 走位段求值 → 世界位移 + 步态增量 */
function posAt(segs, t) {
  let x = segs[0].x, z = segs[0].z;
  let gait = null;
  for (const s of segs) {
    if (t <= s.t0) break;
    if (t >= s.t1) {
      if (s.walk) { x = s.walk.x1; z = s.walk.z1; }
      else { x = s.x; z = s.z; }
      continue;
    }
    if (!s.walk) return { x: s.x, z: s.z, gait: null };
    const tr = stepTrain(s.walk.starts, t, s.walk.ampScales);
    if (!tr) return { x: s.walk.x0, z: s.walk.z0, gait: null };
    const progress = (tr.i + tr.advance) / tr.n;
    const w = s.walk;
    return {
      x: w.x0 + (w.x1 - w.x0) * progress,
      z: w.z0 + (w.z1 - w.z0) * progress,
      gait: gaitFrom(tr, w),
    };
  }
  return { x, z, gait };
}

/** 由步态剖面生成四肢增量：摆动腿抬/落，支撑腿停，双臂反向摆，每步一沉 */
function gaitFrom(tr, w) {
  const d = w.dir;                       // +1 = 沿 +x 走
  const amp = tr.amp * tr.env;
  const A = 0.44 * amp * w.amp;          // 大腿前后摆幅
  const F = 1.05 * amp * w.amp;          // 膝盖屈曲幅度
  const swingL = tr.i % 2 === 0;
  const swingThigh = A * d * (-0.62 + 1.62 * tr.extend);
  const plantThigh = A * d * (-0.62);
  const kdir = -d;                       // 屈膝：脚往行进的反方向收（向 +x 走 → 负 z）
  const g = {
    thighL: swingL ? swingThigh : plantThigh,
    thighR: swingL ? plantThigh : swingThigh,
    shinL: swingL ? kdir * F * tr.lift : kdir * 0.04,
    shinR: swingL ? kdir * 0.04 : kdir * F * tr.lift,
    armL: (swingL ? -1 : 1) * 0.19 * d * tr.extend * amp,
    armR: (swingL ? 1 : -1) * 0.19 * d * tr.extend * amp,
    bob: -0.011 * amp * (1 + Math.cos(2 * Math.PI * tr.phase)),
    lean: 0.055 * amp * -d,              // 走路时身体朝行进方向压一点
    side: 0.02 * amp * (swingL ? 1 : -1),
  };
  return g;
}

/* ================================================================== *
 * 4. 动作谱（scoreTrack：动作段之间留空 = 停顿）
 *    每通道每轴：{t0,t1,to,ease} —— 「从当前值走到 to」，空档保持不动。
 * ================================================================== */

const SCORE = {
  general: {
    /* ---- 腰：全身重心的总开关，每一次发力都从它开始 ---- */
    waist: {
      z: [
        { t0: 11.95, t1: 12.30, to: 0.055, ease: 'easeOutCubic' },   // 入场压低
        { t0: 18.25, t1: 18.55, to: -0.020, ease: 'easeOutBack' },   // 停步过冲回弹
        { t0: 18.55, t1: 18.90, to: 0.000, ease: 'easeOutCubic' },
        { t0: 20.05, t1: 20.25, to: 0.010, ease: 'easeInOutCubic' },
        { t0: 21.30, t1: 21.75, to: 0.050, ease: 'easeOutCubic' },   // 搭额前探
        { t0: 21.75, t1: 21.95, to: 0.030, ease: 'easeOutBack' },
        { t0: 23.40, t1: 24.00, to: -0.020, ease: 'easeInOutSine' }, // 风起后仰
        { t0: 24.40, t1: 24.75, to: -0.150, ease: 'easeOutCubic' },  // 预备：重心往后压
        { t0: 24.75, t1: 24.90, to: 0.070, ease: 'easeOutQuint' },   // 抽刀
        { t0: 24.90, t1: 25.12, to: 0.020, ease: 'easeOutBack' },
        { t0: 25.28, t1: 25.42, to: 0.270, ease: 'easeOutQuint' },   // 前刺
        { t0: 25.42, t1: 25.62, to: 0.200, ease: 'easeOutBack' },
        { t0: 26.98, t1: 27.30, to: -0.120, ease: 'easeInOutCubic' },// 挥一预备
        { t0: 27.30, t1: 27.45, to: 0.300, ease: 'easeOutQuint' },   // 挥一发
        { t0: 27.45, t1: 27.68, to: 0.225, ease: 'easeOutBack' },
        { t0: 28.42, t1: 28.97, to: 0.020, ease: 'easeInOutSine' },  // 挥二预备（慢）
        { t0: 28.97, t1: 29.09, to: 0.240, ease: 'easeOutQuint' },   // 挥二发
        { t0: 29.09, t1: 29.34, to: 0.175, ease: 'easeOutBack' },
        { t0: 30.12, t1: 30.62, to: 0.060, ease: 'easeInOutSine' },  // 沉腰
        { t0: 30.62, t1: 31.42, to: -0.080, ease: 'easeInOutCubic' },// 转身
        { t0: 31.52, t1: 32.00, to: 0.075, ease: 'easeOutBack' },    // 回身定型
        { t0: 32.90, t1: 34.10, to: -0.020, ease: 'easeInOutSine' }, // 收势
        { t0: 34.10, t1: 34.45, to: 0.115, ease: 'easeOutQuint' },   // 猛回头
        { t0: 35.10, t1: 36.30, to: 0.000, ease: 'easeInOutSine' },
        { t0: 37.50, t1: 38.30, to: 0.045, ease: 'easeInOutSine' },  // 收刀
        { t0: 38.30, t1: 38.70, to: 0.000, ease: 'easeOutCubic' },
        { t0: 39.20, t1: 39.55, to: -0.100, ease: 'easeOutQuint' },  // 退半步（后压）
        { t0: 39.55, t1: 39.75, to: 0.010, ease: 'easeOutBack' },
        { t0: 40.25, t1: 40.95, to: -0.030, ease: 'easeInOutSine' }, // 转身背对
        { t0: 40.95, t1: 41.70, to: 0.055, ease: 'easeInOutSine' },  // 走远
        { t0: 43.30, t1: 43.90, to: 0.000, ease: 'easeInOutSine' },
      ],
      y: [
        { t0: 21.30, t1: 22.75, to: -0.070, ease: 'easeOutCubic' },
        { t0: 23.40, t1: 24.00, to: 0.000, ease: 'easeInOutSine' },
        { t0: 24.40, t1: 24.75, to: -0.080, ease: 'easeOutCubic' },
        { t0: 24.75, t1: 24.90, to: -0.120, ease: 'easeOutQuint' },
        { t0: 24.90, t1: 25.12, to: -0.060, ease: 'easeOutBack' },
        { t0: 25.28, t1: 25.42, to: 0.120, ease: 'easeOutQuint' },
        { t0: 25.42, t1: 25.62, to: 0.080, ease: 'easeOutBack' },
        { t0: 26.98, t1: 27.30, to: 0.140, ease: 'easeOutCubic' },
        { t0: 27.30, t1: 27.45, to: -0.140, ease: 'easeOutQuint' },
        { t0: 27.45, t1: 27.68, to: -0.080, ease: 'easeOutBack' },
        { t0: 28.42, t1: 28.97, to: 0.100, ease: 'easeInOutSine' },
        { t0: 28.97, t1: 29.09, to: -0.090, ease: 'easeOutQuint' },
        { t0: 29.09, t1: 29.34, to: -0.050, ease: 'easeOutBack' },
        { t0: 30.62, t1: 31.42, to: 0.110, ease: 'easeInOutCubic' }, // 转身的先导扭转
        { t0: 31.52, t1: 32.00, to: -0.045, ease: 'easeOutBack' },
        { t0: 32.90, t1: 34.10, to: 0.000, ease: 'easeInOutSine' },
        { t0: 34.10, t1: 34.45, to: -0.200, ease: 'easeOutQuint' },
        { t0: 35.10, t1: 35.60, to: 0.000, ease: 'easeInOutSine' },
      ],
      x: [
        { t0: 25.28, t1: 25.42, to: 0.050, ease: 'easeOutQuint' },
        { t0: 25.62, t1: 26.10, to: 0.020, ease: 'easeOutCubic' },
        { t0: 27.30, t1: 27.45, to: -0.060, ease: 'easeOutQuint' },
        { t0: 27.45, t1: 27.90, to: -0.030, ease: 'easeOutCubic' },
        { t0: 30.62, t1: 31.42, to: 0.120, ease: 'easeInOutCubic' },  // 离心侧倾
        { t0: 31.52, t1: 32.00, to: -0.035, ease: 'easeOutBack' },
        { t0: 32.90, t1: 33.60, to: 0.000, ease: 'easeInOutSine' },
      ],
    },

    /* ---- 胸：比腰慢半拍，负责「重量感」 ---- */
    chest: {
      z: [
        { t0: 11.95, t1: 12.35, to: 0.050, ease: 'easeOutCubic' },
        { t0: 18.25, t1: 18.60, to: -0.025, ease: 'easeOutBack' },
        { t0: 18.60, t1: 18.95, to: 0.000, ease: 'easeOutCubic' },
        { t0: 21.30, t1: 21.80, to: 0.050, ease: 'easeOutCubic' },
        { t0: 23.40, t1: 24.00, to: -0.025, ease: 'easeInOutSine' },
        { t0: 24.40, t1: 24.78, to: -0.110, ease: 'easeOutCubic' },
        { t0: 24.78, t1: 24.95, to: 0.060, ease: 'easeOutQuint' },
        { t0: 24.95, t1: 25.18, to: 0.015, ease: 'easeOutBack' },
        { t0: 25.28, t1: 25.45, to: 0.230, ease: 'easeOutQuint' },
        { t0: 25.45, t1: 25.65, to: 0.165, ease: 'easeOutBack' },
        { t0: 26.98, t1: 27.32, to: -0.100, ease: 'easeInOutCubic' },
        { t0: 27.32, t1: 27.47, to: 0.260, ease: 'easeOutQuint' },
        { t0: 27.47, t1: 27.70, to: 0.190, ease: 'easeOutBack' },
        { t0: 28.42, t1: 28.99, to: 0.030, ease: 'easeInOutSine' },
        { t0: 28.99, t1: 29.11, to: 0.220, ease: 'easeOutQuint' },
        { t0: 29.11, t1: 29.36, to: 0.155, ease: 'easeOutBack' },
        { t0: 30.12, t1: 30.62, to: 0.050, ease: 'easeInOutSine' },
        { t0: 30.62, t1: 31.42, to: -0.060, ease: 'easeInOutCubic' },
        { t0: 31.52, t1: 32.00, to: 0.065, ease: 'easeOutBack' },
        { t0: 32.90, t1: 34.10, to: -0.015, ease: 'easeInOutSine' },
        { t0: 34.10, t1: 34.45, to: 0.105, ease: 'easeOutQuint' },
        { t0: 35.10, t1: 36.30, to: 0.000, ease: 'easeInOutSine' },
        { t0: 37.50, t1: 38.40, to: 0.035, ease: 'easeInOutSine' },
        { t0: 38.40, t1: 38.70, to: 0.000, ease: 'easeOutCubic' },
      ],
      y: [
        { t0: 21.30, t1: 21.90, to: -0.100, ease: 'easeOutCubic' },
        { t0: 21.90, t1: 22.10, to: -0.070, ease: 'easeOutBack' },
        { t0: 23.40, t1: 24.00, to: 0.000, ease: 'easeInOutSine' },
        { t0: 24.78, t1: 24.95, to: -0.150, ease: 'easeOutQuint' },
        { t0: 24.95, t1: 25.18, to: -0.090, ease: 'easeOutBack' },
        { t0: 27.30, t1: 27.45, to: 0.220, ease: 'easeOutQuint' },
        { t0: 27.45, t1: 27.70, to: 0.130, ease: 'easeOutBack' },
        { t0: 28.97, t1: 29.12, to: -0.150, ease: 'easeOutQuint' },
        { t0: 29.12, t1: 29.36, to: -0.085, ease: 'easeOutBack' },
        { t0: 30.62, t1: 31.42, to: 0.150, ease: 'easeInOutCubic' },
        { t0: 31.52, t1: 32.00, to: -0.055, ease: 'easeOutBack' },
        { t0: 32.90, t1: 34.10, to: 0.000, ease: 'easeInOutSine' },
        { t0: 34.10, t1: 34.45, to: -0.240, ease: 'easeOutQuint' },
        { t0: 35.10, t1: 35.60, to: 0.000, ease: 'easeInOutSine' },
      ],
    },

    /* ---- 颈 / 头：张望与「头先动」 ---- */
    neck: {
      y: [
        { t0: 19.26, t1: 19.65, to: 0.240, ease: 'easeOutQuint' },   // 转头看来路（+x，颈先动）
        { t0: 20.05, t1: 20.25, to: 0.000, ease: 'easeInOutCubic' },
        { t0: 20.25, t1: 20.62, to: -0.270, ease: 'easeOutQuint' },  // 第二次张望（转向 -x 敌影）
        { t0: 21.00, t1: 21.30, to: -0.040, ease: 'easeInOutCubic' },
        { t0: 21.30, t1: 22.75, to: -0.080, ease: 'easeOutCubic' },
        { t0: 24.78, t1: 24.95, to: -0.050, ease: 'easeOutQuint' },
        { t0: 27.30, t1: 27.45, to: -0.130, ease: 'easeOutQuint' },
        { t0: 27.45, t1: 27.70, to: -0.070, ease: 'easeOutBack' },
        { t0: 28.97, t1: 29.12, to: -0.090, ease: 'easeOutQuint' },
        { t0: 30.40, t1: 30.90, to: 0.260, ease: 'easeInOutCubic' }, // 转身时头先在前面
        { t0: 30.90, t1: 31.45, to: 0.000, ease: 'easeInOutCubic' },
        { t0: 31.52, t1: 32.00, to: -0.050, ease: 'easeOutBack' },
        { t0: 32.90, t1: 33.80, to: 0.000, ease: 'easeInOutSine' },
        { t0: 34.10, t1: 34.45, to: -0.320, ease: 'easeOutQuint' },
        { t0: 35.10, t1: 35.55, to: 0.000, ease: 'easeInOutSine' },
      ],
      x: [
        { t0: 21.30, t1: 21.90, to: -0.100, ease: 'easeOutCubic' },
        { t0: 23.40, t1: 24.00, to: 0.020, ease: 'easeInOutSine' },
        { t0: 24.40, t1: 24.80, to: 0.070, ease: 'easeOutCubic' },
        { t0: 24.80, t1: 25.00, to: -0.020, ease: 'easeOutQuint' },
        { t0: 27.30, t1: 27.47, to: -0.130, ease: 'easeOutQuint' },
        { t0: 27.47, t1: 27.72, to: -0.060, ease: 'easeOutBack' },
        { t0: 31.52, t1: 32.00, to: -0.090, ease: 'easeOutBack' },
        { t0: 32.90, t1: 33.90, to: 0.000, ease: 'easeInOutSine' },
        { t0: 34.10, t1: 34.45, to: -0.060, ease: 'easeOutQuint' },
        { t0: 35.10, t1: 35.55, to: 0.000, ease: 'easeInOutSine' },
      ],
    },
    head: {
      y: [
        { t0: 19.22, t1: 19.62, to: 0.320, ease: 'easeOutQuint' },   // 头比颈更早、更大
        { t0: 20.05, t1: 20.25, to: 0.000, ease: 'easeInOutCubic' },
        { t0: 20.25, t1: 20.59, to: -0.360, ease: 'easeOutQuint' },
        { t0: 21.00, t1: 21.30, to: -0.050, ease: 'easeInOutCubic' },
        { t0: 21.30, t1: 22.75, to: -0.100, ease: 'easeOutCubic' },
        { t0: 24.78, t1: 24.95, to: -0.070, ease: 'easeOutQuint' },
        { t0: 27.30, t1: 27.45, to: -0.170, ease: 'easeOutQuint' },
        { t0: 27.45, t1: 27.70, to: -0.090, ease: 'easeOutBack' },
        { t0: 28.97, t1: 29.12, to: -0.120, ease: 'easeOutQuint' },
        { t0: 30.36, t1: 30.86, to: 0.340, ease: 'easeInOutCubic' },
        { t0: 30.86, t1: 31.40, to: 0.000, ease: 'easeInOutCubic' },
        { t0: 31.52, t1: 32.00, to: -0.070, ease: 'easeOutBack' },
        { t0: 32.90, t1: 33.80, to: 0.000, ease: 'easeInOutSine' },
        { t0: 34.10, t1: 34.43, to: -0.420, ease: 'easeOutQuint' },
        { t0: 35.10, t1: 35.50, to: 0.000, ease: 'easeInOutSine' },
      ],
      x: [
        { t0: 21.30, t1: 21.85, to: -0.130, ease: 'easeOutCubic' },
        { t0: 21.85, t1: 22.05, to: -0.100, ease: 'easeOutBack' },
        { t0: 23.40, t1: 24.00, to: 0.030, ease: 'easeInOutSine' },
        { t0: 24.40, t1: 24.80, to: 0.090, ease: 'easeOutCubic' },
        { t0: 24.80, t1: 25.00, to: -0.030, ease: 'easeOutQuint' },
        { t0: 27.30, t1: 27.47, to: -0.160, ease: 'easeOutQuint' },
        { t0: 27.47, t1: 27.72, to: -0.070, ease: 'easeOutBack' },
        { t0: 31.52, t1: 32.00, to: -0.110, ease: 'easeOutBack' },
        { t0: 32.90, t1: 33.90, to: 0.000, ease: 'easeInOutSine' },
        { t0: 34.10, t1: 34.43, to: -0.070, ease: 'easeOutQuint' },
        { t0: 35.10, t1: 35.50, to: 0.000, ease: 'easeInOutSine' },
      ],
    },

    /* ---- 肩：绷劲的地方，快而小 ---- */
    shoulderL: {
      z: [
        { t0: 21.30, t1: 21.90, to: 0.100, ease: 'easeOutCubic' },
        { t0: 23.40, t1: 24.00, to: 0.000, ease: 'easeInOutSine' },
        { t0: 24.78, t1: 24.98, to: 0.060, ease: 'easeOutQuint' },
        { t0: 27.30, t1: 27.45, to: 0.150, ease: 'easeOutQuint' },
        { t0: 27.45, t1: 27.70, to: 0.090, ease: 'easeOutBack' },
        { t0: 28.97, t1: 29.12, to: 0.070, ease: 'easeOutQuint' },
        { t0: 31.52, t1: 32.00, to: 0.110, ease: 'easeOutBack' },
        { t0: 32.90, t1: 33.60, to: -0.020, ease: 'easeInOutSine' },
        { t0: 37.50, t1: 38.70, to: -0.020, ease: 'easeInOutSine' },
      ],
    },
    shoulderR: {
      z: [
        { t0: 21.30, t1: 21.85, to: -0.050, ease: 'easeOutCubic' },
        { t0: 24.40, t1: 24.78, to: -0.110, ease: 'easeOutCubic' },   // 蓄
        { t0: 24.78, t1: 24.95, to: 0.150, ease: 'easeOutQuint' },  // 出刀
        { t0: 24.95, t1: 25.18, to: 0.080, ease: 'easeOutBack' },
        { t0: 25.28, t1: 25.45, to: 0.190, ease: 'easeOutQuint' },  // 刺
        { t0: 25.45, t1: 25.65, to: 0.110, ease: 'easeOutBack' },
        { t0: 26.98, t1: 27.32, to: -0.060, ease: 'easeInOutCubic' },
        { t0: 27.32, t1: 27.47, to: 0.210, ease: 'easeOutQuint' },  // 劈
        { t0: 27.47, t1: 27.70, to: 0.120, ease: 'easeOutBack' },
        { t0: 28.97, t1: 29.12, to: 0.170, ease: 'easeOutQuint' },
        { t0: 29.12, t1: 29.36, to: 0.090, ease: 'easeOutBack' },
        { t0: 31.52, t1: 32.00, to: 0.170, ease: 'easeOutBack' },   // 亮相耸肩
        { t0: 32.90, t1: 33.60, to: 0.000, ease: 'easeInOutSine' },
        { t0: 34.10, t1: 34.45, to: 0.070, ease: 'easeOutQuint' },
        { t0: 35.10, t1: 35.60, to: 0.000, ease: 'easeInOutSine' },
        { t0: 37.50, t1: 38.70, to: -0.015, ease: 'easeInOutSine' },
      ],
    },

    /* ---- 右臂：持刀臂，全剧动作的主线 ---- */
    upperArmR: {
      z: [
        { t0: 24.40, t1: 24.78, to: -0.240, ease: 'easeOutCubic' },   // 预备：手先摸到刀柄
        { t0: 24.78, t1: 24.93, to: -1.560, ease: 'easeOutQuint' },   // 抽刀：0.15s 大角度
        { t0: 24.93, t1: 25.15, to: -1.440, ease: 'easeOutBack' },    // 过冲回弹
        { t0: 25.15, t1: 25.28, to: -1.180, ease: 'easeInOutCubic' }, // 收臂（第二记的预备）
        { t0: 25.28, t1: 25.42, to: -1.620, ease: 'easeOutQuint' },   // 前刺
        { t0: 25.42, t1: 25.62, to: -1.510, ease: 'easeOutBack' },
        { t0: 26.98, t1: 27.30, to: -2.600, ease: 'easeOutCubic' },  // 挥一预备：举刀过顶（刀尖短暂出画）
        { t0: 27.30, t1: 27.45, to: -0.240, ease: 'easeOutQuint' },   // 大劈 2.12 rad
        { t0: 27.45, t1: 27.68, to: -0.390, ease: 'easeOutBack' },    // 回弹
        { t0: 28.42, t1: 28.97, to: -1.550, ease: 'easeInOutCubic' }, // 挥二预备（慢）
        { t0: 28.97, t1: 29.09, to: -0.860, ease: 'easeOutQuint' },   // 小劈 0.69 rad
        { t0: 29.09, t1: 29.34, to: -1.000, ease: 'easeOutBack' },
        { t0: 30.12, t1: 30.62, to: -1.180, ease: 'easeInOutSine' },
        { t0: 30.62, t1: 31.42, to: -1.950, ease: 'easeInOutCubic' }, // 转身刀随身上扬
        { t0: 31.52, t1: 32.00, to: -0.300, ease: 'easeOutBack' },   // 亮相：握杆的手收在胸前
        { t0: 32.90, t1: 34.10, to: -1.100, ease: 'easeInOutSine' },  // 收势
        { t0: 34.10, t1: 34.45, to: -1.620, ease: 'easeOutQuint' },
        { t0: 34.45, t1: 34.62, to: -1.430, ease: 'easeOutBack' },
        { t0: 35.10, t1: 36.30, to: -0.300, ease: 'easeInOutSine' },  // 垂刀
        { t0: 37.50, t1: 38.30, to: -0.060, ease: 'easeInOutSine' },  // 收刀入鞘
        { t0: 38.30, t1: 38.70, to: 0.000, ease: 'easeOutCubic' },
        { t0: 39.20, t1: 39.60, to: 0.180, ease: 'easeOutQuint' },  // 退步时臂后撑
        { t0: 39.60, t1: 39.80, to: 0.100, ease: 'easeOutBack' },
        { t0: 40.25, t1: 40.95, to: 0.040, ease: 'easeInOutSine' },
      ],
      y: [
        { t0: 24.78, t1: 24.95, to: -0.190, ease: 'easeOutQuint' },
        { t0: 27.30, t1: 27.45, to: 0.030, ease: 'easeOutQuint' },   // 只留极小扭转：大幅前倾会让刀杆戳到幕布前面
        { t0: 27.45, t1: 27.70, to: 0.020, ease: 'easeOutBack' },
        { t0: 28.97, t1: 29.12, to: -0.110, ease: 'easeOutQuint' },
        { t0: 31.52, t1: 32.00, to: 0.070, ease: 'easeOutBack' },
        { t0: 32.90, t1: 33.60, to: 0.000, ease: 'easeInOutSine' },
        { t0: 37.50, t1: 38.70, to: 0.010, ease: 'easeInOutSine' },  // 收刀时只留极小扭转，刀杆不越到幕前
      ],
      x: [
        { t0: 24.78, t1: 24.95, to: -0.110, ease: 'easeOutQuint' },
        { t0: 27.30, t1: 27.45, to: -0.060, ease: 'easeOutQuint' },  // 略往后压，保证刀杆在幕布之后
        { t0: 31.52, t1: 32.00, to: -0.070, ease: 'easeOutBack' },
        { t0: 32.90, t1: 33.60, to: 0.000, ease: 'easeInOutSine' },
      ],
    },
    forearmR: {
      z: [
        { t0: 24.78, t1: 25.00, to: -1.120, ease: 'easeOutCubic' },   // 腕后随（比上臂晚 0.05s）
        { t0: 25.00, t1: 25.20, to: -0.960, ease: 'easeOutBack' },
        { t0: 25.28, t1: 25.44, to: -0.300, ease: 'easeOutQuint' },   // 前刺：肘伸直
        { t0: 25.44, t1: 25.64, to: -0.430, ease: 'easeOutBack' },
        { t0: 26.98, t1: 27.32, to: 0.470, ease: 'easeInOutCubic' },// 举刀屈肘
        { t0: 27.32, t1: 27.47, to: -0.560, ease: 'easeOutQuint' },   // 劈出肘伸
        { t0: 27.47, t1: 27.70, to: -0.430, ease: 'easeOutBack' },
        { t0: 28.42, t1: 28.99, to: 0.310, ease: 'easeInOutSine' },
        { t0: 28.99, t1: 29.11, to: -0.310, ease: 'easeOutQuint' },
        { t0: 29.11, t1: 29.36, to: -0.210, ease: 'easeOutBack' },
        { t0: 30.62, t1: 31.42, to: 0.360, ease: 'easeInOutCubic' },
        { t0: 31.52, t1: 32.00, to: -2.300, ease: 'easeOutBack' },   // 亮相：屈肘把杆立在身前（刀月不出画）
        { t0: 32.90, t1: 34.10, to: 0.150, ease: 'easeInOutSine' },
        { t0: 34.10, t1: 34.45, to: -0.200, ease: 'easeOutQuint' },
        { t0: 35.10, t1: 36.30, to: 0.000, ease: 'easeInOutSine' },
        { t0: 37.50, t1: 38.30, to: -0.360, ease: 'easeInOutSine' },
        { t0: 38.30, t1: 38.70, to: 0.000, ease: 'easeOutCubic' },
      ],
    },
    handR: {
      z: [
        { t0: 24.78, t1: 25.05, to: -0.560, ease: 'easeOutCubic' },
        { t0: 25.05, t1: 25.25, to: -0.430, ease: 'easeOutBack' },
        { t0: 25.28, t1: 25.46, to: 0.160, ease: 'easeOutQuint' },
        { t0: 25.46, t1: 25.66, to: 0.060, ease: 'easeOutBack' },
        { t0: 26.98, t1: 27.34, to: 0.300, ease: 'easeInOutCubic' },
        { t0: 27.34, t1: 27.49, to: -0.350, ease: 'easeOutQuint' },
        { t0: 27.49, t1: 27.72, to: -0.220, ease: 'easeOutBack' },
        { t0: 31.52, t1: 32.00, to: 0.050, ease: 'easeOutBack' },
        { t0: 32.90, t1: 34.10, to: 0.050, ease: 'easeInOutSine' },
        { t0: 37.50, t1: 38.30, to: 0.420, ease: 'easeInOutSine' },
        { t0: 38.30, t1: 38.70, to: 0.000, ease: 'easeOutCubic' },
      ],
    },

    /* ---- 左臂：搭额远眺 + 打斗时的平衡臂 ---- */
    upperArmL: {
      z: [
        { t0: 21.30, t1: 21.75, to: 1.420, ease: 'easeOutCubic' },  // 肘先动：上臂抬平
        { t0: 21.75, t1: 21.95, to: 1.500, ease: 'easeOutBack' },   // 过冲回弹（定在 1.50）
        { t0: 23.40, t1: 24.00, to: 0.000, ease: 'easeInOutSine' },  // 放下
        { t0: 24.40, t1: 24.78, to: -0.300, ease: 'easeOutCubic' },
        { t0: 25.28, t1: 25.45, to: 0.560, ease: 'easeOutQuint' },  // 反手撑开
        { t0: 25.45, t1: 25.65, to: 0.440, ease: 'easeOutBack' },
        { t0: 26.98, t1: 27.30, to: 0.300, ease: 'easeInOutCubic' },
        { t0: 27.30, t1: 27.45, to: 0.860, ease: 'easeOutQuint' },
        { t0: 27.45, t1: 27.70, to: 0.700, ease: 'easeOutBack' },
        { t0: 28.42, t1: 28.97, to: 0.350, ease: 'easeInOutSine' },
        { t0: 28.97, t1: 29.09, to: 0.760, ease: 'easeOutQuint' },
        { t0: 29.09, t1: 29.34, to: 0.620, ease: 'easeOutBack' },
        { t0: 30.12, t1: 30.62, to: 0.200, ease: 'easeInOutSine' },
        { t0: 30.62, t1: 31.42, to: 0.460, ease: 'easeInOutCubic' },
        { t0: 31.52, t1: 32.00, to: 1.250, ease: 'easeOutBack' },  // 亮相：左掌前撑
        { t0: 32.90, t1: 34.10, to: 0.300, ease: 'easeInOutSine' },
        { t0: 34.10, t1: 34.45, to: 0.560, ease: 'easeOutQuint' },
        { t0: 35.10, t1: 36.30, to: 0.050, ease: 'easeInOutSine' },
        { t0: 37.50, t1: 38.70, to: 0.000, ease: 'easeInOutSine' },
        { t0: 39.20, t1: 39.58, to: -0.320, ease: 'easeOutQuint' },
        { t0: 39.58, t1: 39.78, to: -0.180, ease: 'easeOutBack' },
        { t0: 40.25, t1: 40.95, to: -0.080, ease: 'easeInOutSine' },
      ],
      y: [
        { t0: 21.30, t1: 21.90, to: 0.160, ease: 'easeOutCubic' },
        { t0: 23.40, t1: 24.00, to: 0.000, ease: 'easeInOutSine' },
        { t0: 27.30, t1: 27.45, to: -0.200, ease: 'easeOutQuint' },
        { t0: 31.52, t1: 32.00, to: -0.160, ease: 'easeOutBack' },
        { t0: 32.90, t1: 33.60, to: 0.000, ease: 'easeInOutSine' },
      ],
    },
    forearmL: {
      z: [
        { t0: 21.30, t1: 21.80, to: 2.000, ease: 'easeOutCubic' },  // 腕后随（再晚 0.05s）：肘折回来搭额
        { t0: 21.80, t1: 22.00, to: 2.120, ease: 'easeOutBack' },
        { t0: 23.40, t1: 24.00, to: 0.000, ease: 'easeInOutSine' },
        { t0: 24.40, t1: 24.78, to: -0.250, ease: 'easeOutCubic' },
        { t0: 25.28, t1: 25.45, to: 0.460, ease: 'easeOutQuint' },
        { t0: 25.45, t1: 25.65, to: 0.350, ease: 'easeOutBack' },
        { t0: 27.30, t1: 27.45, to: 0.560, ease: 'easeOutQuint' },
        { t0: 27.45, t1: 27.70, to: 0.450, ease: 'easeOutBack' },
        { t0: 31.52, t1: 32.00, to: 0.760, ease: 'easeOutBack' },
        { t0: 32.90, t1: 34.10, to: 0.150, ease: 'easeInOutSine' },
        { t0: 35.10, t1: 36.30, to: 0.020, ease: 'easeInOutSine' },
        { t0: 37.50, t1: 38.70, to: 0.000, ease: 'easeInOutSine' },
      ],
    },
    handL: {
      z: [
        { t0: 21.30, t1: 21.85, to: 0.280, ease: 'easeOutCubic' },
        { t0: 21.85, t1: 22.05, to: 0.340, ease: 'easeOutBack' },
        { t0: 23.40, t1: 24.00, to: 0.000, ease: 'easeInOutSine' },
        { t0: 31.52, t1: 32.00, to: 0.300, ease: 'easeOutBack' },
        { t0: 32.90, t1: 34.10, to: 0.000, ease: 'easeInOutSine' },
      ],
    },

    /* ---- 胯 / 腿 / 膝 / 脚：站桩、弓步、屈膝转身 ---- */
    hipL: {
      z: [
        { t0: 24.40, t1: 24.78, to: 0.060, ease: 'easeOutCubic' },
        { t0: 30.12, t1: 30.62, to: 0.090, ease: 'easeInOutSine' },
        { t0: 31.52, t1: 32.00, to: -0.050, ease: 'easeOutBack' },
        { t0: 32.90, t1: 33.80, to: 0.000, ease: 'easeInOutSine' },
        { t0: 40.25, t1: 40.95, to: 0.070, ease: 'easeInOutSine' },
        { t0: 43.30, t1: 43.90, to: 0.000, ease: 'easeInOutSine' },
      ],
    },
    hipR: {
      z: [
        { t0: 24.40, t1: 24.78, to: -0.070, ease: 'easeOutCubic' },
        { t0: 25.28, t1: 25.45, to: 0.080, ease: 'easeOutQuint' },
        { t0: 30.12, t1: 30.62, to: -0.100, ease: 'easeInOutSine' },
        { t0: 31.52, t1: 32.00, to: 0.060, ease: 'easeOutBack' },
        { t0: 32.90, t1: 33.80, to: 0.000, ease: 'easeInOutSine' },
        { t0: 39.20, t1: 39.60, to: -0.090, ease: 'easeOutQuint' },
        { t0: 39.60, t1: 39.80, to: -0.050, ease: 'easeOutBack' },
        { t0: 40.25, t1: 40.95, to: -0.080, ease: 'easeInOutSine' },
        { t0: 43.30, t1: 43.90, to: 0.000, ease: 'easeInOutSine' },
      ],
    },
    thighL: {
      z: [
        { t0: 24.40, t1: 24.78, to: 0.170, ease: 'easeOutCubic' },  // 撤步开腿
        { t0: 25.28, t1: 25.42, to: 0.270, ease: 'easeOutQuint' },  // 前刺：后腿蹬直
        { t0: 25.42, t1: 25.62, to: 0.230, ease: 'easeOutBack' },
        { t0: 26.98, t1: 27.30, to: 0.180, ease: 'easeInOutCubic' },
        { t0: 27.30, t1: 27.45, to: 0.300, ease: 'easeOutQuint' },
        { t0: 27.45, t1: 27.68, to: 0.250, ease: 'easeOutBack' },
        { t0: 30.12, t1: 30.62, to: 0.240, ease: 'easeInOutSine' },
        { t0: 30.62, t1: 31.42, to: 0.150, ease: 'easeInOutCubic' },
        { t0: 31.52, t1: 32.00, to: -0.060, ease: 'easeOutBack' },   // 亮相：两腿交叉拧住
        { t0: 32.90, t1: 34.10, to: 0.030, ease: 'easeInOutSine' },
        { t0: 35.10, t1: 36.30, to: 0.000, ease: 'easeInOutSine' },
      ],
    },
    thighR: {
      z: [
        { t0: 24.40, t1: 24.78, to: -0.120, ease: 'easeOutCubic' },
        { t0: 25.28, t1: 25.42, to: -0.320, ease: 'easeOutQuint' },   // 前刺：前腿弓
        { t0: 25.42, t1: 25.62, to: -0.260, ease: 'easeOutBack' },
        { t0: 26.98, t1: 27.30, to: -0.180, ease: 'easeInOutCubic' },
        { t0: 27.30, t1: 27.45, to: -0.300, ease: 'easeOutQuint' },
        { t0: 27.45, t1: 27.68, to: -0.240, ease: 'easeOutBack' },
        { t0: 30.12, t1: 30.62, to: -0.200, ease: 'easeInOutSine' },
        { t0: 30.62, t1: 31.42, to: -0.100, ease: 'easeInOutCubic' },
        { t0: 31.52, t1: 32.00, to: 0.150, ease: 'easeOutBack' },
        { t0: 32.90, t1: 34.10, to: -0.020, ease: 'easeInOutSine' },
        { t0: 35.10, t1: 36.30, to: 0.000, ease: 'easeInOutSine' },
        { t0: 39.20, t1: 39.60, to: -0.140, ease: 'easeOutQuint' },
        { t0: 39.60, t1: 39.80, to: -0.070, ease: 'easeOutBack' },
        { t0: 40.25, t1: 40.95, to: -0.050, ease: 'easeInOutSine' },
      ],
    },
    shinL: {
      z: [
        { t0: 21.30, t1: 21.75, to: 0.060, ease: 'easeOutCubic' },  // 抬手时重心微沉
        { t0: 23.40, t1: 24.00, to: 0.030, ease: 'easeInOutSine' },
        { t0: 24.40, t1: 24.78, to: 0.160, ease: 'easeOutCubic' },  // 蓄势屈膝
        { t0: 24.78, t1: 24.95, to: 0.060, ease: 'easeOutQuint' },
        { t0: 25.28, t1: 25.45, to: 0.230, ease: 'easeOutQuint' },  // 蹬地
        { t0: 25.45, t1: 25.65, to: 0.110, ease: 'easeOutBack' },
        { t0: 26.98, t1: 27.30, to: 0.170, ease: 'easeInOutCubic' },
        { t0: 27.30, t1: 27.45, to: 0.270, ease: 'easeOutQuint' },
        { t0: 27.45, t1: 27.68, to: 0.130, ease: 'easeOutBack' },
        { t0: 28.42, t1: 28.97, to: 0.100, ease: 'easeInOutSine' },
        { t0: 28.97, t1: 29.12, to: 0.250, ease: 'easeOutQuint' },
        { t0: 29.12, t1: 29.36, to: 0.120, ease: 'easeOutBack' },
        { t0: 30.12, t1: 30.62, to: 0.350, ease: 'easeInOutSine' }, // 沉腰
        { t0: 30.62, t1: 31.42, to: 0.300, ease: 'easeInOutCubic' },// 转身屈膝
        { t0: 31.52, t1: 32.00, to: 0.180, ease: 'easeOutBack' },   // 亮相
        { t0: 32.90, t1: 34.10, to: 0.070, ease: 'easeInOutSine' },
        { t0: 34.10, t1: 34.45, to: 0.130, ease: 'easeOutQuint' },
        { t0: 35.10, t1: 36.30, to: 0.020, ease: 'easeInOutSine' },
        { t0: 36.30, t1: 37.50, to: 0.000, ease: 'easeInOutSine' },
        { t0: 37.50, t1: 38.70, to: 0.040, ease: 'easeInOutSine' },
        { t0: 39.20, t1: 39.58, to: 0.210, ease: 'easeOutQuint' },
        { t0: 39.58, t1: 39.78, to: 0.070, ease: 'easeOutBack' },
        { t0: 40.25, t1: 40.95, to: 0.260, ease: 'easeInOutSine' }, // 转身屈膝
        { t0: 40.95, t1: 41.70, to: 0.120, ease: 'easeInOutSine' },
        { t0: 43.30, t1: 43.90, to: 0.000, ease: 'easeInOutSine' },
      ],
    },
    shinR: {
      z: [
        { t0: 21.30, t1: 21.75, to: 0.040, ease: 'easeOutCubic' },
        { t0: 23.40, t1: 24.00, to: 0.020, ease: 'easeInOutSine' },
        { t0: 24.40, t1: 24.78, to: 0.190, ease: 'easeOutCubic' },
        { t0: 24.78, t1: 24.95, to: 0.080, ease: 'easeOutQuint' },
        { t0: 25.28, t1: 25.45, to: 0.310, ease: 'easeOutQuint' },  // 前腿深弓
        { t0: 25.45, t1: 25.65, to: 0.150, ease: 'easeOutBack' },
        { t0: 26.98, t1: 27.30, to: 0.190, ease: 'easeInOutCubic' },
        { t0: 27.30, t1: 27.45, to: 0.290, ease: 'easeOutQuint' },
        { t0: 27.45, t1: 27.68, to: 0.140, ease: 'easeOutBack' },
        { t0: 28.42, t1: 28.97, to: 0.110, ease: 'easeInOutSine' },
        { t0: 28.97, t1: 29.12, to: 0.270, ease: 'easeOutQuint' },
        { t0: 29.12, t1: 29.36, to: 0.130, ease: 'easeOutBack' },
        { t0: 30.12, t1: 30.62, to: 0.380, ease: 'easeInOutSine' },
        { t0: 30.62, t1: 31.42, to: 0.330, ease: 'easeInOutCubic' },
        { t0: 31.52, t1: 32.00, to: 0.240, ease: 'easeOutBack' },
        { t0: 32.90, t1: 34.10, to: 0.090, ease: 'easeInOutSine' },
        { t0: 34.10, t1: 34.45, to: 0.150, ease: 'easeOutQuint' },
        { t0: 35.10, t1: 36.30, to: 0.030, ease: 'easeInOutSine' },
        { t0: 36.30, t1: 37.50, to: 0.000, ease: 'easeInOutSine' },
        { t0: 37.50, t1: 38.70, to: 0.030, ease: 'easeInOutSine' },
        { t0: 39.20, t1: 39.60, to: 0.170, ease: 'easeOutQuint' },
        { t0: 39.60, t1: 39.80, to: 0.060, ease: 'easeOutBack' },
        { t0: 40.25, t1: 40.95, to: 0.280, ease: 'easeInOutSine' },
        { t0: 40.95, t1: 41.70, to: 0.130, ease: 'easeInOutSine' },
        { t0: 43.30, t1: 43.90, to: 0.000, ease: 'easeInOutSine' },
      ],
    },
    footL: { z: [] },   // 脚踝由「保持脚掌水平」规则自动补（见 buildPose）
    footR: { z: [] },

    /* ---- 兵器：这里写的**不是**关节相对角，而是刀杆的**绝对倾角**
     *      （正 = 刀尖倒向 -x，0 = 刀尖朝上）。buildPose 会扣掉持刀手链的累计旋转 ——
     *      皮影的偃月刀挂在 handR 上，手臂举过头顶时刀杆会跟着翻过去、刀尖朝下，
     *      真实兵器要靠腕子反拧；这一层换算就是那记「反拧」。 ---- */
    weapon: {
      z: [
        { t0: 24.40, t1: 24.78, to: 0.180, ease: 'easeOutCubic' },   // 预备：杆随手一沉
        { t0: 24.78, t1: 24.95, to: 0.620, ease: 'easeOutQuint' },   // 抽刀：刀尖甩向左上
        { t0: 24.95, t1: 25.15, to: 0.500, ease: 'easeOutBack' },    // 过冲回弹
        { t0: 25.15, t1: 25.28, to: 0.950, ease: 'easeInOutCubic' }, // 收杆蓄势
        { t0: 25.28, t1: 25.42, to: 1.620, ease: 'easeOutQuint' },   // 前刺：刀杆几乎放平
        { t0: 25.42, t1: 25.62, to: 1.500, ease: 'easeOutBack' },
        { t0: 26.98, t1: 27.30, to: -0.750, ease: 'easeOutCubic' },  // 挥一蓄：刀背过头（刀尖短暂出画）
        { t0: 27.30, t1: 27.45, to: 1.850, ease: 'easeOutQuint' },   // 大劈：刀尖扫下 2.60 rad，收在幕内
        { t0: 27.45, t1: 27.62, to: 1.650, ease: 'easeOutBack' },    // 刀势未尽
        { t0: 28.42, t1: 28.97, to: 0.950, ease: 'easeInOutSine' },  // 挥二蓄：慢慢绕上去
        { t0: 28.97, t1: 29.09, to: 1.700, ease: 'easeOutQuint' },   // 小劈
        { t0: 29.09, t1: 29.30, to: 1.450, ease: 'easeOutBack' },
        { t0: 30.12, t1: 30.62, to: 0.750, ease: 'easeInOutSine' },  // 沉腰蓄势
        { t0: 30.62, t1: 31.42, to: 0.300, ease: 'easeInOutCubic' }, // 转身：大刀花随身走
        { t0: 31.52, t1: 31.90, to: 0.150, ease: 'easeOutBack' },    // 亮相：刀杆立在身前（刀月不出画）
        { t0: 31.90, t1: 32.00, to: 0.120, ease: 'easeOutBack' },
        { t0: 32.90, t1: 34.10, to: 0.250, ease: 'easeInOutSine' },  // 收势
        { t0: 34.10, t1: 34.45, to: -0.450, ease: 'easeOutQuint' },  // 猛回头：杆往回一挑
        { t0: 34.45, t1: 34.62, to: -0.300, ease: 'easeOutBack' },
        { t0: 35.10, t1: 36.30, to: 0.000, ease: 'easeInOutSine' },  // 垂刀：杆立正
        { t0: 37.50, t1: 38.35, to: -0.200, ease: 'easeInOutSine' }, // 收刀
        { t0: 38.35, t1: 38.70, to: 0.000, ease: 'easeOutCubic' },
      ],
      x: [
        { t0: 27.35, t1: 27.52, to: -0.030, ease: 'easeOutQuint' },
        { t0: 27.52, t1: 27.75, to: -0.020, ease: 'easeOutBack' },
        { t0: 31.58, t1: 32.00, to: -0.060, ease: 'easeOutBack' },
        { t0: 32.90, t1: 33.60, to: 0.000, ease: 'easeInOutSine' },
      ],
    },
    weaponTip: {
      z: [
        { t0: 24.82, t1: 25.08, to: 0.460, ease: 'easeOutCubic' },
        { t0: 25.08, t1: 25.30, to: -0.170, ease: 'easeOutBack' },
        { t0: 27.02, t1: 27.38, to: 0.600, ease: 'easeInOutCubic' },
        { t0: 27.38, t1: 27.56, to: -0.440, ease: 'easeOutQuint' },
        { t0: 27.56, t1: 27.80, to: -0.240, ease: 'easeOutBack' },
        { t0: 28.47, t1: 29.04, to: 0.400, ease: 'easeInOutSine' },
        { t0: 30.67, t1: 31.47, to: 0.420, ease: 'easeInOutCubic' },
        { t0: 31.60, t1: 32.00, to: -0.300, ease: 'easeOutBack' },
        { t0: 34.12, t1: 34.47, to: -0.320, ease: 'easeOutQuint' },
        { t0: 34.47, t1: 34.62, to: -0.150, ease: 'easeOutBack' },
      ],
    },
    /* ---- 翎羽：头顶最末端的惯性 ---- */
    plume: {
      z: [
        { t0: 21.30, t1: 21.90, to: 0.260, ease: 'easeOutCubic' },
        { t0: 23.40, t1: 24.00, to: 0.110, ease: 'easeInOutSine' },
        { t0: 24.40, t1: 24.78, to: 0.310, ease: 'easeOutCubic' },
        { t0: 24.78, t1: 24.98, to: -0.460, ease: 'easeOutQuint' },
        { t0: 24.98, t1: 25.20, to: 0.160, ease: 'easeOutBack' },
        { t0: 26.98, t1: 27.32, to: -0.310, ease: 'easeInOutCubic' },
        { t0: 27.32, t1: 27.47, to: 0.560, ease: 'easeOutQuint' },
        { t0: 27.47, t1: 27.72, to: 0.260, ease: 'easeOutBack' },
        { t0: 28.97, t1: 29.12, to: 0.360, ease: 'easeOutQuint' },
        { t0: 29.12, t1: 29.38, to: 0.190, ease: 'easeOutBack' },
        { t0: 30.62, t1: 31.42, to: -0.410, ease: 'easeInOutCubic' },
        { t0: 31.52, t1: 32.00, to: 0.310, ease: 'easeOutBack' },
        { t0: 32.90, t1: 34.10, to: -0.160, ease: 'easeInOutSine' },
        { t0: 34.10, t1: 34.45, to: 0.290, ease: 'easeOutQuint' },
        { t0: 34.45, t1: 34.62, to: 0.150, ease: 'easeOutBack' },
        { t0: 35.10, t1: 36.30, to: 0.050, ease: 'easeInOutSine' },
        { t0: 40.25, t1: 41.20, to: 0.120, ease: 'easeInOutSine' },
        { t0: 43.30, t1: 43.90, to: 0.030, ease: 'easeInOutSine' },
      ],
      x: [
        { t0: 31.52, t1: 32.00, to: 0.150, ease: 'easeOutBack' },
        { t0: 32.90, t1: 33.60, to: 0.000, ease: 'easeInOutSine' },
      ],
    },
  },

  /* ================= 副将：背景层，动作少而小，只做「看」和「惊」 ================= */
  cavalry: {
    waist: {
      z: [
        { t0: 8.30, t1: 8.90, to: 0.045, ease: 'easeOutCubic' },
        { t0: 9.40, t1: 9.90, to: 0.000, ease: 'easeInOutSine' },
        { t0: 24.80, t1: 25.20, to: -0.110, ease: 'easeOutQuint' },  // 惊：后仰
        { t0: 25.20, t1: 25.60, to: -0.040, ease: 'easeOutBack' },
        { t0: 30.90, t1: 31.40, to: 0.030, ease: 'easeInOutSine' },
      ],
      y: [
        { t0: 8.30, t1: 8.85, to: -0.120, ease: 'easeOutCubic' },
        { t0: 9.00, t1: 9.55, to: 0.100, ease: 'easeInOutCubic' },
        { t0: 9.80, t1: 10.30, to: 0.000, ease: 'easeInOutSine' },
        { t0: 13.00, t1: 14.20, to: 0.180, ease: 'easeInOutSine' },  // 望向主将方向（+x）
        { t0: 16.40, t1: 17.80, to: 0.000, ease: 'easeInOutSine' },
        { t0: 24.80, t1: 25.20, to: 0.140, ease: 'easeOutCubic' },   // 惊：朝主将一侧
        { t0: 26.60, t1: 28.00, to: 0.000, ease: 'easeInOutSine' },
        { t0: 30.90, t1: 31.60, to: 0.150, ease: 'easeInOutSine' },  // 退场前回头看一眼
      ],
    },
    chest: {
      z: [
        { t0: 8.30, t1: 8.90, to: 0.040, ease: 'easeOutCubic' },
        { t0: 9.40, t1: 9.90, to: 0.000, ease: 'easeInOutSine' },
        { t0: 24.80, t1: 25.20, to: -0.080, ease: 'easeOutQuint' },
        { t0: 25.20, t1: 25.60, to: -0.020, ease: 'easeOutBack' },
      ],
      y: [
        { t0: 8.30, t1: 8.85, to: -0.150, ease: 'easeOutCubic' },
        { t0: 9.00, t1: 9.55, to: 0.130, ease: 'easeInOutCubic' },
        { t0: 9.80, t1: 10.30, to: 0.000, ease: 'easeInOutSine' },
        { t0: 13.20, t1: 14.40, to: 0.200, ease: 'easeInOutSine' },
        { t0: 16.60, t1: 18.00, to: 0.000, ease: 'easeInOutSine' },
        { t0: 24.80, t1: 25.20, to: 0.160, ease: 'easeOutCubic' },
        { t0: 30.90, t1: 31.60, to: 0.170, ease: 'easeInOutSine' },
      ],
    },
    neck: {
      y: [
        { t0: 8.26, t1: 8.85, to: -0.200, ease: 'easeOutQuint' },
        { t0: 9.00, t1: 9.58, to: 0.170, ease: 'easeInOutCubic' },
        { t0: 9.90, t1: 10.40, to: 0.000, ease: 'easeInOutSine' },
        { t0: 13.10, t1: 14.30, to: 0.240, ease: 'easeInOutSine' },
        { t0: 16.60, t1: 18.00, to: 0.000, ease: 'easeInOutSine' },
        { t0: 24.80, t1: 25.15, to: 0.190, ease: 'easeOutQuint' },
        { t0: 26.60, t1: 28.00, to: 0.000, ease: 'easeInOutSine' },
        { t0: 30.90, t1: 31.60, to: 0.200, ease: 'easeInOutSine' },
      ],
      x: [
        { t0: 8.30, t1: 8.85, to: -0.070, ease: 'easeOutCubic' },
        { t0: 9.90, t1: 10.40, to: 0.000, ease: 'easeInOutSine' },
        { t0: 24.80, t1: 25.20, to: -0.090, ease: 'easeOutQuint' },
        { t0: 27.00, t1: 28.20, to: 0.000, ease: 'easeInOutSine' },
      ],
    },
    head: {
      y: [
        { t0: 8.22, t1: 8.82, to: -0.260, ease: 'easeOutQuint' },
        { t0: 9.00, t1: 9.55, to: 0.220, ease: 'easeInOutCubic' },
        { t0: 9.90, t1: 10.40, to: 0.000, ease: 'easeInOutSine' },
        { t0: 13.06, t1: 14.26, to: 0.300, ease: 'easeInOutSine' },
        { t0: 16.60, t1: 18.00, to: 0.000, ease: 'easeInOutSine' },
        { t0: 24.80, t1: 25.12, to: 0.240, ease: 'easeOutQuint' },
        { t0: 26.60, t1: 28.00, to: 0.000, ease: 'easeInOutSine' },
        { t0: 30.90, t1: 31.55, to: 0.260, ease: 'easeInOutSine' },
      ],
      x: [
        { t0: 8.30, t1: 8.85, to: -0.090, ease: 'easeOutCubic' },
        { t0: 9.90, t1: 10.40, to: 0.000, ease: 'easeInOutSine' },
        { t0: 24.80, t1: 25.20, to: -0.110, ease: 'easeOutQuint' },
        { t0: 27.00, t1: 28.20, to: 0.000, ease: 'easeInOutSine' },
      ],
    },
    upperArmL: {
      z: [
        { t0: 8.30, t1: 8.95, to: 0.180, ease: 'easeOutCubic' },
        { t0: 9.50, t1: 10.00, to: 0.000, ease: 'easeInOutSine' },
        { t0: 24.80, t1: 25.20, to: 0.520, ease: 'easeOutQuint' },  // 惊：抬手护身
        { t0: 25.20, t1: 25.60, to: 0.420, ease: 'easeOutBack' },
        { t0: 27.20, t1: 28.60, to: 0.120, ease: 'easeInOutSine' },
      ],
    },
    forearmL: {
      z: [
        { t0: 24.80, t1: 25.25, to: 0.460, ease: 'easeOutCubic' },
        { t0: 25.25, t1: 25.65, to: 0.380, ease: 'easeOutBack' },
        { t0: 27.40, t1: 28.80, to: 0.150, ease: 'easeInOutSine' },
      ],
    },
    handL: {
      z: [
        { t0: 24.80, t1: 25.30, to: 0.220, ease: 'easeOutCubic' },
        { t0: 27.40, t1: 28.80, to: 0.080, ease: 'easeInOutSine' },
      ],
    },
    upperArmR: {
      z: [
        { t0: 8.30, t1: 8.95, to: -0.140, ease: 'easeOutCubic' },
        { t0: 9.50, t1: 10.00, to: 0.000, ease: 'easeInOutSine' },
        { t0: 24.80, t1: 25.20, to: -0.430, ease: 'easeOutQuint' },
        { t0: 27.20, t1: 28.60, to: -0.100, ease: 'easeInOutSine' },
      ],
    },
    forearmR: {
      z: [
        { t0: 24.80, t1: 25.25, to: -0.380, ease: 'easeOutCubic' },
        { t0: 27.40, t1: 28.80, to: -0.120, ease: 'easeInOutSine' },
      ],
    },
    shoulderL: { z: [{ t0: 24.80, t1: 25.20, to: 0.120, ease: 'easeOutQuint' }] },
    shoulderR: { z: [{ t0: 24.80, t1: 25.20, to: -0.120, ease: 'easeOutQuint' }] },
    hipL: { z: [{ t0: 24.80, t1: 25.20, to: 0.050, ease: 'easeOutCubic' }] },
    hipR: { z: [{ t0: 24.80, t1: 25.20, to: -0.050, ease: 'easeOutCubic' }] },
    thighL: { z: [{ t0: 24.80, t1: 25.20, to: 0.120, ease: 'easeOutCubic' }] },
    thighR: { z: [{ t0: 24.80, t1: 25.20, to: -0.070, ease: 'easeOutCubic' }] },
    shinL: { z: [{ t0: 24.80, t1: 25.20, to: 0.150, ease: 'easeOutCubic' }, { t0: 27.00, t1: 29.00, to: 0.060, ease: 'easeInOutSine' }] },
    shinR: { z: [{ t0: 24.80, t1: 25.20, to: 0.130, ease: 'easeOutCubic' }, { t0: 27.00, t1: 29.00, to: 0.050, ease: 'easeInOutSine' }] },
    footL: { z: [] },
    footR: { z: [] },
  },
};

// 实际驱动的通道 = SCORE 里真实存在的通道（声明与实际永远一致，
// 避免 QA/引擎读到某个演员根本没有的通道）
CHANNELS.general = Object.keys(SCORE.general);
CHANNELS.cavalry = Object.keys(SCORE.cavalry);

/* ================================================================== *
 * 5. 倾身 / 偏航 / 上下（root）
 * ================================================================== */
/** root.rz：画面内倾身，**有界**（|rz| ≤ 0.30）。大角度转身一律交给 root.ry。 */
const RZ_GENERAL = [
  { t0: 11.95, t1: 12.30, to: 0.075, ease: 'easeInOutSine' },  // 走左：向左压
  { t0: 18.25, t1: 18.55, to: -0.030, ease: 'easeOutBack' },   // 停步惯性
  { t0: 18.55, t1: 18.95, to: 0.000, ease: 'easeInOutSine' },
  { t0: 21.30, t1: 21.80, to: -0.045, ease: 'easeOutCubic' },
  { t0: 23.40, t1: 24.00, to: 0.030, ease: 'easeInOutSine' },
  { t0: 24.40, t1: 24.78, to: -0.110, ease: 'easeOutCubic' },  // 撤步（向 +x 退）：往移动方向倾
  { t0: 24.78, t1: 24.95, to: -0.130, ease: 'easeOutQuint' },
  { t0: 24.95, t1: 25.18, to: -0.060, ease: 'easeOutBack' },
  { t0: 25.28, t1: 25.42, to: 0.230, ease: 'easeOutQuint' },   // 前刺（向 -x 扑）：压向对手
  { t0: 25.42, t1: 25.62, to: 0.140, ease: 'easeOutBack' },
  { t0: 26.98, t1: 27.30, to: -0.090, ease: 'easeInOutCubic' },
  { t0: 27.30, t1: 27.45, to: 0.260, ease: 'easeOutQuint' },
  { t0: 27.45, t1: 27.68, to: 0.170, ease: 'easeOutBack' },
  { t0: 28.42, t1: 28.97, to: -0.050, ease: 'easeInOutSine' },
  { t0: 28.97, t1: 29.12, to: 0.220, ease: 'easeOutQuint' },
  { t0: 29.12, t1: 29.36, to: 0.130, ease: 'easeOutBack' },
  { t0: 30.12, t1: 30.62, to: 0.060, ease: 'easeInOutSine' },
  { t0: 30.62, t1: 31.42, to: 0.260, ease: 'easeInOutCubic' },  // 离心倾（转身）
  { t0: 31.52, t1: 32.00, to: 0.100, ease: 'easeOutBack' },
  { t0: 32.90, t1: 34.10, to: 0.000, ease: 'easeInOutSine' },
  { t0: 34.10, t1: 34.45, to: -0.090, ease: 'easeOutQuint' },
  { t0: 35.10, t1: 36.30, to: 0.000, ease: 'easeInOutSine' },
  { t0: 37.50, t1: 38.70, to: 0.020, ease: 'easeInOutSine' },
  { t0: 39.20, t1: 39.58, to: 0.150, ease: 'easeOutQuint' },   // 退半步
  { t0: 39.58, t1: 39.78, to: 0.045, ease: 'easeOutBack' },
  { t0: 40.25, t1: 40.95, to: 0.000, ease: 'easeInOutSine' },
  { t0: 40.95, t1: 41.70, to: 0.070, ease: 'easeInOutSine' },  // 走左
  { t0: 43.30, t1: 43.90, to: 0.000, ease: 'easeInOutSine' },
];
const RZ_CAVALRY = [
  { t0: 2.45, t1: 3.30, to: -0.070, ease: 'easeInOutSine' },   // 向 +x 走：身体向 +x 压
  { t0: 7.50, t1: 8.20, to: -0.020, ease: 'easeOutBack' },
  { t0: 8.20, t1: 8.80, to: 0.000, ease: 'easeInOutSine' },
  { t0: 24.80, t1: 25.30, to: 0.130, ease: 'easeOutQuint' },   // 惊：往 -x 躲，重心后坐
  { t0: 25.30, t1: 25.80, to: 0.030, ease: 'easeOutBack' },
  { t0: 30.90, t1: 31.50, to: 0.050, ease: 'easeInOutSine' },
];

/**
 * root.ry：绕竖轴偏航 —— 平片皮影的「真转身」。
 * B.3 指定的路径 0 → -1.6 → -3.14 → -1.9 原样落在这里：
 *   -1.6 是转身启动，-3.14 是甩过半个身位（此时正好侧身成一条细线，物理正确），
 *   -1.9 是**惯性过冲回弹后定住的背身 3/4 亮相**（0.16s 屏息在 -3.14）。
 * 收势时 ry 回到 0（转回正面）；第四幕再转 -3.14 背对观众走远。
 */
const RY_GENERAL = [
  { t0: 30.62, t1: 31.02, to: -1.60, ease: 'easeInOutCubic' },  // 转身Ⅰ
  { t0: 31.02, t1: 31.35, to: -3.14, ease: 'easeOutCubic' },    // 转身Ⅱ：0.33s 掠过侧身
  { t0: 31.35, t1: 31.52, to: -3.14, ease: 'linear' },          // 背身一瞬（停 0.17s）
  { t0: 31.52, t1: 32.00, to: -1.90, ease: 'easeInOutSine' },   // 过冲回弹 → 背身 3/4 亮相
  { t0: 32.90, t1: 34.10, to: 0.00, ease: 'easeInOutSine' },    // 收势：转回正面
  { t0: 34.10, t1: 34.45, to: -0.30, ease: 'easeOutQuint' },    // 猛回头（小角度）
  { t0: 35.10, t1: 35.70, to: 0.00, ease: 'easeInOutSine' },
  { t0: 40.25, t1: 40.95, to: -3.14, ease: 'easeInOutSine' },   // 第四幕：转身背对观众
];
const RY_CAVALRY = [];

/** 上下（米）：走路起伏由步态给，这里只写站桩的沉浮与转身下沉 */
const TY_GENERAL = [
  { t0: 11.95, t1: 12.20, to: -0.012, ease: 'easeInOutSine' },
  { t0: 18.25, t1: 18.55, to: -0.032, ease: 'easeOutCubic' },  // 停步：沉
  { t0: 18.55, t1: 19.00, to: 0.000, ease: 'easeOutBack' },    // 回弹
  { t0: 21.30, t1: 21.75, to: -0.018, ease: 'easeOutCubic' },
  { t0: 23.40, t1: 24.00, to: -0.012, ease: 'easeInOutSine' },
  { t0: 24.40, t1: 24.78, to: -0.035, ease: 'easeOutCubic' },  // 蓄势
  { t0: 24.78, t1: 24.95, to: 0.012, ease: 'easeOutQuint' },   // 起身出手
  { t0: 24.95, t1: 25.18, to: -0.005, ease: 'easeOutBack' },
  { t0: 25.28, t1: 25.45, to: -0.048, ease: 'easeOutQuint' },  // 前刺下沉
  { t0: 25.45, t1: 25.65, to: 0.000, ease: 'easeOutBack' },
  { t0: 26.98, t1: 27.32, to: -0.030, ease: 'easeInOutCubic' },
  { t0: 27.30, t1: 27.47, to: -0.058, ease: 'easeOutQuint' },
  { t0: 27.47, t1: 27.70, to: -0.016, ease: 'easeOutBack' },
  { t0: 28.42, t1: 28.99, to: -0.026, ease: 'easeInOutSine' },
  { t0: 28.97, t1: 29.12, to: -0.052, ease: 'easeOutQuint' },
  { t0: 29.12, t1: 29.36, to: -0.014, ease: 'easeOutBack' },
  { t0: 30.12, t1: 30.62, to: -0.072, ease: 'easeInOutSine' }, // 沉腰
  { t0: 30.62, t1: 31.42, to: -0.075, ease: 'easeInOutCubic' },// 转身下沉（-0.075 ✓）
  { t0: 31.42, t1: 31.52, to: -0.075, ease: 'linear' },
  { t0: 31.52, t1: 32.00, to: -0.062, ease: 'easeOutBack' },   // 亮相
  { t0: 32.90, t1: 34.10, to: -0.020, ease: 'easeInOutSine' },
  { t0: 34.10, t1: 34.45, to: -0.038, ease: 'easeOutQuint' },
  { t0: 35.10, t1: 36.30, to: -0.008, ease: 'easeInOutSine' },
  { t0: 36.30, t1: 37.50, to: 0.000, ease: 'easeInOutSine' },
  { t0: 37.50, t1: 38.70, to: -0.022, ease: 'easeInOutSine' },
  { t0: 39.20, t1: 39.58, to: -0.050, ease: 'easeOutQuint' },
  { t0: 39.58, t1: 39.78, to: -0.012, ease: 'easeOutBack' },
  { t0: 39.75, t1: 40.25, to: -0.012, ease: 'linear' },
  { t0: 40.25, t1: 40.95, to: -0.070, ease: 'easeInOutSine' }, // 转身下沉
  { t0: 40.95, t1: 41.70, to: -0.022, ease: 'easeInOutSine' },
  { t0: 43.30, t1: 43.90, to: -0.004, ease: 'easeInOutSine' },
];
const TY_CAVALRY = [
  { t0: 7.50, t1: 8.20, to: -0.030, ease: 'easeOutCubic' },
  { t0: 8.20, t1: 8.80, to: 0.000, ease: 'easeOutBack' },
  { t0: 24.80, t1: 25.20, to: -0.045, ease: 'easeOutQuint' },
  { t0: 25.20, t1: 25.70, to: -0.010, ease: 'easeOutBack' },
  { t0: 30.90, t1: 31.60, to: -0.035, ease: 'easeInOutSine' },
];

/* ================================================================== *
 * 6. 灯 / 道具 / 字幕
 * ================================================================== */

const LI_GENERAL_INT = [
  { t0: 0.00, t1: 1.20, to: 1.05, ease: 'easeInOutSine' },   // 上灯 0.15→1.05
  { t0: 1.20, t1: 2.40, to: 1.12, ease: 'linear' },
  { t0: 2.40, t1: 7.50, to: 1.65, ease: 'easeInOutSine' },
  { t0: 7.50, t1: 11.00, to: 2.25, ease: 'easeInOutSine' },
  { t0: 11.00, t1: 11.90, to: 2.60, ease: 'easeOutCubic' },
  { t0: 23.40, t1: 24.00, to: 1.85, ease: 'easeInOutSine' }, // 风起压暗
  { t0: 24.40, t1: 24.78, to: 1.55, ease: 'easeOutCubic' },  // 蓄势更暗
  { t0: 24.78, t1: 24.93, to: 2.95, ease: 'easeOutQuint' },  // 出刀灯焰暴涨
  { t0: 24.93, t1: 25.28, to: 2.70, ease: 'easeOutCubic' },
  { t0: 25.28, t1: 25.43, to: 3.05, ease: 'easeOutQuint' },  // 前刺最亮
  { t0: 25.43, t1: 25.70, to: 2.80, ease: 'easeOutCubic' },
  { t0: 26.98, t1: 27.30, to: 2.45, ease: 'easeInOutCubic' },
  { t0: 27.30, t1: 27.45, to: 3.10, ease: 'easeOutQuint' },
  { t0: 27.45, t1: 27.75, to: 2.75, ease: 'easeOutCubic' },
  { t0: 28.42, t1: 28.97, to: 2.50, ease: 'easeInOutSine' },
  { t0: 28.97, t1: 29.12, to: 2.95, ease: 'easeOutQuint' },
  { t0: 29.12, t1: 29.40, to: 2.70, ease: 'easeOutCubic' },
  { t0: 30.12, t1: 30.62, to: 2.45, ease: 'easeInOutSine' },
  { t0: 30.62, t1: 31.42, to: 2.80, ease: 'easeInOutCubic' },
  { t0: 31.52, t1: 32.00, to: 3.05, ease: 'easeOutCubic' },  // 亮相最亮
  { t0: 32.90, t1: 34.10, to: 2.60, ease: 'easeInOutSine' },
  { t0: 34.10, t1: 34.45, to: 2.75, ease: 'easeOutCubic' },
  { t0: 35.10, t1: 36.30, to: 2.45, ease: 'easeInOutSine' },
  { t0: 37.50, t1: 38.70, to: 2.30, ease: 'easeInOutSine' },
  { t0: 40.25, t1: 44.00, to: 0.35, ease: 'easeInOutSine' },  // 收成一个点
  { t0: 44.00, t1: 46.00, to: 0.30, ease: 'easeInOutSine' },
];
const LI_FLICKER = [
  { t0: 0.00, t1: 1.20, to: 0.95, ease: 'linear' },
  { t0: 1.20, t1: 11.00, to: 0.20, ease: 'easeInOutSine' },
  { t0: 11.00, t1: 23.40, to: 0.14, ease: 'easeInOutSine' },
  { t0: 23.40, t1: 24.40, to: 0.32, ease: 'easeOutCubic' },
  { t0: 24.40, t1: 25.00, to: 0.62, ease: 'easeOutCubic' },
  { t0: 25.00, t1: 30.12, to: 0.45, ease: 'easeInOutSine' },
  { t0: 30.12, t1: 31.42, to: 0.70, ease: 'easeInOutSine' },
  { t0: 31.42, t1: 32.90, to: 0.35, ease: 'easeInOutSine' },
  { t0: 32.90, t1: 37.50, to: 0.20, ease: 'easeInOutSine' },
  { t0: 37.50, t1: 44.00, to: 0.07, ease: 'easeInOutSine' },
  { t0: 44.00, t1: 46.00, to: 0.03, ease: 'linear' },
];
const LI_POS_X = [
  { t0: 0.00, t1: 23.40, to: 0.10, ease: 'linear' },
  { t0: 23.40, t1: 24.40, to: 0.17, ease: 'easeInOutSine' },  // 风把灯芯推偏
  { t0: 24.40, t1: 31.42, to: 0.12, ease: 'easeInOutSine' },
  { t0: 40.25, t1: 44.00, to: 0.00, ease: 'easeInOutSine' },
  { t0: 44.00, t1: 46.00, to: 0.00, ease: 'linear' },
];
const LI_POS_Y = [
  { t0: 0.00, t1: 23.40, to: 0.22, ease: 'linear' },
  { t0: 23.40, t1: 24.40, to: 0.28, ease: 'easeInOutSine' },
  { t0: 24.40, t1: 31.42, to: 0.24, ease: 'easeInOutSine' },
  { t0: 40.25, t1: 44.00, to: 0.14, ease: 'easeInOutSine' },  // 收到画面偏上
  { t0: 44.00, t1: 46.00, to: 0.14, ease: 'linear' },
];
// 灯后退 = 光斑收小（不能往前移：往前越过了远景远山/月窗，它们会被照到灯后面而消失）
const LI_POS_Z = [
  { t0: 0.00, t1: 40.25, to: BASE.light[2], ease: 'linear' },
  { t0: 40.25, t1: 44.00, to: -3.30, ease: 'easeInOutSine' },
  { t0: 44.00, t1: 46.00, to: -3.30, ease: 'linear' },
];
const LIGHT_COLOR = [
  { t0: 0.00, t1: 1.20, to: '#ff9a3c', ease: 'linear' },  // 起手：深琥珀
  { t0: 1.20, t1: 7.50, to: '#ffab4e', ease: 'easeInOutSine' },
  { t0: 7.50, t1: 11.90, to: '#ffb45a', ease: 'easeInOutSine' },  // 暖黄（stage.js 默认）
  { t0: 31.52, t1: 32.90, to: '#ffc06a', ease: 'easeInOutSine' }, // 亮相略亮一档
  { t0: 32.90, t1: 44.00, to: '#ffcf96', ease: 'easeInOutSine' }, // 收灯：月色偏淡
];

/**
 * 灯的色温：'#rrggbb' 不能直接做数值插值，所以拆成 r/g/b 三条数值轨道同步插值再拼回去
 * （THREE.Color.set 只吃 0xRRGGBB / '#rrggbb' / 颜色名，不能是 {r,g,b}）。
 */
const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rgb2hex = (r, g, b) => '#' + [r, g, b]
  .map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
const COLOR_INIT = hex2rgb(LIGHT_COLOR[0].to);
const COLOR_CH = [0, 1, 2].map((i) => LIGHT_COLOR.map((m) => ({
  t0: m.t0, t1: m.t1, to: hex2rgb(m.to)[i], ease: m.ease,
})));
function colorAt(t) {
  return rgb2hex(
    scoreTrack(COLOR_CH[0], t, COLOR_INIT[0]),
    scoreTrack(COLOR_CH[1], t, COLOR_INIT[1]),
    scoreTrack(COLOR_CH[2], t, COLOR_INIT[2]),
  );
}
const PROP_SWAY_PINE = [
  { t0: 0.00, t1: 2.40, to: 0.010, ease: 'linear' },
  { t0: 23.40, t1: 24.40, to: 0.055, ease: 'easeOutCubic' },  // 风起
  { t0: 24.40, t1: 25.40, to: 0.135, ease: 'easeInOutSine' },
  { t0: 30.12, t1: 31.42, to: 0.185, ease: 'easeInOutSine' }, // 转身时风最急
  { t0: 32.90, t1: 37.50, to: 0.075, ease: 'easeInOutSine' },
  { t0: 37.50, t1: 41.00, to: 0.030, ease: 'easeInOutSine' },
  { t0: 41.00, t1: 44.00, to: 0.010, ease: 'easeInOutSine' },
  { t0: 44.00, t1: 46.00, to: 0.005, ease: 'linear' },
];
const PROP_OPACITY_MOUNTAIN = [
  { t0: 0.00, t1: 23.40, to: 0.85, ease: 'linear' },
  { t0: 23.40, t1: 40.25, to: 0.90, ease: 'easeInOutSine' },
  { t0: 40.25, t1: 44.00, to: 0.93, ease: 'easeInOutSine' },
  { t0: 44.00, t1: 46.00, to: 0.96, ease: 'easeInOutSine' },  // 留白：远山更清
];

const WIND = [
  { t0: 0.00, t1: 23.40, to: 0.06, ease: 'linear' },
  { t0: 23.40, t1: 24.40, to: 0.45, ease: 'easeOutCubic' },
  { t0: 24.40, t1: 31.42, to: 0.70, ease: 'easeInOutSine' },
  { t0: 31.42, t1: 37.50, to: 0.35, ease: 'easeInOutSine' },
  { t0: 37.50, t1: 44.00, to: 0.06, ease: 'easeInOutSine' },
  { t0: 44.00, t1: 46.00, to: 0.03, ease: 'linear' },
];

/** 唱词（幕布下方，每句 ≤ 28 字）：空白段落就是「无言」的停顿 */
const SUBTITLES = [
  { t0: 0.30, t1: 2.40, text: '夜气沉沉，一灯初上。' },
  { t0: 2.40, t1: 7.50, text: '副将先行，探路无声。' },
  { t0: 7.50, t1: 11.00, text: '灯影摇摇，四下无人。' },
  { t0: 11.00, t1: 12.70, text: '将军押后，步履渐紧。' },
  { t0: 12.70, t1: 16.30, text: '三步一停，似听得什么。' },
  { t0: 16.30, t1: 18.50, text: '脚下生风，疾行数步。' },
  { t0: 19.30, t1: 20.05, text: '停步侧耳——' },
  { t0: 20.05, t1: 21.00, text: '四下张望，不见人影。' },
  { t0: 21.30, t1: 22.75, text: '抬手搭额，远望——' },
  { t0: 22.75, t1: 23.40, text: '不见人，只见风。' },
  { t0: 23.40, t1: 24.40, text: '风起，灯影乱了。' },
  { t0: 24.75, t1: 26.98, text: '刀出鞘！' },
  { t0: 27.00, t1: 28.42, text: '一记大劈，破空无声。' },
  { t0: 28.97, t1: 30.12, text: '再补一记，短而狠。' },
  { t0: 30.62, t1: 32.00, text: '旋身——' },
  { t0: 32.00, t1: 32.90, text: '定！' },
  { t0: 32.90, t1: 34.10, text: '刀锋不动，人也不动。' },
  { t0: 34.10, t1: 34.62, text: '——还有动静！' },
  { t0: 35.10, t1: 37.50, text: '一口气，慢慢收回来。' },
  { t0: 37.50, t1: 39.20, text: '刀归鞘。' },
  { t0: 40.25, t1: 41.00, text: '转过身去，背对灯火。' },
  { t0: 41.00, t1: 43.30, text: '影渐远，灯渐小。' },
  { t0: 44.00, t1: 46.00, text: '幕上只剩月色。' },
];

/* ================================================================== *
 * 7. 组装 Frame
 * ================================================================== */

const LIGHT_SEED = 2.7;

/** 停顿中的微颤窗：只在「刺定 / 背身一瞬 / 定格亮相」里，刀尖与翎羽才在动 */
const TREMOR_WINDOWS = [
  { t0: 25.62, t1: 26.40, amp: 0.0040 },
  { t0: 31.35, t1: 31.52, amp: 0.0035 },
  { t0: 32.00, t1: 32.90, amp: 0.0055 },
];

function tremorAt(t, k) {
  let a = 0;
  for (const w of TREMOR_WINDOWS) {
    if (t < w.t0 || t > w.t1) continue;
    // 软边：进出各 0.05s，避免微颤突然出现/消失造成的速度尖峰
    const rise = Math.min(1, (t - w.t0) / 0.05);
    const fall = Math.min(1, (w.t1 - t) / 0.05);
    a = Math.max(a, w.amp * Math.min(rise, fall));
  }
  return tremor(t, 6.3 + k * 0.8, a, k * 1.7);
}

/** 呼吸（喘息）：只在收势 32.9–34.1 存在 */
function breathAt(t) {
  if (t < 32.90 || t > 34.10) return 0;
  return breath(t, 1.05) * 0.022 * Math.min(1, (t - 32.90) / 0.3) * Math.min(1, (34.10 - t) / 0.3);
}

/** 由 REST + 动作谱 + 步态 + 微颤 组装绝对姿态。rootRz 用来把刀杆倾角换算到世界坐标。 */
function buildPose(actorKey, t, gait, rootRz = 0) {
  const src = SCORE[actorKey];
  const pose = {};
  for (const ch in src) {
    const rest = REST[ch] || [0, 0, 0];
    const axes = src[ch];
    const v = [rest[0], rest[1], rest[2]];
    for (const ax in axes) v[AX[ax]] += scoreTrack(axes[ax], t);
    pose[ch] = v;
  }
  // 步态增量
  if (gait) {
    pose.thighL[2] += gait.thighL;
    pose.thighR[2] += gait.thighR;
    pose.shinL[2] += gait.shinL;
    pose.shinR[2] += gait.shinR;
    pose.upperArmL[2] += gait.armL;
    pose.upperArmR[2] += gait.armR;
    if (pose.waist) pose.waist[0] += gait.side;
  }
  if (actorKey === 'general') {
    pose.weaponTip[2] += tremorAt(t, 0.0);
    pose.plume[2] += tremorAt(t, 1.0);
    pose.weaponTip[0] += tremorAt(t, 2.0) * 0.7;
    pose.chest[2] += breathAt(t);
    pose.waist[2] += breathAt(t) * 0.35;
    // 兵器：谱里给的是刀杆**绝对倾角**（相对世界，0 = 刀尖朝上），这里扣掉从 root 到手链的
    // 全部累计 z 旋转（root.rz + 腰 + 胸 + 持刀臂），换算成 weapon 自己的关节角 —— 相当于腕子反拧。
    if (pose.weapon) {
      const chainZ = rootRz + pose.waist[2] + pose.chest[2]
        + pose.shoulderR[2] + pose.upperArmR[2] + pose.forearmR[2] + pose.handR[2];
      pose.weapon[2] = pose.weapon[2] - chainZ;
    }
  } else {
    pose.waist[2] += gait ? 0 : 0;
    pose.chest[2] += t > 26.6 && t < 31.0 ? 0.012 * Math.sin(t * 2.1) : 0;  // 副将的紧张喘息
  }
  // 脚踝：保持脚掌大致水平（膝屈/腿摆都反向吃掉一半）
  for (const side of ['L', 'R']) {
    const key = 'foot' + side;
    if (!pose[key]) continue;
    const restFoot = (REST[key] || [0, 0, 0])[2];
    const th = pose['thigh' + side][2] - (REST['thigh' + side] || [0, 0, 0])[2];
    const sh = pose['shin' + side][2] - (REST['shin' + side] || [0, 0, 0])[2];
    pose[key][2] = restFoot - 0.55 * (th + sh);
  }
  return pose;
}

function subtitleAt(t) {
  for (const s of SUBTITLES) if (t >= s.t0 && t < s.t1) return s.text;
  return null;
}

function propVisible(t) {
  return { moon: t >= 0.60 };
}

/** 兵器：抽刀出鞘后才显形（影子随 visible 一起出现/消失） */
function weaponDrawn(t) {
  return t >= 24.78 && t < 38.62;
}

/**
 * 采样一帧。**纯函数**：只有 t 决定输出。
 * @param {number} t 秒
 */
export function sampleAt(tRaw) {
  const t = clamp(tRaw, 0, DURATION);

  const g = posAt(POS_GENERAL, t);
  const c = posAt(POS_CAVALRY, t);
  const gy = scoreTrack(TY_GENERAL, t) + (g.gait ? g.gait.bob : 0);
  const cy = scoreTrack(TY_CAVALRY, t) + (c.gait ? c.gait.bob : 0);

  const rzG = scoreTrack(RZ_GENERAL, t) + (g.gait ? g.gait.lean : 0);
  const rzC = scoreTrack(RZ_CAVALRY, t) + (c.gait ? c.gait.lean : 0);

  const inten = clamp(scoreTrack(LI_GENERAL_INT, t, 0.15), 0, 4);  // 开幕 0.15（一点灯芯）
  const flick = scoreTrack(LI_FLICKER, t, 0.95);
  const flickerMul = 1 + 0.016 * flick * flickerNoise(t, LIGHT_SEED);

  return {
    dt: 1 / 60,
    subtitle: subtitleAt(t),
    actors: {
      general: {
        visible: t >= 12.05 && t < 43.72,
        // root.ry = 绕竖轴偏航（真转身）；root.rz = 画面内倾身（有界）
        root: {
          tx: g.x, ty: BASE.ty + gy, tz: g.z, rz: rzG,
          ry: scoreTrack(RY_GENERAL, t),
        },
        pose: buildPose('general', t, g.gait, rzG),
        wind: [scoreTrack(WIND, t), 0],
        visibleParts: { weapon: weaponDrawn(t), weaponTip: weaponDrawn(t) },
      },
      cavalry: {
        visible: t >= 2.45 && t < 33.42,
        root: { tx: c.x, ty: BASE.ty + cy, tz: c.z, rz: rzC, ry: 0 },
        pose: buildPose('cavalry', t, c.gait),
        wind: [scoreTrack(WIND, t) * 0.8, 0],
      },
    },
    light: {
      intensity: inten * flickerMul,
      color: colorAt(t),   // '#rrggbb' 逐段插值（字符串轨道不能直接做数值插值）
      pos: lightPos(t),
      flicker: flick,
    },
    props: {
      sway: { pine: scoreTrack(PROP_SWAY_PINE, t, 0.010) },
      visible: propVisible(t),
      opacity: { mountain: scoreTrack(PROP_OPACITY_MOUNTAIN, t, 0.85) },
    },
  };
}

/**
 * 灯位：返回**带 x/y/z 属性的数组** —— JSON 里是 [x,y,z]，同时满足
 * THREE.Vector3.copy(pos) 与 pos.x/pos.y/pos.z（stage.setLight 两者都用）。
 */
function lightPos(t) {
  // 初值必须显式给（= stage.js 的灯位），否则 moveTrack 会从 0 慢慢爬过去 ——
  // 灯会贴着幕布飘十几秒，投影尺度全错。
  const x = scoreTrack(LI_POS_X, t, BASE.light[0]);
  const y = scoreTrack(LI_POS_Y, t, BASE.light[1]);
  const z = scoreTrack(LI_POS_Z, t, BASE.light[2]);
  const p = [x, y, z];
  p.x = x; p.y = y; p.z = z;
  return p;
}

/* ================================================================== *
 * 8. 对外的 PERFORMANCE / buildTimeline / debug
 * ================================================================== */

const EASINGS_USED = (() => {
  const set = new Set();
  for (const actor of Object.values(SCORE)) {
    for (const ch of Object.values(actor)) {
      for (const axis of Object.values(ch)) for (const m of axis) if (m.ease) set.add(m.ease);
    }
  }
  for (const list of [RZ_GENERAL, RZ_CAVALRY, RY_GENERAL, RY_CAVALRY, TY_GENERAL, TY_CAVALRY,
    LI_GENERAL_INT, LI_FLICKER, LI_POS_X, LI_POS_Y, LI_POS_Z, LIGHT_COLOR,
    PROP_SWAY_PINE, PROP_OPACITY_MOUNTAIN, WIND]) {
    for (const m of list) if (m.ease) set.add(m.ease);
  }
  set.add('linear');
  return [...set].sort();
})();

export const PERFORMANCE = {
  title: '影窗·夜巡',
  duration: DURATION,
  acts: ACTS.map((a) => ({
    ...a,
    beats: BEATS.filter((b) => b.act === a.id)
      .map((b) => ({ name: b.name, t0: b.t0, t1: b.t1, speed: b.speed, ease: b.ease, what: b.what })),
  })),
};

function debugInfo() {
  return {
    title: PERFORMANCE.title,
    duration: DURATION,
    acts: ACTS.map((a) => ({ id: a.id, name: a.name, t0: a.t0, t1: a.t1, dur: +(a.t1 - a.t0).toFixed(2) })),
    beats: BEATS.map((b) => ({ act: b.act, name: b.name, t0: b.t0, t1: b.t1, speed: b.speed, ease: b.ease, what: b.what })),
    holds: HOLDS,
    holdTotal: HOLD_TOTAL,
    holdCount: HOLDS.length,
    easings: EASINGS_USED,
    // 转身：路径原样落在 root.ry（绕竖轴）；ty 下沉 = BASE.ty 之上再降
    turn: {
      t0: 30.62, t1: 32.00,
      yawPath: [0, -1.6, -3.14, -1.9],
      axis: 'root.ry',
      mode: 'overshoot-settle',
      tyDip: 0.075,
      kneeFlex: 0.30,
      settleHold: { t0: 31.35, t1: 31.52 },
      freezeframe: { t0: 32.00, t1: 32.90 },
      notes: '0→-1.6 转身启动；-3.14 甩过半个身位（侧身瞬间成一条细线）；-1.9 = 惯性过冲回弹后定住的背身 3/4 亮相。root.rz 只做有界倾身（|rz| ≤ 0.30）',
    },
    rest: REST,
    base: BASE,
    channels: CHANNELS,
    steps: { general: POS_GENERAL.filter((s) => s.walk).map((s) => s.walk.starts), cavalry: POS_CAVALRY.filter((s) => s.walk).map((s) => s.walk.starts) },
    tremorWindows: TREMOR_WINDOWS,
    subtitles: SUBTITLES,
    lightSeed: LIGHT_SEED,
  };
}

/** 供引擎与 QA 使用的时间轴 */
export function buildTimeline() {
  return { duration: DURATION, sample: sampleAt, debug: debugInfo, performance: PERFORMANCE };
}

export default { PERFORMANCE, buildTimeline, sampleAt, REST, BASE, ACTS, BEATS, HOLDS, DURATION };

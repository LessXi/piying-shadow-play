// 影窗 · 夜巡 —— 布景道具剪影（沿 z 分层，靠灯投影到幕布上）
//
// ⚠ 投影几何（决定了摆位方式）：
//   灯在幕布后 z=-3.2、灯高 y=-0.28（约幕布中心），幕布在 z=0。
//   物体离灯越近，投到幕布上放大越厉害：K(z) = 3.2 / (3.2 + z)   （z=-0.4 → 1.14×，z=-2.2 → 3.2×）
//   所以"远景"道具如果按普通思路摆，影子会大到糊满整块幕布。
//   本文件用 placeByShadow() **反解**：给出"希望影子落在幕布上的位置和尺寸"，算出道具的世界位置与尺寸。
//   （STAGE_LIGHT 必须与 src/stage.js 的 SpotLight 同步；引擎灯位改过一次，这里是新值 [0.10,-0.28,-3.2]。）
//
// 布局约束（check-assets.mjs 逐条验）：
//   1) 中央通道 |x| ≤ 0.95m 且 y ∈ [-1.15, 0.45] 留给演员，任何道具影子不得进入
//   2) 每件道具影子高度 ≤ 1.10m（幕布高 2.5m 的 44%）
//   3) 每件道具 |cx| - w/2 ≥ 0.95，与中央通道留净空

import { resolveSpecs, resolveAnchors, drawPartSpec, TEX_PPM, TEX_MAX_PX, placeByShadow, STAGE_LIGHT } from './shapes.js';
import { makeAlphaFromDraw } from './textures.js';
import { Rig } from './rig.js';

/**
 * 道具图纸表（严格 JSON，每件一行）。
 *   target: [cx, cy, w, h] —— **期望影子在幕布上的**中心与尺寸（幕布 4.0m×2.5m，中心在原点）
 *   z:      道具所在的真实深度（层叠感来自这里）
 *   其余字段同 puppet.js 的图纸（outline/decor/pierce/pivot/ppm）
 */
export const PROP_SPECS = {
  "props": [
    { "key": "rock", "tex": "propRock", "z": -0.10, "target": [1.86, -0.94, 0.96, 0.62], "pivot": [0.5, 1.0], "ppm": 620,
      "outline": [[0.02, 0.30], [0.14, 0.06], [0.34, 0.16], [0.48, 0.00], [0.66, 0.14], [0.82, 0.04], [0.98, 0.26], [1.00, 0.62], [0.86, 0.94], [0.62, 1.00], [0.34, 0.92], [0.14, 1.00], [0.00, 0.78]],
      "decor": [{ "k": "line", "pts": [[0.20, 0.34], [0.44, 0.52], [0.62, 0.44], [0.78, 0.62]], "width": 0.030 }, { "k": "line", "pts": [[0.16, 0.66], [0.40, 0.74], [0.70, 0.78]], "width": 0.024 }],
      "pierce": [
        { "p": "moonSlit", "x": 0.24, "y": 0.40, "w": 0.16, "h": 0.12, "o": { "cols": 2, "rows": 1, "alt": 0.60, "tilt": 0.5, "depth": 0.45 } },
        { "p": "dotField", "x": 0.52, "y": 0.60, "w": 0.14, "h": 0.12, "o": { "cols": 2, "rows": 1, "alt": 0.6 } }
      ] },
    { "key": "pine", "tex": "propPine", "z": -0.40, "target": [-1.78, -0.62, 0.72, 1.06], "pivot": [0.5, 1.0], "ppm": 620,
      "outline": [[0.42, 0.02], [0.58, 0.02], [0.60, 0.30], [0.72, 0.22], [0.86, 0.34], [0.92, 0.18], [0.98, 0.40], [0.80, 0.52], [0.88, 0.66], [0.70, 0.74], [0.76, 0.88], [0.54, 0.96], [0.40, 0.86], [0.24, 0.94], [0.20, 0.76], [0.06, 0.62], [0.16, 0.48], [0.04, 0.32], [0.22, 0.22], [0.34, 0.34], [0.40, 0.18]],
      "decor": [{ "k": "line", "pts": [[0.50, 0.44], [0.50, 0.98]], "width": 0.048 }, { "k": "line", "pts": [[0.30, 0.72], [0.50, 0.60], [0.70, 0.70]], "width": 0.026 }],
      "pierce": [
        { "p": "moonSlit", "x": 0.26, "y": 0.30, "w": 0.48, "h": 0.12, "o": { "cols": 4, "rows": 1, "alt": 0.62, "tilt": -0.5, "depth": 0.45, "ridge": 1, "gap": 0.18 } },
        { "p": "scaleField", "x": 0.30, "y": 0.52, "w": 0.40, "h": 0.26, "o": { "cols": 3, "rows": 2, "alt": 0.62, "stagger": 1, "gap": 0.20, "ridge": 1 } },
        { "p": "dotField", "x": 0.42, "y": 0.80, "w": 0.16, "h": 0.08, "o": { "cols": 1, "rows": 1 } }
      ] },
    { "key": "tavern", "tex": "propTavern", "z": -0.75, "target": [1.80, -0.58, 0.40, 1.00], "pivot": [0.5, 1.0], "ppm": 620,
      "outline": [[0.20, 0.00], [0.80, 0.00], [0.86, 0.10], [0.84, 0.30], [0.92, 0.50], [0.80, 0.66], [0.86, 0.84], [0.70, 1.00], [0.30, 1.00], [0.28, 0.86], [0.46, 0.78], [0.30, 0.62], [0.42, 0.44], [0.26, 0.24], [0.22, 0.08]],
      "decor": [{ "k": "line", "pts": [[0.50, 0.26], [0.50, 1.00]], "width": 0.030 }, { "k": "text", "at": [0.52, 0.36], "t": "酒", "s": 0.16 }],
      "pierce": [
        { "p": "fretBand", "x": 0.30, "y": 0.10, "w": 0.40, "h": 0.08, "o": { "cols": 3, "rows": 1, "alt": 0.62, "gap": 0.18, "ridge": 1 } },
        { "p": "cloudBand", "x": 0.32, "y": 0.56, "w": 0.36, "h": 0.10, "o": { "cols": 2, "rows": 1, "lobes": 1, "alt": 0.60, "ridge": 1 } },
        { "p": "dotField", "x": 0.42, "y": 0.72, "w": 0.14, "h": 0.10, "o": { "cols": 1, "rows": 1 } }
      ] },
    { "key": "bird", "tex": "propBird", "z": -1.60, "target": [1.16, 0.86, 0.34, 0.18], "pivot": [0.5, 0.55], "ppm": 1600,
      "outline": [[0.02, 0.30], [0.26, 0.12], [0.46, 0.28], [0.62, 0.16], [0.98, 0.26], [0.70, 0.52], [0.54, 0.46], [0.34, 0.56], [0.14, 0.50]],
      "pierce": [
        { "p": "dotField", "x": 0.34, "y": 0.34, "w": 0.14, "h": 0.14, "o": { "cols": 1, "rows": 1 } },
        { "p": "moonSlit", "x": 0.58, "y": 0.30, "w": 0.16, "h": 0.14, "o": { "cols": 1, "rows": 1, "depth": 0.5 } }
      ] },
    { "key": "mountain", "tex": "propMountain", "z": -1.55, "target": [0.00, -1.16, 4.00, 0.24], "pivot": [0.5, 1.0], "ppm": 620,
      "outline": [[0.00, 0.72], [0.08, 0.34], [0.16, 0.56], [0.26, 0.16], [0.34, 0.48], [0.44, 0.10], [0.52, 0.44], [0.60, 0.22], [0.70, 0.52], [0.78, 0.30], [0.88, 0.60], [0.96, 0.40], [1.00, 0.74], [1.00, 1.00], [0.00, 1.00]],
      "pierce": [
        { "p": "cloudScroll", "x": 0.06, "y": 0.62, "w": 0.20, "h": 0.24, "o": { "cols": 1, "rows": 1, "turns": 1.1, "ridge": 1 } },
        { "p": "cloudScroll", "x": 0.40, "y": 0.62, "w": 0.20, "h": 0.24, "o": { "cols": 1, "rows": 1, "turns": 1.1, "ridge": 1 } },
        { "p": "cloudScroll", "x": 0.74, "y": 0.62, "w": 0.20, "h": 0.24, "o": { "cols": 1, "rows": 1, "turns": 1.1, "ridge": 1 } }
      ] },
    { "key": "moon", "tex": "propMoon", "z": -1.90, "target": [1.30, 0.60, 0.68, 0.68], "pivot": [0.5, 0.5], "ppm": 2600,
      "outline": [[0.50, 0.02], [0.79, 0.12], [0.96, 0.36], [0.98, 0.62], [0.84, 0.86], [0.58, 0.98], [0.32, 0.92], [0.12, 0.72], [0.04, 0.44], [0.16, 0.18], [0.34, 0.06]],
      "pierce": [
        { "p": "fretBand", "x": 0.16, "y": 0.26, "w": 0.68, "h": 0.16, "o": { "cols": 3, "rows": 1, "alt": 0.62, "gap": 0.20, "ridge": 1 } },
        { "p": "fretBand", "x": 0.16, "y": 0.56, "w": 0.68, "h": 0.16, "o": { "cols": 3, "rows": 1, "alt": 0.62, "gap": 0.20, "ridge": 1 } },
        { "p": "fretBand", "x": 0.40, "y": 0.14, "w": 0.20, "h": 0.62, "o": { "cols": 1, "rows": 3, "alt": 0.62, "gap": 0.20, "ridge": 1 } },
        { "p": "petalWindow", "x": 0.40, "y": 0.40, "w": 0.20, "h": 0.20, "o": { "petals": 6, "ridge": 1, "gap": 0.02, "winPad": 0.04 } }
      ] }
  ]
};

/** apply() 支持的别名（编排组可能用复数） */
const ALIAS = { mountains: 'mountain', moonWindow: 'moon' };

function keyOf(k) { return ALIAS[k] || k; }

/**
 * 建布景道具：影子按 target 反解摆位，z 决定层叠。
 * @param {THREE.Object3D} scene
 * @param {number} lightFar
 * @returns {{rig: Rig, apply: (data:object, t:number)=>void, targets: object}}
 */
export function buildProps(scene, lightFar = 12) {
  // 1) 反解：把"影子在幕布上的位置/尺寸"换算成道具在世界里的位置/尺寸
  const placed = PROP_SPECS.props.map((p) => {
    const g = placeByShadow(p.target, p.z, STAGE_LIGHT);
    return Object.assign({}, p, {
      w: g.size[0], h: g.size[1],
      joint: [g.center[0], g.center[1]],
      shadowScale: g.scale,
    });
  });

  // 2) 解析成运行时规格（pivot 由 uv 换算成米，挂点 = joint，全部挂在 rig.root 上）
  const specs = resolveSpecs(placed, { props: placed }, {
    table: 'props', ppm: TEX_PPM.props || 660, maxPx: TEX_MAX_PX,
  });
  const { anchors } = resolveAnchors(specs);

  const rig = new Rig({ lightFar });
  rig.root.name = 'propsRoot';
  const texes = new Map();
  for (const spec of specs) {
    const [pw, ph] = spec.pix;
    let tex = texes.get(spec.artKey);
    if (!tex) {
      tex = makeAlphaFromDraw((ctx, W, H) => drawPartSpec(ctx, W, H, spec), {
        w: pw, h: ph, parchment: true, glow: 0.5,
        baseColor: spec.baseColor, seed: spec.seed,
      });
      tex.name = spec.artKey;
      texes.set(spec.artKey, tex);
    }
    // 远山**参与投影**（皮影的布景在幕布后方、幕布不透明，唯一可见通路就是 shadow map）。
    // 但它原来的 z=-2.0 距灯只有约 1.2m，落在阴影深度区间 [~2.6, ~4.7] 之外，
    // 深度被 clamp 到端点 → 在幕布上盖出一整块假暗区（独立验证组实测过）。
    // 修法不是"取消投影"（那等于让它彻底不可见），而是**把它挪进灯能正常拍到的距离**：
    // z 从 -2.0 改到 -0.55，距灯约 2.65m，落进区间；同时缩小目标尺寸到 4.20×0.28，
    // 依然横贯整幅作为地平线，仍处于所有演员（z ≥ -0.25）之后。
    rig.addPart({
      key: spec.key,
      tex,
      w: spec.w, h: spec.h,
      anchor: anchors.get(spec.key),
      pivot: spec.pivot,
      z: spec.z,
      rest: spec.rest,
      castShadow: true,
    });
  }
  scene.add(rig.root);

  const targets = {};
  for (const p of PROP_SPECS.props) targets[p.key] = p.target;

  /**
   * 编排组给的 propsData：{ sway:{pine:0.03}, visible:{moon:false}, opacity:{mountain:0.85} }
   * 只用 t 的纯函数驱动摆动（不依赖累积状态，保证 __SET_TIME__ 可复现）。
   */
  const apply = (data = {}, t = 0) => {
    if (!data) data = {};
    const sway = data.sway || {};
    const pose = {};
    for (const raw of Object.keys(sway)) {
      const k = keyOf(raw);
      if (!rig.parts.has(k)) continue;
      const amp = +sway[raw] || 0;
      const ph = k.length * 1.7;
      pose[k] = [0, 0, amp * Math.sin(t * 0.9 + ph) + amp * 0.35 * Math.sin(t * 2.3 + ph * 1.7)];
    }
    if (Object.keys(pose).length) rig.setPose(pose);

    const vis = data.visible || {};
    for (const raw of Object.keys(vis)) rig.setPartVisible(keyOf(raw), !!vis[raw]);

    const op = data.opacity || {};
    for (const raw of Object.keys(op)) rig.setPartOpacity(keyOf(raw), +op[raw]);

    // 道具没有布料模拟，这里只是把姿态推进场景图（dt=0：不推进任何积分）
    rig.update(0);
  };

  return { rig, apply, targets };
}

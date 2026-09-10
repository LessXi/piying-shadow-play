// 影窗 · 夜巡 —— 皮影人物剪影（将军 / 副将）
//
// 设计方式：**图纸即数据**。
//   PART_SPECS 是一张严格 JSON 的图纸表（每个部件一行），声明：
//     轮廓 outline（uv 闭合折线，平滑成曲线）、装饰 decor、镂空 pierce、关节 pivot、身位挂点 joint。
//   shapes.js 的绘制机把它画成 alpha 贴图（实体深色 + 孔洞 alpha=0），
//   tools/check-assets.mjs 用桩 ctx 跑同一份数据做静态校验与孔洞统计。
//   代码里没有 SVG、没有位图资源，全部是 canvas 2D 路径。
//
// 坐标：整体身位坐标（米）——x 向右、y 向上、脚底 y=0。
//   身高 PUPPET_HEIGHT = 1.55（头顶 1.55；翎羽尖 ≈1.55；武器刀尖 ≈1.52）。
//   关节用 joint 声明在身位坐标里，anchor 由 shapes.js 的 resolveAnchors 从 joint 差值算出
//   （父部件 pivot 坐标系里的关节到末端向量）—— 这样就不会把 anchor 误写成世界坐标。
//
// 通道名严格用 INTERFACES.md A.1 的标准表。所有部件 rest 见每条声明的 "rest" 字段
// （只有两条上臂 ±0.06，其余全 0；造型角度都画进图纸里）。

import { makeAlphaFromDraw } from './textures.js';
import {
  resolveSpecs, resolveAnchors, drawPartSpec, TEX_PPM, TEX_MAX_PX,
} from './shapes.js';
import { buildProps } from './props.js';

/** 整体身高（米）—— 与 stage.js 的幕布 2.5m 匹配（人占幕布 62%） */
export const PUPPET_HEIGHT = 1.55;

/* ================================================================== *
 * 图纸表（严格 JSON：双引号、无注释、无尾逗号、每部件一行）
 *
 * 字段说明
 *   key/tex      通道名 / 贴图名
 *   w/h          世界尺寸（米）
 *   parent       父部件 key（省略 = 挂在 rig.root）
 *   joint        [x,y] 该部件**关节**的整体身位坐标（米）
 *   at           [u,v] 关节在**父部件图纸**里的位置（武器刃、翎羽这种贴着父件末端的挂法）
 *   pivot        [u,v] 关节在**自己图纸**里的位置（即旋转轴心）
 *   rest         [rx,ry,rz] 静息欧拉角（弧度）；本项目中除了两条上臂外都是 0
 *   z            层叠微偏移（+ 靠近观众）
 *   ball         关节球半径（米）：圆盘状关节，乱转也不露缝；必须能在贴图内画下
 *   outline      闭合轮廓（uv 折线，平滑成曲线）
 *   decor        装饰画笔：disc/bar/blob/line/arc
 *   pierce       镂空：[{p:花纹名, x,y,w,h(uv 框), o:{cols,rows,gap,alt,ridge,...}}]
 *                o.ridge=1 → **开窗留肉**：整格挖成大亮窗，花纹以实体留在窗里（传统花窗做法）
 *   cloth        布料次级摆动参数
 *   flip         左右镜像（右侧肢体复用左侧图纸，几何镜像，贴图共用）
 *   uses/from    复用同表/他表某部件的图纸
 * ================================================================== */
export const PART_SPECS = {
  "general": [
    { "key": "waist", "tex": "skirtArmor", "w": 0.32, "h": 0.38, "joint": [0, 0.88], "pivot": [0.5, 0.0], "rest": [0, 0, 0], "z": 0,
      "outline": [[0.40, 0.02], [0.60, 0.02], [0.62, 0.14], [0.70, 0.34], [0.88, 0.66], [0.98, 0.96], [0.78, 1.00], [0.56, 0.90], [0.44, 0.90], [0.22, 1.00], [0.02, 0.96], [0.12, 0.66], [0.30, 0.34], [0.38, 0.14]],
      "decor": [{ "k": "bar", "at": [0.5, 0.085], "w": 0.315, "h": 0.038 }, { "k": "disc", "at": [0.5, 0.085], "r": 0.030 }],
      "pierce": [
        { "p": "fretBand", "x": 0.17, "y": 0.46, "w": 0.66, "h": 0.12, "o": { "cols": 5, "rows": 1, "alt": 0.60, "gap": 0.22, "ridge": 1 } },
        { "p": "scaleField", "x": 0.16, "y": 0.62, "w": 0.22, "h": 0.24, "o": { "cols": 2, "rows": 2, "alt": 0.62, "stagger": 1, "gap": 0.22, "ridge": 1 } },
        { "p": "scaleField", "x": 0.62, "y": 0.62, "w": 0.22, "h": 0.24, "o": { "cols": 2, "rows": 2, "alt": 0.62, "stagger": 1, "gap": 0.22, "ridge": 1 } },
        { "p": "petalWindow", "x": 0.40, "y": 0.58, "w": 0.20, "h": 0.22, "o": { "petals": 8, "ridge": 1, "gap": 0.05, "winPad": 0.05 } },
        { "p": "dotField", "x": 0.25, "y": 0.32, "w": 0.10, "h": 0.09, "o": { "cols": 1, "rows": 1 } },
        { "p": "dotField", "x": 0.65, "y": 0.32, "w": 0.10, "h": 0.09, "o": { "cols": 1, "rows": 1 } },
        { "p": "dotField", "x": 0.14, "y": 0.82, "w": 0.12, "h": 0.09, "o": { "cols": 2, "rows": 1, "gap": 0.30 } },
        { "p": "dotField", "x": 0.74, "y": 0.82, "w": 0.12, "h": 0.09, "o": { "cols": 2, "rows": 1, "gap": 0.30 } }
      ] },
    { "key": "chest", "tex": "chestArmor", "w": 0.30, "h": 0.40, "parent": "waist", "joint": [0, 0.965], "pivot": [0.5, 0.62], "rest": [0, 0, 0], "z": 0.004,
      "outline": [[0.32, 0.00], [0.68, 0.00], [0.80, 0.06], [0.90, 0.13], [0.96, 0.26], [0.94, 0.44], [0.86, 0.62], [0.74, 0.82], [0.66, 1.00], [0.34, 1.00], [0.26, 0.82], [0.14, 0.62], [0.06, 0.44], [0.04, 0.26], [0.10, 0.13], [0.20, 0.06]],
      "decor": [{ "k": "disc", "at": [0.5, 0.34], "r": 0.044 }, { "k": "bar", "at": [0.5, 0.05], "w": 0.24, "h": 0.026 }, { "k": "bar", "at": [0.5, 0.66], "w": 0.26, "h": 0.032 }],
      "pierce": [
        { "p": "fretBand", "x": 0.16, "y": 0.01, "w": 0.68, "h": 0.09, "o": { "cols": 6, "rows": 1, "alt": 0.62, "gap": 0.22, "ridge": 1 } },
        { "p": "vineScroll", "x": 0.24, "y": 0.10, "w": 0.52, "h": 0.14, "o": { "cols": 2, "rows": 1, "alt": 0.72, "gap": 0.16, "leaves": 3, "ridge": 1 } },
        { "p": "ringWindow", "x": 0.37, "y": 0.245, "w": 0.26, "h": 0.19, "o": { "ridge": 1, "gap": 0.04, "winPad": 0.06, "square": 1 } },
        { "p": "scaleField", "x": 0.05, "y": 0.14, "w": 0.14, "h": 0.30, "o": { "cols": 1, "rows": 2, "alt": 0.70, "gap": 0.25, "ridge": 1 } },
        { "p": "scaleField", "x": 0.81, "y": 0.14, "w": 0.14, "h": 0.30, "o": { "cols": 1, "rows": 2, "alt": 0.70, "gap": 0.25, "ridge": 1 } },
        { "p": "dotField", "x": 0.44, "y": 0.72, "w": 0.12, "h": 0.06, "o": { "cols": 1, "rows": 1 } },
        { "p": "dotField", "x": 0.20, "y": 0.62, "w": 0.12, "h": 0.05, "o": { "cols": 1, "rows": 1 } },
        { "p": "dotField", "x": 0.68, "y": 0.62, "w": 0.12, "h": 0.05, "o": { "cols": 1, "rows": 1 } }
      ] },
    { "key": "neck", "tex": "neck", "w": 0.10, "h": 0.09, "parent": "chest", "joint": [0, 1.205], "pivot": [0.5, 1.0], "rest": [0, 0, 0], "z": 0.006,
      "outline": [[0.24, 0.02], [0.76, 0.02], [0.92, 0.30], [0.86, 0.72], [0.66, 1.00], [0.34, 1.00], [0.14, 0.72], [0.08, 0.30]],
      "pierce": [{ "p": "dotField", "x": 0.30, "y": 0.34, "w": 0.40, "h": 0.32, "o": { "cols": 1, "rows": 1 } }] },
    { "key": "head", "tex": "headHelm", "w": 0.26, "h": 0.27, "parent": "neck", "joint": [0, 1.245], "pivot": [0.5, 1.0], "rest": [0, 0, 0], "z": 0.008,
      "outline": [[0.22, 0.16], [0.40, 0.02], [0.62, 0.02], [0.82, 0.14], [0.90, 0.28], [0.98, 0.36], [0.99, 0.50], [0.92, 0.60], [1.00, 0.66], [0.88, 0.78], [0.84, 0.90], [0.66, 1.00], [0.46, 0.98], [0.30, 0.88], [0.16, 0.70], [0.10, 0.46], [0.14, 0.26]],
      "decor": [{ "k": "disc", "at": [0.42, 0.035], "r": 0.020 }, { "k": "blob", "pts": [[0.10, 0.50], [0.20, 0.34], [0.29, 0.52], [0.25, 0.74], [0.12, 0.68]] }, { "k": "bar", "at": [0.78, 0.40], "w": 0.056, "h": 0.013, "rot": -0.25 }],
      "pierce": [
        { "p": "petalWindow", "x": 0.28, "y": 0.09, "w": 0.36, "h": 0.25, "o": { "petals": 6, "ring": 0.30, "coreR": 0.13, "ridge": 1, "gap": 0.05, "winPad": 0.05 } },
        { "p": "fretBand", "x": 0.10, "y": 0.305, "w": 0.76, "h": 0.115, "o": { "cols": 5, "rows": 1, "alt": 0.60, "gap": 0.20, "ridge": 1 } },
        { "p": "moonSlit", "x": 0.60, "y": 0.53, "w": 0.22, "h": 0.085, "o": { "depth": 0.35, "tilt": -0.12 } },
        { "p": "moonSlit", "x": 0.58, "y": 0.80, "w": 0.18, "h": 0.055, "o": { "depth": 0.40 } },
        { "p": "dotField", "x": 0.20, "y": 0.56, "w": 0.10, "h": 0.08, "o": { "cols": 1, "rows": 1 } },
        { "p": "dotField", "x": 0.28, "y": 0.80, "w": 0.09, "h": 0.07, "o": { "cols": 1, "rows": 1 } }
      ] },
    { "key": "plume", "tex": "plumeFeather", "w": 0.44, "h": 0.20, "parent": "head", "at": [0.40, 0.06], "pivot": [0.95, 0.86], "rest": [0, 0, 0], "z": 0.008,
      "cloth": { "amp": 1.5, "freq": 1.0, "lag": 0.7, "scaleBy": 0.40, "gravity": 0.05, "wind": 1.4, "stiff": 32, "damp": 5.6, "axis": "z" },
      "outline": [[0.97, 0.82], [0.86, 0.70], [0.68, 0.64], [0.46, 0.62], [0.24, 0.64], [0.08, 0.70], [0.02, 0.80], [0.16, 0.88], [0.40, 0.92], [0.64, 0.94], [0.86, 0.92]],
      "pierce": [
        { "p": "slitRow", "x": 0.30, "y": 0.66, "w": 0.44, "h": 0.16, "o": { "slits": 1, "tilt": -0.9, "cols": 3, "rows": 1, "alt": 0.62, "gap": 0.22, "ridge": 1 } },
        { "p": "cloudScroll", "x": 0.80, "y": 0.68, "w": 0.16, "h": 0.16, "o": { "turns": 1.1, "cols": 1, "rows": 1, "ridge": 1 } },
        { "p": "dotField", "x": 0.12, "y": 0.70, "w": 0.10, "h": 0.09, "o": { "cols": 1, "rows": 1 } }
      ] },
    { "key": "cape", "tex": "capeOuter", "w": 0.70, "h": 0.66, "parent": "chest", "joint": [0, 1.19], "pivot": [0.5, 0.045], "rest": [0, 0, 0], "z": -0.055,
      "cloth": { "amp": 1.4, "freq": 1.0, "lag": 0.95, "scaleBy": 0.50, "gravity": 0.06, "wind": 1.2, "stiff": 26, "damp": 6.0, "axis": "z" },
      "outline": [[0.34, 0.02], [0.66, 0.02], [0.74, 0.16], [0.88, 0.46], [0.99, 0.88], [0.84, 1.00], [0.68, 0.90], [0.50, 1.00], [0.32, 0.90], [0.16, 1.00], [0.02, 0.86], [0.12, 0.44], [0.26, 0.16]],
      "decor": [{ "k": "bar", "at": [0.5, 0.045], "w": 0.30, "h": 0.042 }],
      "pierce": [
        { "p": "cloudScroll", "x": 0.09, "y": 0.22, "w": 0.24, "h": 0.18, "o": { "turns": 1.2, "cols": 1, "rows": 1, "ridge": 1 } },
        { "p": "cloudScroll", "x": 0.67, "y": 0.22, "w": 0.24, "h": 0.18, "o": { "turns": 1.2, "flip": 1, "cols": 1, "rows": 1, "ridge": 1 } },
        { "p": "vineScroll", "x": 0.26, "y": 0.46, "w": 0.48, "h": 0.18, "o": { "cols": 3, "rows": 1, "alt": 0.62, "gap": 0.15, "leaves": 3, "ridge": 1 } },
        { "p": "cloudBand", "x": 0.13, "y": 0.60, "w": 0.32, "h": 0.13, "o": { "cols": 2, "rows": 1, "lobes": 1, "alt": 0.70, "ridge": 1 } },
        { "p": "cloudBand", "x": 0.55, "y": 0.60, "w": 0.32, "h": 0.13, "o": { "cols": 2, "rows": 1, "lobes": 1, "alt": 0.70, "ridge": 1 } },
        { "p": "moonSlit", "x": 0.36, "y": 0.80, "w": 0.28, "h": 0.10, "o": { "cols": 2, "rows": 1, "alt": 0.60, "depth": 0.40 } },
        { "p": "dotField", "x": 0.44, "y": 0.34, "w": 0.12, "h": 0.09, "o": { "cols": 1, "rows": 1 } }
      ] },
    { "key": "cape2", "tex": "capeInner", "w": 0.52, "h": 0.50, "parent": "waist", "joint": [0, 0.90], "pivot": [0.5, 0.04], "rest": [0, 0, 0], "z": -0.075,
      "cloth": { "amp": 1.1, "freq": 1.0, "lag": 0.8, "scaleBy": 0.44, "gravity": 0.04, "wind": 0.9, "stiff": 30, "damp": 6.4, "axis": "z" },
      "outline": [[0.34, 0.02], [0.66, 0.02], [0.78, 0.20], [0.92, 0.52], [0.99, 0.86], [0.80, 1.00], [0.62, 0.88], [0.44, 1.00], [0.24, 0.86], [0.04, 0.98], [0.10, 0.52], [0.24, 0.20]],
      "pierce": [
        { "p": "fretBand", "x": 0.10, "y": 0.10, "w": 0.80, "h": 0.12, "o": { "cols": 5, "rows": 1, "alt": 0.60, "gap": 0.22, "ridge": 1 } },
        { "p": "diamondField", "x": 0.18, "y": 0.40, "w": 0.64, "h": 0.18, "o": { "cols": 4, "rows": 1, "alt": 0.60, "solid": 1, "gap": 0.20, "ridge": 1 } },
        { "p": "waveBand", "x": 0.12, "y": 0.66, "w": 0.76, "h": 0.16, "o": { "cols": 4, "rows": 1, "alt": 0.60, "waves": 1, "ridge": 1 } }
      ] },
    { "key": "flag", "tex": "backFlag", "w": 0.36, "h": 0.40, "parent": "chest", "joint": [-0.05, 1.16], "pivot": [0.5, 0.95], "rest": [0, 0, 0], "z": -0.040,
      "cloth": { "amp": 1.2, "freq": 1.0, "lag": 0.6, "scaleBy": 0.34, "gravity": 0.0, "wind": 1.3, "stiff": 30, "damp": 5.2, "axis": "z" },
      "outline": [[0.24, 0.02], [0.76, 0.02], [0.90, 0.12], [0.94, 0.40], [0.88, 0.62], [0.96, 0.80], [0.72, 0.98], [0.60, 0.80], [0.44, 0.98], [0.22, 0.86], [0.30, 0.64], [0.16, 0.62], [0.06, 0.40], [0.12, 0.10]],
      "decor": [{ "k": "line", "pts": [[0.5, 0.02], [0.5, 0.99]], "width": 0.016 }],
      "pierce": [
        { "p": "wanField", "x": 0.13, "y": 0.12, "w": 0.24, "h": 0.20, "o": { "cols": 1, "rows": 1, "ridge": 1 } },
        { "p": "wanField", "x": 0.63, "y": 0.12, "w": 0.24, "h": 0.20, "o": { "cols": 1, "rows": 1, "ridge": 1 } },
        { "p": "fretBand", "x": 0.20, "y": 0.44, "w": 0.60, "h": 0.10, "o": { "cols": 4, "rows": 1, "alt": 0.60, "gap": 0.22, "ridge": 1 } },
        { "p": "cloudBand", "x": 0.24, "y": 0.56, "w": 0.52, "h": 0.11, "o": { "cols": 2, "rows": 1, "lobes": 1, "alt": 0.65, "ridge": 1 } },
        { "p": "dotField", "x": 0.30, "y": 0.68, "w": 0.12, "h": 0.10, "o": { "cols": 1, "rows": 1 } },
        { "p": "dotField", "x": 0.58, "y": 0.68, "w": 0.12, "h": 0.10, "o": { "cols": 1, "rows": 1 } }
      ] },
    { "key": "shoulderL", "tex": "pauldron", "w": 0.17, "h": 0.16, "parent": "chest", "joint": [0.115, 1.165], "pivot": [0.42, 0.30], "rest": [0, 0, 0], "z": 0.010, "ball": 0.044,
      "outline": [[0.12, 0.06], [0.46, 0.00], [0.80, 0.10], [0.98, 0.36], [0.92, 0.66], [0.70, 0.92], [0.40, 0.98], [0.14, 0.80], [0.03, 0.50], [0.04, 0.22]],
      "pierce": [
        { "p": "scaleField", "x": 0.16, "y": 0.14, "w": 0.70, "h": 0.46, "o": { "cols": 2, "rows": 2, "alt": 0.60, "stagger": 1, "gap": 0.24, "ridge": 1 } },
        { "p": "dotField", "x": 0.30, "y": 0.68, "w": 0.16, "h": 0.14, "o": { "cols": 1, "rows": 1 } }
      ] },
    { "key": "upperArmL", "tex": "armUpper", "w": 0.105, "h": 0.312, "parent": "shoulderL", "joint": [0.115, 1.165], "pivot": [0.5, 0.07], "rest": [0, 0, 0.06], "z": 0.012, "ball": 0.020,
      "outline": [[0.34, 0.01], [0.66, 0.01], [0.78, 0.16], [0.72, 0.42], [0.64, 0.72], [0.58, 0.99], [0.42, 0.99], [0.36, 0.72], [0.28, 0.42], [0.22, 0.16]],
      "decor": [{ "k": "bar", "at": [0.5, 0.30], "w": 0.090, "h": 0.020 }, { "k": "bar", "at": [0.5, 0.56], "w": 0.082, "h": 0.018 }],
      "pierce": [
        { "p": "scaleField", "x": 0.22, "y": 0.14, "w": 0.56, "h": 0.32, "o": { "cols": 2, "rows": 2, "alt": 0.62, "stagger": 1, "gap": 0.22, "ridge": 1 } },
        { "p": "diamondField", "x": 0.28, "y": 0.52, "w": 0.44, "h": 0.26, "o": { "cols": 2, "rows": 2, "alt": 0.70, "gap": 0.25, "solid": 1, "ridge": 1 } },
        { "p": "dotField", "x": 0.40, "y": 0.86, "w": 0.20, "h": 0.09, "o": { "cols": 1, "rows": 1 } }
      ] },
    { "key": "forearmL", "tex": "armLower", "w": 0.095, "h": 0.28, "parent": "upperArmL", "joint": [0.115, 0.875], "pivot": [0.5, 0.07], "rest": [0, 0, 0], "z": 0.014, "ball": 0.018,
      "outline": [[0.34, 0.01], [0.66, 0.01], [0.76, 0.20], [0.68, 0.50], [0.62, 0.80], [0.55, 0.99], [0.45, 0.99], [0.38, 0.80], [0.32, 0.50], [0.24, 0.20]],
      "decor": [{ "k": "bar", "at": [0.5, 0.90], "w": 0.094, "h": 0.022 }],
      "pierce": [
        { "p": "wanField", "x": 0.30, "y": 0.18, "w": 0.40, "h": 0.36, "o": { "cols": 1, "rows": 3, "alt": 0.66, "gap": 0.20, "ridge": 1 } },
        { "p": "dotField", "x": 0.36, "y": 0.66, "w": 0.28, "h": 0.12, "o": { "cols": 2, "rows": 1, "alt": 0.60 } }
      ] },
    { "key": "handL", "tex": "handClaw", "w": 0.09, "h": 0.13, "parent": "forearmL", "joint": [0.115, 0.615], "pivot": [0.5, 0.08], "rest": [0, 0, 0], "z": 0.016, "ball": 0.010,
      "outline": [[0.28, 0.06], [0.62, 0.02], [0.86, 0.20], [0.94, 0.42], [0.78, 0.56], [0.92, 0.72], [0.70, 0.94], [0.44, 0.98], [0.34, 0.78], [0.16, 0.68], [0.10, 0.40]],
      "pierce": [
        { "p": "moonSlit", "x": 0.44, "y": 0.30, "w": 0.36, "h": 0.16, "o": { "cols": 2, "rows": 1, "alt": 0.55, "gap": 0.20, "depth": 0.50 } },
        { "p": "dotField", "x": 0.36, "y": 0.62, "w": 0.22, "h": 0.18, "o": { "cols": 1, "rows": 1 } }
      ] },
    { "key": "shoulderR", "tex": "pauldron", "parent": "chest", "joint": [-0.115, 1.165], "rest": [0, 0, 0], "flip": true, "uses": "shoulderL" },
    { "key": "upperArmR", "tex": "armUpper", "parent": "shoulderR", "joint": [-0.115, 1.165], "rest": [0, 0, -0.06], "flip": true, "uses": "upperArmL" },
    { "key": "forearmR", "tex": "armLower", "parent": "upperArmR", "joint": [-0.115, 0.875], "rest": [0, 0, 0], "flip": true, "uses": "forearmL" },
    { "key": "handR", "tex": "handClaw", "parent": "forearmR", "joint": [-0.115, 0.615], "rest": [0, 0, 0], "flip": true, "uses": "handL" },
    { "key": "hipL", "tex": "hipGuard", "w": 0.14, "h": 0.15, "parent": "waist", "joint": [0.085, 0.810], "pivot": [0.30, 0.26], "rest": [0, 0, 0], "z": -0.004, "ball": 0.036,
      "outline": [[0.10, 0.06], [0.52, 0.00], [0.88, 0.16], [0.98, 0.48], [0.90, 0.82], [0.62, 1.00], [0.26, 0.96], [0.05, 0.70], [0.02, 0.32]],
      "pierce": [
        { "p": "diamondField", "x": 0.14, "y": 0.28, "w": 0.70, "h": 0.32, "o": { "cols": 3, "rows": 1, "alt": 0.60, "gap": 0.25, "solid": 1, "ridge": 1 } },
        { "p": "dotField", "x": 0.36, "y": 0.70, "w": 0.16, "h": 0.14, "o": { "cols": 1, "rows": 1 } }
      ] },
    { "key": "thighL", "tex": "legUpper", "w": 0.115, "h": 0.40, "parent": "hipL", "joint": [0.085, 0.810], "pivot": [0.5, 0.06], "rest": [0, 0, 0], "z": -0.006, "ball": 0.022,
      "outline": [[0.32, 0.01], [0.68, 0.01], [0.80, 0.18], [0.72, 0.50], [0.64, 0.86], [0.58, 0.99], [0.42, 0.99], [0.36, 0.86], [0.28, 0.50], [0.20, 0.18]],
      "decor": [{ "k": "bar", "at": [0.5, 0.24], "w": 0.104, "h": 0.022 }],
      "pierce": [
        { "p": "scaleField", "x": 0.22, "y": 0.12, "w": 0.56, "h": 0.36, "o": { "cols": 2, "rows": 3, "alt": 0.66, "stagger": 1, "gap": 0.20, "ridge": 1 } },
        { "p": "dotField", "x": 0.38, "y": 0.56, "w": 0.24, "h": 0.10, "o": { "cols": 1, "rows": 1 } },
        { "p": "dotField", "x": 0.40, "y": 0.74, "w": 0.20, "h": 0.09, "o": { "cols": 1, "rows": 1 } }
      ] },
    { "key": "shinL", "tex": "legLower", "w": 0.10, "h": 0.383, "parent": "thighL", "joint": [0.085, 0.435], "pivot": [0.5, 0.06], "rest": [0, 0, 0], "z": -0.004, "ball": 0.021,
      "outline": [[0.34, 0.01], [0.66, 0.01], [0.76, 0.14], [0.66, 0.46], [0.60, 0.78], [0.54, 0.98], [0.46, 0.98], [0.38, 0.76], [0.30, 0.46], [0.24, 0.14]],
      "decor": [{ "k": "bar", "at": [0.5, 0.92], "w": 0.096, "h": 0.020 }],
      "pierce": [
        { "p": "fretBand", "x": 0.26, "y": 0.14, "w": 0.48, "h": 0.20, "o": { "cols": 1, "rows": 2, "alt": 0.66, "gap": 0.18, "ridge": 1 } },
        { "p": "dotField", "x": 0.36, "y": 0.52, "w": 0.28, "h": 0.12, "o": { "cols": 2, "rows": 1, "alt": 0.60 } },
        { "p": "dotField", "x": 0.38, "y": 0.72, "w": 0.24, "h": 0.10, "o": { "cols": 1, "rows": 1 } }
      ] },
    { "key": "footL", "tex": "bootFoot", "w": 0.22, "h": 0.10, "parent": "shinL", "joint": [0.085, 0.075], "pivot": [0.30, 0.28], "rest": [0, 0, 0], "z": -0.002, "ball": 0.026,
      "outline": [[0.06, 0.30], [0.18, 0.06], [0.46, 0.02], [0.72, 0.10], [0.90, 0.34], [0.99, 0.66], [0.94, 0.90], [0.66, 1.00], [0.22, 1.00], [0.05, 0.80]],
      "pierce": [
        { "p": "dotField", "x": 0.36, "y": 0.30, "w": 0.30, "h": 0.40, "o": { "cols": 2, "rows": 1, "alt": 0.60 } },
        { "p": "moonSlit", "x": 0.62, "y": 0.32, "w": 0.24, "h": 0.34, "o": { "cols": 1, "rows": 1, "tilt": 1.20, "depth": 0.40 } }
      ] },
    { "key": "hipR", "tex": "hipGuard", "parent": "waist", "joint": [-0.085, 0.810], "rest": [0, 0, 0], "flip": true, "uses": "hipL" },
    { "key": "thighR", "tex": "legUpper", "parent": "hipR", "joint": [-0.085, 0.810], "rest": [0, 0, 0], "flip": true, "uses": "thighL" },
    { "key": "shinR", "tex": "legLower", "parent": "thighR", "joint": [-0.085, 0.435], "rest": [0, 0, 0], "flip": true, "uses": "shinL" },
    { "key": "footR", "tex": "bootFoot", "parent": "shinR", "joint": [-0.085, 0.075], "rest": [0, 0, 0], "flip": true, "uses": "footL" },
    { "key": "weapon", "tex": "polearm", "w": 0.30, "h": 1.30, "parent": "handR", "joint": [-0.125, 0.560], "pivot": [0.5, 0.78], "rest": [0, 0, 0], "z": 0.020,
      "decor": [
        { "k": "bar", "at": [0.5, 0.62], "w": 0.085, "h": 0.94 },
        { "k": "disc", "at": [0.5, 0.962], "r": 0.048 },
        { "k": "bar", "at": [0.5, 0.30], "w": 0.272, "h": 0.072 },
        { "k": "blob", "pts": [[0.13, 0.335], [0.20, 0.275], [0.25, 0.33], [0.20, 0.395], [0.14, 0.395]] },
        { "k": "blob", "pts": [[0.87, 0.335], [0.80, 0.275], [0.75, 0.33], [0.80, 0.395], [0.86, 0.395]] }
      ],
      "pierce": [
        { "p": "wanField", "x": 0.40, "y": 0.64, "w": 0.20, "h": 0.24, "o": { "cols": 1, "rows": 3, "alt": 0.70, "gap": 0.20, "ridge": 1 } },
        { "p": "fretBand", "x": 0.42, "y": 0.42, "w": 0.16, "h": 0.18, "o": { "cols": 1, "rows": 2, "alt": 0.68, "gap": 0.18, "ridge": 1 } },
        { "p": "petalWindow", "x": 0.34, "y": 0.275, "w": 0.32, "h": 0.06, "o": { "petals": 6, "ring": 0.34, "coreR": 0.12, "ridge": 1, "gap": 0.05, "winPad": 0.06 } },
        { "p": "dotField", "x": 0.44, "y": 0.395, "w": 0.12, "h": 0.05, "o": { "cols": 1, "rows": 1 } },
        { "p": "cloudScroll", "x": 0.35, "y": 0.885, "w": 0.30, "h": 0.10, "o": { "cols": 1, "rows": 1, "turns": 1.0, "weight": 0.20, "ridge": 1 } }
      ] },
    { "key": "weaponTip", "tex": "bladeCrescent", "w": 0.34, "h": 0.34, "parent": "weapon", "at": [0.5, 0.26], "pivot": [0.5, 0.88], "rest": [0, 0, 0], "z": 0.020,
      "outline": [[0.50, 0.90], [0.62, 0.78], [0.66, 0.56], [0.60, 0.34], [0.48, 0.14], [0.34, 0.05], [0.20, 0.14], [0.10, 0.34], [0.16, 0.60], [0.28, 0.80], [0.38, 0.90]],
      "decor": [
        { "k": "bar", "at": [0.50, 0.92], "w": 0.10, "h": 0.05 },
        { "k": "blob", "pts": [[0.60, 0.84], [0.72, 0.90], [0.80, 0.82], [0.74, 0.70], [0.62, 0.74]] },
        { "k": "line", "pts": [[0.60, 0.76], [0.66, 0.58], [0.62, 0.36], [0.50, 0.14], [0.34, 0.04]], "width": 0.012 }
      ],
      "pierce": [
        { "p": "moonSlit", "x": 0.34, "y": 0.26, "w": 0.12, "h": 0.46, "o": { "cols": 1, "rows": 1, "tilt": 1.5708, "depth": 0.45, "ridge": 1, "gap": 0.02, "winPad": 0.05 } },
        { "p": "scaleField", "x": 0.44, "y": 0.42, "w": 0.18, "h": 0.18, "o": { "cols": 1, "rows": 2, "alt": 0.65, "gap": 0.20, "ridge": 1 } },
        { "p": "vineScroll", "x": 0.18, "y": 0.56, "w": 0.26, "h": 0.24, "o": { "cols": 1, "rows": 1, "leaves": 3, "ridge": 1 } },
        { "p": "dotField", "x": 0.34, "y": 0.12, "w": 0.13, "h": 0.11, "o": { "cols": 1, "rows": 1 } }
      ] }
  ],
  "cavalry": [
    { "key": "waist", "tex": "skirtArmor", "rest": [0, 0, 0], "uses": "waist", "from": "general" },
    { "key": "chest", "tex": "cavRobe", "w": 0.30, "h": 0.40, "parent": "waist", "joint": [0, 0.965], "pivot": [0.5, 0.62], "rest": [0, 0, 0], "z": 0.004,
      "outline": [[0.32, 0.00], [0.68, 0.00], [0.82, 0.06], [0.92, 0.16], [0.96, 0.32], [0.92, 0.54], [0.84, 0.74], [0.76, 0.90], [0.68, 1.00], [0.32, 1.00], [0.24, 0.90], [0.16, 0.74], [0.08, 0.54], [0.04, 0.32], [0.08, 0.16], [0.18, 0.06]],
      "decor": [{ "k": "line", "pts": [[0.5, 0.06], [0.5, 1.00]], "width": 0.014 }, { "k": "bar", "at": [0.5, 0.62], "w": 0.26, "h": 0.030 }],
      "pierce": [
        { "p": "vineScroll", "x": 0.20, "y": 0.12, "w": 0.60, "h": 0.16, "o": { "cols": 2, "rows": 1, "alt": 0.70, "gap": 0.16, "leaves": 3, "ridge": 1 } },
        { "p": "fretBand", "x": 0.14, "y": 0.02, "w": 0.72, "h": 0.09, "o": { "cols": 5, "rows": 1, "alt": 0.60, "gap": 0.22, "ridge": 1 } },
        { "p": "dotField", "x": 0.42, "y": 0.72, "w": 0.16, "h": 0.06, "o": { "cols": 1, "rows": 1 } },
        { "p": "dotField", "x": 0.42, "y": 0.86, "w": 0.16, "h": 0.06, "o": { "cols": 1, "rows": 1 } }
      ] },
    { "key": "neck", "tex": "neck", "rest": [0, 0, 0], "uses": "neck", "from": "general" },
    { "key": "head", "tex": "cavHelm", "w": 0.26, "h": 0.30, "parent": "neck", "joint": [0, 1.245], "pivot": [0.5, 1.0], "rest": [0, 0, 0], "z": 0.008,
      "outline": [[0.10, 0.38], [0.30, 0.20], [0.50, 0.13], [0.70, 0.20], [0.90, 0.38], [0.99, 0.46], [0.90, 0.54], [0.84, 0.62], [0.80, 0.90], [0.62, 1.00], [0.36, 0.98], [0.22, 0.84], [0.16, 0.58], [0.06, 0.52]],
      "decor": [{ "k": "line", "pts": [[0.10, 0.38], [0.50, 0.13], [0.90, 0.38]], "width": 0.016 }, { "k": "bar", "at": [0.5, 0.31], "w": 0.13, "h": 0.020 }],
      "pierce": [
        { "p": "fretBand", "x": 0.18, "y": 0.42, "w": 0.64, "h": 0.10, "o": { "cols": 4, "rows": 1, "alt": 0.62, "gap": 0.20, "ridge": 1 } },
        { "p": "moonSlit", "x": 0.60, "y": 0.60, "w": 0.20, "h": 0.075, "o": { "depth": 0.35, "tilt": -0.12 } },
        { "p": "dotField", "x": 0.28, "y": 0.70, "w": 0.12, "h": 0.10, "o": { "cols": 1, "rows": 1 } }
      ] },
    { "key": "plume", "tex": "plumeFeather", "rest": [0, 0, 0], "uses": "plume", "from": "general" },
    { "key": "cape", "tex": "cavCape", "w": 0.62, "h": 0.52, "parent": "chest", "joint": [0, 1.16], "pivot": [0.5, 0.05], "rest": [0, 0, 0], "z": -0.050,
      "cloth": { "amp": 1.2, "freq": 1.0, "lag": 0.85, "scaleBy": 0.46, "gravity": 0.05, "wind": 1.1, "stiff": 28, "damp": 6.2, "axis": "z" },
      "outline": [[0.34, 0.02], [0.66, 0.02], [0.78, 0.18], [0.92, 0.50], [0.99, 0.86], [0.82, 1.00], [0.64, 0.88], [0.46, 1.00], [0.26, 0.88], [0.04, 0.98], [0.10, 0.50], [0.24, 0.18]],
      "pierce": [
        { "p": "waveBand", "x": 0.12, "y": 0.58, "w": 0.76, "h": 0.16, "o": { "cols": 5, "rows": 1, "alt": 0.60, "waves": 1, "ridge": 1 } },
        { "p": "dotField", "x": 0.28, "y": 0.28, "w": 0.14, "h": 0.12, "o": { "cols": 2, "rows": 1, "alt": 0.60 } }
      ] },
    { "key": "scarf", "tex": "scarfRibbon", "w": 0.44, "h": 0.26, "parent": "chest", "joint": [0.04, 1.19], "pivot": [0.05, 0.35], "rest": [0, 0, 0], "z": 0.012,
      "cloth": { "amp": 1.8, "freq": 1.0, "lag": 1.1, "scaleBy": 0.55, "gravity": 0.02, "wind": 1.6, "stiff": 24, "damp": 5.4, "axis": "z" },
      "outline": [[0.02, 0.25], [0.20, 0.06], [0.46, 0.16], [0.66, 0.36], [0.88, 0.42], [0.98, 0.62], [0.80, 0.86], [0.58, 0.74], [0.44, 0.52], [0.24, 0.40], [0.06, 0.52]],
      "pierce": [
        { "p": "dotField", "x": 0.40, "y": 0.26, "w": 0.12, "h": 0.10, "o": { "cols": 1, "rows": 1 } },
        { "p": "dotField", "x": 0.62, "y": 0.44, "w": 0.12, "h": 0.10, "o": { "cols": 1, "rows": 1 } },
        { "p": "moonSlit", "x": 0.40, "y": 0.28, "w": 0.16, "h": 0.10, "o": { "cols": 1, "rows": 1, "depth": 0.40 } }
      ] },
    { "key": "flag", "tex": "cavFlag", "w": 0.30, "h": 0.36, "parent": "chest", "joint": [-0.06, 1.17], "pivot": [0.18, 0.95], "rest": [0, 0, 0], "z": -0.040,
      "cloth": { "amp": 1.3, "freq": 1.2, "lag": 0.5, "scaleBy": 0.30, "gravity": 0.0, "wind": 1.4, "stiff": 34, "damp": 5.0, "axis": "z" },
      "outline": [[0.20, 0.05], [0.88, 0.08], [0.94, 0.30], [0.70, 0.52], [0.92, 0.74], [0.60, 0.95], [0.22, 0.70], [0.10, 0.38]],
      "decor": [{ "k": "line", "pts": [[0.14, 0.04], [0.14, 0.98]], "width": 0.020 }],
      "pierce": [
        { "p": "fretBand", "x": 0.26, "y": 0.16, "w": 0.60, "h": 0.12, "o": { "cols": 3, "rows": 1, "alt": 0.62, "gap": 0.20, "ridge": 1 } },
        { "p": "dotField", "x": 0.52, "y": 0.40, "w": 0.14, "h": 0.12, "o": { "cols": 1, "rows": 1 } },
        { "p": "cloudBand", "x": 0.30, "y": 0.56, "w": 0.46, "h": 0.12, "o": { "cols": 2, "rows": 1, "lobes": 1, "alt": 0.65, "ridge": 1 } }
      ] },
    { "key": "shoulderL", "tex": "pauldron", "rest": [0, 0, 0], "uses": "shoulderL", "from": "general" },
    { "key": "upperArmL", "tex": "armUpper", "rest": [0, 0, 0.06], "uses": "upperArmL", "from": "general" },
    { "key": "forearmL", "tex": "armLower", "rest": [0, 0, 0], "uses": "forearmL", "from": "general" },
    { "key": "handL", "tex": "handClaw", "rest": [0, 0, 0], "uses": "handL", "from": "general" },
    { "key": "shoulderR", "tex": "pauldron", "parent": "chest", "joint": [-0.115, 1.165], "rest": [0, 0, 0], "flip": true, "uses": "shoulderL" },
    { "key": "upperArmR", "tex": "armUpper", "parent": "shoulderR", "joint": [-0.115, 1.165], "rest": [0, 0, -0.06], "flip": true, "uses": "upperArmL" },
    { "key": "forearmR", "tex": "armLower", "parent": "upperArmR", "joint": [-0.115, 0.875], "rest": [0, 0, 0], "flip": true, "uses": "forearmL" },
    { "key": "handR", "tex": "handClaw", "parent": "forearmR", "joint": [-0.115, 0.615], "rest": [0, 0, 0], "flip": true, "uses": "handL" },
    { "key": "hipL", "tex": "hipGuard", "rest": [0, 0, 0], "uses": "hipL", "from": "general" },
    { "key": "thighL", "tex": "legUpper", "rest": [0, 0, 0], "uses": "thighL", "from": "general" },
    { "key": "shinL", "tex": "legLower", "rest": [0, 0, 0], "uses": "shinL", "from": "general" },
    { "key": "footL", "tex": "bootFoot", "rest": [0, 0, 0], "uses": "footL", "from": "general" },
    { "key": "hipR", "tex": "hipGuard", "parent": "waist", "joint": [-0.085, 0.810], "rest": [0, 0, 0], "flip": true, "uses": "hipL" },
    { "key": "thighR", "tex": "legUpper", "parent": "hipR", "joint": [-0.085, 0.810], "rest": [0, 0, 0], "flip": true, "uses": "thighL" },
    { "key": "shinR", "tex": "legLower", "parent": "thighR", "joint": [-0.085, 0.435], "rest": [0, 0, 0], "flip": true, "uses": "shinL" },
    { "key": "footR", "tex": "bootFoot", "parent": "shinR", "joint": [-0.085, 0.075], "rest": [0, 0, 0], "flip": true, "uses": "footL" },
    { "key": "weapon", "tex": "cavSpear", "w": 0.22, "h": 1.28, "parent": "handR", "joint": [-0.125, 0.560], "pivot": [0.5, 0.79], "rest": [0, 0, 0], "z": 0.020,
      "decor": [
        { "k": "bar", "at": [0.5, 0.60], "w": 0.055, "h": 0.96 },
        { "k": "disc", "at": [0.5, 0.965], "r": 0.032 },
        { "k": "bar", "at": [0.5, 0.26], "w": 0.150, "h": 0.045 },
        { "k": "blob", "pts": [[0.24, 0.29], [0.30, 0.24], [0.34, 0.29], [0.30, 0.33], [0.25, 0.33]] },
        { "k": "blob", "pts": [[0.76, 0.29], [0.70, 0.24], [0.66, 0.29], [0.70, 0.33], [0.75, 0.33]] }
      ],
      "pierce": [
        { "p": "wanField", "x": 0.38, "y": 0.68, "w": 0.24, "h": 0.20, "o": { "cols": 1, "rows": 2, "alt": 0.70, "gap": 0.18, "ridge": 1 } },
        { "p": "dotField", "x": 0.44, "y": 0.36, "w": 0.12, "h": 0.03, "o": { "cols": 1, "rows": 1 } },
        { "p": "dotField", "x": 0.44, "y": 0.44, "w": 0.12, "h": 0.03, "o": { "cols": 1, "rows": 1 } },
        { "p": "dotField", "x": 0.44, "y": 0.52, "w": 0.12, "h": 0.03, "o": { "cols": 1, "rows": 1 } },
        { "p": "fretBand", "x": 0.40, "y": 0.24, "w": 0.20, "h": 0.06, "o": { "cols": 2, "rows": 1, "alt": 0.60, "gap": 0.18, "ridge": 1 } }
      ] },
    { "key": "weaponTip", "tex": "cavSpearHead", "w": 0.20, "h": 0.32, "parent": "weapon", "at": [0.5, 0.22], "pivot": [0.5, 0.92], "rest": [0, 0, 0], "z": 0.020,
      "outline": [[0.30, 0.94], [0.70, 0.94], [0.78, 0.76], [0.72, 0.44], [0.56, 0.10], [0.50, 0.03], [0.44, 0.10], [0.28, 0.44], [0.22, 0.76]],
      "decor": [{ "k": "bar", "at": [0.50, 0.93], "w": 0.055, "h": 0.05 }, { "k": "blob", "pts": [[0.56, 0.86], [0.64, 0.92], [0.70, 0.84], [0.64, 0.74], [0.56, 0.78]] }],
      "pierce": [
        { "p": "moonSlit", "x": 0.42, "y": 0.28, "w": 0.16, "h": 0.44, "o": { "cols": 1, "rows": 1, "tilt": 1.5708, "depth": 0.45, "ridge": 1, "gap": 0.02, "winPad": 0.04 } },
        { "p": "dotField", "x": 0.44, "y": 0.80, "w": 0.12, "h": 0.10, "o": { "cols": 1, "rows": 1 } }
      ] }
  ]
};

/* ================================================================== *
 * 运行时：图纸 -> 贴图 -> rig.addPart
 * ================================================================== */

/** 表缓存：同一张表只解析/建贴图一次（将军与副将共用四肢贴图） */
const TABLES = new Map();

function table(name) {
  if (TABLES.has(name)) return TABLES.get(name);
  const raw = PART_SPECS[name];
  if (!raw) throw new Error('未知图纸表：' + name);
  const specs = resolveSpecs(raw, PART_SPECS, {
    table: name, ppm: TEX_PPM[name] || 900, maxPx: TEX_MAX_PX,
  });
  const { byKey, anchors, joints } = resolveAnchors(specs);
  const entry = { name, specs, byKey, anchors, joints, texes: new Map() };
  TABLES.set(name, entry);
  return entry;
}

/** 取"画这张图纸的原件"：镜像复用件用来源部件的图纸（避免二次镜像） */
function artSpecOf(entry, spec) {
  if (!spec.uses) return spec;
  const src = table(spec.usesFrom || entry.name);
  const srcSpec = src.byKey.get(spec.uses);
  if (!srcSpec) throw new Error(`部件 ${spec.key} 复用 ${spec.uses} 失败`);
  return artSpecOf(src, srcSpec);
}

function textureOf(entry, spec) {
  const cached = entry.texes.get(spec.artKey);
  if (cached) return cached;
  const art = artSpecOf(entry, spec);
  const [pw, ph] = art.pix;
  const tex = makeAlphaFromDraw((ctx, W, H) => drawPartSpec(ctx, W, H, art), {
    w: pw, h: ph,
    parchment: true,
    glow: art.glow,
    baseColor: art.baseColor,
    seed: art.seed,
  });
  tex.name = spec.artKey;
  entry.texes.set(spec.artKey, tex);
  return tex;
}

/** 把一张图纸表装配到 rig 上（父部件先建、子部件后建，顺序即层级） */
export function buildFromTable(rig, name) {
  const entry = table(name);
  for (const spec of entry.specs) {
    rig.addPart({
      key: spec.key,
      tex: textureOf(entry, spec),
      w: spec.w,
      h: spec.h,
      parent: spec.parent || undefined,
      anchor: entry.anchors.get(spec.key),
      pivot: spec.pivot,
      z: spec.z,
      rest: spec.rest,
      cloth: spec.cloth,
      flipX: spec.flip,
    });
  }
  return entry;
}

/** 主演员：将军（头盔翎羽、靠旗、披风、长柄偃月刀） */
export function buildGeneral(rig) { return buildFromTable(rig, 'general'); }

/** 远景副将（层叠用）：斗笠、飘带、短披风、长矛；四肢复用将军图纸 */
export function buildCavalry(rig) { return buildFromTable(rig, 'cavalry'); }

/** 布景道具：见 src/props.js（保持 INTERFACES A 的入口在 puppet.js 上） */
export { buildProps };

/** 供预览/自检使用：解析后的图纸表（含贴图尺寸、孔洞声明） */
export function partTable(name) { return table(name); }

# 模块接口细则 v1（引擎已实现，其他人按此对接）

引擎（`index.html` / `src/main.js` / `renderer.js` / `screen.js` / `compositor.js` / `stage.js` / `textures.js` / `rig.js` / `materials.js`）
已经写好。以下是被依赖方**必须精确遵守**的契约。

## A. `src/puppet.js`（皮影资产组）

```js
export function buildGeneral(rig)   // 主演员“将军”
export function buildCavalry(rig)   // 远景副将（层叠用）
export function buildProps(scene, lightFar)  // -> { rig, apply(propsData, t) }
```

### A.1 rig 提供的 API（只能用这些）

```js
rig.addPart({
  key,                 // 通道名，必须用下面「标准通道名」
  tex,                 // THREE.Texture，来自 textures.js 的 makeAlphaFromDraw
  w, h,                // 世界单位（米）宽度/高度
  parent,              // 父部件 key；省略 = 挂在 rig.root
  anchor: [x, y],      // 关节挂点，位于**父部件 pivot 的局部坐标系**里
  pivot:  [x, y],      // 纹理内旋转轴心（0,0 = 纹理中心；向右+
  z,                   // 层叠微偏移
  rest:  [rx,ry,rz],   // 静息欧拉角（弧度）
  cloth: { amp, freq, lag, scaleBy, gravity, wind, stiff, damp, axis } | null,
  opacity, visible, alphaTest, castShadow,
});
```

局部坐标约定：向右 +x，向上 +y。**部件自身的 pivot 就是它绕之旋转的关节**；
子部件的 `anchor` 写在父部件 pivot 的坐标系里。例：

```js
// 上臂长 0.30，从肩关节往下垂
rig.addPart({ key:'upperArmL', tex:armTex, w:0.085, h:0.30, parent:'chest',
              anchor:[-0.075, 0.10], pivot:[0, 0.15], rest:[0,0,0.06] });
// 前臂挂在“上臂的末端”：上臂 pivot 在它自己顶部，所以末端是 pivot 坐标系的 (0, -0.30)
rig.addPart({ key:'forearmL', tex:armTex2, w:0.075, h:0.27, parent:'upperArmL',
              anchor:[0, -0.30], pivot:[0, 0.135] });
```

**标准通道名（只能用这些，编排组靠它驱动）**

```
躯干： waist, chest, neck, head
左臂： shoulderL, upperArmL, forearmL, handL
右臂： shoulderR, upperArmR, forearmR, handR
左腿： hipL, thighL, shinL, footL
右腿： hipR, thighR, shinR, footR
附加： cape, cape2, scarf, weapon, weaponTip, plume, flag
```

### A.2 造型硬要求

1. **头饰**（盔、冠、翎羽）必须有镂空花纹：缠枝纹 / 云纹 / 回纹 / 花瓣窗。
2. **衣纹**：袍摆、袖口、甲片必须有通透的花纹（鳞甲、万字纹、海棠窗）。
3. **兵器**：刀身、刀柄、护手必须有镂空（血槽改成镂空更传统，或用缠枝纹）。
4. 镂空要**成组、有节奏**（大小孔洞交替），不要随机洒点。
5. 整体身高 `PUPPET_HEIGHT = 1.55` 米（幕布高 2.5 米，所以人在幕布上约占 62%）。
6. 侧脸/半侧正面造型（4/5 视角最适合皮影）。脚底在 y ≈ 0 附近（rig.root 会被放到 y≈-1.24）。
7. 每个部件都要 `castShadow`（默认 true）。**不要**给背景/幕布之外的东西加。

### A.3 道具布景 `buildProps`

要求最少 5 件，沿 z 轴分层（层叠感）：
- 近景（z≈-0.05）：右下角的山石一角，剪影深、最实
- 中景（z≈-0.5）：左前方的松树 / 竹子，带镂空树冠
- 中景（z≈-0.9）：右侧酒旗或灯笼杆
- 远景（z≈-2.0）：连绵远山（可以是扁平剪影，不需要镂空）
- 远景（z≈-2.4）：一轮月亮或窗棂（镂空窗格）

`apply(propsData, t)` 里 propsData 形如
```js
{ sway: {pine: 0.03}, visible: {moon: true}, opacity: {mountain: 0.85} }
```
（编排组会按幕次给出；没给就保持不变。）

## B. `src/choreography.js` 与 `src/ease.js`（编排组）

### B.1 必须导出

```js
export const PERFORMANCE = { title, duration, acts: [{id,name,t0,t1,beats:[...]}] };
export function buildTimeline(): {
  duration: number,
  sample(t: number) -> Frame,
  debug(): { acts, beats, holds, easings },   // 给 QA 打表用的结构化信息
}
```

### B.2 `Frame` 结构（严格）

```js
{
  dt: number,                    // 本次采样的时间步（秒），引擎直接喂给布料模拟
  subtitle: string | null,       // 幕布下方唱词/旁白（一句，≤28 字）
  actors: {
    general: {
      visible: true,
      root: { tx, ty, tz, rz, ry },  // 世界位移(米)、倾身 rz(弧度)、绕竖轴偏航 ry(弧度)
      pose: { waist:[x,y,z], upperArmL:[x,y,z], ... },   // 只写要动的通道，其余保持不变
      opacity:  { weapon: 0.0 } | undefined,             // 需要时用
      visibleParts: { flag: false } | undefined,
      wind: [wx, wy] | undefined,
    },
    cavalry: { ... 同上 ... },
  },
  light: { intensity: 0..4, color: 0xRRGGBB|'#rrggbb', pos: [x,y,z], flicker: 0..1 },
  props: { sway:{}, visible:{}, opacity:{} },
}
```

**重要**：`sample(t)` 必须**是纯函数**（同一 t 永远同一结果），不能依赖内部累积状态。
引擎每帧都调用它；布料模拟在引擎侧，`dt` 只是提示。

**字段语义补充（v1.1）**
- `root.ty` **由时间轴负责给出绝对基线**（引擎每帧覆写 `root.position`）。recommended `BASE.ty = -1.24`。
- `root.tz` 也要每帧回传（general ≈ -0.14，cavalry ≈ -0.46），否则演员会贴到幕布平面上。
- `root.ry` 是**绕竖轴偏航**（平片皮影的“真转身”通道，`rotation.set(0, ry, rz)`）。转身请用 ry，不要用 waist.y（那看起来是扭腰而不是转身）。ry=±π/2 时剪影收成一条窄边，物理正确。
- `root.rz` 只作有界倾身（建议 |rz| ≤ 0.30），不要用大角度转身，否则人会倒。
- `light.pos` 必须是 `THREE.Vector3` 或带 `x/y/z` 属性的数组；`light.color` 接受 `'#rrggbb'` / 十六进制数 / `THREE.Color`。
- **隐藏部件用 `visibleParts`，不要用 `opacity`**：阴影深度材质只读贴图 alpha 与 alphaTest，不读 opacity —— 用 opacity 会让可见剪影变淡但影子还在。
- `dt` 是本次采样间隔（秒），引擎直接喂给布料二阶阻尼；建议固定 1/60。

### B.3 编排硬要求（用户原话：有起承转合，不只是走来走去）

时长 **46 秒左右**，四幕：

- **起 · 上灯·入场**：灯由暗到亮（intensity 0.15→2.6），灯焰抖动；副将从左侧缓步入场并停在画面左侧 2/3 处；主演员缺席。有 1.2 秒的静场。
- **承 · 探看·生疑**：主演员自右侧入场（走路 6–8 步，步频前慢后快）；停步；转头张望两次（每次含 0.4s 停顿）；抬手搭额远眺（抬手要“肘先动、腕后随”）；灯光轻微压暗一下（示意风起）。
- **转 · 拔刀·激斗**：抽刀（先撤半步、再猛然前刺）；连续两记挥刀（一大一小，节奏一快一慢）；一个转身（root.rz 从 0 → -1.6 → -3.14 → -1.9，配合重心下沉）；一个定格亮相（全身绷住 0.9 秒不动，只有刀尖与翎羽在微颤）。
- **合 · 收势·余韵**：收刀入鞘（慢）；退后半步；转身背对观众缓步走远（脚步越来越慢，最后一步几乎不动）；幕布上只剩远景与月亮；灯光缓缓收成一个点（intensity → 0.35），最后 2 秒留白。

**节奏硬指标**（写进 `debug()`）：
- 停顿（速度接近 0）时长合计 ≥ 6 秒，且至少 5 处独立停顿；
- 每幕至少一次“快 — 停 — 慢”的对比；
- 脚步不能用正弦匀速：每一步用「抬起(快, easeOut) → 落下(慢, easeIn) → 支撑(停)」；
- 转身时重心必须下沉（ty 下降 0.05~0.09 米），否则会像原地旋转。

### B.4 `debug()` 必须返回

```js
{ acts:[{id,name,t0,t1}],
  beats:[{act, name, t0, t1, speed:'慢|中|快|停', ease:'easeOutCubic|...'}],
  holds:[{t0,t1,dur,what}],          // 所有停顿
  holdTotal:number, holdCount:number,
  easings:[...] }
```

## C. 验证组

- `tools/qa.mjs`：headless Chrome + CDP（复用 `tools/cdp.mjs`）。加载 `index.html`，等 `window.__READY__`（超时 60s），调 `window.__qa()`，逐时间点 `window.__SET_TIME__(t)` + 等 2 帧 + `Page.captureScreenshot` 写 `shots/`。
- `tools/probe.mjs`：把 PNG 解码成像素做**定量断言**（需要自己写 PNG 解码：zlib 在 node:zlib，PNG 是 filter+deflate，写一个最小解码器）。
- **必须给出数字**，不许写“看起来不错”。

## D. 跨组红线

- 只写自己范围内的文件（见 `CONTRIBUTING.md` 第 3 节）。
- 任何接口变更先改 `CONTRIBUTING.md` 和本文件，并在消息里通知 lead。
- 引擎的 `src/renderer.js`、`src/compositor.js`、`src/screen.js`、`src/stage.js`、`src/main.js`、`src/materials.js`、`src/rig.js`、`src/textures.js` 由 lead 独占写。

## E. 全局约定 v2（灯位 / 相机 / 基线已按投影几何重算）

- 相机在 **(0, 0, 3.63)，fov 38** —— 取景**正好等于幕布 4.0 × 2.5**，所以幕布坐标 = 画面坐标。
- **光源在 (0.10, -0.28, -3.2)**，暖黄 `0xffb45a`，距离 12，张角 0.62。
  ```
  放大率 K = zLight / (zActor - zLight)
  影子屏幕坐标 y = yLight + (yActor - yLight) * K
  ```
  演员脚底 y=-1.06（`BASE.ty`）→ 影子脚底 ≈ -1.11，正好在幕布下沿(-1.25)之内；K ≈ 1.09。
  **任何依赖灯位的换算都必须与 `src/stage.js` 同步**（`shapes.js` 的 `STAGE_LIGHT` 已同步为 `[0.10,-0.28,-3.2]`）。
- 演员基线：`BASE.ty = -1.06`、`BASE.tzGeneral = -0.25`、`BASE.tzCavalry = -0.55`。
- 阴影贴图的**最终可采样纹理**是 `ShadowStage.pre`（横向→纵向两级模糊后的距离图），
  `ShadowStage.map` 只是第一步的原始深度。**不要把 `pre` 拷回 `map`** —— 那是同纹理读写同一像素的反馈回路。
- 阴影贴图的深度编码：`(灯光视空间距离 - rangeNear) / (rangeFar - rangeNear)`，
  区间由 `WaveScreen.update()` 按「灯到幕布四角的真实距离 ± 0.6」算出。
  区间必须覆盖真实距离，否则片元被 clamp 成常量、影子整片消失。
- 采样阴影贴图时必须取 `(u, 1-v)`（FBO 纹理 v 轴与 NDC 相反）。


# 影窗 · Shadow Play — 技术简报与模块契约 (v1)

> 本文件是所有协作者的唯一事实来源。改接口必须先改本文件。

## 1. 目标（逐条可验收）

用户要求做一场皮影戏。必须满足：

| # | 要求 | 实现手段 | 验收方式 |
|---|------|----------|----------|
| R1 | 幕布后面有光源，观众看到幕布上投出的剪影 | Three.js `SpotLight`（暖黄）位于幕布后方，`castShadow`；幕布 `receiveShadow`，剪影为真实 shadow map 遮挡 | 控制台打印 shadowMap 尺寸；QA 截图检查幕布上有暗剪影 |
| R2 | 人物由可活动关节组成，能走路/转身/抬手 | 分层关节树 `Rig`：root→腰→胸→颈/头、肩→上臂→前臂→手、胯→大腿→小腿→脚；每帧由姿态驱动 | 逐帧关节角度日志 + 关键帧截图差异 |
| R3 | 动作之间有停顿与轻重缓急 | `Choreography` 时间轴：每段有 `hold`（停顿）、`ease`（缓动曲线）、`speed` 曲线 | 打印每段时长/停顿/缓动类型 |
| R4 | 造型有传统皮影镂空感（头饰/衣纹/兵器通透花纹），光透过能看清细节 | 每个剪影部件是**带 alpha 的镂空纹理**（程序化生成，非 SVG）；镂空处光直接穿过 → shadow map 里是亮斑 | 截图中剪影内部可见花纹亮斑 |
| R5 | 灯光暖黄 | 光色 RGB 暖黄 + 后期暖色调映射 | 采样幕布中心像素色相 |
| R6 | 幕布有织物纹理与轻微褶皱 | 程序化织物纹理（经纬线 + 噪声）+ 顶点级褶皱起伏（`PlaneGeometry` 位移） | 截图中可见纹理与褶皱明暗 |
| R7 | 光晕在幕布边缘散开 | 光斑径向衰减 + 后期 bloom 泛光（多级模糊） | 截图边缘亮度剖面 |
| R8 | 真实光影与层叠，禁止简单 SVG | WebGL2 + 真实 shadow mapping + HDR 多级泛光 + 多层前后景视差 | 代码审查：无 SVG 元素；有三层以上 z 深度 |
| R9 | 有起承转合的表演，不只是走来走去 | 四幕结构：《起》入场上灯 →《承》探看生疑 →《转》拔刀激斗 →《合》万籁俱寂 | 时间轴文本 + 逐幕截图 |

## 2. 技术栈（已锁定）

- 纯前端，无构建步骤，ES modules，`type="module"`。
- Three.js **r160.1，已本地 vendored** 到 `vendor/three.module.js`（1.27 MB）。**禁止 CDN**。
- importmap 已写在 `index.html`：`"three" -> "./vendor/three.module.js"`。
- 无后处理 addon 依赖：泛光/composite 用**自写 shader pass**（避免 `EffectComposer` 依赖链）。
- 画布 WebGL2。已在本机 headless Chrome + SwiftShader 上验证可运行。

## 3. 目录与写入范围（严格分区，禁止越界写）

```
皮影戏-影窗/
  index.html          <- 引擎组（lead）
  README.md           <- lead
  vendor/three.module.js
  src/
    main.js           <- 引擎组（lead）     入口/装配/UI
    renderer.js       <- 引擎组（lead）     WebGL 渲染器、RT、合成、后期
    screen.js         <- 引擎组（lead）     幕布网格 + 材质 + 褶皱
    textures.js       <- 引擎组（lead）     程序化织物/纸感纹理
    compositor.js     <- 引擎组（lead）     泛光/颗粒/暗角 shader pass
    stage.js          <- 引擎组（lead）     舞台、灯、背景、道具放置
    rig.js            <- 皮影资产组         ★ 关节树、部件烘焙、cloth、姿态应用
    puppet.js         <- 皮影资产组         ★ 人物剪影定义 + 镂空部件图纸
    shapes.js         <- 皮影资产组         ★ 镂空花纹与刀法（通用件）
    props.js          <- 皮影资产组         道具剪影（山石/树/旗/鸟）
    choreography.js   <- 编排组             ★ 四幕时间轴与动作函数
    ease.js           <- 编排组             缓动/间歇曲线
  assets/                                  （如需烘焙图片，皮影资产组）
  tools/              <- 验证组
  shots/              <- 验证组输出截图
```

## 4. 模块契约（签名即接口，先按此写，再实现）

### 4.1 `src/textures.js`（lead 拥有，其他人**只读**）

```js
export function makeFabricTexture(size=1024): {map: THREE.CanvasTexture, bumpMap: THREE.CanvasTexture}
// 经纬织纹 + 细噪声 + 轻微色差；bumpMap 为灰度凹凸
export function makeParchmentTexture(opts?): THREE.CanvasTexture  // 皮影牛皮/羊皮纸底纹(alpha)
export function makeAlphaFromDraw(draw, {w,h}={}): THREE.CanvasTexture // 圆滑描边+抗锯齿
```

### 4.2 `src/rig.js`（皮影资产组拥有）

```js
export class Rig {
  constructor(opts?:{scale?:number})
  root: THREE.Group            // 直接加到舞台；自身不承担朝向
  addPart(spec: PartSpec): THREE.Object3D   // 返回该部件的 Pivot(Object3D)，见下
  setPose(pose: Record<string, Vec3>): void  // 通道名 -> [rx,ry,rz] 弧度；缺省通道保持不变
  resetPose(): void
  update(dt: number): void     // cloth/次级运动
  dispose(): void
}

type PartSpec = {
  key: string,                 // 部件与通道同名：'upperArmL' 等
  tex: THREE.Texture,          // 带 alpha 的镂空纹理
  w: number, h: number,        // 世界单位尺寸（宽, 高）
  parent?: string|null,        // 父部件 key；null/省略 = 挂在 root 的 anchor
  anchor?: [number, number],   // 父部件局部坐标下的关节挂点（相对父 pivot 的位置）
  pivot?: [number, number],    // 纹理内的旋转轴心（-w/2..w/2, -h/2..h/2 的局部坐标）；默认 [0,0] 即纹理中心
  z?: number,                  // 局部 z 偏移（层叠），默认 0
  cloth?: {amp:number, freq:number, lag:number} | null  // 布料次级摆动
  hidden?: boolean
}
```

规则：
- 每个部件 = 一个 `THREE.Object3D`（Pivot，在 `anchor` 处）+ 其下的 `THREE.Mesh(PlaneGeometry(w,h))`，mesh 平移 `-pivot` 以便绕轴心转。
- 材质：`MeshBasicMaterial({map:tex, transparent:true, alphaTest:0.5, depthWrite:true, side:DoubleSide, toneMapped:false})`；
  并设置 `mesh.customDepthMaterial = new THREE.MeshDepthMaterial({depthPacking:RGBADepthPacking, map:tex, alphaTest:0.5})` 保证**镂空处投影是真亮的**。
- `setPose` 用弧度欧拉角（默认 XYZ 顺序）。

标准通道名（编排组只能用这些）：

```
root(x,y,z,rotZ)  ← 经 rig.root / setPose 中的 'tx','ty','tz','rz' 控制整体位移与倾身
waist, chest, neck
shoulderL, upperArmL, forearmL, handL        shoulderR, upperArmR, forearmR, handR
hipL, thighL, shinL, footL                   hipR, thighR, shinR, footR
cape, scarf, weapon, weaponTip               (布料/道具，可选)
```

整体位移通道：`tx ty rz`（米 / 弧度）。

### 4.3 `src/puppet.js`（皮影资产组拥有）

```js
export const PUPPET_HEIGHT = 1.55;   // 世界单位（米），保证与 stage.js 的幕布/相机匹配
export function buildGeneral(rig: Rig): void   // 将军：头盔翎羽、披风、长柄偃月刀
export function buildWeaponBear(rig: Rig): void // 持械随从（可选，用于层叠）
```

要求：**头饰、衣纹、兵器必须镂空**。镂空用 `shapes.js` 的花纹生成器绘制到 alpha 纹理上。

### 4.4 `src/choreography.js`（编排组拥有）

```js
export const PERFORMANCE = {
  title: '影窗·夜巡',
  acts: [ {id:'起', name:'上灯·入场', t0:0, t1:11}, ... ],  // 时间秒
  duration: 46,
};
export function buildTimeline(): Timeline;   // 返回 { duration, sample(t) -> Frame }
// Frame = { pose: {channel:[x,y,z]}, root:{tx,ty,rz}, light:{intensity,flicker,pos}, facts?:{} }
export function sampleAt(t:number): Frame
```

编排组提交时必须附：**每幕的真实秒数、每个动作的停顿时长、缓动类型**，并且在自己写的 `tools/qa-perf.mjs` 里打印出来（不用真浏览器，直接 node import）。

### 4.5 `src/renderer.js`（lead 拥有）

```js
export class Renderer {
  constructor(canvas: HTMLCanvasElement, opts?)
  get scene(): THREE.Scene
  get camera(): THREE.PerspectiveCamera
  setSize(w,h,dpr)
  render(dt:number): void     // 场景 -> RT -> bloom/复合 -> 屏幕
  stats(): {tris, drawCalls, shadowMap, bloomLevels, hdr:boolean}
  dispose(): void
}
```

## 5. 验证组

- `tools/qa.mjs`：headless Chrome + CDP，加载 `index.html`，等 `window.__READY__`，执行 `window.__qa()` 取结构化指标，按时间点截图到 `shots/`。
- `tools/probe.mjs`：像素级断言（幕布中心亮度、剪影暗度、边缘光晕衰减、镂空亮斑存在、帧间差异证明有动画）。
- 任何断言失败 = 任务未完成，必须回报具体数字。

## 6. 全局约定（v2：灯位与相机已按投影几何重算）

- 世界单位 = 米。幕布在 z=0，尺寸 4.0(宽) x 2.5(高)。相机在 **(0, 0, 3.63)，fov 38** ——
  取景**正好等于幕布**，所以「幕布坐标」可以直接当作画面坐标用。
- **光源在 (0.10, -0.28, -3.2)**，暖黄 `0xffb45a`，距离 12，张角 0.62。
  这组位置是反推出来的：
  ```
  放大率 K = zLight / (zActor - zLight)      灯越远，影子越大
  影子屏幕坐标 y = yLight + (yActor - yLight) * K
  ```
  灯高 -0.28 ≈ 幕布中心，演员脚底 -1.06 → 影子脚底 ≈ -1.11（正好在幕布下沿 -1.25 之内），
  放大率 ≈ 1.09（影子比人大一点点，传统的观感）。
  **任何依赖灯位的换算（例如 `shapes.js` 的 `STAGE_LIGHT`）都必须与这里同步。**
- 皮影站在幕布后方：主将 z ≈ -0.25，副将 z ≈ -0.55，打斗时下压到 -0.26，走远时 -0.44。
  z 越负离幕布越远、剪影越大越虚（真实透视）。
- 所有动画**必须确定性**：`window.__SET_TIME__ = t` 能把场景精确设置到 t 秒并渲一帧（供 QA 截图）。
  禁止依赖 `Date.now()`/随机。`sample(t)` 必须是纯函数。
- **注意**：`index.html` 用的是真实模块；任何"临时/预览"用的页面请放到 `tools/` 下并自己
  import 真实模块（例如 `tools/probe-screen.html`），**不要**在 `index.html` 里放回退实现。
- 代码注释用中文，标识符英文。

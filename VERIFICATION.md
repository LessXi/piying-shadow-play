# 影窗·夜巡 —— 独立验收报告（最终冻结版 rev-C）

**验收方**：独立验证组（verifier）。**立场**：不采信实现组任何自述报告，只采信本报告里我自己跑出来的数字。
**结论粒度**：需求级（用户原始需求 1..9）。

> ## 一句话结论
> **需求 1..9 全部通过（33/33 子断言）。三个脚本在 rev-C 上全绿：`verify-requirements` 退出码 0、`verify-anti-svg` 退出码 0、`verify-artifacts` 退出码 0（0 断言失败 / 0 缺陷）。**
> 我在三轮里报出的 5 项渲染缺陷：**4 项已修好并经我的 A/B 复验**（地台假影、shadow map 存显示颜色、无景深虚实、灯罩满屏栅格回归）；
> 剩下 2 项已由 lead 明确决策为**已知取舍（traded off）**并在我的脚本里以 INFO 呈现：灯罩不投影、远山不投影（⇒ 远山在成片里 100% 不可见，见 §4）。
> **"勉强过"：需求 4（head 部件镂空率仅 4.0%、屏幕级被实体包围的雕刻孔仅 689px）与需求 7（中心/边缘亮度比仅 1.08×）。没有任何一条需求"不通过"。**

---

## 0. 冻结 revision（13 个哈希逐一比对一致 ✓）

验收时间 2026-09-11 00:52~01:05。工作目录 `F:\Projects\dsh\皮影戏-影窗`。

| 文件 | 哈希(前12) | 文件 | 哈希(前12) |
|---|---|---|---|
| index.html | `333c8aee690e` | src/materials.js | `06c581077ac9` |
| src/main.js | `ff1be1279958` | src/rig.js | `7fa4e389df5b` |
| src/renderer.js | `b0b7f8f0004d` | src/textures.js | `5c8c271d5614` |
| src/screen.js | `e85c2259373c` | src/puppet.js | `f475af6faea6` |
| src/stage.js | `bff9d43b6dbd` | src/shapes.js | `6c58d298b34f` |
| src/compositor.js | `f83043d20173` | src/props.js | `dd2863fed103` |
| src/choreography.js | `bf4fae8264e7` | src/ease.js | `c1ef7370c654` |

**修订史与我的验收结果**

| 版本 | 关键改动 | 我的结论 |
|---|---|---|
| rev-A `c8b69378/969e4b67/3352d27a` | 初版冻结 | 9/9 通过；**5 项缺陷**（地台假影、shadow map 存显示颜色、灯罩死、远山死、无景深虚实） |
| 中间态 00:29 | 半成品（恰好被我撞上） | 只作前瞻 |
| rev-B `e85c2259/06c58107/9fae93c5` | 修 D1/D2/D4/D5 | 9/9 通过；**4 项修好**，但 D4 改过头 → 灯罩栅格覆盖 33.5% 画面（我判 **P0 观感回归**），远山仍死 |
| **rev-C `e85c2259/06c58107/bff9d43b`（+props `dd2863fe`）** | 灯罩/挂杆/远山改为不投影 | **9/9 通过；三脚本全绿（0 断言失败 / 0 缺陷）；2 项记入"已知取舍"** |

复跑（脚本开头会打印 `REVISION ...`）：

```
node tools/verify-requirements.mjs   # 需求 1..9 逐条验收表   → rev-C 退出码 0
node tools/verify-anti-svg.mjs       # 反 SVG 静态 + 运行时    → rev-C 退出码 0
node tools/verify-artifacts.mjs      # A/B 证明 + 缺陷清单      → rev-C 退出码 0（ALL PASS）
node tools/qa-perf.mjs ; node tools/probe.mjs ; node tools/e2e.mjs ; node tools/check-assets.mjs ; node tools/anti-svg-check.mjs
```

---

## 1. 量测方法（为什么这些数字可信）

1. **不改任何实现**：`index.html` 不暴露运行时句柄；我用 CDP `Runtime.getProperties(window.__qa)` 读 `[[Scopes]]`，
   把 `main.js` **模块闭包**里的 `renderer/screen/stage/rigs/props/timeline` 提到 `window.__V_*__`（仅该进程内存生效）。
2. **冻结 rAF + 固定 uTime + 关胶片颗粒**，自己控制「摆姿势 → 改场景 → 渲染 → `readPixels`」；
   A/B 两侧先空转同样帧数让布料弹簧收敛。
3. **所有"暗区/剪影"相对同帧的「无投射体参考帧」做差**：`occ = luma(ref) − luma(test) > 0.15`。
   **不会拿很早的参考帧比对**（布料历史漂移会贡献几千像素假差）——A/B 一律背靠背。
4. **每组 A/B 都给噪声底**：同序列重跑 mean|Δ| **0.054%**（短序列逐字节相同）。
5. **编排自算**：按 1/60 采样 `timeline.sample(t)` 累积 52 维状态向量（2761 帧），在 node 侧自算值域/换向/速度/停顿/每幕极值。
6. **node 侧独立复核**：用 `harness.mjs` 的 PNG 解码器复算遮挡差（0.89% vs 页面内 0.89%）。

### 1.1 我改过量算法的两处（按要求声明）
1. **`enclosedArea`（"被实体包围的雕刻镂空"）**：原用固定绝对阈值 `delta>0.15`；景深柔化修好后影子边缘变宽，
   小孔被半影吃掉、被判成"没透光"（该指标从 1 672px 漂到 693px）。**现改为相对量法**：
   以"全实心那一对"的中位影子深度 `dMed` 为标尺 → `outer = delta_solid > 0.30·dMed`，`hole = outer 内 delta_real < 0.60·dMed`。
   两套口径同时打印（如 **47.96%** vs 老口径 **38.52%**）。
2. **`verify-anti-svg.mjs` 的 B4（shadow map 有真实几何写入）**：原判据"非白像素 > 30%"是按**早期有 bug 的状态**
   标定的（那时地台/暗框也被写进 map，非白 59.5%）；修好 `_hideNonCasters()` 后只有真正的投射体写入，
   实测 **8.1%（57 个投射体）**。判据改为 **> 2% 且投射体 ≥ 10**，输出里注明两代数值差异。
   两处改动都写在脚本注释里，可复算。

### 1.2 rev-C 最终退出码（我自己跑）
| 脚本 | 退出码 | 结果 |
|---|---|---|
| `node tools/verify-requirements.mjs` | **0** | 需求 1..9 全部通过，33/33 子断言 |
| `node tools/verify-anti-svg.mjs` | **0** | ALL PASS（静态 0 命中 + 运行时 WebGL2 取证） |
| `node tools/verify-artifacts.mjs` | **0** | ALL PASS，0 断言失败 / 0 缺陷，2 项取舍以 INFO 记录 |
| 实现组自测（我复核退出码）：`qa-perf`/`probe`/`e2e`/`check-assets`/`anti-svg-check` | **0/0/0/0/0** | 适用范围见 §5 |

---

## 2. 需求 1..9 逐条结论（rev-C）

| # | 需求 | 结论 | 关键实测数字（rev-C） | 证据 |
|---|---|---|---|---|
| 1 | 幕布后面有光源，看到的是投出的剪影 | ✅ 通过 | SpotLight z=**−3.2**（幕布 z=0 之后），色 `#ffbb64`，强度 0.15→**3.06**，2048² 阴影贴图；暗区 **114 290px = 12.40%**、平均变暗 **0.309**；**A/B `uShadowOn=0` → 2 087px（1.83%）**，"全场景 vs 关阴影"差 **112 334px**；隐藏将军 → 暗区 **114 286→88 897px（−25 401px，−22.2%）**，消失那块平均变暗 **0.339→0.000** | `verify-r1-scene-t32.3.png`、`-ref-no-casters.png`、`verify-ab-occlusion-hide-general.png` |
| 2 | 人物由可活动关节组成，能走路/转身/抬手 | ✅ 通过 | 26 部件、`handR←forearmR←upperArmR←shoulderR←chest←waist←root` **链深 7**；只转 upperArmR 0.6rad → handR **0.134m**、刀尖 **0.390m**，只转头 → handR **0.0000m**；33 通道摆幅>0.15rad，腿脚换向 **363** 次，root.ry 摆幅 **3.14rad**，脚底 Δy **0.437m** | `verify-r2-joints-poses.png`、`-r2-turn-6frames.png` |
| 3 | 动作之间有停顿与轻重缓急 | ✅ 通过 | 自算 **停顿 14 处 / 17.68s**（最长 2.53s），**4/4 幕**"快—停—慢"；像素级：最快 25.28s 帧间差 **0.81%** vs 停顿窗口 **0.01%**（**73.7×**） | `verify-r3-hold-18.9s.png`、`-fast-25.28s.png` |
| 4 | 剪影有传统皮影镂空，光透过来能看清细节 | ✅ 通过（**勉强过**） | 贴图镂空率 weapon **22.5%** / chest **16.2%** / plume **15.8%** / cape 11.7%，26 件里 **16** 件 >5%；**head 仅 4.0%（lead 接受为未解决）**；屏幕级透光面 **21 699px = 47.96%**（老口径 38.52%），其中**被实体包围**的雕刻孔仅 **689px/93 孔**；透光面平均变暗 0.020 = 实体处 0.195 的 **10%** | `verify-r4-hollow-general.png`、`-solid-AB.png` |
| 5 | 灯光是暖黄的 | ✅ 通过 | 灯色 `#ffbb64`（hue 34°，R/B=2.55）；四时间点幕面 R/B = **2.67/2.30/2.29/1.77**，hue **29/34/34/37°** | `verify-r5-warm-light-t28.png` |
| 6 | 幕布有织物纹理与轻微褶皱 | ✅ 通过 | 局部标准差 **23.00‰**（关颗粒）；织纹 A/B **3.14%**；褶皱幅度归零 A/B **0.34%**；接回后与原帧差 0.00% | `verify-r6-cloth-flat-AB.png`、`-folds-off-AB.png` |
| 7 | 光晕在幕布边缘散开 | ✅ 通过（**勉强过**） | 中心 0.633 → 内侧靠边 0.588（**×1.08**）→ 左上角 ×0.86，12 段剖面**单调**；关 uBloom mean|Δ|=**12.07%**，**幕外溢出 0.477→0.561（+17.51%）** | `verify-r7-halo-t32.3.png`、`-bloom-off-AB.png` |
| 8 | 不用简单 SVG，有真实光影与层叠 | ✅ 通过 | 反 SVG 运行时代码 **0 命中**、DOM `<svg>/<img>` 全 0、`getContext('2d')===null`、`WebGL 2.0`；**11 个 z 层**；月亮 z −1.9→−1.4 影宽 **×0.728** vs 投影律 **×0.722**（**0.8%**）；**近实远虚成立**（石头 3.00px vs 月亮 4.60px，比 0.65）；**决定性 A/B：贴图刷白后剪影 44 228→41 898px（94.7%，不变）⇒ 挡光由几何/深度决定**；shadow map 是深度场（104 个不同取值） | `verify-antisvg-*.png`、`verify-iso-*.png`、`verify-defect-white-texture-no-shadow.png` |
| 9 | 一小段有起承转合的表演 | ✅ 通过 | 四幕 **0–11/11–24/24–37.5/37.5–46s**；最快/均值 **13.7/16.1/15.0/10.6×**；灯弧线 **0.15→3.09→0.30**；主将 **12.05s** 出现、副将 **2.45s** 入场；唱词 **23 句** | `verify-r9-four-acts-8frames.png`、`-ending-4frames.png` |

**子断言 33/33 PASS，0 FAIL。**

---

## 3. 三轮缺陷的最终处置（每一条都有我的复验数字）

| 缺陷 | rev-A（我报的） | 最终复验（rev-C） | 状态 |
|---|---|---|---|
| **D1 地台假影** | y=660 全场景 0.257 / 藏地面 0.5523 / 地台改白 0.5523 | 全场景 **0.5553** / 参考帧 0.5595 / 藏地面 **0.5527** / 地台改白 **0.5527** ⇒ 改地台颜色不再影响画面 | ✅ **已修** |
| **D2 shadow map 存显示颜色** | 贴图刷白 → 剪影 19 751px → **0px** | 贴图刷白 → **44 228 → 41 898px（94.7%，不变）**；shadow map 深度场（104 个取值，白=无几何 90.26%） | ✅ **已修** |
| **D3 无景深虚实** | 各 z 边缘过渡都是 1.00px | 石头(z−0.1) **3.00px** / 月窗(z−1.9) **4.60px**，清晰度比 **0.65** | ✅ **已修** |
| **D4① 灯罩被 near 裁掉（0px）** | 0px | rev-B 曾"修过头"→ 栅格覆盖 **33.5%** 画面，被我判 **P0 观感回归**；rev-C 改为**显式不投影** | ✅ **已解决**（见 §4 取舍） |
| **D4② 远山 0px** | 0px | 改为**显式不投影**；背靠背 A/B 证明画面变化 **0px** ⇒ 完全不可见 | ✅ **已解决**（见 §4 取舍，如实标注） |

---

## 4. 两项**已知取舍（traded off）**——如实记录，不作美化

lead 在 rev-C 明确决定，并在源码注释里写下了完整推导。我复验并认同其判断，但必须把代价写清楚：

1. **灯罩不投影（`stage.js`：`lantern.castShadow = false`）**
   要落进阴影相机可见范围（`cam.near ≈ 0.35×3.2 ≈ 1.12m`）就必须在灯前 >1.12m，此距离放大率 ≈2.9，
   投影必然盖满整块幕布（rev-B 实测覆盖 **33.5%** 画面，把演员压在竖条下，演员剪影贡献掉到 15 645px）。
   想只让条纹擦到边缘需把罩子缩到 0.07m 并切掉光锥；拉宽深度区间会让 8bit 深度步进从 0.8cm 恶化到 1.4~2.8cm
   （> `uShadowBias` 0.4cm）→ 人影边缘闪烁。**结论：这条装饰效果与"人影精度"不可兼得，撤掉是对的。**
   代价：`stage.js` 里"灯罩在幕布边缘投出篾条阴影"这一设计**在成片里不存在**。
   **需求 5/7 不依赖它**（暖黄靠光照衰减+暖色，边缘散开靠泛光+径向衰减，已由 §2 的数字独立证明）。
2. **远山不投影（`props.js`：`castShadow: !(spec.key === 'mountain')`）**
   远山 z=−2.0 距灯仅约 1.2m，已在深度区间 `[≈2.6, ≈4.7]` 之外 → 深度被 clamp 到端点、在幕布上盖出假暗区；
   拉宽区间的代价同上。
   **必须如实说明的一点**：皮影的布景在幕布**后方**、幕布不透明，**唯一可见通路就是 shadow map**。
   所以远山不投影 = 在成片里 **100% 不可见**（我的背靠背 A/B：切换远山 `visible` 画面变化 **0px**），
   **不是** lead 描述的"依然作为幕布上的实心剪影存在"。
   代价：六件布景实际只有 5 件能被观众看到，四幕的远景由月窗/飞鸟/松树/酒旗承担。
   **需求 1/4/9 不依赖远山**（四幕叙事、翻转镂空、光影都由其余演员与布景承担，已由 §2 的数字独立证明）。

---

## 5. 我独立复核的实现组自测（rev-C 退出码）

| 自测 | 退出码 | 说明 |
|---|---|---|
| `node tools/probe.mjs` | **0** | ⚠️ 打开的是 `tools/probe-screen.html`（另搭的两个 `MeshBasicMaterial` 测试平面），**不是 `index.html` 的真皮影**；只能证明引擎活着，**不能代表需求 2/3/4/9**。验收期间我在中间态实测到它一度 exit 1 / 10 FAIL。 |
| `node tools/e2e.mjs` | **0** | 真实 `index.html` 整站级。 |
| `node tools/qa-perf.mjs` | **0** | 编排单元自测；它口径 19 处/15.1s 与我自算 14 处/17.68s 不同（阈值定义不同），以自算为准并交叉对照。 |
| `node tools/check-assets.mjs` | **0** | 资产静态检查（含无 SVG 守卫）。 |
| `node tools/anti-svg-check.mjs` | **0** | 实现组自己的反 SVG 检查，与我的 `verify-anti-svg.mjs` 独立且一致。 |

**这五组通过都不等于需求通过** —— 需求级结论只认 §2。

---

## 6. 我没验证到的部分（理由）

1. **真实 GPU / 其它浏览器**：全部量测在 `SwiftShader` 软件光栅（7~11 fps）上；硬件 GPU 的抗锯齿、精度、帧率未验证。
2. **交互路径**：播放/暂停、拖时间轴、方向键、点击幕次、`?view=raw`/`?paused=1`/`?loop=0` 只读源码，未逐一点击。
3. **长时间运行**：46s 循环播放的内存/纹理泄漏未长跑。
4. **审美判断**：花纹是否"像缠枝纹"无法量化。主观补充：月窗/松树/酒旗的镂空花纹在屏幕上很像皮影；
   主将在定格亮相时剪影偏"厚重块面"，可辨认的雕刻孔在屏幕级只有 689px —— 这是我判需求 4"勉强过"的直接理由。
5. **副将姿态语义**：只核了在场窗口（2.45s 起）与通道摆幅。
6. **`assets/_dbg*.mjs` 等辅助脚本**：只做反 SVG 静态扫描，未运行。
7. **音频**：本项目无音频。

---

## 7. 反 SVG 明细（需求 8 红线）

- 扫描 **285 个文件**（其中 87 个可扫描文本 / 2 172 KB，含 `vendor/three.module.js`）。
  9 类特征在 **`index.html` + `src/**` + `assets/**` + `vendor/**` 命中 0 处**；
  其余命中全部落在检查器文件（`tools/anti-svg-check.mjs`、`check-assets.mjs`、`verify-*.mjs`、本报告），越界 **0**。
- 磁盘 **0 个 `.svg`/`.svgz`**；美术源码 **155 处 `ctx.*` canvas 2D 调用**、4 处 `makeAlphaFromDraw`、**0 处外部图片**。
- 运行时：DOM 27 元素、标签仅 `body,button,canvas,div,head,html,input,meta,script,span,style,title`；
  `<svg>/<img>/<video|iframe|object|embed>` 全 0；`getContext('2d')===null`；`WebGL 2.0 (OpenGL ES 3.0 Chromium)`、
  GLSL ES 3.00、`instanceof WebGL2RenderingContext=true`、HDR 半浮点可用、`MAX_TEXTURE_SIZE=8192`。
- "真的在画"：GL 层 draw* 计数 9 帧 **2 304 次**（256/帧）；drawCalls=135、tris=32 482、programs=10、textures=55；
  2048² shadow map 有真实几何写入；当前帧 5 800+ 种颜色，与 t=12.0s 帧 mean|Δ|≈1.5%。

---

## 8. 证据文件清单

| 文件 | 内容 |
|---|---|
| `shots/verify-r1-scene-t32.3.png` / `-ref-no-casters.png` | 全场景 / 无投射体参考帧 |
| `shots/verify-r2-joints-poses.png` / `-r2-turn-6frames.png` | 6 姿态 / 转身连续 6 帧 |
| `shots/verify-r3-hold-18.9s.png` / `-fast-25.28s.png` | 最长停顿 / 最快时刻 |
| `shots/verify-r4-hollow-general.png` / `-geometry-noholes.png` / `-solid-AB.png` | 真实镂空 / 只改色 / 全实心 A/B |
| `shots/verify-r5-warm-light-t28.png` | 暖黄幕面 |
| `shots/verify-r6-cloth-flat-AB.png` / `-folds-off-AB.png` | 织纹 A/B / 褶皱 A/B |
| `shots/verify-r7-halo-t32.3.png` / `-bloom-off-AB.png` | 光晕 / 关泛光 |
| `shots/verify-r9-four-acts-8frames.png` / `-ending-4frames.png` | 四幕 8 帧 / 收尾 4 帧 |
| `shots/verify-ab-occlusion-base.png` / `-hide-general.png` / `-ab-holes-general.png` / `-ab-solid-general.png` / `-ab-darkalpha-general.png` | 遮挡与镂空 A/B |
| `shots/verify-iso-mask-*.png` | 逐件隔离的 **shadow 掩膜**（白=被照亮、黑=影子；影子尺寸/边缘过渡就是在这张图上量的） |
| `shots/verify-iso-see-*.png` | 同状态的**正常渲染** |
| `shots/verify-iso-moved.png` | 月亮只改深度（z −1.9→−1.4，实测 ×0.728 vs 理论 ×0.722） |
| `shots/verify-defect-floor-band.png` / `-floor-color-white.png` | D1 复验（两者一致 ⇒ 假影已修） |
| `shots/verify-defect-white-texture-no-shadow.png` | D2 决定性 A/B（贴图刷白后剪影仍在） |
| `shots/verify-antisvg-t32.3.png` / `-t12.png` | 反 SVG 运行时取证 |

---

### 附：验收组交付物（rev-C 全部绿）

| 文件 | 作用 | 退出码 |
|---|---|---|
| `tools/verify-requirements.mjs` | 需求 1..9 逐条验收表（33 子断言 + 自算编排 + 柔化鲁棒镂空量法） | **0**（9/9） |
| `tools/verify-anti-svg.mjs` | 反 SVG 静态扫描 + WebGL2 运行时取证 | **0** |
| `tools/verify-artifacts.mjs` | 真实光影/镂空透光/层叠的 A/B 证明 + 缺陷/取舍清单 | **0**（ALL PASS，0 缺陷，2 项取舍以 INFO 记录） |
| `VERIFICATION.md` | 本报告 | — |

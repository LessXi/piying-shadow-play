# tools/ —— 构建、验证与调试工具

全部是 Node 脚本，**零第三方依赖**（没有 puppeteer、没有 playwright）。
无头浏览器驱动 `harness.mjs` 里自己实现了最小 CDP 客户端（含 RFC6455 握手）
和一个 PNG 解码器，所以整条链只需要本机装了 Chrome 或 Edge。

---

## 一、构建

| 脚本 | 作用 |
|---|---|
| `build-single.mjs` | ★ 把 three.js 与 `src/` 全部模块内联成自包含 `index.html`。带三道自检（语法、模板注入、script 标签配对）。 |
| `export-share.mjs` | 再导出一份中文命名的分享副本，并自检「零外链」。 |

改动 `src/` 之后跑 `build-single.mjs` 即可。

## 二、验收（核心，CI 上就该跑这些）

| 脚本 | 覆盖 | 断言数 |
|---|---|---|
| `probe.mjs` | 引擎层：光影/镂空透光/织纹/暖色/动画/阴影跟随 | 11 项像素级 |
| `e2e.mjs` | 整站：真实 `index.html`，11 个时间点截图 + 断言 | 6 项 |
| `qa-perf.mjs` | 编排：停顿/节奏/步态/转身/全身协同/纯函数 | 77 项（无需浏览器） |
| `check-assets.mjs` | 造型：真跑绘制机数孔洞、校验关节挂点几何、道具分层 | 全部静态检查 |
| `anti-svg-check.mjs` | 反 SVG：扫源码 + 磁盘 + 运行时 DOM | — |
| `verify-requirements.mjs` | 独立验收：逐条对照需求 1..9 | 33 项 |
| `verify-anti-svg.mjs` | 反 SVG 的运行时取证版 | — |
| `verify-artifacts.mjs` | 对抗性 A/B：证明「真实光影 / 镂空透光 / 层叠」不是画上去的 | — |

## 三、环境验证（★ 这两条最重要，见 README「踩过的坑」第 1 条）

| 脚本 | 作用 |
|---|---|
| `repro-user.mjs` | 用**不带任何特殊开关**的浏览器，直接 `file://` 打开 `index.html`。防止出现「自动化全绿但用户双击打不开」。 |
| `verify-share-file.mjs` | 把单文件复制到一个**空目录**再打开，证明它真的自包含。 |

## 四、调试探针

开发过程中用来定位具体问题的脚本，保留下来是因为**它们各自定位过一个真实缺陷**，
比读代码猜要快得多：

| 脚本 | 定位过什么 |
|---|---|
| `gl-feedback.mjs` | WebGL 反馈回路。逐阶段读 `gl.getError()`，发现「源 ≠ 目标」还不够 —— 只要被采样的纹理**之前某一趟**当过渲染目标就会被丢弃 draw，泛光因此静默失效。 |
| `shadow-ab.mjs` | 用「开/关阴影」的逐格亮度差，量化影子到底落在画面哪里、对比度多少。 |
| `shadow-truth.mjs` / `shadow-compare.mjs` / `shadow-expect.mjs` | 阴影贴图的深度语义：把 ref（片元到灯的距离）与 sd（贴图采样值）分别可视化/列表比对。 |
| `diag-shadow.mjs` / `diag-after.mjs` | 灯光相机矩阵、深度区间、贴图取值直方图。 |
| `iso-shadow.mjs` | 把 `ShadowStage` 从整站里隔离出来单独跑，确认是引擎问题还是装配问题。 |
| `props-ab.mjs` | 布景可见性 A/B（皮影布景在幕布后方，唯一可见通路是 shadow map）。 |
| `mountain-ab.mjs` / `occlusion-test.mjs` / `veil-test.mjs` | 逐个隐藏对象，定位「谁在画面上占了多少」。 |
| `edge-scan.mjs` | 沿幕布扫亮度剖面，验证光晕径向衰减。 |
| `rt-capacity.mjs` | 探测本机 WebGL 支持的 RT 格式（HalfFloat / Float 是否可渲染、是否可回读）。 |
| `cal-check.mjs` / `expo-scan.mjs` | 曝光与亮度标定。 |
| `inspect-composite.mjs` / `inspect-runtime.mjs` | 读运行时对象：着色器 uniform 是否真被编译进去、材质是否真被替换。 |
| `stage-metrics.mjs` | 相机取景 vs 幕布尺寸的几何核对。 |
| `asset-preview.mjs` + `asset-preview.html` | 皮影装配台：把 rig 摆成 6 组姿态截图，检查关节是否脱节、镂空是否透光。 |

### 配套的临时页面

部分探针需要一个最小页面来跑真实引擎（不依赖 `main.js`）：
`probe-screen.html`、`gl-feedback.html`、`iso-shadow.html`、`props-ab.html`、
`shadow-compare.html`、`shadow-truth.html`、`shadow-viz.html`、`raw-scene.html`、
`rt-capacity.html`、`asset-preview.html`、`dbgmode-repro.html`、`min-shadow.html`。

---

## 常用命令

```bash
# 改完引擎后
node tools/build-single.mjs          # 重新打包
node tools/probe.mjs                 # 引擎自检
node tools/e2e.mjs                   # 整站自检
node tools/repro-user.mjs            # file:// 直开自检（别跳过）

# 改完编排后
node tools/qa-perf.mjs               # 77 项，秒级

# 改完造型后
node tools/check-assets.mjs
```

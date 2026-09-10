// 幕布（影窗）：真实顶点级褶皱 + 自定义采样，保证褶皱渐变平滑无带状。
// 幕布着色完全自写：光锥衰减、距离平方衰减、织物织纹、镂空剪影。
import * as THREE from 'three';
import { makeBlurMaterial, syncShadowDepthUniforms, applyShadowDepthMaterials } from './materials.js';
const QUAD_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const SCREEN_VERT = /* glsl */`
  uniform float uTime;
  uniform vec2  uWaveDir;
  uniform float uAmpTop;
  uniform float uAmpBottom;
  varying vec2  vUv;
  varying vec3  vWorldPos;
  varying float vSlopeX;
  varying float vCurv0;
  varying float vCurv1;
  varying float vFold;

  float foldShape(float s, float p) {
    float primary = sin(s * p + 0.35);
    float ripple  = 0.45 * sin(s * p * 2.37 + 1.9);
    float third   = 0.18 * sin(s * p * 4.13 + 4.1);
    return (primary + ripple + third) / 1.63;
  }

  void main() {
    vec3 pos = position;
    vec2 uv  = uv;

    // 褶皱包络：顶部挂杆处紧绷，向下逐渐自由
    float s = uv.x;
    float drop = 1.0 - uv.y;
    float env = 0.40 + 0.75 * smoothstep(0.0, 0.55, drop) * (0.55 + 0.65 * drop);

    // 主褶皱（低频，横向）
    float p0 = 5.4;
    float f0 = foldShape(s, p0);
    // 次级褶皱（高频），幅度受主褶皱调制，模拟布料受力集中处
    float p1 = 10.7;
    float f1 = sin(s * p1 + 1.3 + sin(s * p0) * 0.7);

    float base = f0 * 0.72 + f1 * 0.28;

    // 纵向的轻微起伏：越往下越松
    float gy = sin(uv.y * 3.3 + 1.1 + uTime * 0.05) * 0.22 * drop
             + sin(uv.x * 8.0 + uv.y * 2.1 + uTime * 0.041) * 0.10 * drop;

    float wave = sin((uv.x * uWaveDir.x + uv.y * uWaveDir.y) * 6.28318 * 1.7
                     + uTime * 0.55) * 0.30
               + sin((uv.x * uWaveDir.x - uv.y * uWaveDir.y) * 6.28318 * 2.9
                     - uTime * 0.42) * 0.18;

    float amp = mix(uAmpBottom, uAmpTop, uv.y);
    float h = (base + gy + wave) * amp * env;
    pos.z += h;

    float dEnv = env + (1.0 - uv.y) * 0.0;
    float slope0 = cos(s * p0 + 0.35) + 0.45 * (p0 * 2.37 / p0) * cos(s * p0 * 2.37 + 1.9)
                 + 0.18 * (p0 * 4.13 / p0) * cos(s * p0 * 4.13 + 4.1);
    float slope1 = cos(s * p1 + 1.3 + sin(s * p0) * 0.7) * (p1 / p0);
    float dHds = (slope0 / 1.63) * 0.72 + slope1 * 0.28;

    vSlopeX = dHds * amp * dEnv;
    vCurv0  = -sin(s * p0) * amp * dEnv;
    vCurv1  = -sin(s * p1 + 1.3) * amp * dEnv;
    vFold   = base;
    vUv     = uv;
    vWorldPos = (modelMatrix * vec4(pos, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(pos, 1.0);
  }
`;

const SCREEN_FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D uWeaveMap;
  uniform sampler2D uWeaveBump;
  uniform sampler2D uShadowMap;
  uniform sampler2D uPreBlur;
  uniform mat4  uLightProjection;
  uniform mat4  uLightView;
  uniform vec3  uLightPos;
  uniform vec3  uLightDir;
  uniform vec3  uLightColor;
  uniform float uLightIntensity;
  uniform float uLightCosOuter;
  uniform float uLightCosInner;
  uniform float uLightDistance;
  uniform float uShadowOn;
  uniform float uShadowBias;
  uniform float uShadowNormalBias;
  uniform float uShadowTexel;
  uniform float uFarPlane;
  uniform float uRangeNear;
  uniform float uRangeFar;
  uniform vec2  uWeaveScale;
  uniform vec2  uScreenSize;
  uniform float uCameraZDir;
  uniform float uClothDiffusion;
  uniform float uDepthSoftness;
  uniform float uFlipY;
  uniform float uTime;
  uniform float uDebug;

  varying vec2  vUv;
  varying vec3  vWorldPos;
  varying float vSlopeX;
  varying float vCurv0;
  varying float vCurv1;
  varying float vFold;
  vec2 vDebugUV = vec2(0.0);
  float refNDC = 0.0;

  /** 把世界坐标投到灯光的 shadow map UV（超出 [0,1] 表示不在光锥投影内） */
  vec2 lightUV(vec3 world) {
    vec4 lc = uLightProjection * uLightView * vec4(world, 1.0);
    vec3 ndc = lc.xyz / lc.w;
    return ndc.xy * 0.5 + 0.5;
  }

  /** 调试：只返回单次中心采样的比较结果 */
  float computeShadowNDC() {
    vec2 suv = lightUV(vWorldPos);
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) return 0.5;
    float viewDist = -(uLightView * vec4(vWorldPos, 1.0)).z;
    float ref = (viewDist - uRangeNear) / max(uRangeFar - uRangeNear, 1e-3);
    refNDC = ref;
    // shadow map 是渲染到 FBO 的：UV 原点在左下，纹理 v 轴向下（three 的 flipY），
    // 所以比较前必须把 v 翻一下，否则人影会上下镜像且对不上。
    vec2 muv = vec2(suv.x, 1.0 - suv.y);
    if (uDebug > 9.5) return texture2D(uShadowMap, muv).r;     // 10 = 翻转后采样
    float sd = texture2D(uShadowMap, muv).r;
    if (uDebug > 8.5) return sd;                      // 9 = 只显示采样到的深度
    if (uDebug > 7.5) return ref;                     // 8 = 只显示 ref
    if (uDebug > 6.5) return sd;                      // 7 = 阴影贴图原始采样
    if (uDebug > 5.5) return ref;                     // 6 = 片元归一化距离
    return step(ref - uShadowBias, sd);
  }

  /** 调试：把灯光 shadow map 的原始内容按“世界坐标方向”可视化，
   *  R = shadow map 采样值，G = 该片元的 ref（归一化距离），B = 是否越界 */
  float debugMapProbe() {
    vec2 suv = lightUV(vWorldPos);
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) return 0.35;
    return texture2D(uShadowMap, suv).r;
  }

  // 把 X 方向的斜率/曲率装进切空间法线
  vec3 perturbNormal() {
    float nx = -vSlopeX * 1.25;
    float ny = (vCurv0 * 0.010 + vCurv1 * 0.004) * 1.1;
    return normalize(vec3(nx, ny, 1.0));
  }

  float computeShadow() {
    if (uShadowOn < 0.5) return 1.0;

    vec3 world = vWorldPos;
    vec3 toLight = uLightPos - world;
    float dist = length(toLight);

    vec4 lc = uLightProjection * uLightView * vec4(world, 1.0);
    vec3 ndc = lc.xyz / lc.w;
    vec2 suv = ndc.xy * 0.5 + 0.5;
    vDebugUV = suv;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) return 1.0;

    // 和深度材质用完全相同的量：灯光视空间 -z，映射到 [uRangeNear, uRangeFar]
    float viewDist = -(uLightView * vec4(world, 1.0)).z;
    float ref = (viewDist - uRangeNear) / max(uRangeFar - uRangeNear, 1e-3);
    refNDC = ref;

    // shadow map 是渲染进 FBO 的：FBO 的纹理 v 轴与 NDC 的 v 方向相反，
    // 所以要取 (u, 1-v)。uFlipY 只作为运行时开关保留（校准用），默认必须为 1。
    vec2 muv = mix(vec2(suv.x, 1.0 - suv.y), suv, uFlipY);

    // 布料扩散：按**该投射物离幕布多远**（深度图 B 通道）放大采样半径 —— 近实远虚。
    // 注意不能用"幕布片元到灯的距离"，那个在整个幕布上几乎是常数（3.07~3.39m），
    // 做不出景深。这里按 B 通道逐样本取真实的投射物深度。
    float baseTexel = uShadowTexel;

    // 8 抽头泊松盘 + 贴图侧预模糊，得到织物漫射感的柔边
    vec2 poisson[8];
    poisson[0] = vec2(-0.94201624, -0.39906216);
    poisson[1] = vec2( 0.94558609, -0.76890725);
    poisson[2] = vec2(-0.09418410, -0.92938870);
    poisson[3] = vec2( 0.34495938,  0.29387760);
    poisson[4] = vec2(-0.91588581,  0.45771432);
    poisson[5] = vec2(-0.81544232, -0.87912464);
    poisson[6] = vec2(-0.38277543,  0.27676845);
    poisson[7] = vec2( 0.97484398,  0.75648379);

    float lit = 0.0;
    for (int i = 0; i < 8; i++) {
      vec2 uv = muv + poisson[i] * baseTexel * vec2(1.0, -1.0);
      vec4 s = texture2D(uShadowMap, uv);
      // B 通道 = 投射物离幕布的距离（0..1.5m）：本体越远，采样半径越大 → 影子越虚
      float soft = 1.0 + s.b * uDepthSoftness;
      vec2 o = poisson[i] * baseTexel * soft * vec2(1.0, -1.0);
      float sd = texture2D(uShadowMap, muv + o).r;
      lit += (ref - uShadowBias <= sd) ? 1.0 : 0.0;
    }
    float s = lit / 8.0;
    // 只有很窄的过渡带，避免硬边；布料本身会再散开一点
    return smoothstep(0.25, 0.75, s);
  }

  void main() {
    // ---- 经纬织纹：高频凹凸 ----
    vec2 wuv = vUv * uWeaveScale;
    float wv = texture2D(uWeaveBump, wuv).r;

    // 用织纹做切空间法线扰动，形成布面斜光的明暗颗粒
    vec3 nrm = perturbNormal();
    float gx = texture2D(uWeaveBump, wuv + vec2(1.0 / uWeaveScale.x, 0.0)).r
             - texture2D(uWeaveBump, wuv - vec2(1.0 / uWeaveScale.x, 0.0)).r;
    float gy = texture2D(uWeaveBump, wuv + vec2(0.0, 1.0 / uWeaveScale.y)).r
             - texture2D(uWeaveBump, wuv - vec2(0.0, 1.0 / uWeaveScale.y)).r;
    nrm = normalize(nrm + vec3(-gx, -gy, 0.0) * 3.6);

    // ---- 光照：光锥衰减 + 距离平方衰减 ----
    vec3 toLight = uLightPos - vWorldPos;
    float dist = max(length(toLight), 1e-4);
    vec3 L = toLight / dist;
    float cosang = dot(-L, uLightDir);

    float spread = 0.72;          // 光锥边缘的柔化量
    float cone = smoothstep(uLightCosOuter,
                            mix(uLightCosOuter, uLightCosInner, 1.0 - spread) + 1e-4,
                            cosang);
    cone = pow(cone, 1.15);

    // 距离衰减：用接近平方反比的曲线，但整体放平缓（光斑外扩），
    // 使得「中心亮、四缘暗」是均匀渐晕，而不是一束窄光。
    float atten = 1.0 / (1.0 + (dist * dist) * 0.085);

    // ---- 阴影 ----
    float shadow = computeShadow();

    // ---- 布料 ----
    vec3 cloth = texture2D(uWeaveMap, wuv).rgb;
    float clothLum = dot(cloth, vec3(0.299, 0.587, 0.114));
    // 织物的微观明暗（经纬的凹凸本身会挡住一部分光）
    float micro = 0.78 + (wv - 0.5) * 0.55;

    float ndl = clamp(dot(vec3(0.0, 0.0, uCameraZDir), nrm), 0.0, 1.0);
    ndl = pow(ndl, 0.75);

    float lambert = 0.52 + 0.48 * ndl;
    float lightGain = cone * atten * lambert * micro;
    // lightGain 保留给调试参考；实际亮度用 LIT_TARGET 直接标定

    // 被照亮处：暖白布面被背后的灯打透。
    // 这里直接定"目标线性亮度"再乘锥形/距离衰减，比用一堆物理系数相乘可控得多：
    // 目标 0.35 经曝光 1.0 + ACES + sRGB 后约 0.85，是理想的暖白布面。
    // 基线必须够亮，否则后期泛光会相对主导、把幕布洗平（这也是之前失败的根因）。
    const float LIT_TARGET = 1.15;
    vec3 lit = uLightColor * vec3(0.92, 0.86, 0.74) * cone * atten * lambert * micro * LIT_TARGET;

    // 被剪影挡住处：只剩纤维散射的微光（约亮部的 3%），影子才有分量
    vec3 ambient = cloth * uLightColor * vec3(0.30, 0.26, 0.20) * (LIT_TARGET * 0.030);

    // 透光：布面被强光照亮时的自身发光（与遮挡无关，所以剪影内部仍看得到织纹）
    float vd = clamp(uCameraZDir * dot(L, vec3(0.0, 0.0, 1.0)), 0.0, 1.0);
    vec3 transmissive = cloth * uLightColor * cone * atten * mix(0.002, 0.005, vd);

    // 织物纹理的对比（让纹理不被光晕冲平）
    lit *= 0.90 + (clothLum - 0.5) * 0.30;

    vec3 col = mix(ambient, lit, shadow);

    // 阴影边缘的纤维散射：在过渡带上抬一点，避免影子像贴上去的黑块
    col += uLightColor * cloth * (1.0 - shadow) * 0.005;
    // 布面的整体透光（很弱，但让死黑的影子区不至于像空场）
    col += transmissive;

    // 调试模式：把中间量直接可视化（0=关；1=shadow,2=cone,3=atten,4=shadowUV,5=法线）
    if (uDebug > 0.5) {
      vec3 dbg = vec3(0.0);
      if (uDebug < 1.5) dbg = vec3(shadow);
      else if (uDebug < 2.5) dbg = vec3(cone);
      else if (uDebug < 3.5) dbg = vec3(atten);
      else if (uDebug < 4.5) dbg = vec3(vDebugUV, 0.0);
      else if (uDebug < 5.5) dbg = nrm * 0.5 + 0.5;
      else if (uDebug < 7.5) dbg = vec3(computeShadowNDC(), 0.0, 0.0);
      else dbg = vec3(texture2D(uShadowMap, vDebugUV).r,
                      clamp(refNDC / max(uFarPlane, 1e-3), 0.0, 1.0), 0.0);
      gl_FragColor = vec4(clamp(dbg, 0.0, 1.0), 1.0);
      return;
    }

    gl_FragColor = vec4(col, 1.0);

    // 调试模式 5：把「处于阴影中」的像素直接涂红，肉眼一秒判断影子落在哪
    if (uDebug > 4.5 && uDebug < 5.5) {
      if (shadow < 0.5) gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
      else gl_FragColor = vec4(col * 0.35, 1.0);
    }
  }
`;

/* ------------------------------------------------------------------ *
 * 投影到幕布上的“写实阴影贴图”
 * ------------------------------------------------------------------ */

class ShadowStage {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.SpotLight} light
   * @param {{size?:number, lightFar?:number}} opts
   */
  constructor(renderer, light, { size = 2048, lightFar = 12 } = {}) {
    this.renderer = renderer;
    this.light = light;
    this.lightFar = lightFar;
    this.size = size;

    const rtOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
    };
    this.map = new THREE.WebGLRenderTarget(size, size, rtOpts);
    // 预模糊与最终采样都在**全分辨率**上做：这样 uShadowTexel 的单位就是一致的 1/size，
    // 泊松采样半径不用担心"采样的是小图、texel 按大图算"造成的偏差（之前就是 1024 图配 1/2048）。
    this.pre = new THREE.WebGLRenderTarget(size, size, rtOpts);
    this.blurH = new THREE.WebGLRenderTarget(size, size, rtOpts);

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.quad.frustumCulled = false;
    // 注意 near 不能是 0：那会让全屏四边形的 w = -z = 0，投影退化后整块被裁掉。
    // 把相机放在 z=1、四边形（PlaneGeometry 在 z=0）距离 1，完全覆盖 [-1,1]^2。
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.quadCam.position.z = 1;
    this.quadCam.lookAt(0, 0, 0);
    this.quadCam.updateProjectionMatrix();
    this.quadCam.updateMatrixWorld(true);
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);

    // 模糊链路必须首尾相接：map -> blurH -> pre -> map
    // （之前的写法让 blurX 去采样 pre，而 pre 当时还没被任何东西写过，于是全是 0）
    this.blurX = makeBlurMaterial(this.map.texture, [1, 0], 1 / size);
    this.blurY = makeBlurMaterial(this.blurH.texture, [0, 1], 1 / this.pre.height);

    // 阈值化材质（把预模糊结果二值化回干净的 0/1 深度）
    this.thresholdMat = new THREE.ShaderMaterial({
      uniforms: {
        tPre: { value: this.pre.texture },
        uCut: { value: 0.5 },
        uSoft: { value: 1.6 },
        uTexel: { value: new THREE.Vector2(1 / size, 1 / size) },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tPre;
        uniform float uCut;
        uniform float uSoft;
        uniform vec2 uTexel;
        varying vec2 vUv;
        void main() {
          float c = texture2D(tPre, vUv).r;
          // 用相邻样本做一点轮廓软化，避免二值化后的阶梯
          float s = 0.0;
          s += texture2D(tPre, vUv + vec2( uTexel.x, 0.0) * uSoft).r;
          s += texture2D(tPre, vUv + vec2(-uTexel.x, 0.0) * uSoft).r;
          s += texture2D(tPre, vUv + vec2(0.0, uTexel.y) * uSoft).r;
          s += texture2D(tPre, vUv - vec2(0.0, uTexel.y) * uSoft).r;
          s *= 0.25;
          float f = (c * 0.6 + s * 0.4);
          gl_FragColor = vec4(f, f, 0.0, 1.0);
        }
      `,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    this.thresholdMat.name = 'shadowThreshold';

    this._casters = [];
    this._fallbackDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    this.diag = { casterCount: 0, hiddenNonCasters: 0, shadowCalls: 0, shadowTris: 0, mapCleared: false };
  }

  get texelSize() { return 1 / this.size; }

  /** 收集需要投影的网格（带 castShadowRaw 标记的皮影部件） */
  collect(scene) {
    this._casters.length = 0;
    scene.traverse((o) => {
      if (o.isMesh && o.castShadowRaw && o.material && o.visible) this._casters.push(o);
    });
    this.diag.casterCount = this._casters.length;
    return this._casters.length;
  }

  /** 诊断：读完 shadow map 的取值直方图（默认读最终供采样的 pre） */
  readStats(renderer, rt = null) {
    const target = rt || this.pre;
    const w = target.width, h = target.height;
    const buf = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(target, 0, 0, w, h, buf);
    const vals = new Map();
    for (let i = 0; i < buf.length; i += 4) vals.set(buf[i], (vals.get(buf[i]) || 0) + 1);
    return Array.from(vals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
  }

  /** 隐藏所有**非投射体**的可见网格（地面、暗框、幕布、背景…）。
   *  three 内建阴影流程只画 `castShadow` 的物体，但我们是手写 render，
   *  `castShadow` 不生效 —— 不显式藏起来的话，地面会横插在灯与幕布之间，
   *  在幕布下缘压出一条横贯整幅的假影。 */
  _hideNonCasters(scene) {
    const hidden = [];
    scene.traverse((o) => {
      if (o.isMesh && o.visible && !o.castShadowRaw) {
        hidden.push(o);
        o.visible = false;
      }
    });
    return hidden;
  }

  render(scene) {
    const r = this.renderer;

    // 0) 收集投射体，并把灯光视图矩阵 / 深度区间同步给深度材质
    const casters = this.collect(scene);
    // 灯光视图矩阵由 WaveScreen.update() 缓存到这里；深度区间也由它算好
    const lv = this.lightView || (this.lightView = new THREE.Matrix4());
    const rn = this.rangeNear != null ? this.rangeNear : 0;
    const rf = this.rangeFar != null ? this.rangeFar : 12;
    const screenZ = this.screenZ != null ? this.screenZ : 0;
    for (let i = 0; i < casters; i++) {
      syncShadowDepthUniforms(this._casters[i], lv, rn, rf, screenZ);
    }

    // 1) 从光源视角把投射体画进 shadow map
    //    ★ 必须两件事一起做：
    //      a) 把材质换成自写的距离编码深度材质（three 的 customDepthMaterial 在这里不生效）
    //      b) 把非投射体藏起来（castShadow 在这里不生效）
    //    只做一半的话，贴图里存的就是显示颜色而不是距离，"比较深度"就失去物理意义。
    const restoreMaterials = applyShadowDepthMaterials(this._casters);
    const hiddenNonCasters = this._hideNonCasters(scene);
    r.setRenderTarget(this.map);
    r.setClearColor(0xffffff, 1);
    r.info.reset();
    r.clear(true, true, false);
    r.render(scene, this.light.shadow.camera);
    this.diag.shadowCalls = r.info.render.calls;
    this.diag.shadowTris = r.info.render.triangles;
    this.diag.hiddenNonCasters = hiddenNonCasters.length;
    r.setRenderTarget(null);
    restoreMaterials();
    for (const o of hiddenNonCasters) o.visible = true;

    if (this.captureAfterStep1) {
      const c0 = this._casters[0];
      const dm = c0 && c0.customDepthMaterial;
      this.step1Debug = {
        casterName: c0 && c0.name,
        hasCustomDepthMaterial: !!dm,
        alphaTest: dm && dm.uniforms.alphaTest.value,
        rangeNear: dm && dm.uniforms.uRangeNear.value,
        rangeFar: dm && dm.uniforms.uRangeFar.value,
        lightViewIsIdentity: dm ? dm.uniforms.uLightView.value.equals(new THREE.Matrix4()) : null,
        stats: this.readStats(r),
      };
    }

    // 2) 深度图做两级可分离模糊。
    //    ★ 源与目标**绝不能是同一张纹理**，否则 WebGL 报
    //      "Feedback loop formed between Framebuffer and active Texture" 并丢弃这次 draw。
    //    所以：map(原始深度) → blurH(横向) → map(纵向，这一级的最终结果)。
    //    注意 blurY 采样的必须是 blurH，**不能**采 map（那又是自读自写）。
    let prevMat = this.quad.material;
    this.quad.material = this.blurX;
    r.setRenderTarget(this.blurH);
    r.clear(true, true, false);
    r.render(this.quadScene, this.quadCam);

    this.quad.material = this.blurY;      // blurY: tDiffuse = blurH.texture
    r.setRenderTarget(this.map);
    r.clear(true, true, false);
    r.render(this.quadScene, this.quadCam);
    this.quad.material = prevMat;
    r.setRenderTarget(null);

    this.final = this.map.texture;
    return this.final;
  }

  dispose() {
    this.map.dispose(); this.pre.dispose(); this.blurH.dispose();
    this.quad.geometry.dispose();
    this.blurX.dispose(); this.blurY.dispose();
    this.thresholdMat.dispose();
  }
}

/* ------------------------------------------------------------------ *
 * 幕布
 * ------------------------------------------------------------------ */

export class WaveScreen {
  /**
   * @param {{width?:number, height?:number, segX?:number, segY?:number,
   *          fabric:{map:THREE.Texture, bumpMap:THREE.Texture}}} opts
   */
  constructor({ width = 4.0, height = 2.5, segX = 150, segY = 96, fabric } = {}) {
    this.width = width;
    this.height = height;
    this._tmpV = new THREE.Vector3();
    this._tmpV2 = new THREE.Vector3();

    const geo = new THREE.PlaneGeometry(width, height, segX, segY);
    // 挂杆在顶部：把 uv 翻过来，让 uv.y=1 是顶边
    const uv = geo.attributes.uv;
    const pos = geo.attributes.position;
    for (let i = 0; i < uv.count; i++) {
      const y = pos.getY(i);
      uv.setXY(i, uv.getX(i), (y / height) + 0.5);
    }
    uv.needsUpdate = true;
    geo.translate(0, 0, 0);

    this.uniforms = {
      uTime: { value: 0 },
      uWaveDir: { value: new THREE.Vector2(0.83, 0.56) },
      uAmpTop: { value: 0.052 },
      uAmpBottom: { value: 0.018 },
      uWeaveMap: { value: fabric.map },
      uWeaveBump: { value: fabric.bumpMap },
      uWeaveScale: { value: new THREE.Vector2(width / 0.5, height / 0.5) },
      uShadowMap: { value: null },
      uPreBlur: { value: null },
      uLightProjection: { value: new THREE.Matrix4() },
      uLightView: { value: new THREE.Matrix4() },
      uLightPos: { value: new THREE.Vector3() },
      uLightDir: { value: new THREE.Vector3(0, 0, 1) },
      uLightColor: { value: new THREE.Color(0xffb45a) },
      uLightIntensity: { value: 2.0 },
      uLightCosOuter: { value: Math.cos(0.62) },
      uLightCosInner: { value: Math.cos(0.44) },
      uLightDistance: { value: 6.0 },
      uShadowOn: { value: 1 },
      uShadowBias: { value: 0.0042 },
      uShadowNormalBias: { value: 0.0 },
      uShadowTexel: { value: 1 / 2048 },
      uFarPlane: { value: 12 },
      uRangeNear: { value: 0.6 },
      uRangeFar: { value: 4.5 },
      uScreenSize: { value: new THREE.Vector2(width, height) },
      uCameraZDir: { value: 1 },
      uClothDiffusion: { value: 0.055 },
      uDepthSoftness: { value: 6.0 },
      uFlipY: { value: 1 },
      uDebug: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SCREEN_VERT,
      fragmentShader: SCREEN_FRAG,
      side: THREE.DoubleSide,
      depthWrite: true,
      depthTest: true,
    });
    this.material.name = 'screenCloth';

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'screen';
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;
    this.mesh.userData.noShadowReceipt = true;

    this.shadowStage = null;
  }

  /** 设置光源与阴影上下文。renderer 必须已经通过 bindRenderer 绑定。 */
  attachLight(light, { lightFar = 12, shadowSize = 2048, clothDiffusion = 0.055 } = {}) {
    if (!this._renderer) throw new Error('WaveScreen.attachLight: 请先调用 bindRenderer(renderer)');
    this.light = light;
    this.shadowStage = new ShadowStage(this._renderer, light, { size: shadowSize, lightFar });
    this.uniforms.uShadowTexel.value = 1 / shadowSize;
    this.uniforms.uFarPlane.value = lightFar;
    this.uniforms.uClothDiffusion.value = clothDiffusion;
  }

  /**
   * 绑定 three 的 WebGLRenderer（注意：不是 Renderer 包装类）。
   * 兼容传入包装类的情况。
   */
  bindRenderer(renderer) {
    const r = renderer && renderer.renderer ? renderer.renderer : renderer;
    if (!r || typeof r.setRenderTarget !== 'function') {
      throw new Error('WaveScreen.bindRenderer 需要 THREE.WebGLRenderer（或含 .renderer 的包装类）');
    }
    this._renderer = r;
    this._camera = (renderer && renderer.camera) || null;
    const camZ = this._camera ? this._camera.position.z : 5.2;
    this.uniforms.uCameraZDir.value = Math.sign(camZ - this.mesh.position.z) || 1;
  }

  /** 每帧更新：时间、光源、阴影贴图 */
  update(dt, light, camera) {
    const u = this.uniforms;
    u.uTime.value += dt;
    if (light) {
      u.uLightPos.value.copy(light.position);
      light.getWorldDirection(u.uLightDir.value);
      u.uLightColor.value.copy(light.color);
      u.uLightIntensity.value = light.intensity;
      u.uLightCosOuter.value = Math.cos(light.angle);
      u.uLightCosInner.value = Math.cos(light.angle * 0.68);
      u.uLightDistance.value = light.distance || 8;

      // 关键：投影相机（light.shadow.camera）不在场景图里，three 只会在它自己的阴影流程里
      // 更新它的矩阵。我们自己渲染 shadow map，所以必须手动把它对准光源。
      const cam = light.shadow.camera;
      const lp = light.getWorldPosition(this._tmpV);
      cam.position.copy(lp);
      light.target.updateWorldMatrix(true, false);
      const tp = light.target.getWorldPosition(this._tmpV2);
      cam.lookAt(tp);
      cam.near = Math.max(0.05, lp.distanceTo(tp) * 0.35);
      cam.far = Math.max(cam.near + 1, light.distance || 12);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);

      u.uLightProjection.value.copy(cam.projectionMatrix);
      u.uLightView.value.copy(cam.matrixWorldInverse);
      u.uFarPlane.value = cam.far;

      // 深度区间：必须覆盖"灯 -> 幕布"的**真实**距离范围，
      // 否则幕布的片元会被 clamp 到区间端点，比对的不是距离而是常量（影子会整片消失）。
      // 同时还要容纳那些**贴近灯**的远层布景（远山 z≈-0.55 距灯约 2.65m）。
      // 8bit 精度账：区间越宽，步进越粗。这里取 「灯到幕布最近点 - 1.6m」起，
      // 实测区间约 [1.0, 4.8]，步进 ≈ 1.5cm；仍然远小于剪影边缘 4~5cm 的柔化尺度，
      // 而且 uShadowBias 是相对量，所以人影边缘不会因此抖动。
      const halfW = this.width * 0.5, halfH = this.height * 0.5;
      const corners = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(-halfW, -halfH, 0), new THREE.Vector3(halfW, -halfH, 0),
        new THREE.Vector3(-halfW, halfH, 0), new THREE.Vector3(halfW, halfH, 0),
      ];
      let dMin = Infinity, dMax = 0;
      for (const c of corners) {
        const d = lp.distanceTo(c);
        if (d < dMin) dMin = d;
        if (d > dMax) dMax = d;
      }
      const pad = 0.6;
      const near = Math.max(0.05, dMin - pad - 1.6);   // 再往前留 1.6m，给远层布景
      const far = dMax + pad;
      this.rangeNear = near;
      this.rangeFar = far;
      u.uRangeNear.value = near;
      u.uRangeFar.value = far;

      // 缓存给 ShadowStage 的深度材质用
      if (this.shadowStage) {
        if (!this.shadowStage.lightView) this.shadowStage.lightView = new THREE.Matrix4();
        this.shadowStage.lightView.copy(cam.matrixWorldInverse);
        this.shadowStage.rangeNear = near;
        this.shadowStage.rangeFar = far;
        this.shadowStage.screenZ = this.mesh.position.z;
      }
    }
    if (camera) {
      u.uCameraZDir.value = Math.sign(camera.position.z - this.mesh.position.z) || 1;
    }
  }

  /** 渲染阴影贴图（须在主渲染之前调用一次） */
  renderShadow(scene) {
    if (!this.shadowStage) return null;
    const tex = this.shadowStage.render(scene);
    this.uniforms.uShadowMap.value = tex;
    return tex;
  }

  /** 调试：0 关闭；1 shadow，2 cone，3 atten，4 shadow UV（含越界指示），5 法线 */
  setDebugMode(v) { this.uniforms.uDebug.value = Number(v) || 0; }

  /** 把阴影贴图读回 CPU（诊断用） */
  readShadowMap(renderer) {
    if (!this.shadowStage) return null;
    const rt = this.shadowStage.map;
    const w = rt.width, h = rt.height;
    const buf = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    let dark = 0;
    for (let i = 0; i < buf.length; i += 4) if (buf[i] < 128) dark++;
    return { w, h, dark, total: w * h, darkRatio: dark / (w * h), sample: Array.from(buf.slice(0, 16)) };
  }

  get shadowCasterCount() { return this.shadowStage ? this.shadowStage._casters.length : 0; }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    if (this.shadowStage) this.shadowStage.dispose();
  }
}

// 后期合成：HDR 场景 -> 亮部提取 -> 多级高斯泛光 -> 暖调色 -> 颗粒/暗角。
// 全部自写，不依赖 three 的 addon，避免 CDN 与版本问题。
import * as THREE from 'three';

const QUAD_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const THRESHOLD_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform float uThreshold;
  uniform float uKnee;
  void main() {
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    float l = max(max(c.r, c.g), c.b);
    // 软阈值：只有亮度超过 (threshold - knee) 的部分才进入泛光。
    // 之前写成 clamp(l - threshold + knee, 0, 2*knee) 会让**纯黑像素也拿到 0.28 的权重**，
    // 于是整块幕布被泛光洗成一片死白。
    float lo = max(uThreshold - uKnee, 0.0);
    float soft = clamp((l - lo) / max(2.0 * uKnee, 1e-4), 0.0, 1.0);
    soft = soft * soft * (3.0 - 2.0 * soft);
    float w = soft * soft;
    gl_FragColor = vec4(c * w, 1.0);
  }
`;

const BLUR_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform vec2 uDir;
  void main() {
    // 9 抽头高斯
    float w[5];
    w[0] = 0.227027; w[1] = 0.1945946; w[2] = 0.1216216; w[3] = 0.0540540; w[4] = 0.0162162;
    vec3 sum = texture2D(tDiffuse, vUv).rgb * w[0];
    for (int i = 1; i < 5; i++) {
      vec2 o = uDir * float(i);
      sum += texture2D(tDiffuse, vUv + o).rgb * w[i];
      sum += texture2D(tDiffuse, vUv - o).rgb * w[i];
    }
    gl_FragColor = vec4(sum, 1.0);
  }
`;

const COMPOSITE_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tScene;
  uniform sampler2D tBloomA;
  uniform sampler2D tBloomB;
  uniform sampler2D tBloomC;
  uniform float uBloom;
  uniform float uExposure;
  uniform float uGrain;
  uniform float uVignette;
  uniform float uWarm;
  uniform float uTime;
  uniform float uFade;
  uniform vec3  uLampTint;

  vec3 aces(vec3 x) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }

  void main() {
    vec3 base = texture2D(tScene, vUv).rgb;

    // 多级泛光叠加：宽窄结合，形成灯罩外扩的光晕
    vec3 bA = texture2D(tBloomA, vUv).rgb;
    vec3 bB = texture2D(tBloomB, vUv).rgb;
    vec3 bC = texture2D(tBloomC, vUv).rgb;
    vec3 bloom = bA * 0.55 + bB * 0.32 + bC * 0.13;

    // 泛光只在亮部已经接近饱和处才明显外扩，避免把幕布冲成一片白
    vec3 col = base + bloom * uBloom * (1.0 - smoothstep(0.55, 0.95, base));

    // 曝光
    col *= uExposure;

    // 暖调：随亮度缩放，暗部不额外加光（否则幕后黑框会被抬成灰）
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    vec3 warmShift = uLampTint * (uWarm * (0.05 + 0.09 * (1.0 - clamp(lum, 0.0, 1.0))));
    col += warmShift * col * 1.3;
    // 只在已有亮度上加一点点暖，绝不无中生有
    col += uLampTint * 0.0012 * smoothstep(0.02, 0.30, lum);

    // 高光微金
    col.r *= 1.0 + uWarm * 0.035 * smoothstep(0.45, 1.0, lum);
    col.b *= 1.0 - uWarm * 0.055 * smoothstep(0.30, 1.0, lum);

    // 胶片式 tone map（把线性高光滚降，避免死白）
    col = aces(col * 1.02);

    // 暗角
    vec2 d = vUv - 0.5;
    float vig = 1.0 - uVignette * dot(d, d) * 2.4;
    col *= clamp(vig, 0.0, 1.0);

    // 轻微对比 S 曲线（温和，不要压掉幕布层次）
    col = mix(col, col * col * (3.0 - 2.0 * col), 0.16);

    // 暗部保留一点暖底，但只在真有亮度处，避免黑框发灰
    col += uLampTint * 0.0016 * smoothstep(0.03, 0.45, dot(col, vec3(0.333)));

    // 颗粒
    float g = fract(sin(dot(vUv * vec2(1234.5, 5678.9) + uTime * 13.7, vec2(12.9898, 78.233))) * 43758.5453);
    col += (g - 0.5) * uGrain;

    // 线性 -> sRGB
    vec3 srgb = mix(col * 12.92,
                    pow(max(col, vec3(0.0)), vec3(1.0 / 2.4)) * 1.055 - 0.055,
                    step(vec3(0.0031308), col));
    srgb = clamp(srgb, 0.0, 1.0);

    gl_FragColor = vec4(srgb * uFade, 1.0);
  }
`;

export class Compositor {
  constructor(renderer, { width = 1280, height = 720, hdr = true } = {}) {
    this.renderer = renderer;
    this.hdr = hdr;

    const type = hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const base = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type,
      depthBuffer: false,
      stencilBuffer: false,
    };

    this.sceneRT = new THREE.WebGLRenderTarget(width, height, {
      ...base,
      depthBuffer: true,
      samples: 0,
    });

    this.levels = [];
    let w = Math.max(4, width >> 1), h = Math.max(4, height >> 1);
    for (let i = 0; i < 3; i++) {
      const a = new THREE.WebGLRenderTarget(w, h, base);
      const b = new THREE.WebGLRenderTarget(w, h, base);
      this.levels.push({ a, b, w, h });
      w = Math.max(4, w >> 1); h = Math.max(4, h >> 1);
    }

    // ★ 专用暂存目标：泛光链里**任何被采样的纹理，都不能曾经是渲染目标**。
    //   实测（见 tools/gl-feedback.html）：即使某次 draw 的源与目标不同，
    //   只要源纹理在**之前某一趟**当过渲染目标，SwiftShader 就会报
    //   "Feedback loop formed between Framebuffer and active Texture" 并丢弃这次 draw。
    //   所以亮部提取的结果先写到这块 scratch，再把它当纯纹理去采样。
    this.scratch = new THREE.WebGLRenderTarget(
      Math.max(4, width >> 1), Math.max(4, height >> 1), base,
    );

    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this.uniforms = {
      threshold: {
        tDiffuse: { value: null },
        uThreshold: { value: 1.15 },
        uKnee: { value: 0.34 },
      },
      blur: {
        tDiffuse: { value: null },
        uDir: { value: new THREE.Vector2() },
      },
      composite: {
        tScene: { value: null },
        tBloomA: { value: null },
        tBloomB: { value: null },
        tBloomC: { value: null },
        uBloom: { value: 0.075 },
        uExposure: { value: 0.80 },
        uGrain: { value: 0.028 },
        uVignette: { value: 0.40 },
        uWarm: { value: 0.75 },
        uTime: { value: 0 },
        uFade: { value: 1 },
        uLampTint: { value: new THREE.Color(0xffb257) },
      },
    };

    const mk = (frag, uniforms, name) => {
      const m = new THREE.ShaderMaterial({
        vertexShader: QUAD_VERT,
        fragmentShader: frag,
        uniforms,
        depthTest: false,
        depthWrite: false,
      });
      m.name = name;
      return m;
    };

    this.thresholdMat = mk(THRESHOLD_FRAG, this.uniforms.threshold, 'bloomThreshold');
    this.blurMat = mk(BLUR_FRAG, this.uniforms.blur, 'bloomBlur');
    this.compositeMat = mk(COMPOSITE_FRAG, this.uniforms.composite, 'composite');
  }

  get sceneTarget() { return this.sceneRT; }

  setSize(width, height) {
    this.sceneRT.setSize(width, height);
    this.scratch.setSize(Math.max(4, width >> 1), Math.max(4, height >> 1));
    let w = Math.max(4, width >> 1), h = Math.max(4, height >> 1);
    for (const lv of this.levels) {
      lv.w = w; lv.h = h;
      lv.a.setSize(w, h); lv.b.setSize(w, h);
      w = Math.max(4, w >> 1); h = Math.max(4, h >> 1);
    }
  }

  _blit(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  render(dt = 1 / 60) {
    const r = this.renderer;
    const prevAuto = r.autoClear;

    // 1) 亮部提取：sceneRT → scratch（专用暂存，之后只当纹理采样，不再当渲染目标）
    this.uniforms.threshold.tDiffuse.value = this.sceneRT.texture;
    this._blit(this.thresholdMat, this.scratch);

    // 2) 逐级模糊。所有被采样的纹理都必须是"纯纹理"：
    //    第 0 级的源是 scratch；第 N 级的源是上一级的 **b**（b 只作为最终结果被采样一次，
    //    下一级的降采样读它时它已经不是当前目标）。a 永远是中间暂存，不作为任何一级的源。
    let src = this.scratch;
    for (let i = 0; i < this.levels.length; i++) {
      const lv = this.levels[i];
      // 横向：src → a
      this.uniforms.blur.tDiffuse.value = src.texture;
      this.uniforms.blur.uDir.value.set(1.35 / lv.w, 0);
      this._blit(this.blurMat, lv.a);
      // 纵向：a → b（这一级的最终结果）
      this.uniforms.blur.tDiffuse.value = lv.a.texture;
      this.uniforms.blur.uDir.value.set(0, 1.35 / lv.h);
      this._blit(this.blurMat, lv.b);
      src = lv.b;
    }

    // 3) 合成到画布
    const c = this.uniforms.composite;
    c.tScene.value = this.sceneRT.texture;
    c.tBloomA.value = this.levels[0].b.texture;
    c.tBloomB.value = this.levels[1].b.texture;
    c.tBloomC.value = this.levels[2].b.texture;
    c.uTime.value += dt;
    this._blit(this.compositeMat, null);
    r.autoClear = prevAuto;
  }

  dispose() {
    this.sceneRT.dispose();
    this.scratch.dispose();
    for (const lv of this.levels) { lv.a.dispose(); lv.b.dispose(); }
    this.quad.geometry.dispose();
    this.thresholdMat.dispose(); this.blurMat.dispose(); this.compositeMat.dispose();
  }
}

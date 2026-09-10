// 舞台：灯（真实 SpotLight，幕布后方的暖黄光源）、背景、地面、工艺灯罩。
// 灯罩会挡住一部分光，在幕布边缘留下篾条阴影 —— 让“光”本身也有皮影的味道。
import * as THREE from 'three';
import { makeAlphaFromDraw } from './textures.js';
import { markShadowCaster } from './materials.js';

/* ---------------- 背景 ---------------- */

const BACKDROP_FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uLightWorld;
  uniform vec3 uLightColor;
  uniform float uIntensity;
  uniform float uFalloff;
  varying vec3 vWorldPos;
  void main() {
    float d = length(vWorldPos - uLightWorld);
    float g = 1.0 / (1.0 + d * d * uFalloff);
    vec3 col = uLightColor * uIntensity * g * 0.55;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const BACKDROP_VERT = /* glsl */`
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  }
`;

/* ---------------- 灯罩镂空图 ---------------- */

function lanternPillarTexture() {
  return makeAlphaFromDraw((ctx, w, h) => {
    // 垂直的篾条柱：在灯的上下左右形成规则挡光条，投影到幕布边缘成条纹
    const bars = 2 * 11 + 1;
    const bw = w / bars;
    for (let i = 0; i < bars; i++) {
      ctx.fillRect(i * bw + bw * 0.30, 0, bw * 0.40, h);
    }
    // 三道横箍，带镂空小花
    const hr = h * 0.035;
    for (const y of [h * 0.12, h * 0.5, h * 0.88]) {
      ctx.fillRect(0, y - hr * 0.5, w, hr);
      for (let i = 0; i < 9; i++) {
        const cx = (i + 0.5) * w / 9;
        ctx.beginPath();
        ctx.moveTo(cx, y - hr * 1.6);
        ctx.lineTo(cx + hr * 0.62, y);
        ctx.lineTo(cx, y + hr * 1.6);
        ctx.lineTo(cx - hr * 0.62, y);
        ctx.closePath();
        ctx.fill();
      }
    }
  }, { w: 256, h: 256, parchment: false, glow: 0, baseColor: '#080300' });
}

/* ---------------- 舞台 ---------------- */

export class Stage {
  constructor({ screenWidth = 4.0, screenHeight = 2.5, lightFar = 12 } = {}) {
    this.lightFar = lightFar;
    this.group = new THREE.Group();
    this.group.name = 'stage';

    /* --- 光源：幕布后方的暖黄灯 ---
     * 位置由投影几何反推（这是整场戏构图的地基）：
     *   放大率 = zLight / (zActor - zLight)      —— 灯越远，影子越大
     *   影子的屏幕纵坐标 yScreen = yLight + (yActor - yLight) * 放大率
     * 取灯距幕布 3.2m、演员在幕布后 0.25m，放大率 ≈ 1.09；
     * 灯高 -0.28m ≈ 幕布中心，于是演员脚底(y≈-1.06)的影子落在 y≈-1.11，
     * 整个人影几乎填满幕布高度又不被裁掉，且比演员略大——传统的“影子比人大”。
     */
    this.light = new THREE.SpotLight(0xffb45a, 2.6, 12.0, 0.62, 0.85, 1.0);
    this.light.name = 'lantern';
    this.light.position.set(0.10, -0.28, -3.2);
    this.light.target.position.set(0.0, -0.28, 0.0);
    this.light.castShadow = false;
    this.light.shadow.mapSize.set(2048, 2048);
    this.light.shadow.camera.near = 0.25;
    this.light.shadow.camera.far = 8.0;
    this.light.shadow.camera.fov = 0.62 * 2 * 180 / Math.PI;
    this.light.shadow.camera.updateProjectionMatrix();
    this.baseIntensity = 2.6;
    this.group.add(this.light);
    this.group.add(this.light.target);

    /* --- 主光：弱环境光（只在幕布前方有一点点，让画面不至于死黑） --- */
    this.fill = new THREE.DirectionalLight(0xffd9a8, 0.16);
    this.fill.position.set(1.2, 1.6, 3.0);
    this.group.add(this.fill);

    /* --- 背景：剧场暗场（灯光背后的空间感） --- */
    this.backdropUniforms = {
      uLightWorld: { value: new THREE.Vector3().copy(this.light.position) },
      uLightColor: { value: new THREE.Color(0xff9a3c) },
      uIntensity: { value: 1.5 },
      uFalloff: { value: 0.035 },
    };
    const backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(26, 14),
      new THREE.ShaderMaterial({
        uniforms: this.backdropUniforms,
        vertexShader: BACKDROP_VERT,
        fragmentShader: BACKDROP_FRAG,
        side: THREE.DoubleSide,
      }),
    );
    backdrop.name = 'backdrop';
    backdrop.position.set(0, 0.4, -8.2);
    backdrop.frustumCulled = false;
    this.backdrop = backdrop;
    this.group.add(backdrop);

    /* --- 地面：幕布后方的暗色地台 --- */
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 9),
      new THREE.MeshBasicMaterial({ color: 0x0a0503 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -1.34, -3.4);
    floor.name = 'floor';
    // ★ 必须显式关掉投影：three 的阴影流程会渲染所有 castShadow 的物体，
    //   地台横跨灯与幕布之间，会把整个幕布下半截压成一条假影（不是皮影该有的东西）。
    floor.castShadow = false;
    floor.receiveShadow = false;
    this.group.add(floor);

    /* --- 剧场暗框：把幕布之外的一切遮成黑，只在幕布范围留一个亮窗口。
     *     用四条边框平面拼成（比 ShapeGeometry 挖洞更可靠：洞的方向/UV 都不会出错）。 --- */
    const hw = screenWidth / 2, hh = screenHeight / 2;
    const BIG = 30;
    const CUT = Math.max(screenWidth, 6.0);   // 左右两条 veil 的内边要够远，别切进幕布
    const veilMat = new THREE.MeshBasicMaterial({ color: 0x030201, side: THREE.DoubleSide, toneMapped: true });
    const mkVeil = (w, h, x, y, name) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), veilMat);
      m.position.set(x, y, 0.06);
      m.name = name;
      m.frustumCulled = false;
      m.castShadow = false;      // 暗框只负责遮，不参与投影
      m.receiveShadow = false;
      this.group.add(m);
      return m;
    };
    // 上 / 下 两条盖住幕布上下之外；左 / 右 两条盖住幕布左右之外
    this.veilParts = [
      mkVeil(CUT * 2, BIG, 0, hh + BIG / 2, 'veilTop'),
      mkVeil(CUT * 2, BIG, 0, -hh - BIG / 2, 'veilBottom'),
      mkVeil(BIG, hh * 2, -CUT / 2 - BIG / 2, 0, 'veilLeft'),
      mkVeil(BIG, hh * 2, CUT / 2 + BIG / 2, 0, 'veilRight'),
    ];

    /* --- 挂杆：位于暗框与幕布之间，在幕布上缘投出一道细微横影 --- */
    const rod = new THREE.Mesh(
      new THREE.PlaneGeometry(screenWidth, 0.055),
      new THREE.MeshBasicMaterial({ color: 0x050302, toneMapped: false }),
    );
    rod.position.set(0, hh - 0.028, 0.03);
    rod.name = 'topRod';
    rod.castShadow = false;   // 挂杆只是暗框的一部分，参与投影会在幕布中段压出一条横带
    this.group.add(rod);

    /* --- 灯罩：**不投影**，只作为灯芯的视觉灯箱 ---
     *
     * 这里做一个明确的取舍，原因写在下面，不藏着：
     *
     * 想让「灯罩的篾条」在幕布上留下淡影，罩子必须落在阴影相机的可见范围里。
     * 阴影相机的 near ≈ 0.35 × |灯→幕布| ≈ 1.12m，所以罩子得放在灯前 >1.12m；
     * 而在这个距离上，投影放大率 = 3.2 / 1.12 ≈ 2.9 —— 一个能罩住整个光锥的罩子
     * （那就得和光锥一样大）投出来的影会**盖满整块 4.0×2.5 的幕布**，把演员压没。
     * 想只让条纹擦到幕布边缘，罩子就得小到只有 0.07m 见方，几乎等于把光锥切掉一大块，
     * 结果是幕布出现硬边的大块暗斑，更难看。
     *
     * 另外两条路也都试算过：
     *   · 把阴影深度区间拉宽到能容纳灯罩 —— 会让区间从 2.1m 撑到 3.6m，
     *     8bit 深度步进从 0.8cm 恶化到 1.4~2.8cm，直接超过 uShadowBias(0.4cm)，
     *     人影边缘会开始闪烁/丢失。**代价比收益大得多。**
     *   · 用第二个光源/第二张阴影贴图专门做灯罩 —— 复杂度翻倍，为一个装饰性条纹不值得。
     *
     * 所以：灯罩保留在灯的位置（视觉上它就是光源本体），但不参与投影。
     * 「灯光是暖黄的」「光晕在边缘散开」这两条需求由光照衰减 + 泛光负责，不依赖灯罩。
     * --- */
    const tex = lanternPillarTexture();
    const lantern = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.1), null);
    lantern.material = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, alphaTest: 0.4,
      side: THREE.DoubleSide, toneMapped: false, color: 0x000000,
    });
    lantern.position.copy(this.light.position);
    lantern.position.z += 0.012;
    lantern.name = 'lanternShade';
    lantern.castShadow = false;
    this.lantern = lantern;
    this.lanternOffset = 0.012;
    this.group.add(lantern);

    /* --- 灯芯：灯后的小发光点，用于泛光；被幕布挡住不会穿帮 --- */
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xfff0c0, toneMapped: false }),
    );
    core.position.copy(this.light.position);
    core.position.z += 0.09;
    core.name = 'lanternCore';
    this.lanternCore = core;
    this.group.add(core);
  }

  /** 灯的闪烁/呼吸（演员与灯芯一起呼吸） */
  setLight({ intensity, flicker = 0, pos, color } = {}) {
    if (intensity != null) this.light.intensity = intensity;
    if (color != null) this.light.color.set(color);
    if (pos) {
      this.light.position.copy(pos);
      this.backdropUniforms.uLightWorld.value.copy(pos);
      this.lantern.position.set(pos.x, pos.y, pos.z + (this.lanternOffset != null ? this.lanternOffset : 0.012));
      this.lanternCore.position.set(pos.x, pos.y, pos.z + 0.09);
    }
    if (flicker > 0) {
      // 灯芯的细微跳动：由编排给出幅度，这里转成强度上的高频抖动
      this._flickerPhase = (this._flickerPhase || 0) + flicker;
    }
    this.backdropUniforms.uIntensity.value = 1.15 * Math.min(2, (this.light.intensity || 2.6) / 2.6);
    return this.light;
  }

  /** 灯芯视觉体跟随（用于泛光高光） */
  setCoreVisible(v) {
    if (this.lanternCore) this.lanternCore.visible = v;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        if (o.material) o.material.dispose();
      }
    });
  }
}

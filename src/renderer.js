// 渲染器：主场景 -> HDR 目标 -> 后期合成 -> 画布。
import * as THREE from 'three';
import { Compositor } from './compositor.js';

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas, { width = 1280, height = 720, pixelRatio = null } = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
      premultipliedAlpha: false,
    });
    this.isWebGL2 = !!gl;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      context: gl || undefined,
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    });
    this.renderer.autoClear = true;
    this.renderer.toneMapping = THREE.NoToneMapping;      // 合成阶段自己做
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.info.autoReset = false;

    this.hdrSupported = false;
    if (this.isWebGL2) {
      this.hdrSupported = !!this.renderer.extensions.get('EXT_color_buffer_half_float')
        || !!this.renderer.extensions.get('EXT_color_buffer_float');
    }
    // 即使扩展缺失，HalfFloat RGBA 在 WebGL2 里通常仍可渲染；失败时回退到 8bit
    this.compositor = new Compositor(this.renderer, {
      width, height, hdr: this.isWebGL2,
    });

    this.scene = new THREE.Scene();
    this.scene.background = null;
    this.camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 60);
    // 相机取景必须**正好等于幕布**（4.0 x 2.5），这样"亮窗口"才是满幅的影窗。
    //   可见高度 = 2 * d * tan(fov/2) = 2.5  =>  d = 1.25 / tan(19°) ≈ 3.63
    // 而可见宽度 = 2.5 * 16/9 = 4.44，比幕布宽，所以幕布两侧会各留 0.22 的世界单位，
    // 用舞台暗框(veil)遮住即可 —— veil 的窗口也做成 4.0 x 2.5。
    this.camera.position.set(0, 0, 3.63);
    this.camera.lookAt(0, 0, 0);

    this._pr = pixelRatio ?? Math.min(2, globalThis.devicePixelRatio || 1);
    this._w = width; this._h = height;
    this._frame = 0;
    this._lastStats = null;
    this.onBeforeRender = null;
    this.onAfterRender = null;
    this.setSize(width, height);
  }

  setSize(width, height, pixelRatio = null) {
    this._w = width; this._h = height;
    if (pixelRatio != null) this._pr = pixelRatio;
    this.renderer.setPixelRatio(this._pr);
    this.renderer.setSize(width, height, false);
    const bw = Math.max(2, Math.floor(width * this._pr));
    const bh = Math.max(2, Math.floor(height * this._pr));
    this.compositor.setSize(bw, bh);
    this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** 主渲染 */
  render(dt = 1 / 60) {
    this.renderer.info.reset();
    if (this.onBeforeRender) this.onBeforeRender(dt);

    const prevClear = new THREE.Color();
    this.renderer.getClearColor(prevClear);
    const prevAlpha = this.renderer.getClearAlpha();

    // 诊断旁路：直接把场景画到画布（不做后期）
    if (this.bypass) {
      this.renderer.setRenderTarget(null);
      this.renderer.clear(true, true, true);
      this.renderer.render(this.scene, this.camera);
      this.renderer.setClearColor(prevClear, prevAlpha);
      this._frame++;
      this._lastStats = this._collectStats();
      return this._lastStats;
    }

    // 场景 -> HDR
    this.renderer.setRenderTarget(this.compositor.sceneTarget);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.camera);

    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(prevClear, prevAlpha);

    // 后期
    this.compositor.render(dt);

    if (this.onAfterRender) this.onAfterRender(dt);
    this._frame++;
    this._lastStats = this._collectStats();
    return this._lastStats;
  }

  _collectStats() {
    return {
      tris: this.renderer.info.render.triangles,
      drawCalls: this.renderer.info.render.calls,
      programs: this.renderer.info.programs ? this.renderer.info.programs.length : -1,
      textures: this.renderer.info.memory.textures,
      geometries: this.renderer.info.memory.geometries,
      hdr: !!this.hdrSupported || this.isWebGL2,
      webgl2: this.isWebGL2,
      bloomLevels: this.compositor.levels.length,
      frame: this._frame,
      bypass: !!this.bypass,
      drawingBuffer: [this.renderer.domElement.width, this.renderer.domElement.height],
    };
  }

  stats() { return this._lastStats || { frame: 0 }; }

  /** 把场景渲染到屏幕但不做后期（调试用） */
  renderRaw(dt = 1 / 60) {
    if (this.onBeforeRender) this.onBeforeRender(dt);
    this.renderer.setRenderTarget(null);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.compositor.dispose();
    this.renderer.dispose();
  }
}

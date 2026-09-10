// 关节树：每个部件是一个可绕“关节轴心”旋转的 Object3D，子部件挂在父部件的关节上。
// 这样抬手时前臂、手、兵器会跟着动，是真骨架而不是贴图拼贴。
import * as THREE from 'three';
import { makePuppetMaterial, markShadowCaster, setShadowCasterTexture } from './materials.js';

const DEG = Math.PI / 180;

export class Rig {
  constructor({ scale = 1, lightFar = 12 } = {}) {
    this.root = new THREE.Object3D();
    this.root.name = 'rigRoot';
    this.scale = scale;
    this.lightFar = lightFar;

    /** @type {Map<string, {pivot:THREE.Object3D, mesh:THREE.Mesh, spec:object, rest:THREE.Euler}>} */
    this.parts = new Map();
    this.pose = {};                 // 当前姿态（通道 -> [x,y,z]）
    this.rootTransform = { x: 0, y: 0, z: 0, rz: 0, ry: 0 };
    this.cloths = [];
    this._wind = new THREE.Vector2(0, 0);
    this._tmpM = new THREE.Matrix4();
    this._tmpVec = new THREE.Vector3();
  }

  /**
   * 添加一个部件。
   * @param {object} spec
   * @param {string} spec.key 通道名
   * @param {THREE.Texture} spec.tex 镂空贴图
   * @param {number} spec.w 世界宽
   * @param {number} spec.h 世界高
   * @param {string} [spec.parent] 父部件 key；省略表示挂在 root
   * @param {[number,number]} [spec.anchor] 相对父部件 pivot 的关节挂点
   * @param {[number,number]} [spec.pivot] 纹理内旋转轴心（0,0 = 纹理中心）
   * @param {number} [spec.z] 层叠偏移
   * @param {[number,number,number]} [spec.rest] 静息欧拉角
   * @param {boolean} [spec.visible]
   * @param {object|null} [spec.cloth] 布料次级摆动
   */
  addPart(spec) {
    const {
      key, tex, w, h, anchor = [0, 0], pivot = [0, 0], z = 0,
      rest = [0, 0, 0], visible = true, opacity = 1,
      cloth = null, alphaTest = 0.45, castShadow = true, flipX = false,
    } = spec;

    const geo = new THREE.PlaneGeometry(w, h);
    // 把轴心烘焙进顶点，使 mesh 绕 pivot 而不是绕中心旋转
    geo.translate(-pivot[0], -pivot[1], 0);
    if (flipX) geo.scale(-1, 1, 1);

    const mat = makePuppetMaterial(tex);
    mat.alphaTest = alphaTest;
    mat.opacity = opacity;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = key;
    mesh.frustumCulled = true;
    if (castShadow) markShadowCaster(mesh, tex, { alphaTest, lightFar: this.lightFar });

    const pivotNode = new THREE.Object3D();
    pivotNode.name = key + ':pivot';
    pivotNode.position.set(anchor[0], anchor[1], z);
    pivotNode.add(mesh);

    // 找父节点
    let parentNode = this.root;
    if (spec.parent) {
      const p = this.parts.get(spec.parent);
      if (!p) throw new Error(`Rig.addPart: 未找到父部件 "${spec.parent}"（部件 ${key}）`);
      parentNode = p.pivot;
    }
    parentNode.add(pivotNode);

    pivotNode.rotation.set(rest[0], rest[1], rest[2]);

    const entry = {
      pivot: pivotNode, mesh, spec, rest: new THREE.Euler(rest[0], rest[1], rest[2]),
      cloth: cloth ? {
        angle: 0, vel: 0,
        amp: cloth.amp ?? 1, freq: cloth.freq ?? 1.0, lag: cloth.lag ?? 0.5,
        phase: ((key.length * 37) % 100) / 100 * Math.PI * 2,
        lastWorld: new THREE.Vector3(), first: true,
      } : null,
    };
    this.parts.set(key, entry);
    this.pose[key] = [rest[0], rest[1], rest[2]];

    if (entry.cloth) {
      entry.cloth.axis = cloth.axis || 'z';
      entry.cloth.scaleBy = cloth.scaleBy || 0.55;
      entry.cloth.gravity = cloth.gravity ?? 0.0;
      entry.cloth.wind = cloth.wind ?? 1.0;
      entry.cloth.stiff = cloth.stiff ?? 34;
      entry.cloth.damp = cloth.damp ?? 6.5;
      this.cloths.push(key);
    }
    return pivotNode;
  }

  /** 便捷方法：改某个部件的贴图/尺寸（道具换装用） */
  setPartTexture(key, tex, { alphaTest = 0.45 } = {}) {
    const p = this.parts.get(key);
    if (!p) return;
    p.mesh.material.map = tex;
    p.mesh.material.needsUpdate = true;
    setShadowCasterTexture(p.mesh, tex);
  }

  setPartVisible(key, v) {
    const p = this.parts.get(key);
    if (!p) return;
    p.mesh.visible = !!v;
  }

  setPartOpacity(key, o) {
    const p = this.parts.get(key);
    if (!p) return;
    p.mesh.material.opacity = o;
    p.mesh.material.transparent = o < 1;
  }

  /** 通道名 -> [rx,ry,rz] */
  setPose(next) {
    for (const k in next) {
      if (k === 'tx' || k === 'ty' || k === 'tz' || k === 'rz') {
        this.rootTransform[k] = next[k];
        continue;
      }
      this.pose[k] = next[k];
    }
  }

  /**
   * 整体位移/旋转。
   * @param {number} tx 左右位移（米）
   * @param {number} ty 上下位移（米）
   * @param {number} rz 画面内倾身（弧度，正=前倾/顺指针倒向）
   * @param {number} tz 前后位移（米，负=远离幕布，影子更大更虚）
   * @param {number} ry 绕竖轴偏航（弧度）—— 平片皮影的“真转身”用这个通道
   */
  setRootTransform(tx, ty, rz = 0, tz = 0, ry = 0) {
    this.rootTransform.x = tx; this.rootTransform.y = ty;
    this.rootTransform.rz = rz; this.rootTransform.z = tz;
    this.rootTransform.ry = ry;
  }

  resetPose() {
    for (const [key, p] of this.parts) {
      this.pose[key] = [p.rest.x, p.rest.y, p.rest.z];
    }
    this.rootTransform = { x: 0, y: 0, z: 0, rz: 0, ry: 0 };
  }

  setWind(x, y) { this._wind.set(x, y); }

  /**
   * 应用当前姿态 + 布料次级运动。dt 为秒。
   */
  update(dt) {
    const s = this.scale;
    const rt = this.rootTransform;
    this.root.position.set(rt.x, rt.y, rt.z);
    this.root.rotation.set(0, rt.ry || 0, rt.rz);
    this.root.scale.set(s, s, s);

    // 先渲染基础姿态（temporarily zero cloth）
    for (const [key, p] of this.parts) {
      const a = this.pose[key];
      if (!a) continue;
      p.pivot.rotation.set(a[0], a[1], a[2]);
    }
    this.root.updateMatrixWorld(true);

    // 布料：跟随父关节的运动做二阶阻尼摆动
    const h = Math.max(1 / 240, Math.min(0.05, dt || 1 / 60));
    for (const key of this.cloths) {
      const p = this.parts.get(key);
      const c = p.cloth;
      if (!c) continue;

      // 父枢轴的当前世界位置（用父的 matrixWorld；没有父就用 root）
      const parentObj = p.pivot.parent;
      this._tmpVec.setFromMatrixPosition(parentObj.matrixWorld);
      const prev = c.lastWorld.clone();
      if (c.first) { prev.copy(this._tmpVec); c.first = false; }
      const vx = (this._tmpVec.x - prev.x) / h;
      const vy = (this._tmpVec.y - prev.y) / h;
      c.lastWorld.copy(this._tmpVec);

      // 驱动力：惯性（反向）+ 重力 + 风
      const drive = (-vx * 0.34 * c.lag - vy * 0.16 * c.lag)
                  + c.gravity + Math.sin(this._elapsed * 1.7 + c.phase) * 0.35 * c.wind
                  + this._wind.x * c.wind;
      // 二阶弹簧
      const acc = (drive - c.angle) * c.stiff - c.vel * c.damp;
      c.vel += acc * h;
      c.angle += c.vel * h;
      // 限幅，避免布料翻飞
      const lim = 0.55 * c.amp;
      if (c.angle > lim) { c.angle = lim; c.vel *= -0.25; }
      if (c.angle < -lim) { c.angle = -lim; c.vel *= -0.25; }

      const base = this.pose[key] || [0, 0, 0];
      const sway = c.angle * c.scaleBy;
      if (c.axis === 'x') p.pivot.rotation.set(base[0] + sway, base[1], base[2]);
      else p.pivot.rotation.set(base[0], base[1], base[2] + sway);
      // 轻微位移，摆动更松
      p.mesh.position.x = -sway * this._partHalfHeight(p) * 0.5;
    }
    this.root.updateMatrixWorld(true);
  }

  _partHalfHeight(p) { return p.spec.h || 0.2; }

  tick(dt) { this._elapsed = (this._elapsed || 0) + dt; this.update(dt); }

  traverse(fn) { this.root.traverse(fn); }

  dispose() {
    for (const [, p] of this.parts) {
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
      if (p.mesh.customDepthMaterial) p.mesh.customDepthMaterial.dispose();
    }
    this.parts.clear();
    this.cloths.length = 0;
  }
}

export { DEG };

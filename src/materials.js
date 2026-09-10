// 皮影部件的材质与“写实阴影贴图”用的自定义深度材质。
// 关键点：深度材质里做 alphaTest，让镂空孔洞成为真正的透光孔 —— 光能穿过去，
// 幕布上的剪影才会自然出现内部亮斑（这正是传统皮影的观感来源）。
import * as THREE from 'three';

/**
 * 皮影部件材质：本身不参与着色，颜色来自镂空贴图。
 * 实体部分在贴图里是深色，所以它看起来就是剪影；孔洞是透明的，光直接穿过。
 */
export function makePuppetMaterial(tex) {
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    alphaTest: 0.45,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
    toneMapped: false,
    color: 0xffffff,
  });
  mat.name = 'puppet';
  return mat;
}

/** 阴影通道通用顶点着色器：three 的 ShaderMaterial 会自动注入 position/uv 属性与矩阵 uniform */
const DEPTH_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// 输出：R/G = 「到光源的距离」映射到 [uRangeNear, uRangeFar] 后的 0..1（给预模糊与直接比较用）
// 关键：距离必须用**灯光视空间**的 -z（three 自己也是这么存的），
// 并且用灯光到幕布的**实际距离区间**归一化 —— 否则 8bit 精度太差，阈值化会把人影整片吃掉。
const DEPTH_FRAG_SAFE = /* glsl */`
  precision highp float;
  uniform sampler2D map;
  uniform float alphaTest;
  uniform float uRangeNear;
  uniform float uRangeFar;
  varying vec2 vUv;
  varying float vDist;
  varying float vToScreen;
  void main() {
    vec4 t = texture2D(map, vUv);
    if (t.a < alphaTest) discard;
    float n = clamp((vDist - uRangeNear) / max(uRangeFar - uRangeNear, 1e-3), 0.0, 1.0);
    // B 通道：该投射物离幕布多远（0..1.5m）→ 幕布那边据此放大采样半径，实现「近实远虚」
    float s = clamp(vToScreen / 1.5, 0.0, 1.0);
    gl_FragColor = vec4(n, n, s, 1.0);
  }
`;
const DEPTH_VERT_SAFE = /* glsl */`
  uniform mat4 uLightView;
  uniform float uScreenZ;
  varying vec2 vUv;
  varying float vDist;
  varying float vToScreen;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec4 lp = uLightView * wp;
    vDist = -lp.z;
    vToScreen = abs(wp.z - uScreenZ);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

/**
 * 阴影渲染专用的深度材质。
 * 与 THREE.MeshDepthMaterial 不同，这里把“到光源多远”直接编码进颜色，
 * 于是可以用一张普通 RGBA 纹理当**可过滤**的阴影贴图，并且支持预模糊；
 * 同时把「离幕布多远」写进 B 通道，实现近实远虚。
 * @param {THREE.Texture} tex 部件镂空贴图
 * @param {{alphaTest?:number, rangeNear?:number, rangeFar?:number}} opts
 */
export function makeShadowDepthMaterial(tex, { alphaTest = 0.45, rangeNear = 0, rangeFar = 12 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: tex },
      alphaTest: { value: alphaTest },
      uRangeNear: { value: rangeNear },
      uRangeFar: { value: rangeFar },
      uLightView: { value: new THREE.Matrix4() },
      uScreenZ: { value: 0 },
    },
    vertexShader: DEPTH_VERT_SAFE,
    fragmentShader: DEPTH_FRAG_SAFE,
    side: THREE.DoubleSide,
  });
}

/** 预模糊用的材质：对深度图做很轻的可分离模糊，只用来压锯齿。
 *  spread 必须小 —— 模糊半径直接决定影子的柔边宽度：
 *  1.6 texel @1024 约等于 8mm 幕布尺度，是"织物漫射"该有的量级；
 *  拉大就会把人影糊成一团淡影。柔化主要靠幕布那边的布料扩散与泊松采样。 */
export function makeBlurMaterial(tex, direction, texelSize, spread = 1.0) {
  return new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: tex },
      // 注意：shader 里声明成 vec2，值也**必须**是 Vector2（传标量 three 会走 uniform2fv 并抛错）
      uDir: { value: new THREE.Vector2(direction[0] ?? direction.x, direction[1] ?? direction.y) },
      uTexel: { value: new THREE.Vector2(texelSize, texelSize) },
      uSpread: { value: spread },
    },
    vertexShader: DEPTH_VERT,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform sampler2D tDiffuse;
      uniform vec2 uDir;
      uniform vec2 uTexel;
      uniform float uSpread;
      varying vec2 vUv;
      void main() {
        // 3 抽头高斯（半径 1 texel）：只抹掉阶梯，不糊掉轮廓。
        // 影子柔化交给幕布那边的布料扩散与泊松采样，这里的模糊半径必须小。
        // ★ B 通道必须一起保留：它是「该投射物离幕布多远」，擦成 0 会让近实远虚失效。
        vec4 a = texture2D(tDiffuse, vUv);
        vec4 b = texture2D(tDiffuse, vUv + uDir * uTexel * uSpread);
        vec4 c = texture2D(tDiffuse, vUv - uDir * uTexel * uSpread);
        vec4 sum = a * 0.5 + (b + c) * 0.25;
        gl_FragColor = vec4(sum.r, sum.r, sum.b, 1.0);
      }
    `,
    side: THREE.DoubleSide,
  });
}

/**
 * 把部件网格登记为阴影投射体。
 *
 * ★ 关键：three 的阴影流程读的是 `object.customDepthMaterial`
 *   （见 WebGLShadowMap.getDepthMaterial），**不是**任意挂在 mesh 上的字段。
 *   所以这里必须直接赋值给材质属性，否则 three 会用内置的 MeshDepthMaterial
 *   （packDepthToRGBA 打包深度），我们那套「距离区间编码 + 幕布直接比较」就完全失效。
 *
 * @param {THREE.Mesh} mesh
 * @param {THREE.Texture} tex 镂空贴图
 * @param {{alphaTest?:number, rangeNear?:number, rangeFar?:number}} opts
 *   rangeNear / rangeFar：灯光到幕布附近的距离区间，用来把深度映射到 0..1。
 *   区间越窄，8bit 深度精度越高（人影边缘越干净）。
 */
export function markShadowCaster(mesh, tex, { alphaTest = 0.45, rangeNear = 0, rangeFar = 12 } = {}) {
  mesh.castShadow = true;
  mesh.castShadowRaw = true;
  mesh.userData.shadowTex = tex;
  const depthMat = makeShadowDepthMaterial(tex, { alphaTest, rangeNear, rangeFar });
  mesh.customDepthMaterial = depthMat;      // ← three 唯一认的属性
  mesh.userData.shadowMat = depthMat;       // 方便内部同步 uniforms
  return mesh;
}

/** 同步深度材质的灯光视图矩阵、深度区间与幕布平面（每帧阴影渲染前调用一次） */
export function syncShadowDepthUniforms(mesh, lightViewMatrix, rangeNear, rangeFar, screenZ = 0) {
  const m = mesh && mesh.userData && mesh.userData.shadowMat;
  if (!m || !m.uniforms) return;
  if (m.uniforms.uLightView) m.uniforms.uLightView.value.copy(lightViewMatrix);
  if (rangeNear != null && m.uniforms.uRangeNear) m.uniforms.uRangeNear.value = rangeNear;
  if (rangeFar != null && m.uniforms.uRangeFar) m.uniforms.uRangeFar.value = rangeFar;
  if (m.uniforms.uScreenZ) m.uniforms.uScreenZ.value = screenZ;
}

/** 换贴图时同步深度材质的 alpha 贴图 */
export function setShadowCasterTexture(mesh, tex) {
  mesh.userData.shadowTex = tex;
  const m = mesh.userData.shadowMat;
  if (m && m.uniforms && m.uniforms.map) m.uniforms.map.value = tex;
}

/**
 * 手写阴影通道：把投射体的材质临时换成自写的距离编码深度材质。
 *
 * 为什么要手写而不是走 three 内建阴影流程：内建流程由 `light.castShadow` 触发，
 * 而我们的幕布是自己采样阴影贴图（`WaveScreen` 自写 shader），需要一张**可过滤、
 * 存距离**的纹理，并且要自己控制模糊与阈值。代价就是 `castShadow` /
 * `customDepthMaterial` 这两个 three 的属性在这里**不会自动生效**，必须手动应用。
 *
 * 返回 restore()，调用后恢复原材质。
 */
export function applyShadowDepthMaterials(casters) {
  const saved = [];
  for (const mesh of casters) {
    if (!mesh.customDepthMaterial) continue;
    saved.push([mesh, mesh.material]);
    mesh.material = mesh.customDepthMaterial;
  }
  return () => {
    for (const [mesh, mat] of saved) mesh.material = mat;
  };
}

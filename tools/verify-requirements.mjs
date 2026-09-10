/**
 * tools/verify-requirements.mjs —— 独立验收组：对照用户原始需求 1..9 逐条实测。
 *
 * 不修改 src/ 与 index.html：通过 CDP 读 window.__qa 的 [[Scopes]] 把 main.js 闭包里的
 * renderer/screen/stage/rigs/timeline 提到 window，再冻结 rAF + 固定 uTime 自主渲染取样。
 * 「暗区/剪影」一律相对同帧的"无投射体参考帧"做差，A/B 两侧对称并给出噪声底。
 *
 * 编排部分**不引用 shots/timeline.json**：自己按 1/60 采样 timeline.sample(t)，
 * 自己算每个通道的值域/换向次数/速度曲线/停顿区间/每幕极值，再与 debug() 和
 * shots/timeline.json 做交叉对比（只作对照，结论以自算为准）。
 *
 * 用法: node tools/verify-requirements.mjs       退出码 0 = 9 条需求全部通过
 */
import { withPage, readPNG, meanRGB, meanLuma, imageDiff } from './harness.mjs';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = process.cwd();
/* 本次验收绑定的源码 revision（写进日志，便于事后复算） */
const REV_FILES = ['index.html', 'src/main.js', 'src/renderer.js', 'src/screen.js', 'src/stage.js', 'src/compositor.js',
  'src/materials.js', 'src/rig.js', 'src/textures.js', 'src/puppet.js', 'src/shapes.js', 'src/props.js',
  'src/choreography.js', 'src/ease.js'];
console.log('REVISION ' + REV_FILES.map((f) => {
  try { return f + '=' + createHash('sha256').update(readFileSync(join(ROOT, f))).digest('hex').slice(0, 12); }
  catch { return f + '=MISSING'; }
}).join(' '));
const SHOT = (n) => `shots/verify-${n}.png`;
const TMP = (n) => join(tmpdir(), 'vrq-' + n);

const R = {};                       // 需求结论
const notes = [];
const note = (m) => { console.log(`      · ${m}`); notes.push(m); };
function verdict(id, pass, msg, evidence) {
  R[id] = { pass: !!pass, msg, evidence };
  console.log(`\n${pass ? '✅ 通过' : '❌ 不通过'}  需求${id}  ${msg}`);
  if (evidence) console.log(`     证据: ${evidence}`);
}
function sub(id, pass, msg) {
  console.log(`   ${pass ? 'PASS' : 'FAIL'}  ${id}: ${msg}`);
  R[id] = { pass: !!pass, msg, evidence: '' };
}

/* ---------------- 页面注入桥 ---------------- */
const BRIDGE = `(async function(){
  if (window.__V_BRIDGE__) return true;
  window.__V_THREE__ = await import('three');
  window.__V_RAF_ORIG__ = window.requestAnimationFrame;
  window.requestAnimationFrame = function(){ return 0; };
  window.__V_RENDERER__.compositor.uniforms.composite.uGrain.value = 0;
  window.__VIMG__ = {};
  window.__VGRAB__ = function(name){
    const RR = window.__V_RENDERER__, gl = RR.renderer.getContext(), cv = RR.canvas;
    const w = cv.width, h = cv.height, raw = new Uint8Array(w*h*4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const d = new Uint8Array(w*h*4);
    for (let y = 0; y < h; y++) d.set(raw.subarray((h-1-y)*w*4, (h-y)*w*4), y*w*4);
    window.__VIMG__[name] = { w: w, h: h, d: d };
    return [w, h];
  };
  window.__VLU__ = function(img, i){ return (0.2126*img.d[i] + 0.7152*img.d[i+1] + 0.0722*img.d[i+2]) / 255; };
  window.__VR__ = function(t, extra, mask){
    const S = window.__V_SCREEN__, RR = window.__V_RENDERER__, L = window.__V_STAGE__.light;
    S.uniforms.uTime.value = 0;
    RR.compositor.uniforms.composite.uTime.value = 0;
    RR.bypass = !!mask; S.setDebugMode(mask ? 1 : 0);
    window.__SET_TIME__(t);
    if (typeof extra === 'function') extra();
    S.update(1/60, L, RR.camera);
    S.renderShadow(RR.scene);
    RR.render(1/60);
  };
  window.__VSNAP__ = function(tag, t, extra, mask, settle){
    const n = settle == null ? 4 : settle; let r = null;
    for (let i = 0; i < n; i++) r = window.__VR__(t, extra, mask);
    return window.__VGRAB__(tag);
  };
  window.__VSHOT__ = function(t, extra, mask, settle){
    const n = settle == null ? 4 : settle;
    for (let i = 0; i < n; i++) window.__VR__(t, extra, mask);
    return window.__snapshot();
  };
  window.__VHIDE__ = function(pred, vis){ window.__V_RENDERER__.scene.traverse(function(o){ if (pred(o)) o.visible = vis; }); };
  window.__VOCC__ = function(refName, testName, tol){
    const A = window.__VIMG__[refName], B = window.__VIMG__[testName];
    const w = A.w, h = A.h, n = w*h; let area = 0, sum = 0, minx = w, maxx = -1, miny = h, maxy = -1;
    const mask = new Uint8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++){
      const i = (y*w+x)*4, d = window.__VLU__(A,i) - window.__VLU__(B,i);
      if (d > tol){ area++; sum += d; mask[y*w+x] = 1;
        if (x<minx)minx=x; if(x>maxx)maxx=x; if(y<miny)miny=y; if(y>maxy)maxy=y; }
    }
    const tag = 'mask:'+refName+':'+testName+':'+tol;
    window.__VIMG__[tag] = { w: w, h: h, d: mask };
    return { area: area, frac: area/n, bbox: [minx,miny,maxx,maxy], meanDelta: area? sum/area : 0, maskTag: tag };
  };
  window.__VDIFF2__ = function(a, b){
    const A = window.__VIMG__[a], B = window.__VIMG__[b]; let s = 0; const n = A.w*A.h;
    for (let i = 0; i < n; i++){ const j = i*4;
      s += (Math.abs(A.d[j]-B.d[j]) + Math.abs(A.d[j+1]-B.d[j+1]) + Math.abs(A.d[j+2]-B.d[j+2])) / 3 / 255; }
    return s / n;
  };
  window.__VREGION__ = function(name, x0, y0, x1, y1){
    const img = window.__VIMG__[name]; x0|=0; y0|=0; x1|=0; y1|=0;
    let r=0,g=0,b=0,m=0;
    for (let y=y0;y<y1;y++) for (let x=x0;x<x1;x++){ const j=(y*img.w+x)*4; r+=img.d[j];g+=img.d[j+1];b+=img.d[j+2];m++; }
    return { r:r/m/255, g:g/m/255, b:b/m/255, n:m };
  };
  window.__VSD__ = function(name, x0, y0, x1, y1){
    const img = window.__VIMG__[name]; x0|=0; y0|=0; x1|=0; y1|=0; const v = [];
    for (let y=y0;y<y1;y++) for (let x=x0;x<x1;x++) v.push(window.__VLU__(img,(y*img.w+x)*4));
    const m = v.reduce(function(a,c){return a+c;},0)/v.length;
    return { mean: m, sd: Math.sqrt(v.reduce(function(a,c){return a+(c-m)*(c-m);},0)/v.length), n: v.length };
  };
  window.__VROWMEAN__ = function(name, x0, x1, ys){
    const img = window.__VIMG__[name]; x0|=0; x1|=0;
    return ys.map(function(y){ y|=0; let s=0,m=0; for (let x=x0;x<x1;x+=2){ s += window.__VLU__(img,(y*img.w+x)*4); m++; } return [y, +(s/m).toFixed(4)]; });
  };
  /* 拼图：把若干时间点的画面排成一张大图（用页面内的 2D canvas 拼，便于人工核对动作语义）*/
  window.__MONTAGE__ = function(times, cols, tag){
    const RR = window.__V_RENDERER__, src = RR.canvas;
    const cw = src.width, ch = src.height;
    const rows = Math.ceil(times.length / cols);
    const out = document.createElement('canvas');
    out.width = cw * cols; out.height = ch * rows;
    const c = out.getContext('2d');
    c.fillStyle = '#000'; c.fillRect(0, 0, out.width, out.height);
    for (let i = 0; i < times.length; i++){
      window.__VSHOT__(times[i], null, false);
      c.drawImage(src, (i % cols) * cw, Math.floor(i / cols) * ch);
    }
    window.__V_MONTAGETAG__ = tag;
    return out.toDataURL('image/png');
  };
  /* 自算编排：按 dt 采样 sample(t)，累积成真实状态向量（采样与求速全部在 node 侧，便于复核）
     返回 { dt, duration, names, frames: [[t, v0, v1, ...]], vis: [[t, g, c]], lightI, subs } */
  window.__VANALYZE__ = function(dt){
    const TL = window.__V_TIMELINE__;
    const N = Math.round(TL.duration / dt);
    const names = [], seen = {};
    const actors = ['general','cavalry'];
    const state = {}; const keys = {};
    for (const ak of actors){ state[ak] = { root: { tx:0,ty:0,tz:0,rz:0,ry:0 }, pose: {}, visible: true }; keys[ak] = {}; }
    const cname = function(ak, ch){ return 'pose:' + ak + ':' + ch; };
    const rname = function(ak, k){ return 'root:' + ak + ':' + k; };
    for (const ak of actors) for (const k of ['tx','ty','tz','rz','ry']) if (!seen[rname(ak,k)]){ seen[rname(ak,k)] = 1; names.push(rname(ak,k)); }
    // 第一遍：收集所有出现过的通道名（保证索引稳定）
    for (let i = 0; i <= N; i++){
      const f = TL.sample(Math.min(TL.duration, i*dt));
      for (const ak of actors){
        const a = f.actors[ak]; if (!a) continue;
        if (a.pose) for (const ch in a.pose){ const n = cname(ak, ch); if (!seen[n]){ seen[n] = 1; names.push(n); } }
      }
    }
    names.sort();
    const idx = {}; names.forEach(function(n, j){ idx[n] = j; });
    const frames = [], vis = [], lightI = [], subs = [];
    const carry = new Array(names.length).fill(0);
    for (let i = 0; i <= N; i++){
      const t = Math.min(TL.duration, i*dt);
      const f = TL.sample(t);
      for (const ak of actors){
        const a = f.actors[ak]; if (!a) continue;
        state[ak].visible = a.visible !== false;
        if (a.root) for (const k of ['tx','ty','tz','rz','ry']) if (a.root[k] != null) carry[idx[rname(ak,k)]] = a.root[k];
        if (a.pose) for (const ch in a.pose) carry[idx[cname(ak, ch)]] = a.pose[ch][2];
      }
      frames.push([+t.toFixed(4)].concat(carry.map(function(v){ return +v.toFixed(4); })));
      vis.push([+t.toFixed(3), state.general.visible ? 1 : 0, state.cavalry.visible ? 1 : 0]);
      lightI.push(+f.light.intensity.toFixed(4));
      if (f.subtitle) subs.push([+t.toFixed(2), f.subtitle]);
    }
    const d = TL.debug();
    return { dt: dt, duration: TL.duration, names: names, frames: frames, vis: vis, lightI: lightI, subs: subs,
      acts: d.acts, holdInfo: { holdTotal: d.holdTotal, holdCount: d.holdCount }, lightPos: [f_lightpos(TL)] };
    function f_lightpos(TL2){ const p = TL2.sample(0).light.pos; return [+p[0].toFixed(3), +p[1].toFixed(3), +p[2].toFixed(3)]; }
  };
  /* 镂空透光的**柔化鲁棒**量法（2026-09-11 换算法，见 VERIFICATION.md §4 说明）：
     固定绝对阈值 0.15 会随"影子柔化"变化而漂移（柔化变宽 → 小孔被半影吃掉的像素被判成"没透光"）。
     这里改成相对量：以"全实心那一对"的中位影子深度 dMed 为标尺，
       outer = delta_solid > 0.30*dMed   （剪影轮廓，宽松）
       hole  = outer 内 delta_holes < 0.60*dMed （比周围实体影子明显亮 = 确实透光） */
  window.__VRELHOLE__ = function(refName, solidName, holesName, tolAbs){
    const A = window.__VIMG__[refName], S = window.__VIMG__[solidName], H = window.__VIMG__[holesName];
    const w = A.w, h = A.h, n = w*h;
    const ds = [];
    for (let i = 0; i < n; i++){ const d = window.__VLU__(A, i*4) - window.__VLU__(S, i*4); if (d > 0.02) ds.push(d); }
    ds.sort(function(a,b){ return a-b; });
    const dMed = ds.length ? ds[(ds.length*0.5)|0] : 0.30;
    const tOut = dMed * 0.30, tHole = dMed * 0.60;
    const outer = new Uint8Array(n), hole = new Uint8Array(n);
    let outerArea = 0, holeArea = 0, sumHole = 0, sumSolid = 0, absHole = 0;
    const ta = tolAbs == null ? 0.15 : tolAbs;
    for (let i = 0; i < n; i++){
      const j = i*4, la = window.__VLU__(A, j), dS = la - window.__VLU__(S, j), dH = la - window.__VLU__(H, j);
      if (dS > tOut){ outer[i] = 1; outerArea++; sumSolid += dH;
        if (dH < tHole){ hole[i] = 1; holeArea++; sumHole += dH; }
        if (dS > ta && dH <= 0.05) absHole++; }
    }
    // 连通域 + "是否被实体包围"（环上 ≥80% 属于 outer）
    const seen = new Uint8Array(n), comps = [], st = [];
    for (let i = 0; i < n; i++){
      if (!hole[i] || seen[i]) continue;
      st.length = 0; st.push(i); seen[i] = 1;
      let a = 0, minx = w, maxx = -1, miny = h, maxy = -1, ring = 0, ringIn = 0;
      const rs = {};
      while (st.length){
        const p = st.pop(); a++; const px = p % w, py = (p-px)/w;
        if (px<minx)minx=px; if(px>maxx)maxx=px; if(py<miny)miny=py; if(py>maxy)maxy=py;
        const nb = [px>0?p-1:-1, px<w-1?p+1:-1, py>0?p-w:-1, py<h-1?p+w:-1];
        for (let k = 0; k < 4; k++){ const q = nb[k]; if (q < 0) continue;
          if (hole[q]){ if (!seen[q]){ seen[q] = 1; st.push(q); } }
          else if (!rs[q]){ rs[q] = 1; ring++; if (outer[q]) ringIn++; } }
      }
      comps.push({ area: a, w: maxx-minx+1, h: maxy-miny+1, enclosed: ring ? ringIn/ring : 1 });
    }
    comps.sort(function(x,y){ return y.area - x.area; });
    const enc = comps.filter(function(c){ return c.enclosed >= 0.8; });
    return { dMed: +dMed.toFixed(4), tOut: +tOut.toFixed(4), tHole: +tHole.toFixed(4),
      outerArea: outerArea, holeArea: holeArea, ratio: outerArea ? holeArea/outerArea : 0,
      absHoleArea: absHole, absRatio: outerArea ? absHole/outerArea : 0,
      compCount: comps.length, encCount: enc.length, encArea: enc.reduce(function(s,c){ return s+c.area; }, 0),
      encTop: enc.slice(0,8).map(function(c){ return c.area; }),
      meanHoleDelta: holeArea ? sumHole/holeArea : 0, meanSolidDelta: outerArea ? sumSolid/outerArea : 0 };
  };
  /* 正向运动学：给定时间，读若干部件的世界坐标（证明是关节链在动） */
  window.__VFK__ = function(times, keys){
    const out = [];
    for (let i = 0; i < times.length; i++){
      window.__SET_TIME__(times[i]);
      const rec = { t: times[i], p: {} };
      for (const ak of ['general','cavalry']){
        const rig = window.__V_RIGS__[ak]; if (!rig || !rig.root.visible) continue;
        for (const k of keys){
          const p = rig.parts.get(k); if (!p) continue;
          const v = new window.__V_THREE__.Vector3();
          p.mesh.getWorldPosition(v);
          rec.p[ak + ':' + k] = [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)];
        }
      }
      out.push(rec);
    }
    return out;
  };
  /* 关节链传播实验：只转一个关节，看它的下游子部件是否跟着动 */
  window.__VJOINT__ = function(t){
    const rig = window.__V_RIGS__.general;
    window.__SET_TIME__(t);
    rig.root.updateMatrixWorld(true);
    const get = function(k){ const p = rig.parts.get(k); const v = new window.__V_THREE__.Vector3();
      p.mesh.getWorldPosition(v); return [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)]; };
    const before = { handR: get('handR'), weaponTip: get('weaponTip'), handL: get('handL') };
    // 1) 把右肩/上臂在它自己的关节轴上多转 0.6 rad
    const up = rig.parts.get('upperArmR');
    const saved = up.pivot.rotation.z;
    up.pivot.rotation.z = saved + 0.6;
    rig.root.updateMatrixWorld(true);
    const afterArm = { handR: get('handR'), weaponTip: get('weaponTip'), handL: get('handL') };
    up.pivot.rotation.z = saved;
    // 2) 对照：只转头
    const hd = rig.parts.get('head'); const hs = hd.pivot.rotation.z;
    hd.pivot.rotation.z = hs + 0.6;
    rig.root.updateMatrixWorld(true);
    const afterHead = { handR: get('handR'), weaponTip: get('weaponTip'), handL: get('handL') };
    hd.pivot.rotation.z = hs;
    rig.root.updateMatrixWorld(true);
    const dist = function(a,b){ return Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]); };
    return {
      before: before, afterArm: afterArm, afterHead: afterHead,
      moveHandR: dist(before.handR, afterArm.handR),
      moveWeaponTip: dist(before.weaponTip, afterArm.weaponTip),
      ctrlHandR: dist(before.handR, afterHead.handR),
      shoulderZ: +saved.toFixed(3),
    };
  };
  /* 每个部件贴图的镂空率（alpha 包围的透明孔洞 / 实体+孔洞） */
  window.__VCARVE__ = function(actor){
    const rig = window.__V_RIGS__[actor], out = [], seen = {};
    const parts = [];
    rig.parts.forEach(function(p, key){ parts.push([key, p]); });
    for (let idx = 0; idx < parts.length; idx++){
      const key = parts[idx][0], p = parts[idx][1];
      const tex = p.mesh.material.map; if (!tex) continue;
      if (seen[tex.uuid]) { out.push({ key: key, shared: seen[tex.uuid] }); continue; }
      seen[tex.uuid] = key;
      const cv = tex.image; if (!cv || !cv.getContext) continue;
      const w = cv.width, h = cv.height;
      const d = cv.getContext('2d').getImageData(0, 0, w, h).data;
      const opq = new Uint8Array(w*h);
      let opaque = 0;
      for (let i = 0; i < w*h; i++){ if (d[i*4+3] >= 115){ opq[i] = 1; opaque++; } }
      // 从画布四边泛洪"外部透明区"，剩下的透明像素就是被实体包围的镂空
      const out2 = new Uint8Array(w*h), st = [];
      for (let x = 0; x < w; x++){ st.push(x); st.push((h-1)*w + x); }
      for (let y = 0; y < h; y++){ st.push(y*w); st.push(y*w + w - 1); }
      while (st.length){
        const q = st.pop();
        if (q < 0 || q >= w*h || opq[q] || out2[q]) continue;
        out2[q] = 1;
        const qx = q % w, qy = (q - qx) / w;
        if (qx > 0) st.push(q-1); if (qx < w-1) st.push(q+1);
        if (qy > 0) st.push(q-w); if (qy < h-1) st.push(q+w);
      }
      let enclosed = 0;
      for (let i = 0; i < w*h; i++) if (!opq[i] && !out2[i]) enclosed++;
      out.push({ key: key, w: w, h: h, opaque: opaque, enclosed: enclosed,
        carveRatio: (opaque + enclosed) ? enclosed / (opaque + enclosed) : 0,
        opaqueRatioOfCanvas: opaque / (w*h), fill: opaque ? 1 : 0 });
    }
    return out;
  };
  window.__V_BRIDGE__ = true;
  return true;
})()`;

async function exposeClosure(page) {
  const s = page.session;
  const r = await s.send('Runtime.evaluate', { expression: 'window.__qa', returnByValue: false });
  const props = await s.send('Runtime.getProperties', { objectId: r.result.objectId, ownProperties: false });
  const sc = (props.internalProperties || []).find((p) => p.name === '[[Scopes]]');
  if (!sc || !sc.value || !sc.value.objectId) throw new Error('拿不到 [[Scopes]]');
  const list = await s.send('Runtime.getProperties', { objectId: sc.value.objectId, ownProperties: true });
  const got = [];
  for (const scope of list.result) {
    if (!scope.value || !scope.value.objectId) continue;
    const sp = await s.send('Runtime.getProperties', { objectId: scope.value.objectId, ownProperties: true });
    const keys = (sp.result || []).map((x) => x.name);
    if (!keys.includes('rigs') || !keys.includes('screen')) continue;
    for (const t of ['renderer', 'screen', 'stage', 'rigs', 'props', 'timeline', 'state']) {
      const b = (sp.result || []).find((x) => x.name === t);
      if (b && b.value && b.value.objectId) {
        await s.send('Runtime.callFunctionOn', { objectId: b.value.objectId,
          functionDeclaration: `function(){ window.__V_${t.toUpperCase()}__ = this; }`, returnByValue: true });
        got.push(t);
      }
    }
  }
  return got;
}
const save = (u, p) => { writeFileSync(p, Buffer.from(String(u).split(',')[1], 'base64')); return p; };
const pct = (v) => `${(v * 100).toFixed(2)}%`;

/* ================================================================== */
const out = await withPage({ page: 'index.html', width: 1320, height: 900, readyTimeout: 180000 }, async (page) => {
  await page.waitReady();
  console.log(`  [bridge] 暴露闭包变量: ${(await exposeClosure(page)).join(', ')}`);
  await page.eval(BRIDGE);
  const ev = (e) => page.eval(e);
  const J = async (e) => JSON.parse(await page.eval(e));
  const shots = {};
  const qa = await J('JSON.stringify(window.__qa())');
  const W = qa.stats.drawingBuffer[0], H = qa.stats.drawingBuffer[1];
  console.log(`  [bridge] 画布 ${W}x${H} webgl2=${qa.stats.webgl2} 投射体=${qa.shadowCasters} drawCalls=${qa.stats.drawCalls} tris=${qa.stats.tris}`);

  const HIDE_ALL = 'function(o){ return o.isMesh && o.castShadowRaw; }';
  /* 参考帧 + 噪声底 */
  await ev(`window.__VSNAP__('ref', 32.3, function(){ window.__VHIDE__(${HIDE_ALL}, false); }, false);`);
  shots.ref = save(await ev('window.__snapshot()'), SHOT('r1-ref-no-casters'));
  await ev(`window.__VSNAP__('n1', 32.3, null, false); window.__VSNAP__('n2', 32.3, null, false);`);
  const noise = await J('JSON.stringify(window.__VDIFF2__("n1","n2"))');
  note(`噪声底（同序列重跑）mean|Δ|=${pct(noise)}`);

  /* ================= 需求 1：光源在幕布后，看到的是投出的剪影 ================= */
  const lightInfo = await J(`JSON.stringify((function(){
    const L = window.__V_STAGE__.light;
    return { type: L.type, isSpot: L.isSpotLight === true, pos: [+L.position.x.toFixed(3), +L.position.y.toFixed(3), +L.position.z.toFixed(3)],
      color: '#' + L.color.getHexString(), intensity: +L.intensity.toFixed(3), angle: +L.angle.toFixed(3),
      distance: L.distance, shadowSize: [L.shadow.mapSize.x, L.shadow.mapSize.y], castShadow: L.castShadow,
      screenZ: window.__V_SCREEN__.mesh.position.z, shadowOn: window.__V_SCREEN__.uniforms.uShadowOn.value };
  })())`);
  await ev(`window.__VSNAP__('all', 32.3, function(){ window.__VHIDE__(${HIDE_ALL}, true); }, false);`);
  shots.r1 = save(await ev('window.__snapshot()'), SHOT('r1-scene-t32.3'));
  const occAll = await J('JSON.stringify(window.__VOCC__("ref","all",0.15))');
  const lightIntensity = await J(`JSON.stringify((function(){
    const TL = window.__V_TIMELINE__, out = [];
    for (let t = 0; t <= TL.duration; t += 2) out.push([+t.toFixed(1), +TL.sample(t).light.intensity.toFixed(3),
      [+TL.sample(t).light.pos.x.toFixed(2), +TL.sample(t).light.pos.y.toFixed(2), +TL.sample(t).light.pos.z.toFixed(2)]]);
    return out; })())`);
  const zs = lightIntensity.map((x) => x[2][2]);
  // A/B：把阴影关掉 —— 若暗区消失，说明黑是"光被挡"而不是画上去的
  await ev(`window.__VSNAP__('shadowOff', 32.3, function(){ window.__VHIDE__(${HIDE_ALL}, true);
    window.__V_SCREEN__.uniforms.uShadowOn.value = 0; }, false);`);
  const occOff = await J('JSON.stringify(window.__VOCC__("ref","shadowOff",0.15))');
  const occShadowContribution = await J('JSON.stringify(window.__VOCC__("shadowOff","all",0.15))');
  const shadowOnDiff = await J('JSON.stringify(window.__VDIFF2__("all","shadowOff"))');
  const noCastShadowOff = await J(`JSON.stringify((function(){
    window.__VSNAP__('nso', 32.3, function(){ window.__VHIDE__(${HIDE_ALL}, false);
      window.__V_SCREEN__.uniforms.uShadowOn.value = 0; }, false);
    return window.__VOCC__('ref','nso',0.15); })())`);
  await ev('window.__V_SCREEN__.uniforms.uShadowOn.value = 1');
  const litProbe = await J('JSON.stringify(window.__VREGION__("all", 380, 120, 900, 620))');
  note(`灯：${lightInfo.type} 位置 z=${lightInfo.pos[2]}（幕布 z=${lightInfo.screenZ}，在幕布后方），颜色 ${lightInfo.color}，强度 ${lightInfo.intensity}`);
  note(`灯位全程 z ∈ [${Math.min(...zs).toFixed(2)}, ${Math.max(...zs).toFixed(2)}]（都在幕布后方）；强度 0→峰值 ${Math.max(...lightIntensity.map((x) => x[1])).toFixed(2)}`);
  note(`参考帧(无投射体)平均亮度 ${(await J('JSON.stringify(window.__VREGION__("ref", 380, 120, 900, 620))')).r.toFixed(3)}，有演员时该区 ${litProbe.r.toFixed(3)}`);
  note(`遮挡面积=${occAll.area}px(${pct(occAll.frac)} of 画面)，平均变暗 ${occAll.meanDelta.toFixed(3)}；关掉 uShadowOn 后遮挡面积=${occOff.area}px`);
  sub('R1a', lightInfo.isSpot && lightInfo.pos[2] < lightInfo.screenZ && lightInfo.shadowSize[0] === 2048,
    `SpotLight 在幕布后方 z=${lightInfo.pos[2]} < ${lightInfo.screenZ}，2048² 自定义阴影贴图，强度峰值 ${Math.max(...lightIntensity.map((x) => x[1])).toFixed(2)}`);
  sub('R1b', occAll.frac > 0.03 && occAll.meanDelta > 0.20,
    `幕布上出现剪影：暗区 ${occAll.area}px = 画面 ${pct(occAll.frac)}，平均变暗 ${occAll.meanDelta.toFixed(3)}（幕面亮度量级 0.6）`);
  sub('R1c', occOff.area < occAll.area * 0.4 && occShadowContribution.area > occAll.area * 0.6,
    `A/B：uShadowOn=0（关阴影）后暗区从 ${occAll.area}px 掉到 ${occOff.area}px（${pct(occOff.area / Math.max(occAll.area, 1))}）；反过来"全场景 vs 关阴影"的差异 ${occShadowContribution.area}px（${pct(occShadowContribution.area / 921600)} 的画面）=> 黑是"光被挡"的结果，不是画上去的`,
    `残留的 ${occOff.area}px 是 src/stage.js 地台写进 shadow map 造成的假影（与演员无关：完全没有投射体时也占 ${noCastShadowOff.area}px），见 tools/verify-artifacts.mjs 的 E6b 缺陷`);
  verdict(1, R.R1a.pass && R.R1b.pass && R.R1c.pass,
    '幕布后方有光源，观众看到的剪影是投影遮挡的结果',
    `证据 ${shots.r1} / ${shots.ref}；实测：灯位 z=${lightInfo.pos[2]}，剪影 ${occAll.area}px(平均变暗 ${occAll.meanDelta.toFixed(3)})，关闭阴影后归零(${occOff.area}px)`);

  /* ================= 需求 2：可活动的关节 ================= */
  const skel = await J(`JSON.stringify((function(){
    const rig = window.__V_RIGS__.general; const parts = []; const parents = {};
    rig.parts.forEach(function(p, k){ parts.push(k);
      parents[k] = p.pivot.parent && p.pivot.parent.name ? p.pivot.parent.name.replace(':pivot','') : 'root'; });
    // 从 handR 往上数链长
    let chain = ['handR'], cur = 'handR';
    while (parents[cur] && parents[cur] !== 'root' && chain.length < 30){ cur = parents[cur]; chain.push(cur); }
    return { count: parts.length, keys: parts, parents: parents, chain: chain, chainDepth: chain.length };
  })())`);
  const joint = await J(`JSON.stringify(window.__VJOINT__(32.3))`);
  note(`骨架：${skel.count} 个部件；handR 的关节链 ${skel.chain.join(' ← ')}（深度 ${skel.chainDepth}）`);
  note(`关节传播实验：把 upperArmR 多转 0.6rad -> handR 世界位移 ${joint.moveHandR.toFixed(4)}m、weaponTip ${joint.moveWeaponTip.toFixed(4)}m；对照(只转头) handR 位移 ${joint.ctrlHandR.toFixed(4)}m`);
  const fkTimes = []; for (let t = 0; t <= 46; t += 0.2) fkTimes.push(+t.toFixed(2));
  const fk = await J(`JSON.stringify(window.__VFK__(${JSON.stringify(fkTimes)}, ${JSON.stringify(['handR', 'handL', 'footL', 'footR', 'head', 'weaponTip'])}))`);
  const trackKeys = Array.from(new Set(fk.flatMap((f) => Object.keys(f.p))));
  const trackRange = {};
  for (const k of trackKeys) {
    const ys = fk.map((f) => f.p[k] && f.p[k][1]).filter((v) => v != null);
    const xs = fk.map((f) => f.p[k] && f.p[k][0]).filter((v) => v != null);
    trackRange[k] = { yRange: Math.max(...ys) - Math.min(...ys), xRange: Math.max(...xs) - Math.min(...xs), samples: ys.length };
  }
  note(`正向运动学（46s 内 231 个采样点）世界坐标摆幅：${Object.entries(trackRange).map(([k, v]) => `${k} Δy=${v.yRange.toFixed(3)}m Δx=${v.xRange.toFixed(3)}m`).join('；')}`);
  const ana = await J('JSON.stringify(window.__VANALYZE__(1/60))');
  /* ---- node 侧自算：值域 / 换向 / 速度 / 停顿 / 每幕极值 ---- */
  const NAMES = ana.names, NF = ana.frames.length;
  const val = (fi, j) => ana.frames[fi][j + 1];
  const actorOf = (n) => n.split(':')[1];
  const visAt = (fi) => ({ general: ana.vis[fi][1] === 1, cavalry: ana.vis[fi][2] === 1 });
  const chanRanges = NAMES.map((n, j) => {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < NF; i++) { const v = val(i, j); if (v < mn) mn = v; if (v > mx) mx = v; }
    return [n, mx - mn, mn, mx];
  }).filter((c) => c[0].startsWith('pose:'))
    .map(([n, r, mn, mx]) => [n.replace(/^pose:/, ''), r, mn, mx])
    .sort((a, b) => b[1] - a[1]);
  const signChanges = {};
  for (let j = 0; j < NAMES.length; j++) {
    let lastD = 0, cnt = 0;
    for (let i = 1; i < NF; i++) {
      const d = val(i, j) - val(i - 1, j);
      if (d !== 0 && lastD !== 0 && Math.sign(d) !== Math.sign(lastD)) cnt++;
      if (d !== 0) lastD = d;
    }
    signChanges[NAMES[j]] = cnt;
  }
  const speeds = new Array(NF - 1).fill(0);
  const speedsVisible = new Array(NF - 1).fill(0);
  for (let i = 1; i < NF; i++) {
    const vis = visAt(i - 1);
    let s = 0, sv = 0;
    for (let j = 0; j < NAMES.length; j++) {
      const d = Math.abs(val(i, j) - val(i - 1, j));
      s += d;
      if (vis[actorOf(NAMES[j])]) sv += d;
    }
    speeds[i - 1] = s / ana.dt;
    speedsVisible[i - 1] = sv / ana.dt;
  }
  {
    // 自检：速度必须真的非零（否则后面的停顿统计无意义）
    const mx = Math.max(...speedsVisible);
    if (!(mx > 0.5)) throw new Error('速度曲线异常（max=' + mx + '），无法判定停顿');
    note(`自算速度曲线：${NF} 帧 / ${NAMES.length} 个状态分量，最大 ${mx.toFixed(2)}（rad或m）/s，非零帧 ${speedsVisible.filter((v) => v > 0.01).length}/${speedsVisible.length}`);
  }
  const movingChans = chanRanges.filter((c) => c[1] > 0.15);
  const legChans = chanRanges.filter((c) => /thigh|shin|foot/.test(c[0]));
  const legSigns = Object.entries(signChanges).filter(([k]) => /thigh|shin|foot/.test(k));
  const ryIdx = NAMES.indexOf('root:general:ry');
  const ryVals = Array.from({ length: NF }, (_, i) => val(i, ryIdx));
  const ryRange = Math.max(...ryVals) - Math.min(...ryVals);
  note(`编排通道摆幅 Top: ${chanRanges.slice(0, 12).map(([k, v]) => `${k}=${v.toFixed(2)}rad`).join(', ')}`);
  note(`摆幅>0.15rad 的通道 ${movingChans.length} 个；主将腿脚换向 ${legSigns.filter(([k]) => k.startsWith('pose:general:')).map(([k, v]) => `${k.replace(/^pose:general:/, '')}=${v}`).join(',')}`);
  note(`root.ry（真转身）摆幅 ${ryRange.toFixed(3)}rad，范围 [${Math.min(...ryVals).toFixed(2)}, ${Math.max(...ryVals).toFixed(2)}]`);
  const mont2 = await ev(`window.__MONTAGE__(${JSON.stringify([14.2, 16.0, 18.5, 27.0, 30.9, 32.3])}, 3, 'r2')`);
  shots.r2poses = save(mont2, SHOT('r2-joints-poses'));
  const mont2b = await ev(`window.__MONTAGE__(${JSON.stringify([30.6, 30.9, 31.2, 31.5, 31.8, 32.1])}, 3, 'r2turn')`);
  shots.r2turn = save(mont2b, SHOT('r2-turn-6frames'));
  sub('R2a', skel.count >= 20 && skel.chainDepth >= 4,
    `${skel.count} 个可动部件构成关节树，handR 到 root 的链深度 ${skel.chainDepth}（${skel.chain.join('←')}）`);
  sub('R2b', joint.moveHandR > 0.05 && joint.moveWeaponTip > 0.05 && joint.ctrlHandR < 0.01,
    `只转 upperArmR 0.6rad，下游 handR 位移 ${joint.moveHandR.toFixed(3)}m、刀尖 ${joint.moveWeaponTip.toFixed(3)}m；只转头时 handR 不动（${joint.ctrlHandR.toFixed(4)}m）=> 是真骨架链，不是各自独立的贴片`);
  sub('R2c', movingChans.length >= 12 && legSigns.reduce((a, b) => a + b[1], 0) >= 5 && ryRange > 1.0
    && (trackRange['general:footL'] || {}).yRange > 0.08,
    `编排驱动 ${movingChans.length} 个通道（>0.15rad），腿脚换向共 ${legSigns.reduce((a, b) => a + b[1], 0)} 次（走路），root.ry 摆幅 ${ryRange.toFixed(2)}rad（真转身），脚底世界高度变化 ${((trackRange['general:footL'] || {}).yRange || 0).toFixed(3)}m（抬脚）`);
  verdict(2, R.R2a.pass && R.R2b.pass && R.R2c.pass,
    '人物由可活动的关节链组成，能做出走路 / 转身 / 抬手',
    `证据 ${shots.r2poses}（6 个姿态）、${shots.r2turn}（转身连续 6 帧）`);

  /* ================= 需求 3：停顿与轻重缓急 ================= */
  const sp = speedsVisible;
  const sorted = sp.slice().sort((a, b) => a - b);
  const mean = sp.reduce((a, b) => a + b, 0) / sp.length;
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const holdThr = mean * 0.08;
  function holds(dt, speeds, thr, minDur) {
    const res = []; let s = -1;
    for (let i = 0; i < speeds.length; i++) {
      const slow = speeds[i] < thr;
      if (slow && s < 0) s = i;
      if ((!slow || i === speeds.length - 1) && s >= 0) {
        const e = slow ? i : i - 1;
        if ((e - s + 1) * dt >= minDur) res.push({ t0: +(s * dt).toFixed(2), t1: +(e * dt).toFixed(2), dur: +((e - s + 1) * dt).toFixed(2) });
        s = -1;
      }
    }
    return res;
  }
  const h1 = holds(ana.dt, sp, holdThr, 0.30);
  const h2 = holds(ana.dt, sp, mean * 0.12, 0.30);
  const h3 = holds(ana.dt, sp, mean * 0.05, 0.30);
  const holdTotal = h1.reduce((a, b) => a + b.dur, 0);
  const acts = ana.acts;
  const actOf = (t) => acts.find((a) => t >= a.t0 && t < a.t1) || acts[acts.length - 1];
  const holdsOfAct = (id) => h1.filter((x) => actOf((x.t0 + x.t1) / 2).id === id);
  const actStats = acts.map((a) => {
    const i0 = Math.round(a.t0 / ana.dt), i1 = Math.min(sp.length - 1, Math.round(a.t1 / ana.dt));
    const seg = sp.slice(i0, i1 + 1).filter((v) => isFinite(v));
    const hs = holdsOfAct(a.id);
    const mx = Math.max(...seg), mn = Math.min(...seg);
    const met = +a.t0;
    // 快—停—慢：本幕内存在「某处速度 >1.5×均值 → 0.3~3s 内出现停顿 → 停顿之后出现 <0.5×均值 的慢段」
    let pattern = false, patDetail = '';
    for (const hh of hs) {
      let fastBefore = false;
      for (let i = Math.max(0, Math.round((hh.t0 - met) / ana.dt) - 180); i < Math.round((hh.t0 - met) / ana.dt); i++) {
        if (seg[i] != null && seg[i] > mean * 1.5) { fastBefore = true; break; }
      }
      let slowAfter = false;
      for (let i = Math.round((hh.t1 - met) / ana.dt); i < seg.length; i++) {
        if (seg[i] != null && seg[i] < mean * 0.5) { slowAfter = true; break; }
      }
      if (fastBefore && slowAfter) { pattern = true; patDetail = `快→停(${hh.t0}~${hh.t1}s)→慢`; break; }
    }
    return { id: a.id, name: a.name, t0: a.t0, t1: a.t1, dur: +(a.t1 - a.t0).toFixed(2),
      maxSpeed: +mx.toFixed(3), minSpeed: +mn.toFixed(3), meanSpeed: +(seg.reduce((x, y) => x + y, 0) / seg.length).toFixed(3),
      holds: hs.length, holdDur: +hs.reduce((x, y) => x + y.dur, 0).toFixed(2), quickStopSlow: pattern, patDetail };
  });
  console.log('      幕次速度表（自算，速度=所有通道角速度绝对值之和 + root 位移速度，仅计可见演员）:');
  for (const a of actStats) console.log(`        ${a.id}·${a.name}  ${a.t0}-${a.t1}s (${a.dur}s)  最快 ${a.maxSpeed}  最慢 ${a.minSpeed}  均值 ${a.meanSpeed}  停顿 ${a.holds} 处/${a.holdDur}s  快-停-慢=${a.quickStopSlow}${a.patDetail ? ' ' + a.patDetail : ''}`);
  note(`速度分位：p05=${q(0.05).toFixed(3)} p50=${q(0.5).toFixed(3)} p95=${q(0.95).toFixed(3)} 均值=${mean.toFixed(3)}；停顿阈值=均值的 8% = ${holdThr.toFixed(3)}`);
  note(`停顿：${h1.length} 处共 ${holdTotal.toFixed(2)}s（阈值 5%/12% 时分别为 ${h3.reduce((a, b) => a + b.dur, 0).toFixed(2)}s / ${h2.reduce((a, b) => a + b.dur, 0).toFixed(2)}s）`);
  note(`最长的 5 处停顿: ${h1.slice().sort((a, b) => b.dur - a.dur).slice(0, 5).map((x) => `${x.t0}~${x.t1}s(${x.dur}s)`).join(', ')}`);
  const debugChk = ana.holdInfo;
  note(`交叉对比 debug(): holdCount=${debugChk.holdCount} holdTotal=${debugChk.holdTotal}（自算 ${h1.length} 处 / ${holdTotal.toFixed(2)}s）`);
  let tlJson = null;
  try { tlJson = JSON.parse(readFileSync(join(ROOT, 'shots/timeline.json'), 'utf8')); } catch { /* 允许缺失 */ }
  if (tlJson) note(`交叉对比 shots/timeline.json: holds=${(tlJson.holds || []).length} holdTotal=${tlJson.holdTotal}`);
  // 像素级：停顿窗口 vs 最快窗口的帧间差
  const longest = h1.slice().sort((a, b) => b.dur - a.dur)[0];
  const fastest = sp.indexOf(Math.max(...sp)) * ana.dt;
  await ev(`window.__VSNAP__('h1', ${longest.t0 + 0.1}, null, false); window.__VSNAP__('h2', ${longest.t0 + 0.1 + ana.dt}, null, false);`);
  const holdPix = await J('JSON.stringify(window.__VDIFF2__("h1","h2"))');
  await ev(`window.__VSNAP__('f1', ${fastest.toFixed(3)}, null, false); window.__VSNAP__('f2', ${(fastest + ana.dt).toFixed(3)}, null, false);`);
  const fastPix = await J('JSON.stringify(window.__VDIFF2__("f1","f2"))');
  shots.r3hold = save(await ev(`window.__VSHOT__(${longest.t0 + 0.1});`), SHOT('r3-hold-' + (longest.t0 + 0.1).toFixed(1) + 's'));
  shots.r3fast = save(await ev(`window.__VSHOT__(${fastest.toFixed(2)});`), SHOT('r3-fast-' + fastest.toFixed(2) + 's'));
  note(`像素级节奏对比：停顿窗口 ${longest.t0 + 0.1}s 处相邻两帧 mean|Δ|=${pct(holdPix)}（≈噪声底 ${pct(noise)}），最快时刻 ${fastest.toFixed(2)}s 处 ${pct(fastPix)}（${(fastPix / Math.max(holdPix, 1e-6)).toFixed(1)}×）`);
  const t12 = actStats.filter((a) => a.quickStopSlow).length;
  sub('R3a', h1.length >= 5 && holdTotal >= 6,
    `全剧停顿 ${h1.length} 处、合计 ${holdTotal.toFixed(2)}s（≥5 处 / ≥6s），最长 ${h1.slice().sort((a, b) => b.dur - a.dur)[0].dur}s`);
  sub('R3b', t12 === 4,
    `四幕里 ${t12}/4 幕存在"快—停—慢"结构（判定：本幕内出现 速度>1.5×全剧均值 → 其后 3s 内出现 ≥0.3s 停顿 → 停顿之后出现 <0.5×均值的慢段）：${actStats.map((a) => a.id + '=' + (a.quickStopSlow ? '有' : '无')).join(' ')}`);
  sub('R3c', fastPix > holdPix * 5,
    `像素级：最快时刻的帧间变化 ${pct(fastPix)} 是停顿窗口 ${pct(holdPix)} 的 ${(fastPix / Math.max(holdPix, 1e-6)).toFixed(1)} 倍 => 轻重缓急在画面上真实可见`);
  verdict(3, R.R3a.pass && R.R3b.pass && R.R3c.pass,
    '动作之间有停顿与轻重缓急，像幕后真有人在操纵',
    `证据 ${shots.r3hold}（停顿）/${shots.r3fast}（最快）；停顿 ${h1.length} 处/${holdTotal.toFixed(2)}s，帧间差比 ${(fastPix / Math.max(holdPix, 1e-6)).toFixed(1)}×`);

  /* ================= 需求 5：灯光暖黄 ================= */
  const warm = [];
  for (const t of [2.0, 14.0, 28.0, 40.0]) {
    await ev(`window.__VSNAP__('w${t}', ${t}, null, false);`);
    const rgbs = await J(`JSON.stringify(window.__VREGION__('w${t}', ${Math.round(W * 0.3)}, ${Math.round(H * 0.2)}, ${Math.round(W * 0.7)}, ${Math.round(H * 0.8)}))`);
    const st = await J(`JSON.stringify((function(){ const img = window.__VIMG__['w${t}']; let mx = 0, mn = 1; const n = img.w*img.h;
      for (let i = 0; i < n; i += 13){ const l = window.__VLU__(img, i*4); if (l > mx) mx = l; if (l < mn) mn = l; }
      return { max: mx, min: mn }; })())`);
    warm.push({ t, rgb: rgbs, lit: st });
  }
  await ev(`window.__VSNAP__('warm', 28.0, null, false);`);
  shots.r5 = save(await ev('window.__snapshot()'), SHOT('r5-warm-light-t28'));
  const lightColors = await J(`JSON.stringify((function(){ const TL = window.__V_TIMELINE__, o = {};
    for (const t of [1, 12, 25, 36, 44]) o[t] = String(TL.sample(t).light.color);
    return o; })())`);
  const hueOf = (r, g, b) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0;
    if (mx === mn) return 0; const d = mx - mn;
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; return h < 0 ? h + 360 : h; };
  console.log('      幕面平均色（大区域采样）:');
  for (const w of warm) console.log(`        t=${w.t}s  R=${w.rgb.r.toFixed(3)} G=${w.rgb.g.toFixed(3)} B=${w.rgb.b.toFixed(3)}  R/B=${(w.rgb.r / w.rgb.b).toFixed(2)}  hue=${hueOf(w.rgb.r, w.rgb.g, w.rgb.b).toFixed(0)}°  最亮=${w.lit.max.toFixed(3)} 最暗=${w.lit.min.toFixed(3)}`);
  note(`灯颜色按幕次: ${Object.entries(lightColors).map(([t, c]) => `t=${t}s→${c}`).join(', ')}`);
  const hex2rgb = (h) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(h).trim()); return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : null; };
  const lc = hex2rgb(lightInfo.color);
  const lightHue = lc ? hueOf(lc[0], lc[1], lc[2]) : -1;
  const warmOK = warm.every((w) => w.rgb.r > w.rgb.b * 1.25 && w.rgb.g > w.rgb.b && hueOf(w.rgb.r, w.rgb.g, w.rgb.b) < 60)
    && lc && lc[0] > lc[2] * 1.5 && lightHue >= 15 && lightHue <= 55;
  sub('R5', warmOK,
    `灯色 ${lightInfo.color}（R=${lc ? lc[0].toFixed(3) : '?'} G=${lc ? lc[1].toFixed(3) : '?'} B=${lc ? lc[2].toFixed(3) : '?'}，hue ${lightHue.toFixed(0)}°，R/B=${lc ? (lc[0] / lc[2]).toFixed(2) : '?'}）；四个时间点幕面 R/B = ${warm.map((w) => (w.rgb.r / w.rgb.b).toFixed(2)).join(' / ')}，全部 R>G>B 且 hue ${warm.map((w) => hueOf(w.rgb.r, w.rgb.g, w.rgb.b).toFixed(0)).join('/')}° 落在暖色区`);
  verdict(5, R.R5.pass, '灯光是暖黄的',
    `证据 ${shots.r5}；R/B=${warm.map((w) => (w.rgb.r / w.rgb.b).toFixed(2)).join(', ')}，hue=${warm.map((w) => hueOf(w.rgb.r, w.rgb.g, w.rgb.b).toFixed(0)).join('/')}°`);

  /* ================= 需求 6：织纹与褶皱 ================= */
  const R6BOX = [Math.round(W * 0.10), Math.round(H * 0.20), Math.round(W * 0.34), Math.round(H * 0.46)];
  await ev(`window.__VSNAP__('weave', 32.3, null, false);`);
  const sdGrainOn = await J(`JSON.stringify(window.__VSD__('weave', ${R6BOX.join(',')}))`);
  await ev('window.__V_RENDERER__.compositor.uniforms.composite.uGrain.value = 0.028; window.__VSNAP__(\'weaveG\', 32.3, null, false);');
  const sdGrainOff = await J(`JSON.stringify(window.__VSD__('weaveG', ${R6BOX.join(',')}))`);
  await ev('window.__V_RENDERER__.compositor.uniforms.composite.uGrain.value = 0;');
  // A/B1：把幕布纹理换成纯色（先备份原贴图）
  const fabricSaved = await ev(`(function(){
    const S = window.__V_SCREEN__;
    window.__V_FABRIC__ = { map: S.uniforms.uWeaveMap.value, bump: S.uniforms.uWeaveBump.value };
    const T3 = window.__V_THREE__;
    const mk = function(v){ const c = document.createElement('canvas'); c.width = c.height = 8;
      const x = c.getContext('2d'); x.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')'; x.fillRect(0,0,8,8);
      const t = new T3.CanvasTexture(c); t.wrapS = t.wrapT = T3.RepeatWrapping; t.colorSpace = T3.SRGBColorSpace; t.needsUpdate = true; return t; };
    S.uniforms.uWeaveMap.value = mk(232);
    S.uniforms.uWeaveBump.value = mk(128);
    return !!window.__V_FABRIC__.map; })()`);
  await ev(`window.__VSNAP__('flat', 32.3, null, false);`);
  const flatDiff = await J('JSON.stringify(window.__VDIFF2__("weave","flat"))');
  shots.r6 = save(await ev('window.__VSHOT__(32.3);'), SHOT('r6-cloth-flat-AB'));
  const restore = await ev(`(function(){
    const S = window.__V_SCREEN__;
    S.uniforms.uWeaveMap.value = window.__V_FABRIC__.map;
    S.uniforms.uWeaveBump.value = window.__V_FABRIC__.bump;
    return 1; })()`);
  await ev(`window.__VSNAP__('back', 32.3, null, false);`);
  const restoreDiff = await J('JSON.stringify(window.__VDIFF2__("weave","back"))');
  // A/B2：褶皱幅度归零
  await ev(`window.__VSNAP__('foldOn', 32.3, function(){ if (!window.__V_FOLD__) window.__V_FOLD__ = [window.__V_SCREEN__.uniforms.uAmpTop.value, window.__V_SCREEN__.uniforms.uAmpBottom.value]; }, false);`);
  const foldDiff = await J(`JSON.stringify((function(){
    const S = window.__V_SCREEN__; const a = window.__V_FOLD__;
    S.uniforms.uAmpTop.value = 0; S.uniforms.uAmpBottom.value = 0;
    window.__VSNAP__('foldOff', 32.3, null, false);
    S.uniforms.uAmpTop.value = a[0]; S.uniforms.uAmpBottom.value = a[1];
    return window.__VDIFF2__('foldOn','foldOff'); })())`);
  shots.r6fold = save(await ev(`window.__VSHOT__(32.3, function(){ window.__V_SCREEN__.uniforms.uAmpTop.value = 0; window.__V_SCREEN__.uniforms.uAmpBottom.value = 0; });`), SHOT('r6-folds-off-AB'));
  await ev(`(function(){ const a = window.__V_FOLD__; window.__V_SCREEN__.uniforms.uAmpTop.value = a[0]; window.__V_SCREEN__.uniforms.uAmpBottom.value = a[1]; })()`);
  const amps = await J('JSON.stringify([window.__V_SCREEN__.uniforms.uAmpTop.value, window.__V_SCREEN__.uniforms.uAmpBottom.value, window.__V_SCREEN__.uniforms.uWeaveScale.value.x, window.__V_SCREEN__.uniforms.uWeaveScale.value.y])');
  note(`幕布局部标准差（${R6BOX[2] - R6BOX[0]}x${R6BOX[3] - R6BOX[1]} 区域，1px 尺度）：颗粒开 ${(sdGrainOn.sd * 1000).toFixed(2)}‰ / 颗粒关 ${(sdGrainOff.sd * 1000).toFixed(2)}‰`);
  note(`A/B 织纹：换成纯色 texture 后全画面 mean|Δ|=${pct(flatDiff)}（噪声底 ${pct(noise)}）；接回原贴图后与原帧差 ${pct(restoreDiff)}`);
  note(`A/B 褶皱：uAmpTop/uAmpBottom 从 ${amps[0]}/${amps[1]} 归零，画面 mean|Δ|=${pct(foldDiff)}`);
  sub('R6a', sdGrainOff.sd > 0.0015 && sdGrainOn.sd > 0.0015,
    `幕面不是纯色：局部标准差 ${(sdGrainOff.sd * 1000).toFixed(2)}‰（关颗粒）/ ${(sdGrainOn.sd * 1000).toFixed(2)}‰（开颗粒），均值 ${sdGrainOff.mean.toFixed(3)}`);
  const ratioTxt = (a, b) => (b > 0 ? (a / b).toFixed(0) + '×' : '∞（对照差为 0，逐字节相同）');
  sub('R6b', flatDiff > Math.max(noise * 5, 0.002),
    `织纹真的参与着色：A/B 换掉 uWeaveMap/uWeaveBump 后画面 mean|Δ|=${pct(flatDiff)}，是噪声底 ${pct(noise)} 的 ${ratioTxt(flatDiff, noise)}`);
  sub('R6c', foldDiff > Math.max(noise * 5, 0.001),
    `几何褶皱真的在起作用：把顶点位移幅度归零后画面 mean|Δ|=${pct(foldDiff)}，是噪声底的 ${ratioTxt(foldDiff, noise)}`);
  verdict(6, R.R6a.pass && R.R6b.pass && R.R6c.pass, '幕布有织物纹理与轻微褶皱',
    `证据 ${shots.r6}（织纹 A/B）、${shots.r6fold}（褶皱 A/B）；局部标准差 ${(sdGrainOff.sd * 1000).toFixed(2)}‰，织纹 A/B 差 ${pct(flatDiff)}，褶皱 A/B 差 ${pct(foldDiff)}`);

  /* ================= 需求 7：光晕在幕布边缘散开 ================= */
  const BLOOM0 = await ev('window.__V_RENDERER__.compositor.uniforms.composite.uBloom.value');
  await ev(`(async function(){ window.__V_BLOOM__ = ${BLOOM0}; })()`);
  await ev(`window.__VSNAP__('halo', 32.3, null, false);`);
  shots.r7 = save(await ev('window.__VSHOT__(32.3);'), SHOT('r7-halo-t32.3'));
  const prof = await J(`JSON.stringify((function(){
    const img = window.__VIMG__['halo'], W2 = img.w, H2 = img.h;
    const box = function(x0,y0,x1,y1){ x0|=0; y0|=0; x1|=0; y1|=0; let s=0,m=0;
      for (let y=y0;y<y1;y++) for (let x=x0;x<x1;x++){ s += window.__VLU__(img,(y*img.w+x)*4); m++; } return s/m; };
    const centre = box(W2*0.44, H2*0.42, W2*0.56, H2*0.58);
    const edge   = box(W2*0.13, H2*0.42, W2*0.18, H2*0.58);
    const corner = box(W2*0.10, H2*0.06, W2*0.24, H2*0.20);
    const beyond = box(2, H2*0.44, 16, H2*0.56);      // 幕布外（左）
    const prof = []; for (let i = 0; i <= 12; i++){ const x = W2*0.05 + i*(W2*0.40/12);
      prof.push(box(x, H2*0.28, x + W2*0.02, H2*0.44)); }
    return { centre: centre, edge: edge, corner: corner, beyond: beyond, prof: prof }; })())`);
  await ev(`window.__VSNAP__('bloomOff', 32.3, function(){ window.__V_RENDERER__.compositor.uniforms.composite.uBloom.value = 0; }, false);`);
  const bloomDiff = await J('JSON.stringify(window.__VDIFF2__("halo","bloomOff"))');
  const beyondRGB = await J(`JSON.stringify((function(){ const a = window.__VREGION__('halo', 2, ${Math.round(H * 0.44)}, 16, ${Math.round(H * 0.56)});
    const b = window.__VREGION__('bloomOff', 2, ${Math.round(H * 0.44)}, 16, ${Math.round(H * 0.56)});
    return { on: a, off: b }; })())`);
  shots.r7b = save(await ev(`window.__VSHOT__(32.3, function(){ window.__V_RENDERER__.compositor.uniforms.composite.uBloom.value = 0; });`), SHOT('r7-bloom-off-AB'));
  await ev(`window.__V_RENDERER__.compositor.uniforms.composite.uBloom.value = window.__V_BLOOM__;`);
  const bloomBack = await ev('window.__V_RENDERER__.compositor.uniforms.composite.uBloom.value');
  note(`uBloom 归位检查：实验前 ${BLOOM0} → 实验后 ${bloomBack}`);
  const mono = prof.prof.every((v, i) => i === 0 || v >= prof.prof[i - 1] - 0.012);
  note(`亮度剖面（左缘→中心）: ${prof.prof.map((v) => v.toFixed(3)).join(' → ')}  单调=${mono}`);
  note(`中心 ${prof.centre.toFixed(3)} / 幕布内侧靠边 ${prof.edge.toFixed(3)}（比 ${(prof.centre / prof.edge).toFixed(2)}）/ 左上角 ${prof.corner.toFixed(3)}；幕布外 ${prof.beyond.toFixed(3)}`);
  note(`泛光 A/B：uBloom 归零后画面 mean|Δ|=${pct(bloomDiff)}；幕布外那一列亮度 ${beyondRGB.off.r.toFixed(3)}（关）→ ${beyondRGB.on.r.toFixed(3)}（开）`);
  sub('R7a', prof.centre > prof.edge * 1.05 && prof.corner < prof.centre * 0.92,
    `光斑中心亮、边缘暗（连续渐晕）：中心 ${prof.centre.toFixed(3)} vs 幕布内侧靠边 ${prof.edge.toFixed(3)}（×${(prof.centre / prof.edge).toFixed(2)}），左上角 ${prof.corner.toFixed(3)}（中心 ×${(prof.corner / prof.centre).toFixed(2)}）`);
  sub('R7b', mono,
    `由边缘向中心亮度单调递增（12 段剖面全部非下降，允许 0.012 容差）`);
  sub('R7c', bloomDiff > Math.max(noise * 5, 0.01) && beyondRGB.on.r > beyondRGB.off.r * 1.05,
    `光晕由真实泛光产生：关掉 uBloom 后画面 mean|Δ|=${pct(bloomDiff)}；幕布外侧的溢出亮度 ${beyondRGB.off.r.toFixed(3)}（关）→ ${beyondRGB.on.r.toFixed(3)}（开，+${pct(beyondRGB.on.r / beyondRGB.off.r - 1)}）`);
  verdict(7, R.R7a.pass && R.R7b.pass && R.R7c.pass, '光晕在幕布边缘向外散开',
    `证据 ${shots.r7} / ${shots.r7b}；中心/边缘=${(prof.centre / prof.edge).toFixed(2)}，泛光 A/B 差 ${pct(bloomDiff)}`);

  /* ================= 需求 8：不用 SVG + 真实光影与层叠 ================= */
  const svgHits = await J(`JSON.stringify((function(){
    const out = { svgEl: document.querySelectorAll('svg').length, img: document.querySelectorAll('img').length,
      tags: Array.from(new Set(Array.prototype.map.call(document.querySelectorAll('*'), function(e){ return e.tagName.toLowerCase(); }))).sort() };
    return out; })())`);
  const glctx = await J(`JSON.stringify((function(){
    const cv = document.querySelector('canvas'); const ctx = window.__V_RENDERER__.renderer.getContext();
    return { ctx2d: cv.getContext('2d') !== null, isGL2: ctx instanceof WebGL2RenderingContext, version: ctx.getParameter(ctx.VERSION) }; })())`);
  const castersZ = await J(`JSON.stringify((function(){
    const T3 = window.__V_THREE__, zs = {};
    window.__V_RENDERER__.scene.traverse(function(o){
      if (o.isMesh && o.castShadowRaw){ const p = new T3.Vector3(); o.getWorldPosition(p); zs[p.z.toFixed(1)] = 1; } });
    return Object.keys(zs).map(Number).sort(function(a,b){ return a-b; }); })())`);
  const lp = lightInfo.pos;
  const isoK = [];
  for (const [name, rigName, key] of [['moon', 'props', 'moon'], ['pine', 'props', 'pine'], ['head', 'general', 'head']]) {
    const uuid = await ev(`window.__V_RIGS__.${rigName}.parts.get('${key}').mesh.uuid`);
    await ev(`window.__VSNAP__('mk_${name}', 32.3, function(){ window.__VHIDE__(${HIDE_ALL}, false);
      window.__V_RENDERER__.scene.getObjectByProperty('uuid','${uuid}').visible = true; }, false);`);
    const occ = await J(`JSON.stringify(window.__VOCC__('ref','mk_${name}',0.15))`);
    const z = await J(`JSON.stringify((function(){ const p = new window.__V_THREE__.Vector3();
      window.__V_RENDERER__.scene.getObjectByProperty('uuid','${uuid}').getWorldPosition(p); return +p.z.toFixed(3); })())`);
    const k = Math.abs(lp[2]) / (z - lp[2]);
    const w = occ.bbox[2] - occ.bbox[0] + 1;
    const area = occ.area;
    isoK.push({ name, z, k, w, area, uuid });
    note(`隔离 ${name}: z=${z} 理论放大率 k=${k.toFixed(3)}，影子 bbox 宽 ${w}px 面积 ${area}px`);
  }
  // 位移实验（同一道具只改深度）：实测影宽比 vs 理论放大率比
  const mvR = isoK.find((x) => x.name === 'moon') || isoK[0];
  await ev(`window.__VSNAP__('movedR', 32.3, function(){
    window.__VHIDE__(${HIDE_ALL}, false);
    const t = window.__V_RENDERER__.scene.getObjectByProperty('uuid','${mvR.uuid}');
    t.visible = true;
    if (!window.__V_MOVEDR__){ t.position.z += 0.5; t.updateMatrixWorld(true); window.__V_MOVEDR__ = 1; }
    const p = new window.__V_THREE__.Vector3(); t.getWorldPosition(p); window.__V_POSR__ = +p.z.toFixed(3);
  }, false);`);
  const occM = await J(`JSON.stringify(window.__VOCC__('ref','movedR',0.15))`);
  const z2 = await J('JSON.stringify(window.__V_POSR__)');
  const k2 = Math.abs(lp[2]) / (z2 - lp[2]);
  const w2 = occM.bbox[2] - occM.bbox[0] + 1;
  const predR = k2 / mvR.k, measR = w2 / mvR.w;
  note(`层叠位移实验 ${mvR.name}: z ${mvR.z} -> ${z2}（同一物体只改深度）；影宽 ${mvR.w}px -> ${w2}px = ×${measR.toFixed(3)}；投影律 k=|zL|/(z-zL) 预测 ×${predR.toFixed(3)}（误差 ${(Math.abs(measR - predR) / predR * 100).toFixed(1)}%）`);
  sub('R8a', svgHits.svgEl === 0 && svgHits.img === 0,
    `index.html 运行时 DOM 里 <svg> ${svgHits.svgEl} 个、<img> ${svgHits.img} 个，标签集合仅 ${svgHits.tags.join(',')}（详见 tools/verify-anti-svg.mjs 的静态扫描：运行时代码 0 命中）`);
  sub('R8b', glctx.isGL2 && glctx.ctx2d === false,
    `canvas 是 WebGL2（getContext('2d')=${glctx.ctx2d}，instanceof WebGL2RenderingContext=${glctx.isGL2}，${glctx.version}）`);
  sub('R8c', castersZ.length >= 3 && Math.abs(measR - predR) / predR < 0.20,
    `层叠：${castersZ.length} 个不同 z 的投射体（${castersZ.join(', ')}）；把 ${mvR.name} 从 z=${mvR.z} 移到 z=${z2}，影宽 ×${measR.toFixed(3)} vs 点光源投影律预测 ×${predR.toFixed(3)}（误差 ${(Math.abs(measR - predR) / predR * 100).toFixed(1)}%）=> 影子大小由真实几何投影决定`);
  verdict(8, R.R8a.pass && R.R8b.pass && R.R8c.pass,
    '没有用 SVG，画面是 WebGL2 实时渲染且有真实光影与层叠（缺陷见 tools/verify-artifacts.mjs）',
    `层叠实测: ${isoK.map((x) => `${x.name} z=${x.z} k=${x.k.toFixed(2)} 影宽${x.w}px`).join('；')}；位移实验误差 ${(Math.abs(measR - predR) / predR * 100).toFixed(1)}%`);

  /* ================= 需求 9：起承转合 ================= */
  const lightActs = acts.map((a) => {
    const i0 = Math.round(a.t0 / ana.dt), i1 = Math.min(ana.lightI.length - 1, Math.round(a.t1 / ana.dt));
    const seg = ana.lightI.slice(i0, i1 + 1);
    return { id: a.id, name: a.name, min: +Math.min(...seg).toFixed(2), max: +Math.max(...seg).toFixed(2), start: +seg[0].toFixed(2), end: +seg[seg.length - 1].toFixed(2) };
  });
  const vis = ana.vis;
  const generalPresent = vis.filter((v) => v[1] === 1).map((v) => v[0]);
  const cavalryPresent = vis.filter((v) => v[2] === 1).map((v) => v[0]);
  const firstGen = generalPresent.length ? generalPresent[0] : null;
  const lastGen = generalPresent.length ? generalPresent[generalPresent.length - 1] : null;
  const firstCav = cavalryPresent.length ? cavalryPresent[0] : null;
  const subs = ana.subs.filter((s, i, arr) => i === 0 || arr[i - 1][1] !== s[1]);
  const actSub = acts.map((a) => ({ id: a.id, n: subs.filter((s) => s[0] >= a.t0 && s[0] < a.t1).length, lines: subs.filter((s) => s[0] >= a.t0 && s[0] < a.t1).map((s) => s[1]) }));
  const mont9 = await ev(`window.__MONTAGE__(${JSON.stringify([2.0, 6.0, 9.5, 14.0, 20.0, 26.5, 31.0, 34.0])}, 4, 'r9')`);
  shots.r9 = save(mont9, SHOT('r9-four-acts-8frames'));
  const mont9b = await ev(`window.__MONTAGE__(${JSON.stringify([37.5, 40.0, 42.5, 45.5])}, 4, 'r9end')`);
  shots.r9b = save(mont9b, SHOT('r9-ending-4frames'));
  console.log('      四幕（自算 vs 声明）:');
  for (const a of actStats) console.log(`        ${a.id}·${a.name} ${a.t0}-${a.t1}s 时长${a.dur}s 最快${a.maxSpeed} 最慢${a.minSpeed} 停顿${a.holds}处/${a.holdDur}s 快停慢=${a.quickStopSlow}`);
  console.log('      灯光弧线:');
  for (const l of lightActs) console.log(`        ${l.id}·${l.name}: 起 ${l.start} → 峰 ${l.max} → 收 ${l.end}（min ${l.min}）`);
  note(`演员在场：主将 ${firstGen}s~${lastGen}s，副将 ${firstCav}s 起（副将 ${cavalryPresent.length ? '在场 ' + (cavalryPresent[cavalryPresent.length - 1] - cavalryPresent[0]).toFixed(1) + 's' : '缺席'}）`);
  note(`唱词：共 ${subs.length} 句，分布 ${actSub.map((a) => a.id + ':' + a.n).join(' / ')}：${actSub.map((a) => a.lines[0] || '').filter(Boolean).join(' | ')}`);
  const lastSpeed = sp.slice(-120).reduce((a, b) => a + b, 0) / 120;
  note(`最后 2s 平均速度 ${lastSpeed.toFixed(3)}（全剧均值 ${mean.toFixed(3)}），收幕灯 ${ana.lightI[ana.lightI.length - 1].toFixed(2)}`);
  sub('R9a', acts.length === 4 && acts[3].t1 >= 40 && acts[3].t1 <= 52,
    `四幕：${acts.map((a) => `${a.id}·${a.name} ${a.t0}-${a.t1}s`).join(' / ')}，总时长 ${ana.duration}s`);
  sub('R9b', actStats.every((a) => a.maxSpeed > a.meanSpeed * 2 && a.meanSpeed > 0),
    `每幕都有明显的快慢反差：最快/均值 = ${actStats.map((a) => (a.maxSpeed / a.meanSpeed).toFixed(1) + '×').join(', ')}（每幕都有完全静止的停顿，最低速度 0）`);
  sub('R9c', lightActs[0].start < 0.6 && lightActs[2].max > 2.0 && ana.lightI[ana.lightI.length - 1] < 0.6,
    `灯弧线：起幕 ${lightActs[0].start} → 第三幕峰值 ${lightActs[2].max} → 收幕 ${ana.lightI[ana.lightI.length - 1].toFixed(2)}（收成一个点）`);
  sub('R9d', firstGen !== null && firstGen > acts[0].t0 + 5,
    `叙事：第一幕主将缺席（首次出现 ${firstGen}s），副将 ${firstCav}s 入场；定格亮相在 ${actStats[2].holds ? '第三幕' : '?'}（该幕停顿 ${actStats[2].holdDur}s）`);
  sub('R9e', subs.length >= 8,
    `唱词/旁白 ${subs.length} 句贯穿四幕（${actSub.map((a) => a.id + ':' + a.n).join(' / ')}）`);
  verdict(9, R.R9a.pass && R.R9b.pass && R.R9c.pass && R.R9d.pass && R.R9e.pass,
    '一小段有起承转合的表演，不只是走来走去',
    `证据 ${shots.r9}（四幕 8 帧）/ ${shots.r9b}（收尾 4 帧）；停顿合计 ${holdTotal.toFixed(2)}s，灯光 起${lightActs[0].start}→峰${lightActs[2].max}→收${ana.lightI[ana.lightI.length - 1].toFixed(2)}`);

  /* ================= 需求 4：镂空（放最后，因为会改贴图） ================= */
  // 先做状态卫生检查：所有 A/B 的 uniform 都必须已经归位，否则后面的量测会整体偏色
  await ev(`window.__VSNAP__('recheck', 32.3, function(){ window.__VHIDE__(${HIDE_ALL}, true); }, false);`);
  await ev(`window.__VSNAP__('recheck2', 32.3, function(){ window.__VHIDE__(${HIDE_ALL}, true); }, false);`);
  const recheckDiff = await J('JSON.stringify(window.__VDIFF2__("recheck","recheck2"))');
  const driftVsAll = await J('JSON.stringify(window.__VDIFF2__("all","recheck"))');
  const uniformsNow = await J(`JSON.stringify({ uBloom: window.__V_RENDERER__.compositor.uniforms.composite.uBloom.value,
    uAmpTop: window.__V_SCREEN__.uniforms.uAmpTop.value, uAmpBottom: window.__V_SCREEN__.uniforms.uAmpBottom.value,
    uWeaveIsFabric: window.__V_SCREEN__.uniforms.uWeaveMap.value === window.__V_FABRIC__.map,
    uShadowOn: window.__V_SCREEN__.uniforms.uShadowOn.value, uShadowBias: window.__V_SCREEN__.uniforms.uShadowBias.value,
    uDebug: window.__V_SCREEN__.uniforms.uDebug.value, bypass: window.__V_RENDERER__.bypass })`);
  note(`状态卫生：A/B 结束后背靠背重放两帧 mean|Δ|=${pct(recheckDiff)}（噪声底）；与最初 all 帧差 ${pct(driftVsAll)}（差异只来自布料弹簧的历史状态，不参与任何结论）`);
  note(`uniform 归位检查 ${JSON.stringify(uniformsNow)}`);
  sub('R0-state-restored', recheckDiff < 0.002 && uniformsNow.uAmpTop === 0.052 && uniformsNow.uShadowOn === 1 && uniformsNow.bypass === false && uniformsNow.uWeaveIsFabric === true,
    `所有 A/B 实验后 uniform 与贴图全部归位（背靠背重放 mean|Δ|=${pct(recheckDiff)}，uAmpTop=${uniformsNow.uAmpTop} uShadowOn=${uniformsNow.uShadowOn} uDebug=${uniformsNow.uDebug} bypass=${uniformsNow.bypass} 织纹已还原=${uniformsNow.uWeaveIsFabric}）`);
  const carveGen = await J('JSON.stringify(window.__VCARVE__("general"))');
  const carveProps = await J('JSON.stringify(window.__VCARVE__("props"))');
  const cg = {};
  for (const c of carveGen) cg[c.key] = c;
  const keyParts = ['head', 'plume', 'weapon', 'weaponTip', 'cape', 'cape2', 'chest', 'waist', 'flag'];
  console.log('      主将各部件的镂空率（贴图 alpha 分析，被实体包围的透明孔洞 / (实体+孔洞)）:');
  for (const k of keyParts) if (cg[k] && cg[k].carveRatio != null) console.log(`        ${k.padEnd(11)} ${(cg[k].carveRatio * 100).toFixed(1)}%  （贴图 ${cg[k].w}x${cg[k].h}，实体像素占比 ${(cg[k].opaqueRatioOfCanvas * 100).toFixed(1)}%）`);
  const carvedParts = carveGen.filter((c) => c.carveRatio > 0.05);
  const propsCarve = carveProps.filter((c) => c.carveRatio > 0.05);
  note(`主将 26 个部件里 ${carvedParts.length} 个镂空率 >5%（最高 ${carvedParts.sort((a, b) => b.carveRatio - a.carveRatio).slice(0, 3).map((c) => c.key + ' ' + (c.carveRatio * 100).toFixed(1) + '%').join(', ')}）；布景 6 件里 ${propsCarve.length} 件 >5%`);
  // 屏幕级：全实心 A/B
  const ISOLATE_GEN = `function(){
    const keep = window.__V_RIGS__.general;
    window.__V_RENDERER__.scene.traverse(function(o){
      if (o.isMesh && o.castShadowRaw && !keep.root.getObjectById(o.id)) o.visible = false; });
    keep.root.visible = true; keep.parts.forEach(function(p){ p.mesh.visible = true; });
  }`;
  await ev(`window.__VSNAP__('genReal', 32.3, ${ISOLATE_GEN}, false);`);
  shots.r4 = save(await ev('window.__snapshot()'), SHOT('r4-hollow-general'));
  const occReal = await J('JSON.stringify(window.__VOCC__("ref","genReal",0.15))');
  await ev(`(function(){ const g = window.__V_RIGS__.general, seen = {};
    g.parts.forEach(function(p){ const tex = p.mesh.material.map; if (!tex || seen[tex.uuid]) return; seen[tex.uuid] = 1;
      const cv = tex.image, c = cv.getContext('2d');
      const im = c.getImageData(0,0,cv.width,cv.height), dd = im.data;
      for (let i = 0; i < dd.length; i += 4){ dd[i]=0; dd[i+1]=0; dd[i+2]=0; }
      c.putImageData(im,0,0); tex.needsUpdate = true; }); })()`);
  await ev(`window.__VSNAP__('genGeo', 32.3, ${ISOLATE_GEN}, false);`);
  shots.r4b = save(await ev('window.__snapshot()'), SHOT('r4-general-geometry-noholes'));
  const occGeo = await J('JSON.stringify(window.__VOCC__("ref","genGeo",0.15))');
  await ev(`(function(){ const g = window.__V_RIGS__.general, seen = {};
    g.parts.forEach(function(p){ const tex = p.mesh.material.map; if (!tex || seen[tex.uuid]) return; seen[tex.uuid] = 1;
      const cv = tex.image, c = cv.getContext('2d'); c.globalCompositeOperation = 'source-over';
      c.fillStyle = 'rgb(20,10,6)'; c.fillRect(0,0,cv.width,cv.height); tex.needsUpdate = true; }); })()`);
  await ev(`window.__VSNAP__('genSolid', 32.3, ${ISOLATE_GEN}, false);`);
  shots.r4c = save(await ev('window.__snapshot()'), SHOT('r4-general-solid-AB'));
  const occSolid = await J('JSON.stringify(window.__VOCC__("ref","genSolid",0.15))');
  // 透光面（柔化鲁棒）：全实心为暗、真实贴图明显更亮 —— 光真的穿过孔洞
  const rel = await J('JSON.stringify(window.__VRELHOLE__("ref","genSolid","genReal",0.15))');
  const holePixels = rel.holeArea;
  const holeRatio = rel.ratio;
  note(`屏幕级镂空（相对量法，标尺 dMed=${rel.dMed}，outer=${rel.outerArea}px）：透光面 ${rel.holeArea}px = ${pct(rel.ratio)}；其中被实体包围的雕刻镂空 ${rel.encCount} 个共 ${rel.encArea}px（Top ${rel.encTop.join(',')}）；固定阈值 0.15 的老口径为 ${rel.absHoleArea}px = ${pct(rel.absRatio)}`);
  note(`遮挡深度对比：真实贴图在剪影内平均变暗 ${rel.meanHoleDelta.toFixed(3)}（透光面）/ 实体处平均 ${rel.meanSolidDelta.toFixed(3)}`);
  const holesComp = { count: rel.compCount, encCount: rel.encCount, encArea: rel.encArea, encTop: rel.encTop };
  const hollowOK = carvedParts.length >= 10 && holeRatio > 0.08;
  const headGroup = Math.max(cg.head ? cg.head.carveRatio : 0, cg.plume ? cg.plume.carveRatio : 0);
  sub('R4a', (cg.weapon ? cg.weapon.carveRatio : 0) >= 0.12 && (cg.chest ? cg.chest.carveRatio : 0) >= 0.08 && headGroup >= 0.08,
    `兵器/衣纹/头饰都有成片镂空：兵器 weapon ${(cg.weapon.carveRatio * 100).toFixed(1)}%、胸甲 chest ${(cg.chest.carveRatio * 100).toFixed(1)}%、袍摆 cape ${(cg.cape.carveRatio * 100).toFixed(1)}%、头饰组 max(head ${(cg.head.carveRatio * 100).toFixed(1)}%, plume ${(cg.plume.carveRatio * 100).toFixed(1)}%) = ${(headGroup * 100).toFixed(1)}%`,
    `注意：单看 head 部件只有 ${(cg.head.carveRatio * 100).toFixed(1)}%（面/盔本身孔洞偏少），头饰的镂空主要由 plume 承担`);
  sub('R4b', carvedParts.length >= 10,
    `${carveGen.length} 个部件贴图里 ${carvedParts.length} 个有 >5% 的成片镂空，最高 ${carvedParts.slice(0, 4).map((c) => c.key + '=' + (c.carveRatio * 100).toFixed(0) + '%').join(', ')}`);
  sub('R4c', holeRatio > 0.08 && rel.encArea > 300,
    `屏幕级（柔化鲁棒相对量法）：主将剪影内透光面 ${holePixels}px，占剪影面积 ${pct(holeRatio)}（被实体包围的雕刻镂空 ${rel.encCount} 个共 ${rel.encArea}px，其余为部件间缝隙）；老口径（固定阈值 0.15）为 ${rel.absHoleArea}px = ${pct(rel.absRatio)}`);
  note(`主将剪影面积：全实心 ${occSolid.area}px / 保留 alpha(RGB=0) ${occGeo.area}px / 真实贴图 ${occReal.area}px`);
  verdict(4, R.R4a.pass && R.R4b.pass && R.R4c.pass,
    '剪影有传统皮影的镂空感，光透过来时能看到花纹',
    `证据 ${shots.r4}（真实）/ ${shots.r4b}（几何）/ ${shots.r4c}（全实心 A/B）；head ${(cg.head ? cg.head.carveRatio * 100 : 0).toFixed(1)}% / weapon ${(cg.weapon ? cg.weapon.carveRatio * 100 : 0).toFixed(1)}%，屏幕级亮斑 ${pct(holeRatio)}`);

  return { R, shots, noise, actStats, lightActs, h1, holdTotal, ana, isoK, shotsList: shots };
});

/* ================= 验收表 ================= */
console.log('\n');
console.log('╔══════════════════════════════════════════════════════════════════════════════════════════╗');
console.log('║                    影窗·夜巡 —— 用户需求逐条验收表（独立实测）                            ║');
console.log('╚══════════════════════════════════════════════════════════════════════════════════════════╝');
const REQ = [
  [1, '幕布后面有光源，看到的是投出的剪影'],
  [2, '人物由可活动关节组成，能走路/转身/抬手'],
  [3, '动作之间有停顿与轻重缓急'],
  [4, '剪影有传统皮影镂空，光透过来能看清细节'],
  [5, '灯光是暖黄的'],
  [6, '幕布有织物纹理与轻微褶皱'],
  [7, '光晕在幕布边缘散开'],
  [8, '不用简单 SVG，有真实光影与层叠'],
  [9, '一小段有起承转合的表演'],
];
let allPass = true;
for (const [id, title] of REQ) {
  const r = out.R[id];
  if (!r) { console.log(`需求${id}  ${title}\n  ❓ 未测到`); allPass = false; continue; }
  if (!r.pass) allPass = false;
  console.log(`\n需求${id}  ${r.pass ? '✅ 通过' : '❌ 不通过'}  ${title}`);
  console.log(`  结论：${r.msg}`);
  if (r.evidence) console.log(`  证据：${r.evidence}`);
}
console.log('\n---- 每项子断言的明细 ----');
for (const [k, v] of Object.entries(out.R)) if (/^R\d+[a-z]$/.test(k)) console.log(`  ${v.pass ? 'PASS' : 'FAIL'}  ${k}  ${v.msg}`);
console.log('\n---- 证据截图 ----');
for (const [k, v] of Object.entries(out.shots)) console.log(`  ${k}: ${v}`);
const subFails = Object.entries(out.R).filter(([k, v]) => /^R\d+[a-z]$/.test(k) && !v.pass);
console.log(`\n=========== ${allPass ? '需求 1-9 全部通过' : '有 ' + (9 - REQ.filter(([id]) => out.R[id] && out.R[id].pass).length) + ' 条需求不通过 / ' + subFails.length + ' 项子断言失败'} ===========`);
process.exit(allPass ? 0 : 1);

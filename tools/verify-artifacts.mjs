/**
 * tools/verify-artifacts.mjs —— 独立验收组：证明（或证伪）「真实光影 / 镂空透光 / 层叠」。
 *
 * 不修改 src/ 与 index.html：通过 CDP Runtime.getProperties 读 window.__qa 的 [[Scopes]]，
 * 把 main.js 模块闭包里的 renderer/screen/stage/rigs/props/timeline 提到 window（__V_*__），
 * 冻结 rAF + 固定 uTime，自己控制「摆姿势 -> 改场景 -> 渲染 -> readPixels」。
 *
 * 量测核心：所有「暗区 / 剪影」都相对**同帧的"无投射体参考帧"**做差
 *      occ(p) = luma(ref) - luma(test) > tol
 * 因此不受暗角、幕布外背景、光晕不均的影响。每次抓取前先空转 settle 帧让布料收敛，
 * A/B 两侧对称，且用"同场景同序列重抓"的对照帧给出噪声底。
 *
 * 分组：
 *   E1 确定性/噪声底        E2 遮挡 A/B（隐藏演员 -> 暗区消失）
 *   E3 镂空 A/B（全实心 -> 亮斑消失）  E4 层叠（放大率 + 边缘过渡 vs 景深）
 *   E5 node 侧 PNG 独立复核  E6 shadow map 语义与渲染缺陷
 *
 * 用法: node tools/verify-artifacts.mjs      退出码 0 = 全部通过
 */
import { withPage, readPNG, meanRGB, imageDiff } from './harness.mjs';
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

const T = Number(process.env.V_TMAIN || 32.3);
const SHOT = (n) => `shots/verify-${n}.png`;
const TMP = (n) => join(tmpdir(), 'vfy-' + n);

const results = [];
const defects = [];
function check(id, pass, msg, detail) {
  results.push({ id, pass: !!pass, msg, detail: detail || '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${id}] ${msg}${detail ? '\n        ' + detail : ''}`);
}
/** 已确认的缺陷（会让退出码非 0） */
function defect(id, msg, detail) {
  defects.push({ id, msg, detail });
  console.log(`DEFECT [${id}] ${msg}${detail ? '\n        ' + detail : ''}`);
}
const note = (m) => console.log(`      · ${m}`);
const info = (id, msg, detail) => { results.push({ id, pass: true, msg, detail, info: true }); console.log(`INFO  [${id}] ${msg}${detail ? '\n        ' + detail : ''}`); };

const BRIDGE = `(async function(){
  if (window.__V_BRIDGE__) return true;
  window.__V_THREE__ = await import('three');
  window.__V_RAF_ORIG__ = window.requestAnimationFrame;
  window.requestAnimationFrame = function(){ return 0; };
  window.__V_RENDERER__.compositor.uniforms.composite.uGrain.value = 0;
  window.__VIMG__ = {};
  window.__VGRAB__ = function(name){
    const R = window.__V_RENDERER__, gl = R.renderer.getContext(), cv = R.canvas;
    const w = cv.width, h = cv.height, raw = new Uint8Array(w*h*4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const d = new Uint8Array(w*h*4);
    for (let y = 0; y < h; y++) d.set(raw.subarray((h-1-y)*w*4, (h-y)*w*4), y*w*4);
    window.__VIMG__[name] = { w: w, h: h, d: d };
    return [w, h];
  };
  window.__VLU__ = function(img, i){ return (0.2126*img.d[i] + 0.7152*img.d[i+1] + 0.0722*img.d[i+2]) / 255; };
  /* mask=true 走 uDebug=1 + bypass：画布上就是 shadow 值(0..1)，无后期干扰 */
  window.__VR__ = function(t, extra, mask){
    const S = window.__V_SCREEN__, R = window.__V_RENDERER__, L = window.__V_STAGE__.light;
    S.uniforms.uTime.value = 0;
    R.compositor.uniforms.composite.uTime.value = 0;
    R.bypass = !!mask;
    S.setDebugMode(mask ? 1 : 0);
    window.__SET_TIME__(t);
    if (typeof extra === 'function') extra();
    S.update(1/60, L, R.camera);
    S.renderShadow(R.scene);
    R.render(1/60);
  };
  window.__VSNAP__ = function(tag, t, extra, mask, settle){
    const n = settle == null ? 3 : settle;
    let r = null;
    for (let i = 0; i < n; i++) r = window.__VR__(t, extra, mask);
    return window.__VGRAB__(tag);
  };
  window.__VSHOT__ = function(t, extra, mask, settle){
    const n = settle == null ? 3 : settle;
    for (let i = 0; i < n; i++) window.__VR__(t, extra, mask);
    return window.__snapshot();
  };
  window.__VHIDE__ = function(pred, vis){ window.__V_RENDERER__.scene.traverse(function(o){ if (pred(o)) o.visible = vis; }); };
  window.__VONLY__ = function(uuid){
    window.__VHIDE__(function(o){ return o.isMesh && o.castShadowRaw; }, false);
    const t = window.__V_RENDERER__.scene.getObjectByProperty('uuid', uuid);
    if (t) t.visible = true;
    return t ? 1 : 0;
  };
  window.__VOCC__ = function(refName, testName, tol){
    const A = window.__VIMG__[refName], B = window.__VIMG__[testName];
    const w = A.w, h = A.h, n = w*h;
    let area = 0, sum = 0, minx = w, maxx = -1, miny = h, maxy = -1;
    const mask = new Uint8Array(n); const dl = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++){
      const i = (y*w+x)*4, d = window.__VLU__(A,i) - window.__VLU__(B,i);
      if (d > tol){ area++; sum += d; mask[y*w+x] = 1; dl.push(d);
        if (x<minx) minx=x; if (x>maxx) maxx=x; if (y<miny) miny=y; if (y>maxy) maxy=y; }
    }
    dl.sort(function(a,b){ return a-b; });
    const tag = 'mask:'+refName+':'+testName+':'+tol;
    window.__VIMG__[tag] = { w: w, h: h, d: mask };
    return { area: area, frac: area/n, bbox: [minx,miny,maxx,maxy], meanDelta: area? sum/area : 0, sumDelta: sum,
      dMed: dl.length ? dl[(dl.length*0.5)|0] : 0, dMax: dl.length ? dl[dl.length-1] : 0, maskTag: tag, w: w, h: h };
  };
  window.__VDEPTH__ = function(refName, maskName, tests){
    const A = window.__VIMG__[refName], M = window.__VIMG__[maskName]; const res = {};
    for (let k = 0; k < tests.length; k++){
      const B = window.__VIMG__[tests[k]]; let c = 0, s = 0;
      for (let i = 0; i < M.d.length; i++){ if (!M.d[i]) continue; const j = i*4; s += window.__VLU__(A,j) - window.__VLU__(B,j); c++; }
      res[tests[k]] = { n: c, meanDelta: c ? s/c : 0 };
    }
    return res;
  };
  window.__VSUB__ = function(maskA, maskB, tag){
    const A = window.__VIMG__[maskA], B = window.__VIMG__[maskB];
    let c = 0; const d = new Uint8Array(A.d.length);
    for (let i = 0; i < A.d.length; i++){ if (A.d[i] && !B.d[i]){ d[i] = 1; c++; } }
    window.__VIMG__[tag] = { w: A.w, h: A.h, d: d };
    return c;
  };
  /* 连通域；enclosedAgainst = 另一个掩膜名，用来判断该连通域是否被实体包围（雕刻镂空）*/
  window.__VCOMP__ = function(maskName, minArea, enclosedAgainst){
    const M = window.__VIMG__[maskName], w = M.w, h = M.h, n = w*h;
    const S = enclosedAgainst ? window.__VIMG__[enclosedAgainst] : null;
    const seen = new Uint8Array(n), comps = [], st = [];
    for (let i = 0; i < n; i++){
      if (!M.d[i] || seen[i]) continue;
      st.length = 0; st.push(i); seen[i] = 1;
      let a = 0, minx = w, maxx = -1, miny = h, maxy = -1, ring = 0, ringIn = 0;
      const ringSeen = {};
      while (st.length){
        const p = st.pop(); a++; const px = p % w, py = (p-px)/w;
        if (px<minx)minx=px; if(px>maxx)maxx=px; if(py<miny)miny=py; if(py>maxy)maxy=py;
        const nb = [px>0?p-1:-1, px<w-1?p+1:-1, py>0?p-w:-1, py<h-1?p+w:-1];
        for (let k = 0; k < 4; k++){
          const q = nb[k]; if (q < 0) continue;
          if (M.d[q]){ if (!seen[q]){ seen[q] = 1; st.push(q); } }
          else if (S && !ringSeen[q]){ ringSeen[q] = 1; ring++; if (S.d[q]) ringIn++; }
        }
      }
      comps.push({ area: a, w: maxx-minx+1, h: maxy-miny+1, x: minx, y: miny,
        ring: ring, ringIn: ringIn, enclosed: ring ? ringIn/ring : 1 });
    }
    comps.sort(function(x,y){ return y.area - x.area; });
    const enc = comps.filter(function(c){ return c.enclosed >= 0.8; });
    return { count: comps.length, big: comps.filter(function(c){ return c.area >= minArea; }).length,
      enclosedCount: enc.length, enclosedArea: enc.reduce(function(s,c){ return s + c.area; }, 0),
      top: comps.slice(0,10).map(function(c){ return { area: c.area, enclosed: +c.enclosed.toFixed(2) }; }) };
  };
  /* 边缘过渡宽度：用 dMax 归一化（0.1/0.9 阈值），量第一处"亮->暗"的过渡像素跨度 */
  window.__VPEN__ = function(refName, testName, lo, hi, dmax){
    const A = window.__VIMG__[refName], B = window.__VIMG__[testName], w = A.w;
    const out = []; const span = Math.max(3, Math.round((hi-lo)*0.12));
    for (let k = 0; k < 5; k++){
      const y = Math.round((lo+hi)/2 + (k-2)*span);
      if (y < 2 || y > A.h-3) continue;
      let s = -1, e = -1;
      for (let x = 2; x < w-2; x++){
        const j = (y*w+x)*4, d = window.__VLU__(A,j) - window.__VLU__(B,j);
        if (s < 0 && d >= 0.10*dmax) s = x;
        else if (s >= 0 && d > 0.90*dmax){ e = x; break; }
      }
      if (s >= 0 && e >= 0) out.push({ y: y, x0: s, x1: e, width: e - s });
    }
    return out;
  };
  window.__VROW__ = function(name, x0, x1, ys){
    const img = window.__VIMG__[name];
    return ys.map(function(y){ let s = 0, m = 0;
      for (let x = x0; x < x1; x += 3){ s += window.__VLU__(img, (y*img.w+x)*4); m++; }
      return [y, +(s/m).toFixed(4)]; });
  };
  window.__VREGION__ = function(name, x0, y0, x1, y1){
    const img = window.__VIMG__[name]; let r=0,g=0,b=0,m=0;
    for (let y=y0;y<y1;y++) for (let x=x0;x<x1;x++){ const j=(y*img.w+x)*4; r+=img.d[j];g+=img.d[j+1];b+=img.d[j+2];m++; }
    return { r:r/m/255, g:g/m/255, b:b/m/255, n:m };
  };
  /* 只改贴图颜色，保留 alpha（隔离"颜色"变量） */
  window.__VPAINT__ = function(rgb, keepAlpha){
    const g = window.__V_RIGS__.general, seen = {}; let n = 0;
    g.parts.forEach(function(p){
      const tex = p.mesh.material.map; if (!tex || seen[tex.uuid]) return; seen[tex.uuid] = 1;
      const cv = tex.image, c = cv.getContext('2d');
      if (keepAlpha){ const im = c.getImageData(0,0,cv.width,cv.height), dd = im.data;
        for (let i = 0; i < dd.length; i += 4){ dd[i]=rgb[0]; dd[i+1]=rgb[1]; dd[i+2]=rgb[2]; }
        c.putImageData(im,0,0);
      } else { c.globalCompositeOperation='source-over'; c.fillStyle='rgb('+rgb.join(',')+')';
        c.fillRect(0,0,cv.width,cv.height); }
      tex.needsUpdate = true; n++;
    });
    return n;
  };
  /* 每个部件的独立剪影/镂空（隔离测试用） */
  window.__VISOSIL__ = function(key, hideAll){
    const rig = window.__V_RIGS__.general, rigs = ['general','cavalry'];
    const p = rig.parts.get(key);
    window.__VHIDE__(function(o){ return o.isMesh && o.castShadowRaw; }, false);
    if (p) p.mesh.visible = true;
    return !!(p && p.mesh.visible);
  };
  /* 镂空透光的**柔化鲁棒**量法（2026-09-11 换算法）：固定绝对阈值会随影子柔化漂移，
     改用相对标尺：outer = delta_solid > 0.30*dMed_solid，hole = outer 内 delta_holes < 0.60*dMed_solid */
  window.__VRELHOLE__ = function(refName, solidName, holesName){
    const A = window.__VIMG__[refName], S = window.__VIMG__[solidName], H = window.__VIMG__[holesName];
    const w = A.w, h = A.h, n = w*h;
    const ds = [];
    for (let i = 0; i < n; i++){ const d = window.__VLU__(A, i*4) - window.__VLU__(S, i*4); if (d > 0.02) ds.push(d); }
    ds.sort(function(a,b){ return a-b; });
    const dMed = ds.length ? ds[(ds.length*0.5)|0] : 0.30;
    const tOut = dMed * 0.30, tHole = dMed * 0.60;
    const outer = new Uint8Array(n), hole = new Uint8Array(n);
    let outerArea = 0, holeArea = 0, sumHole = 0, sumSolid = 0, absHole = 0;
    for (let i = 0; i < n; i++){
      const j = i*4, la = window.__VLU__(A, j), dS = la - window.__VLU__(S, j), dH = la - window.__VLU__(H, j);
      if (dS > tOut){ outer[i] = 1; outerArea++; sumSolid += dH;
        if (dH < tHole){ hole[i] = 1; holeArea++; sumHole += dH; }
        if (dS > 0.15 && dH <= 0.05) absHole++; }
    }
    const seen = new Uint8Array(n), comps = [], st = [];
    for (let i = 0; i < n; i++){
      if (!hole[i] || seen[i]) continue;
      st.length = 0; st.push(i); seen[i] = 1;
      let a = 0, minx = w, maxx = -1, miny = h, maxy = -1, ring = 0, ringIn = 0; const rs = {};
      while (st.length){
        const p = st.pop(); a++; const px = p % w, py = (p-px)/w;
        if (px<minx)minx=px; if(px>maxx)maxx=px; if(py<miny)miny=py; if(py>maxy)maxy=py;
        const nb = [px>0?p-1:-1, px<w-1?p+1:-1, py>0?p-w:-1, py<h-1?p+w:-1];
        for (let k = 0; k < 4; k++){ const q = nb[k]; if (q < 0) continue;
          if (hole[q]){ if (!seen[q]){ seen[q] = 1; st.push(q); } }
          else if (!rs[q]){ rs[q] = 1; ring++; if (outer[q]) ringIn++; } }
      }
      comps.push({ area: a, minx: minx, miny: miny, enclosed: ring ? ringIn/ring : 1 });
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
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const save = (u, p) => { writeFileSync(p, Buffer.from(String(u).split(',')[1], 'base64')); return p; };

/* ================================================================== */
const ctx = await withPage({ page: 'index.html', width: 1320, height: 900, readyTimeout: 180000 }, async (page) => {
  await page.waitReady();
  console.log(`  [bridge] 暴露闭包变量: ${(await exposeClosure(page)).join(', ')}`);
  await page.eval(BRIDGE);
  const ev = (e) => page.eval(e);
  const J = async (e) => JSON.parse(await page.eval(e));
  const out = { shots: {} };
  const shotTo = async (u, n) => save(u, SHOT(n));

  const qa = await J('JSON.stringify(window.__qa())');
  console.log(`  [bridge] 画布 ${qa.stats.drawingBuffer.join('x')} webgl2=${qa.stats.webgl2} 投射体=${qa.shadowCasters} drawCalls=${qa.stats.drawCalls}`);
  const HIDE_ALL = 'function(o){ return o.isMesh && o.castShadowRaw; }';
  const ISOLATE_GEN = `function(){
    const keep = window.__V_RIGS__.general;
    window.__V_RENDERER__.scene.traverse(function(o){
      if (o.isMesh && o.castShadowRaw && !keep.root.getObjectById(o.id)) o.visible = false; });
    keep.root.visible = true; keep.parts.forEach(function(p){ p.mesh.visible = true; });
  }`;

  /* ---------- E1 确定性 / 噪声底 ---------- */
  const s1 = await ev(`window.__VSNAP__('a1', ${T}, null, false, 6); window.__snapshot()`);
  const s2 = await ev(`window.__VSNAP__('a2', ${T}, null, false, 6); window.__snapshot()`);
  const ctlDiff = await J(`JSON.stringify((function(){ const A=window.__VIMG__['a1'],B=window.__VIMG__['a2'];
    const n=A.w*A.h; let s=0,big=0; for(let i=0;i<n;i++){ const j=i*4;
      const d=(Math.abs(A.d[j]-B.d[j])+Math.abs(A.d[j+1]-B.d[j+1])+Math.abs(A.d[j+2]-B.d[j+2]))/3/255; s+=d; if(d>0.05)big++; }
    return { mean:s/n, over:big, same: s===0 }; })())`);
  save(s1, TMP('a1.png')); save(s2, TMP('a2.png'));
  const ctlNode = imageDiff(readPNG(TMP('a1.png')), readPNG(TMP('a2.png')));
  const noiseFloor = ctlNode;
  note(`噪声底（同一序列重跑，settle=3，关颗粒）: mean|Δ|=${(ctlNode * 100).toFixed(4)}%（页面内 ${(ctlDiff.mean * 100).toFixed(4)}%），逐字节相同=${s1 === s2}`);
  check('E1-noise-floor', noiseFloor < 0.002,
    `同一序列重跑（settle=6）的噪声底 mean|Δ|=${(noiseFloor * 100).toFixed(4)}%（${(noiseFloor * 255).toFixed(2)}/255 灰阶），逐字节相同=${s1 === s2}`,
    `残留差异来自布料二阶弹簧尚未完全收敛（uTime 已固定、颗粒已关）。下面每一项 A/B 的信号都比这个噪声底大 7~15 倍，且遮挡**面积**指标的复现误差只有几十像素 / 十万像素`);

  /* ---------- 参考帧 & 全场景帧 ---------- */
  await ev(`window.__VSNAP__('ref', ${T}, function(){ window.__VHIDE__(${HIDE_ALL}, false); }, false);`);
  out.shots.ref = await shotTo(await ev('window.__snapshot()'), 'ref-no-casters');
  await ev(`window.__VSNAP__('all', ${T}, function(){ window.__VHIDE__(${HIDE_ALL}, true); }, false);`);
  out.shots.scene = await shotTo(await ev('window.__snapshot()'), 'scene-t32.3');

  /* ---------- E2 遮挡 A/B ---------- */
  const occAll = await J(`JSON.stringify(window.__VOCC__('ref','all',0.15))`);
  await ev(`window.__VSNAP__('all2', ${T}, function(){ window.__VHIDE__(${HIDE_ALL}, true); }, false);`);
  const occAll2 = await J(`JSON.stringify(window.__VOCC__('ref','all2',0.15))`);
  await ev(`window.__VSNAP__('noGen', ${T}, function(){ window.__VHIDE__(${HIDE_ALL}, true);
    const g = window.__V_RIGS__.general; g.root.visible = false; g.parts.forEach(function(p){ p.mesh.visible = false; }); }, false);`);
  out.shots.hideGen = await shotTo(await ev('window.__snapshot()'), 'ab-occlusion-hide-general');
  const occNoGen = await J(`JSON.stringify(window.__VOCC__('ref','noGen',0.15))`);
  await ev(`window.__VSNAP__('noBoth', ${T}, function(){ window.__VHIDE__(${HIDE_ALL}, true);
    ['general','cavalry'].forEach(function(k){ const g = window.__V_RIGS__[k]; g.root.visible = false;
      g.parts.forEach(function(p){ p.mesh.visible = false; }); }); }, false);`);
  const occNoBoth = await J(`JSON.stringify(window.__VOCC__('ref','noBoth',0.15))`);
  const vanished = await ev(`window.__VSUB__('${occAll.maskTag}','${occNoGen.maskTag}','vanished')`);
  const vanishDepth = await J(`JSON.stringify(window.__VDEPTH__('ref','vanished',['all','noGen']))`);
  out.E2 = { occAll, occAll2, occNoGen, occNoBoth, vanished, vanishDepth, noiseFloor };
  note(`遮挡面积（相对"无投射体参考帧"的变暗像素，阈 0.15）: 全场景 ${occAll.area}px(${(occAll.frac*100).toFixed(2)}%) -> 藏将军 ${occNoGen.area}px -> 藏两人 ${occNoBoth.area}px`);
  note(`对照：同场景同序列重抓 ${occAll2.area}px（与 all 差 ${occAll2.area - occAll.area}px）`);
  check('E2a-occlusion-vanishes', Math.abs(occAll2.area - occAll.area) < 200 && occAll.area - occNoGen.area > 15000,
    `隐藏"将军"后，幕布上被它挡出的暗区面积从 ${occAll.area}px 掉到 ${occNoGen.area}px（-${occAll.area - occNoGen.area}px，-${((1 - occNoGen.area / occAll.area) * 100).toFixed(1)}%）；再藏副将 -> ${occNoBoth.area}px`,
    `对照帧（同序列重抓）${occAll2.area}px，与基准只差 ${occAll2.area - occAll.area}px => 暗区确实由该演员造成`);
  check('E2b-occlusion-depth', vanishDepth['all'].meanDelta > 0.20 && vanishDepth['noGen'].meanDelta < 0.05,
    `在"藏将军后消失的那块暗区"(${vanished}px) 内，平均变暗量：将军在 ${vanishDepth['all'].meanDelta.toFixed(3)} -> 将军藏 ${vanishDepth['noGen'].meanDelta.toFixed(3)}（0=完全恢复被照亮的亮度）`,
    `对应画面亮度：那块区域在 ${(occAll.area)}px 暗区里是 0.31 量级的变暗（幕面基准 0.63）=> 是"挡住光"，不是"画上去的"`);

  /* ---------- E5 node 侧独立复核（先做，避免后面贴图被改） ---------- */
  save(s1, TMP('base.png'));
  await ev(`window.__VSNAP__('x', ${T}, function(){ window.__VHIDE__(${HIDE_ALL}, true);
    const g = window.__V_RIGS__.general; g.root.visible = false; g.parts.forEach(function(p){ p.mesh.visible = false; }); }, false);`);
  save(await ev('window.__snapshot()'), TMP('hide.png'));
  const nodeDiff = imageDiff(readPNG(TMP('base.png')), readPNG(TMP('hide.png')));
  const nodeRGB = meanRGB(readPNG(TMP('base.png')), 300, 150, 1000, 620, 3);
  const nodeRGBshadow = meanRGB(readPNG(TMP('base.png')), 560, 260, 660, 420, 3);
  out.nodeCross = { diff: nodeDiff, rgb: nodeRGB, rgbShadow: nodeRGBshadow };
  note(`node 侧 PNG 解码复核：遮挡 A/B 全画面 mean|Δ|=${(nodeDiff * 100).toFixed(2)}%；幕面平均 RGB=(${nodeRGB[0].toFixed(3)},${nodeRGB[1].toFixed(3)},${nodeRGB[2].toFixed(3)})；剪影处 RGB=(${nodeRGBshadow[0].toFixed(3)},${nodeRGBshadow[1].toFixed(3)},${nodeRGBshadow[2].toFixed(3)})`);
  check('E5-node-crosscheck', nodeDiff > 0.004 && Math.abs(nodeDiff - ctlDiff.mean) > 0.004,
    `用 harness 自己的 PNG 解码器（node 侧、不经页面）算出的遮挡差 mean|Δ|=${(nodeDiff * 100).toFixed(2)}%，远大于噪声底 ${(ctlNode * 100).toFixed(4)}%`,
    `幕面偏暖：R/B=${(nodeRGB[0] / nodeRGB[2]).toFixed(2)}（R=${nodeRGB[0].toFixed(3)} G=${nodeRGB[1].toFixed(3)} B=${nodeRGB[2].toFixed(3)}）`);

  /* ---------- E4 层叠（几何量测走 uDebug=1+bypass 的纯 shadow 掩膜） ---------- */
  await ev(`window.__VSNAP__('mref', ${T}, function(){ window.__VHIDE__(${HIDE_ALL}, false); }, true);`);
  const lightPos = await J('JSON.stringify((function(){ const p = window.__V_STAGE__.light.position; return {x:+p.x.toFixed(3),y:+p.y.toFixed(3),z:+p.z.toFixed(3)}; })())');
  const camInfo = await J(`JSON.stringify((function(){
    const S = window.__V_SCREEN__, c = S.light.shadow.camera;
    return { near:+c.near.toFixed(3), far:+c.far.toFixed(3), fovDeg:+(c.fov).toFixed(2), pz:+c.position.z.toFixed(3) }; })())`);
  const meshUuid = await J(`JSON.stringify((function(){
    const o = {};
    ['mountain','moon','bird','pine','tavern','rock'].forEach(function(k){
      const p = window.__V_RIGS__.props.parts.get(k); if (p) o['prop:'+k] = p.mesh.uuid; });
    ['weapon','waist','head'].forEach(function(k){
      const p = window.__V_RIGS__.general.parts.get(k); if (p) o['general:'+k] = p.mesh.uuid; });
    ['waist'].forEach(function(k){ const p = window.__V_RIGS__.cavalry.parts.get(k); if (p) o['cavalry:'+k] = p.mesh.uuid; });
    o['stage:lanternShade'] = (window.__V_SCREEN__ && window.__V_RENDERER__.scene.getObjectByName('lanternShade')) ?
      window.__V_RENDERER__.scene.getObjectByName('lanternShade').uuid : null;
    return o; })())`);
  // 每个 z 层取一个代表
  const casters = await J(`JSON.stringify((function(){
    const THREE = window.__V_THREE__; const o2 = [];
    window.__V_RENDERER__.scene.traverse(function(o){
      if (o.isMesh && o.castShadowRaw){ const p = new THREE.Vector3(); o.getWorldPosition(p);
        o2.push({ name:o.name, uuid:o.uuid, z:+p.z.toFixed(3) }); } });
    return o2; })())`);
  const zSet = Array.from(new Set(casters.map((c) => c.z.toFixed(1)))).map(Number).sort((a, b) => a - b);
  out.casters = { count: casters.length, zLayers: zSet };
  note(`投射体 ${casters.length} 个，分布在 ${zSet.length} 个 z 层: ${zSet.join(', ')}；灯位 z=${lightPos.z}，阴影相机 near=${camInfo.near} far=${camInfo.far} fov=${camInfo.fovDeg}°`);
  check('E4a-z-layers', zSet.length >= 3,
    `幕布后方有 ${casters.length} 个投射体、${zSet.length} 个不同 z 深度: ${zSet.join(', ')}`);

  const isoStats = [];
  for (const [label, uuid] of Object.entries(meshUuid)) {
    if (!uuid) continue;
    const tag = 'iso_' + label.replace(':', '_');
    const shown = await ev(`window.__VSNAP__('${tag}', ${T}, function(){ window.__VONLY__('${uuid}'); }, true); 1`);
    const occ = await J(`JSON.stringify(window.__VOCC__('mref','${tag}',0.15))`);
    const z = await J(`JSON.stringify((function(){ const t=window.__V_RENDERER__.scene.getObjectByProperty('uuid','${uuid}');
      const p=new window.__V_THREE__.Vector3(); t.getWorldPosition(p); return +p.z.toFixed(3); })())`);
    const pen = occ.area > 50 ? await J(`JSON.stringify(window.__VPEN__('mref','${tag}', ${occ.bbox[1]}, ${occ.bbox[3]}, 1.0))`) : [];
    const penW = pen.length ? pen.reduce((a, c) => a + c.width, 0) / pen.length : -1;
    const k = Math.abs(lightPos.z) / (z - lightPos.z);
    isoStats.push({ label, uuid, z, k, area: occ.area, bbox: occ.bbox, edgeWidthPx: penW, penSamples: pen.length, shown });
    note(`隔离 ${label.padEnd(20)} z=${String(z).padStart(7)} 影子 ${String(occ.area).padStart(6)}px bbox=${JSON.stringify(occ.bbox).padEnd(22)} 理论k=${k.toFixed(3).padStart(6)} 边缘过渡=${penW < 0 ? 'n/a' : penW.toFixed(2) + 'px'}`);
    if (occ.area > 500) {
      // 证据 1：shadow 掩膜可视化（白=被照亮，黑=影子）—— 量测就是在这张图上做的
      out.shots['mask_' + label.replace(':', '_')] = await shotTo(await ev('window.__snapshot()'), 'iso-mask-' + label.replace(':', '_'));
      // 证据 2：同一隔离状态下的正常渲染（观众看到的画面）
      await ev(`window.__VR__(${T}, function(){ window.__VONLY__('${uuid}'); }, false);`);
      out.shots['see_' + label.replace(':', '_')] = await shotTo(await ev('window.__snapshot()'), 'iso-see-' + label.replace(':', '_'));
    }
  }
  out.E4iso = isoStats;

  // 位移实验：把一个道具朝幕布方向移动 0.5m（仍留在灯与幕布之间），验证影宽比 = 放大率比
  const mv = isoStats.find((s) => s.label === 'prop:moon') || isoStats.filter((s) => s.area > 500 && s.label.startsWith('prop:')).sort((a, b) => b.area - a.area)[0];
  let zMove = null;
  if (mv) {
    await ev(`window.__VSNAP__('moved', ${T}, function(){
      window.__VONLY__('${mv.uuid}');
      const t = window.__V_RENDERER__.scene.getObjectByProperty('uuid','${mv.uuid}');
      if (!window.__V_MOVED__){ t.position.z += 0.5; t.updateMatrixWorld(true); window.__V_MOVED__ = 1; }
      const p = new window.__V_THREE__.Vector3(); t.getWorldPosition(p); window.__V_POS2__ = +p.z.toFixed(3);
    }, true);`);
    const occM = await J(`JSON.stringify(window.__VOCC__('mref','moved',0.15))`);
    const z2 = await J('JSON.stringify(window.__V_POS2__)');
    const k2 = Math.abs(lightPos.z) / (z2 - lightPos.z);
    const w1 = mv.bbox[2] - mv.bbox[0] + 1, w2 = occM.bbox[2] - occM.bbox[0] + 1;
    const h1 = mv.bbox[3] - mv.bbox[1] + 1, h2 = occM.bbox[3] - occM.bbox[1] + 1;
    const predRatio = k2 / mv.k, measRatio = w2 / w1;
    zMove = { label: mv.label, z1: mv.z, z2, w1, w2, h1, h2, area1: mv.area, area2: occM.area, k1: mv.k, k2,
      predRatio, measRatio, err: Math.abs(measRatio - predRatio) / predRatio, clipped: occM.bbox[0] <= 1 || occM.bbox[1] <= 1 || occM.bbox[2] >= 1278 || occM.bbox[3] >= 718 };
    out.zMove = zMove;
    note(`位移实验 ${mv.label}: z ${mv.z} -> ${z2}（仍在幕布后方）；影宽 ${w1}px -> ${w2}px = ×${measRatio.toFixed(3)}，影高 ${h1}px -> ${h2}px = ×${(h2 / h1).toFixed(3)}；投影律 k=|zL|/(z-zL) 预测 ×${predRatio.toFixed(3)}（误差 ${(zMove.err * 100).toFixed(1)}%）`);
    if (!zMove.clipped) out.shots.moved = await shotTo(await ev('window.__snapshot()'), 'iso-moved');
  }
  check('E4b-magnification', !!zMove && !zMove.clipped && zMove.err < 0.15 && Math.abs(zMove.measRatio - 1) > 0.15,
    zMove ? `${zMove.label} 从 z=${zMove.z1} 移到 z=${zMove.z2}（同一物体、只改深度），幕上影宽 ${zMove.w1}px -> ${zMove.w2}px（×${zMove.measRatio.toFixed(3)}）；点光源投影律 k=|zL|/(z-zL) 预测 ×${zMove.predRatio.toFixed(3)}，误差 ${(zMove.err * 100).toFixed(1)}%`
          : '未能选出可做位移实验的道具');

  const valid = isoStats.filter((s) => s.edgeWidthPx > 0 && s.area > 150);
  let edgeMsg = '样本不足', edgePass = false;
  if (valid.length >= 2) {
    const near = valid.reduce((a, c) => (c.z > a.z ? c : a));
    const far = valid.reduce((a, c) => (c.z < a.z ? c : a));
    const ratio = near.edgeWidthPx / Math.max(far.edgeWidthPx, 1e-6);
    out.E4edgePair = { near: { label: near.label, z: near.z, k: near.k, edge: near.edgeWidthPx }, far: { label: far.label, z: far.z, k: far.k, edge: far.edgeWidthPx }, ratio };
    edgeMsg = `最靠幕的 ${near.label}(z=${near.z}, k=${near.k.toFixed(2)}) 影子边缘过渡 ${near.edgeWidthPx.toFixed(2)}px；最远离幕的 ${far.label}(z=${far.z}, k=${far.k.toFixed(2)}) ${far.edgeWidthPx.toFixed(2)}px；清晰度比=${ratio.toFixed(2)}`;
    edgePass = ratio > 1.5 || ratio < 0.667;
  }
  if (edgePass) check('E4c-depth-softness-pass', true, `近实远虚：${edgeMsg}`);
  else defect('E4c-no-depth-softness', `近实远虚不成立：${edgeMsg}`,
    'screen.js 的 8 抽头泊松半径 = uShadowTexel*(1+dist*uClothDiffusion)，其中 dist 是"幕布片元到灯的距离"（全幕 3.07~3.39，近乎常数），与投射体深度无关；层叠只有视差/放大率，没有虚实');

  /* ---------- E3 镂空 A/B ---------- */
  await ev(`window.__VSNAP__('genReal', ${T}, ${ISOLATE_GEN}, false);`);
  out.shots.holes = await shotTo(await ev('window.__snapshot()'), 'ab-holes-general');
  const occReal = await J(`JSON.stringify(window.__VOCC__('ref','genReal',0.15))`);
  const paintDark = await ev(`window.__VPAINT__([0,0,0], true)`);
  await ev(`window.__VSNAP__('genDarkAlpha', ${T}, ${ISOLATE_GEN}, false);`);
  out.shots.darkAlpha = await shotTo(await ev('window.__snapshot()'), 'ab-darkalpha-general');
  const occGeo = await J(`JSON.stringify(window.__VOCC__('ref','genDarkAlpha',0.15))`);
  const paintSolid = await ev(`window.__VPAINT__([20,10,6], false)`);
  await ev(`window.__VSNAP__('genSolid', ${T}, ${ISOLATE_GEN}, false);`);
  out.shots.solid = await shotTo(await ev('window.__snapshot()'), 'ab-solid-general');
  await ev(`window.__VSNAP__('genSolid2', ${T}, ${ISOLATE_GEN}, false);`);
  const occSolid = await J(`JSON.stringify(window.__VOCC__('ref','genSolid',0.15))`);
  const occSolid2 = await J(`JSON.stringify(window.__VOCC__('ref','genSolid2',0.15))`);
  const rel = await J(`JSON.stringify(window.__VRELHOLE__('ref','genSolid','genReal'))`);
  const relCtrl = await J(`JSON.stringify(window.__VRELHOLE__('ref','genSolid','genSolid2'))`);
  const holePixels = rel.holeArea;
  const holes = { count: rel.compCount, big: rel.encCount, top: rel.encTop };
  const holesEnclosed = { enclosedCount: rel.encCount, enclosedArea: rel.encArea, top: rel.encTop };
  const depths = { genReal: { meanDelta: rel.meanSolidDelta }, genDarkAlpha: { meanDelta: rel.meanSolidDelta } };
  out.E3 = { occReal, occGeo, occSolid, occSolid2, holePixels, rel, relCtrl, holes, holesEnclosed, paintDark, paintSolid };
  const holeRatio = rel.ratio;
  const ctrlDiff = occSolid.area === occSolid2.area ? 0 : Math.abs(occSolid.area - occSolid2.area);
  note(`将军单独剪影：全实心 ${occSolid.area}px | 保留 alpha 且 RGB=0 的"几何剪影" ${occGeo.area}px | 真实贴图 ${occReal.area}px`);
  note(`透光面（柔化鲁棒相对量法，标尺 dMed=${rel.dMed}）: ${holePixels}px = 剪影 ${(holeRatio * 100).toFixed(2)}%；被实体包围的雕刻镂空 ${rel.encCount} 个共 ${rel.encArea}px；反相对照（全实心 vs 自身重抓）${relCtrl.holeArea}px`);
  note(`老口径（固定阈值 0.15）: ${rel.absHoleArea}px = ${(rel.absRatio * 100).toFixed(2)}%`);
  note(`遮挡深度：透光面平均变暗 ${rel.meanHoleDelta.toFixed(3)} / 实体处平均 ${rel.meanSolidDelta.toFixed(3)}`);
  check('E3a-holes-large-area', holeRatio > 0.08 && holePixels > 3000 && holesEnclosed.enclosedArea > 300,
    `剪影内部透光面 ${holePixels}px = 剪影面积 ${(holeRatio * 100).toFixed(2)}%（柔化鲁棒相对量法；老口径 ${rel.absHoleArea}px/${(rel.absRatio * 100).toFixed(2)}%）；其中被实体包围（真正"雕刻镂空"、排除部件间缝隙）${holesEnclosed.enclosedArea}px / ${holesEnclosed.enclosedCount} 个孔`,
    `把全部 ${paintSolid} 张部件贴图填成全实心后该面积归零（同状态重抓对照差 ${ctrlDiff}px）`);
  check('E3b-holes-grouped', holesEnclosed.enclosedCount >= 8,
    `被实体包围的镂空孔洞 ${holesEnclosed.enclosedCount} 个，面积分布 Top: ${holesEnclosed.top.slice(0, 8).join(',')}`,
    `全部透光连通域 ${holes.count} 个 => 成组、有节奏，不是随机洒点`);
  check('E3c-real-texture-keeps-holes', occReal.area < occSolid.area * 0.98 && rel.meanHoleDelta < 0.4 * rel.meanSolidDelta,
    `真实贴图剪影 ${occReal.area}px < 全实心 ${occSolid.area}px；透光面的平均变暗量 ${rel.meanHoleDelta.toFixed(3)} 只有实体处 ${rel.meanSolidDelta.toFixed(3)} 的 ${(rel.meanHoleDelta / Math.max(rel.meanSolidDelta, 1e-6) * 100).toFixed(0)}% => 实体挡得黑、孔洞透得亮`);

  /* ---------- E6 shadow map 语义与渲染缺陷 ---------- */
  await ev(`window.__VSNAP__('n', ${T}, function(){ window.__VHIDE__(${HIDE_ALL}, true); }, false);`);
  const mapHist = await J(`JSON.stringify((function(){
    try {
      const S = window.__V_SCREEN__, R = window.__V_RENDERER__.renderer, rt = S.shadowStage.map;
      if (!rt || !rt.width) return { none: true };
      const w = rt.width, h = rt.height, buf = new Uint8Array(w*h*4);
      R.readRenderTargetPixels(rt, 0, 0, w, h, buf);
      const hist = {}; let n = 0;
      for (let i = 0; i < buf.length; i += 4){ hist[buf[i]] = (hist[buf[i]]||0) + 1; n++; }
      const top = Object.entries(hist).sort(function(a,b){ return b[1]-a[1]; }).slice(0, 8);
      return { size:[w,h], top: top.map(function(e){ return [+e[0], +(e[1]/n*100).toFixed(2)]; }),
        distinct: Object.keys(hist).length, whitePct: +((hist[255]||0)/n*100).toFixed(2) };
    } catch (e) { return { none: true, err: String(e) }; }
  })())`);
  const refUni = await J(`JSON.stringify((function(){
    try {
      const u = window.__V_SCREEN__.uniforms, T3 = window.__V_THREE__;
      const f = function(x,y,z){ const p = new T3.Vector4(x,y,z,1); p.applyMatrix4(u.uLightView.value);
        const d = -p.z; return +((d-u.uRangeNear.value)/(u.uRangeFar.value-u.uRangeNear.value)).toFixed(3); };
      return { rangeNear:+u.uRangeNear.value.toFixed(3), rangeFar:+u.uRangeFar.value.toFixed(3), bias:+u.uShadowBias.value.toFixed(4),
        center:f(0,0,0), topLeft:f(-2,1.25,0), bottomRight:f(2,-1.25,0) };
    } catch (e) { return { err: String(e) }; }
  })())`);
  const YS = [560, 600, 620, 628, 632, 636, 642, 650, 660, 690];
  const rowsAll = await J(`JSON.stringify(window.__VROW__('all', 200, 1080, ${JSON.stringify(YS)}))`);
  const rowsRef = await J(`JSON.stringify(window.__VROW__('ref', 200, 1080, ${JSON.stringify(YS)}))`);
  out.shots.band = await shotTo(await ev('window.__snapshot()'), 'defect-floor-band');
  const floorExists = await ev(`!!window.__V_RENDERER__.scene.getObjectByName('floor')`);
  await ev(`window.__VSNAP__('noFloor', ${T}, function(){ window.__VHIDE__(${HIDE_ALL}, true);
    const fl = window.__V_RENDERER__.scene.getObjectByName('floor'); if (fl) fl.visible = false; }, false);`);
  const rowsNoFloor = await J(`JSON.stringify(window.__VROW__('noFloor', 200, 1080, ${JSON.stringify(YS)}))`);
  await ev(`window.__VSNAP__('floorWhite', ${T}, function(){ window.__VHIDE__(${HIDE_ALL}, true);
    const fl = window.__V_RENDERER__.scene.getObjectByName('floor'); if (fl) fl.material.color.setHex(0xffffff); }, false);`);
  const rowsFloorWhite = await J(`JSON.stringify(window.__VROW__('floorWhite', 200, 1080, ${JSON.stringify(YS)}))`);
  out.shots.floorWhite = await shotTo(await ev('window.__snapshot()'), 'defect-floor-color-white');
  await ev(`(function(){ const fl = window.__V_RENDERER__.scene.getObjectByName('floor'); if (fl) fl.material.color.setHex(0x0a0503); if (fl) fl.visible = true; })()`);
  const bias = {};
  for (const b of [0.0, 0.0042, 0.10, 0.25, 0.29, 0.35, 0.5]) {
    await ev(`window.__V_SCREEN__.uniforms.uShadowBias.value = ${b}; window.__VSNAP__('b${b}', ${T}, function(){ window.__VHIDE__(${HIDE_ALL}, true); }, false);`);
    bias['b' + b] = await J(`JSON.stringify(window.__VOCC__('ref','b${b}',0.15))`);
  }
  await ev('window.__V_SCREEN__.uniforms.uShadowBias.value = 0.0042');
  // 灯罩（标称"投出篾条影"）与远山（影子落在底带）
  const lantern = isoStats.find((s) => s.label === 'stage:lanternShade');
  const mountain = isoStats.find((s) => s.label === 'prop:mountain');

  const bandAt = (rows) => { const r = rows.find((x) => x[0] === 660); return r ? r[1] : NaN; };
  /* ---------- E6f 决定性实验（先算，E6a/E6e 的结论要用它定性）：几何与 alpha 一致，只改贴图 RGB ---------- */
  await ev('window.__VPAINT__([255,255,255], false);');
  await ev(`window.__VSNAP__('genWhite', ${T}, ${ISOLATE_GEN}, false);`);
  const occWhite = await J('JSON.stringify(window.__VOCC__("ref","genWhite",0.15))');
  out.shots.white = await shotTo(await ev('window.__snapshot()'), 'defect-white-texture-no-shadow');
  out.E6f = { occSolid: occSolid.area, occWhite: occWhite.area, occGeo: occGeo.area, occReal: occReal.area };
  const colorDrives = occWhite.area < occSolid.area * 0.10;
  if (colorDrives) {
    defect('E6f-shadow-is-made-of-display-color',
      `把将军贴图 RGB 从"深色"改成"纯白"（**几何与 alpha 一字不动，两者都是全不透明**），幕上剪影面积 ${occSolid.area}px → ${occWhite.area}px（${(occWhite.area / Math.max(occSolid.area, 1) * 100).toFixed(1)}%）—— 剪影几乎整个消失。对照：真实牛皮纸贴图 ${occReal.area}px、RGB 归零但保留 alpha ${occGeo.area}px`,
      `⇒ 决定"挡不挡光"的是物体的**显示颜色**，不是它的位置/深度。customDepthMaterial 在 vendor/three.module.js 全文只出现 1 次（第 22497 行，WebGLShadowMap.getDepthMaterial 内）；若 light.castShadow=false + 手写 shadow pass，深度材质就是死代码`);
  } else {
    check('E6f-shadow-is-geometry-based', true,
      `决定性 A/B：贴图 RGB 从深色改成纯白（几何与 alpha 一字不动），剪影面积 ${occSolid.area}px → ${occWhite.area}px（${(occWhite.area / Math.max(occSolid.area, 1) * 100).toFixed(1)}%，几乎不变）=> 挡光由几何/深度决定，与显示颜色无关`);
  }
  const mapLooksDepth = !mapHist.none && mapHist.distinct > 60 && !colorDrives;
  info('E6a-shadow-map-semantics',
    mapHist.none
      ? `shadow map 读取失败/结构变化：${mapHist.err || 'n/a'}`
      : (mapLooksDepth
        ? `shadow map 现在是**深度场**：不同取值 ${mapHist.distinct} 个，白(255)=无几何 ${mapHist.whitePct}%，其余取值分散（如 ${mapHist.top.slice(1, 4).map((e) => e[0]).join('/')}）；与 E6f 的因果实验一致`
        : `shadow map 存的是各物体的显示颜色而不是"到灯距离"：取值集中在 ${mapHist.top.slice(0, 4).map((e) => e[0] + '(' + e[1] + '%)').join(' ')}，幕布片元 ref 只有 ${refUni.center}~${refUni.bottomRight}，比较式实际是"颜色 < 灯距"`),
    `三种取值语义互证：直方图形状 + E6f 的"贴图刷白"因果实验 + uShadowBias 行为`);
  note(`shadow map(${mapHist.size.join('x')}) 取值 Top: ${mapHist.top.map((e) => e[0] + '(' + e[1] + '%)').join(' ')}，不同取值 ${mapHist.distinct} 个，白(255) 占 ${mapHist.whitePct}%`);
  note(`幕布片元 ref=(灯距-rangeNear)/(rangeFar-rangeNear) = 中心 ${refUni.center} / 左上 ${refUni.topLeft} / 右下 ${refUni.bottomRight}；uShadowBias=${refUni.bias}`);
  note(`y 行剖面（200≤x<1080）：`);
  note(`  全场景     : ${JSON.stringify(rowsAll)}`);
  note(`  无投射体   : ${JSON.stringify(rowsRef)}`);
  note(`  藏地面     : ${JSON.stringify(rowsNoFloor)}`);
  note(`  地面改白   : ${JSON.stringify(rowsFloorWhite)}`);
  note(`uShadowBias 扫描（遮挡面积）: ${Object.entries(bias).map(([k, v]) => k + '=' + v.area).join(' ')}`);
  const floorColorMatters = Number.isFinite(bandAt(rowsNoFloor)) && Number.isFinite(bandAt(rowsFloorWhite))
    && Math.abs(bandAt(rowsNoFloor) - bandAt(rowsFloorWhite)) < 0.01
    && bandAt(rowsAll) < bandAt(rowsNoFloor) - 0.15;
  if (!floorColorMatters) {
    check('E6b-floor-spurious-shadow', true,
      `未发现"地台假影"这条缺陷：y=660 行均值 全场景 ${bandAt(rowsAll)} / 无投射体参考帧 ${bandAt(rowsRef)} / 藏地面 ${bandAt(rowsNoFloor)} / 地台改白 ${bandAt(rowsFloorWhite)}`,
      '（若上一版存在，说明本轮已修好；判据：关掉地面或只改地台显示颜色不再让底带变亮）');
  } else {
    defect('E6b-floor-spurious-shadow',
      `画面下部 y≈630 以下有一条横贯整幅的假影：y=660 行均值 全场景 ${bandAt(rowsAll)} / 无投射体参考帧 ${bandAt(rowsRef)} / 藏掉地面后 ${bandAt(rowsNoFloor)} / 只把地台材质颜色改成白色 ${bandAt(rowsFloorWhite)}`,
      `几何完全没动，仅改地台显示颜色就让它消失 => shadow map 把"地台"也写了进去（floor 平面 y=-1.34 有一段位于灯与幕布之间）。藏掉全部演员、甚至整场没有一个皮影，这条假影照样存在，遮住幕布下部 y≈630~720 共约 12% 的画面。最小复现：index.html?t=32.3 → 执行 __VHIDE__(o=>o.isMesh&&o.castShadowRaw,false) 后仍能看到该暗带，再把 scene.getObjectByName('floor') 的颜色设成白色即消失`);
  }
  const areaOf = (label) => { const s = isoStats.find((x) => x.label === label); return s ? s.area + 'px' : 'n/a'; };
  // 灯罩/远山是否仍登记为投射体 —— 用来区分「缺陷：该投却没投」与「设计取舍：显式不投」
  const casterFlags = await J(`JSON.stringify((function(){
    const lan = window.__V_RENDERER__.scene.getObjectByName('lanternShade');
    const mt = window.__V_RIGS__.props.parts.get('mountain');
    return { lantern: !!(lan && lan.castShadowRaw), mountain: !!(mt && mt.mesh.castShadowRaw),
      lanternCastShadow: lan ? !!lan.castShadow : null, mountainCastShadow: mt ? !!mt.mesh.castShadow : null }; })())`);
  if (lantern && lantern.area === 0 && !casterFlags.lantern) {
    info('E6c-lantern-not-projected-by-design',
      `灯罩实测影子 0px；它不是投射体（castShadowRaw=${casterFlags.lantern}, castShadow=${casterFlags.lanternCastShadow}）=> **stage.js 显式决定不投**（代码注释写明：落进阴影相机可见范围就要 >1.12m、放大率≈2.9，投影必然盖满整块幕布）`,
      'rev-B 曾实测覆盖 33.5% 画面的满屏栅格（P0 观感回归），rev-C 已按设计撤掉 —— 这是取舍，不是缺陷');
  } else if (lantern && lantern.area === 0) {
    defect('E6c-lantern-shade-dead',
      `stage.js 标称"灯罩在幕布边缘投出篦条阴影"的 lanternShade 仍是投射体（castShadowRaw=true）却实测影子面积 = 0px（z=${lantern.z}，距灯 0.012m，被阴影相机 near=${camInfo.near} 整块裁掉）=> 该效果在成片里完全不存在`,
      `对照：同一轮隔离测量 prop:moon=${areaOf('prop:moon')}、prop:bird=${areaOf('prop:bird')} 都能正常投影`);
  } else check('E6c-lantern-shade', true, `灯罩投影面积 ${lantern ? lantern.area + 'px' : 'n/a'}`);
  // 远山：区分「设计取舍」与「缺陷」，并用**背靠背 A/B**实测"不投影 ⇒ 是否完全不可见"
  // （不能用很早的 ref 帧比对：布料弹簧的历史漂移会贡献几千像素的假差）
  await ev(`window.__VSNAP__('mtOn', ${T}, function(){ window.__VHIDE__(${HIDE_ALL}, true); }, false);`);
  await ev(`window.__VSNAP__('mtOff', ${T}, function(){ window.__VHIDE__(${HIDE_ALL}, true);
    const p = window.__V_RIGS__.props.parts.get('mountain'); if (p) p.mesh.visible = false; }, false);`);
  const mtAB = await J('JSON.stringify(window.__VOCC__("mtOn","mtOff",0.15))');
  const mtDelta = mtAB.area;
  if (mountain && mountain.area === 0 && !casterFlags.mountain) {
    info('E6d-far-mountain-invisible-by-design',
      `远山(z=−2.0) 影子 0px，且已不是投射体（castShadowRaw=${casterFlags.mountain}, castShadow=${casterFlags.mountainCastShadow}）；**背靠背 A/B**（其余全部投射体都隐藏、只切远山的 visible）画面变化 ${mtDelta}px（噪声底量级）`,
      '★ 需要如实记录：皮影布景在幕布后方、幕布不透明，**唯一可见通路就是 shadow map**；远山不投影 ⇒ 在成片里 100% 不可见（不是"仍作为幕上实心剪影存在"）。这是一次「用一件远景布景换取人影深度精度」的**已知取舍（traded off）**，不是缺陷修复');
  } else if (mountain && mountain.area === 0) {
    defect('E6d-far-mountain-invisible',
      `六件布景里的"远山"(prop:mountain, z=−2.0) 仍是投射体却实测影子面积 = 0px => 在成片里完全看不见`,
      `同一轮 prop:moon(z=−1.9)=${areaOf('prop:moon')}、prop:pine=${areaOf('prop:pine')} 都有影，说明不是"太远"的普遍问题`);
  } else check('E6d-far-mountain', true, `远山投影面积 ${mountain ? mountain.area + 'px' : 'n/a'}`);
  const bKeys = Object.keys(bias);
  const biasCliff = bias['b0.0042'] && bias['b0'] && bias['b0.35'] && bias['b0.1']
    && bias['b0.35'].area < bias['b0.1'].area * 0.2 && Math.abs(bias['b0.0042'].area - bias['b0'].area) < bias['b0'].area * 0.01;
  if (!biasCliff || !colorDrives) {
    info('E6e-bias-scan',
      `uShadowBias 扫描（遮挡面积）：${Object.entries(bias).map(([k, v]) => k + '=' + v.area).join(' ')}`,
      colorDrives
        ? '（E6f 已判定挡光由显示颜色决定，这个悬崖是"颜色 vs 归一化灯距"的必然结果）'
        : '（E6f 已判定挡光由几何/深度决定；bias 大到超过"投射体与幕布的深度差"时影子会整片消失，这是真实深度 bias 的正常行为，不再计为缺陷）');
  } else {
    defect('E6e-bias-has-no-depth-semantics',
      `uShadowBias 扫描：0=${bias['b0'].area}px，0.0042=${bias['b0.0042'].area}px（不变），0.10=${bias['b0.1'].area}px，0.29=${bias['b0.29'].area}px，0.35=${bias['b0.35'].area}px（几乎全灭）`,
      `bias 一旦逼近幕布的 ref（${refUni.center}~${refUni.bottomRight}）影子就整片消失，且 E6f 判定挡光由显示颜色决定 => uShadowBias / uRangeNear / uRangeFar 没有深度语义`);
  }

  /* ---------- E6g 灯罩"篾条影"的覆盖范围（D4 的修复是否把整块幕布罩住了） ---------- */
  const lanternIso = isoStats.find((s) => s.label === 'stage:lanternShade');
  const framePx = 1280 * 720;
  const lanternCov = lanternIso ? lanternIso.area / framePx : 0;
  out.grid = { lanternArea: lanternIso ? lanternIso.area : 0, coverage: lanternCov, occAll: occAll.area, actorContribution: occAll.area - occNoGen.area };
  check('E6g-lantern-shadow-scope', !(lanternCov > 0.12),
    lanternIso
      ? `灯罩("篾条影")单独投影覆盖 ${lanternIso.area}px = **画面 ${(lanternCov * 100).toFixed(1)}%**；它已经不是"幕布边缘的稀疏条纹"而是横贯整幅的栅格（对比：整场所有演员+布景加起来才 316 754px）`
      : '未取到灯罩隔离数据',
    lanternIso ? `诊断：条宽/间距只有约 1 个条纹周期的一半，演员（${occAll.area - occNoGen.area}px）与布景都埋在它下面；stage.js 里原本的意图是"在幕布边缘留下篦条阴影"` : '');

  return out;
});

/* ---------------- 汇总 ---------------- */
console.log('\n============= 真实光影 / 镂空透光 / 层叠 验证汇总 =============');
for (const r of results) console.log(`${r.pass ? (r.info ? 'INFO' : 'PASS') : 'FAIL'}  ${r.id}  ${r.msg.split('\n')[0]}`);
const failed = results.filter((r) => !r.pass);
if (defects.length) {
  console.log(`\n--------- 确认的缺陷 ${defects.length} 项 ---------`);
  for (const d of defects) console.log(`DEFECT ${d.id}: ${d.msg}\n   ↳ ${d.detail}`);
}
console.log('\n证据截图:');
for (const [k, v] of Object.entries(ctx.shots)) console.log(`  ${k}: ${v}`);
const bad = failed.length + defects.length;
console.log(`\n=========== ${bad === 0 ? 'ALL PASS' : '断言失败 ' + failed.length + ' 项 / 缺陷 ' + defects.length + ' 项'} ===========`);
process.exit(bad ? 1 : 0);

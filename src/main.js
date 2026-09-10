// 影窗 · 夜巡 —— 入口与装配
import * as THREE from 'three';
import { Renderer } from './renderer.js';
import { Stage } from './stage.js';
import { WaveScreen } from './screen.js';
import { makeFabricTexture } from './textures.js';
import { Rig } from './rig.js';
import { buildGeneral, buildCavalry, buildProps } from './puppet.js';
import { buildTimeline, PERFORMANCE } from './choreography.js';

const qs = new URLSearchParams(location.search);
const SCREEN_W = 4.0, SCREEN_H = 2.5, LIGHT_FAR = 12;

const state = {
  t: 0,
  playing: qs.get('paused') !== '1',
  rate: parseFloat(qs.get('rate') || '1') || 1,
  loop: qs.get('loop') !== '0',
  view: qs.get('view') || 'shadow',   // shadow | raw
  ready: false,
  debug: qs.get('debug') === '1',
};

let renderer, stage, screen, rigs = {}, timeline, props = null;
const el = {};

function $(id) { return document.getElementById(id); }

function initDOM() {
  el.canvas = $('stage-canvas');
  el.title = $('perf-title');
  el.actName = $('act-name');
  el.actBar = $('act-bar');
  el.sub = $('subtitle');
  el.playBtn = $('btn-play');
  el.scrub = $('scrub');
  el.time = $('time-label');
  el.hint = $('hint');
  el.loading = $('loading');
  el.loadingMsg = $('loading-msg');
  el.fps = $('fps');
}

function setLoading(msg) {
  if (el.loadingMsg) el.loadingMsg.textContent = msg;
}

async function build() {
  setLoading('正在配制牛皮…');
  await new Promise((r) => requestAnimationFrame(r));

  renderer = new Renderer(el.canvas, { width: 1280, height: 720, pixelRatio: 1 });
  stage = new Stage({ screenWidth: SCREEN_W, screenHeight: SCREEN_H, lightFar: LIGHT_FAR });
  renderer.scene.add(stage.group);

  setLoading('正在上幕布…');
  await new Promise((r) => requestAnimationFrame(r));

  const fabric = makeFabricTexture(1024);
  screen = new WaveScreen({ width: SCREEN_W, height: SCREEN_H, segX: 160, segY: 100, fabric });
  screen.bindRenderer(renderer.renderer);
  renderer.scene.add(screen.mesh);

  setLoading('正在雕刻镂空花纹…');
  await new Promise((r) => requestAnimationFrame(r));

  // 主光绑定（阴影贴图由 screen 负责，因为只有幕布需要采样它）
  screen.attachLight(stage.light, { lightFar: LIGHT_FAR, shadowSize: 2048, clothDiffusion: 0.062 });

  // 皮影演员。初始位置只是兜底：每帧 applyTime() 会用 Frame 里的 tx/ty/tz/ry/rz 覆写。
  // 基线值必须与 choreography.js 的 BASE 一致（见 INTERFACES.md B.2 的字段语义）。
  const general = new Rig({ lightFar: LIGHT_FAR });
  buildGeneral(general);
  general.root.position.set(0, -1.06, -0.25);
  renderer.scene.add(general.root);
  rigs.general = general;

  const shadowMan = new Rig({ lightFar: LIGHT_FAR });
  buildCavalry(shadowMan);
  shadowMan.root.position.set(0, -1.06, -0.55);
  renderer.scene.add(shadowMan.root);
  rigs.cavalry = shadowMan;

  setLoading('正在布置布景…');
  await new Promise((r) => requestAnimationFrame(r));

  props = buildProps(renderer.scene, LIGHT_FAR);
  rigs.props = props.rig;

  setLoading('正在说戏…');
  await new Promise((r) => requestAnimationFrame(r));

  timeline = buildTimeline();
  state.ready = true;

  if (el.title) el.title.textContent = PERFORMANCE.title;
  buildActBar();
  onResize();
  addEventListener('resize', onResize);
  bindUI();

  // 初始时间
  const t0 = parseFloat(qs.get('t'));
  if (Number.isFinite(t0)) { state.t = t0; state.playing = false; }
  applyTime(state.t);
  hideLoading();
}

function buildActBar() {
  if (!el.actBar) return;
  el.actBar.innerHTML = '';
  for (const act of PERFORMANCE.acts) {
    const b = document.createElement('button');
    b.className = 'act-chip';
    b.textContent = `${act.id}·${act.name}`;
    b.title = `${act.t0.toFixed(1)}s – ${act.t1.toFixed(1)}s`;
    b.addEventListener('click', () => { seek(act.t0 + 0.4); });
    b.dataset.act = act.id;
    el.actBar.appendChild(b);
  }
}

function hideLoading() {
  if (!el.loading) return;
  el.loading.classList.add('gone');
  setTimeout(() => el.loading && el.loading.remove(), 900);
}

function onResize() {
  if (!renderer) return;
  const box = el.canvas.parentElement.getBoundingClientRect();
  const maxW = Math.max(360, Math.floor(box.width));
  const maxH = Math.max(240, Math.floor(box.height));
  const ar = 16 / 9;
  let w = maxW, h = Math.round(w / ar);
  if (h > maxH) { h = maxH; w = Math.round(h * ar); }
  el.canvas.style.width = w + 'px';
  el.canvas.style.height = h + 'px';
  renderer.setSize(w, h, 1);
}

function bindUI() {
  el.playBtn.addEventListener('click', togglePlay);
  el.scrub.addEventListener('input', () => {
    state.playing = false;
    syncPlayBtn();
    seek(parseFloat(el.scrub.value) / 1000 * PERFORMANCE.duration);
  });
  addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.code === 'ArrowRight') seek(state.t + 1.0);
    if (e.code === 'ArrowLeft') seek(state.t - 1.0);
    if (e.code === 'KeyD') { state.debug = !state.debug; screen.mesh.material.wireframe = false; toggleDebugPanel(); }
    if (e.code === 'KeyV') {
      state.view = state.view === 'shadow' ? 'raw' : 'shadow';
      if (el.hint) el.hint.textContent = state.view === 'shadow' ? '' : '原始场景（未做后期）';
    }
  });
  if (el.hint) {
    el.hint.textContent = '空格 播放/暂停 · ←→ 逐秒 · 点击幕次跳转';
  }
}

function toggleDebugPanel() {
  let p = document.getElementById('debug-panel');
  if (p) { p.remove(); return; }
  p = document.createElement('pre');
  p.id = 'debug-panel';
  p.style.cssText = 'position:absolute;left:12px;bottom:12px;font:11px/1.45 ui-monospace,monospace;color:#ffd9a0;background:rgba(20,8,2,.72);padding:8px 10px;border:1px solid rgba(255,180,90,.25);border-radius:6px;z-index:9;pointer-events:none';
  document.getElementById('app').appendChild(p);
  el.debugPanel = p;
}

function togglePlay() {
  state.playing = !state.playing;
  syncPlayBtn();
}
function syncPlayBtn() {
  if (el.playBtn) el.playBtn.textContent = state.playing ? '⏸' : '▶';
}

function seek(t) {
  state.t = Math.max(0, Math.min(PERFORMANCE.duration, t));
  applyTime(state.t);
}

/**
 * 把场景精确设置到 t 秒并刷新一帧 —— QA 截图与人工拖拽都走这条路，保证确定性。
 */
function applyTime(t) {
  const f = timeline.sample(t);

  // 演员
  for (const key in f.actors) {
    const a = f.actors[key];
    const rig = rigs[key];
    if (!rig) continue;
    rig.root.visible = a.visible !== false;
    rig.setRootTransform(a.root.tx, a.root.ty, a.root.rz, a.root.tz || 0, a.root.ry || 0);
    rig.setPose(a.pose);
    rig._elapsed = t;
    rig.setWind(a.wind ? a.wind[0] : 0, a.wind ? a.wind[1] : 0);
    if (a.opacity) for (const k in a.opacity) rig.setPartOpacity(k, a.opacity[k]);
    if (a.visibleParts) for (const k in a.visibleParts) rig.setPartVisible(k, a.visibleParts[k]);
    rig.update(f.dt);
  }

  // 灯光
  stage.setLight({
    intensity: f.light.intensity,
    color: f.light.color,
    pos: f.light.pos,
    flicker: f.light.flicker,
  });

  // 道具
  if (props && f.props) props.apply(f.props, t);

  // UI
  if (el.sub) {
    el.sub.textContent = f.subtitle || '';
    el.sub.classList.toggle('show', !!f.subtitle);
  }
  if (el.actName) {
    const act = PERFORMANCE.acts.find((a) => t >= a.t0 && t < a.t1) || PERFORMANCE.acts[PERFORMANCE.acts.length - 1];
    el.actName.textContent = `${act.id} · ${act.name}`;
    for (const chip of el.actBar.querySelectorAll('.act-chip')) {
      chip.classList.toggle('on', chip.dataset.act === act.id);
    }
  }
  if (el.time) el.time.textContent = `${t.toFixed(1)}s / ${PERFORMANCE.duration.toFixed(0)}s`;
  if (el.scrub) el.scrub.value = String(Math.round(t / PERFORMANCE.duration * 1000));
}

let lastTs = 0, fpsAcc = 0, fpsN = 0, fpsShown = 0;

function frame(ts) {
  requestAnimationFrame(frame);
  if (!state.ready) return;
  const dtReal = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 1 / 60;
  lastTs = ts;

  if (state.playing) {
    state.t += dtReal * state.rate;
    if (state.t > PERFORMANCE.duration) {
      state.t = state.loop ? 0 : PERFORMANCE.duration;
      if (!state.loop) { state.playing = false; syncPlayBtn(); }
    }
  }
  // 布料/次级运动用固定步长推进，保证确定性
  applyTime(state.t);

  // 阴影贴图：先渲染投射体到灯视角
  screen.update(dtReal, stage.light, renderer.camera);
  screen.renderShadow(renderer.scene);

  renderer.render(dtReal);

  // 调试面板
  if (state.debug && el.debugPanel) {
    const s = renderer.stats();
    el.debugPanel.textContent = [
      `t=${state.t.toFixed(2)}s  act=${el.actName ? el.actName.textContent : '-'}`,
      `draw calls=${s.drawCalls}  tris=${s.tris}`,
      `shadow casters=${screen.shadowCasterCount}`,
      `bloom levels=${s.bloomLevels}  hdr=${s.hdr}  webgl2=${s.webgl2}`,
      `buffer=${s.drawingBuffer.join('x')}`,
    ].join('\n');
  }

  fpsAcc += dtReal; fpsN++;
  if (fpsAcc >= 0.5) {
    fpsShown = Math.round(fpsN / fpsAcc);
    if (el.fps) el.fps.textContent = fpsShown + ' fps';
    fpsAcc = 0; fpsN = 0;
  }
}

/* ------------------------------------------------------------------ *
 * QA / 自动化接口
 * ------------------------------------------------------------------ */
window.__SET_TIME__ = (t) => { state.playing = false; syncPlayBtn(); seek(t); return state.t; };
window.__SET_VIEW__ = (v) => { state.view = v; return state.view; };
window.__PLAY__ = (on) => { state.playing = !!on; syncPlayBtn(); return state.playing; };
window.__FRAME_COUNT__ = () => (renderer ? renderer.stats().frame : 0);

window.__qa = () => {
  const s = renderer ? renderer.stats() : {};
  const casters = screen ? screen.shadowCasterCount : 0;
  const acts = PERFORMANCE.acts.map((a) => ({ id: a.id, name: a.name, t0: a.t0, t1: a.t1 }));
  return {
    ready: state.ready,
    t: state.t,
    duration: PERFORMANCE.duration,
    title: PERFORMANCE.title,
    view: state.view,
    stats: s,
    shadowCasters: casters,
    timeline: timeline.debug ? timeline.debug() : null,
    acts,
    subtitle: el.sub ? el.sub.textContent : '',
    casterWords: casters,
    webgl2: renderer ? renderer.isWebGL2 : false,
    renderer: renderer ? (function () {
      const dbg = renderer.renderer.getContext().getExtension('WEBGL_debug_renderer_info');
      const gl = renderer.renderer.getContext();
      return {
        version: gl.getParameter(gl.VERSION),
        unmasked: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
        toneMapping: renderer.renderer.toneMapping,
      };
    })() : null,
  };
};

/** 导出当前帧为 PNG dataURL（自动化截图用） */
window.__snapshot = () => el.canvas.toDataURL('image/png');

/** 逐帧推进（确定性），供自动化生成动画 */
window.__STEP__ = (t, dt = 1 / 60) => {
  state.playing = false;
  const end = t;
  let cur = state.t;
  const n = Math.max(1, Math.round((end - cur) / dt));
  const step = (end - cur) / n;
  for (let i = 0; i < n; i++) {
    cur += step;
    state.t = cur;
    applyTime(cur);
    screen.update(step, stage.light, renderer.camera);
    screen.renderShadow(renderer.scene);
    renderer.render(step);
  }
  return state.t;
};

/* ---------------- 启动 ---------------- */
/** 把失败信息同时写进加载层与 window，看门狗和自动化都能拿到 */
function reportFatal(e) {
  const msg = String((e && (e.stack || e.message)) || e);
  window.__BUILD_ERROR__ = msg;
  console.error(e);
  if (el.loadingMsg) el.loadingMsg.textContent = '出错了：' + ((e && e.message) || e);
}

try {
  initDOM();
} catch (e) {
  window.__BUILD_ERROR__ = '初始化界面失败：' + String(e && (e.stack || e.message) || e);
}

build().then(() => {
  syncPlayBtn();
  requestAnimationFrame(frame);
  window.__READY__ = true;
}).catch(reportFatal);

// 兜底：无论成功失败，15 秒后一定把加载层去掉（成功时它早就已经淡出了）
setTimeout(() => { try { hideLoading(); } catch (_) {} }, 15000);

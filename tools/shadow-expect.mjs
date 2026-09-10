import { withPage, sleep } from './harness.mjs';

const r = await withPage({
  page: 'tools/shadow-compare.html', width: 340, height: 200, readyTimeout: 60000, logConsole: true,
}, async (page) => {
  await page.waitReady();
  await sleep(1000);
  // 用真实相机/灯/project 关系，算出演员在幕布上的影子应该落在屏幕哪个像素，并采样
  return await page.eval(`JSON.stringify((function(){
    const S = window.__SCREEN__, RR = window.__RENDERER__, R = RR.renderer;
    const THREE = window.__THREE__;
    const stage = window.__STAGE__;
    if (!THREE) return { no: 'no THREE' };

    // 手动重算：演员(世界) -> 灯投影 UV -> shadow map 值
    const light = S.light;
    const lv = S.uniforms.uLightView.value, lp = S.uniforms.uLightProjection.value;
    const rn = S.uniforms.uRangeNear.value, rf = S.uniforms.uRangeFar.value;
    const info = { rangeNear: +rn.toFixed(3), rangeFar: +rf.toFixed(3), far: S.uniforms.uFarPlane.value };

    // 演员在世界里的位置（从场景里找 mesh）
    const meshes = [];
    RR.scene.traverse(o => { if (o.isMesh && o.castShadowRaw) meshes.push(o); });
    info.casters = meshes.map(m => m.name || '(anon)');
    const m0 = meshes.find(m => (m.name || '').length === 0) || meshes[0];
    const wp = new THREE.Vector3();
    m0.getWorldPosition(wp);
    info.actorWorld = wp.toArray().map(v => +v.toFixed(3));

    // 世界 -> 灯光 UV
    const clip = new THREE.Vector4(wp.x, wp.y, wp.z, 1).applyMatrix4(lv).applyMatrix4(lp);
    const suv = [clip.x/clip.w*0.5+0.5, clip.y/clip.w*0.5+0.5];
    info.actorLightUV = suv.map(v => +v.toFixed(4));
    const viewDist = -(new THREE.Vector4(wp.x, wp.y, wp.z, 1).applyMatrix4(lv)).z;
    info.actorViewDist = +viewDist.toFixed(3);
    info.actorRef = +((viewDist - rn) / (rf - rn)).toFixed(4);

    // 读 shadow map 在该 UV 的像素
    const rt = S.shadowStage.map;
    const px = Math.floor(suv[0] * rt.width), py = Math.floor(suv[1] * rt.height);
    const buf = new Uint8Array(4);
    R.readRenderTargetPixels(rt, px, py, 1, 1, buf);
    info.shadowMapAtActor = { px, py, val: buf[0] };

    // 演员的投影点到屏幕的位置：把 actor 的 z 换到幕布上 (z=0) 再投 screen
    const shadowWorld = new THREE.Vector3();
    const L = light.getWorldPosition(new THREE.Vector3());
    const t = (0 - L.z) / (wp.z - L.z);
    shadowWorld.set(L.x + (wp.x - L.x) * t, L.y + (wp.y - L.y) * t, 0);
    const sp = shadowWorld.clone().project(RR.camera);
    info.shadowOnScreen = [+((sp.x*0.5+0.5)).toFixed(3), +((sp.y*0.5+0.5)).toFixed(3)];
    info.screenPx = [Math.round((sp.x*0.5+0.5) * 960), Math.round((sp.y*0.5+0.5) * 540)];
    return info;
  })())`);
});
console.log(JSON.stringify(JSON.parse(r), null, 2));
process.exit(0);

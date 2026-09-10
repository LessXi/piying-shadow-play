import { withPage, sleep } from './harness.mjs';

const r = await withPage({
  page: 'tools/probe-screen.html', width: 960, height: 540, readyTimeout: 90000, logConsole: true,
}, async (page) => {
  await page.waitReady();
  await sleep(2500);
  const info = await page.eval(`JSON.stringify((function(){    const RR = window.__RENDERER__, S = window.__SCREEN__, THREE = window.__THREE__;
    const cam = RR.camera;
    const out = {
      cam: { pos: cam.position.toArray(), fov: cam.fov, aspect: +cam.aspect.toFixed(4), near: cam.near, far: cam.far },
      canvas: [RR.renderer.domElement.width, RR.renderer.domElement.height],
      screen: { w: S.width, h: S.height, pos: S.mesh.position.toArray() },
    };
    // 把屏幕四角投到 NDC
    const hw = S.width/2, hh = S.height/2;
    out.corners = [[-hw,-hh],[hw,-hh],[hw,hh],[-hw,hh]].map(([x,y]) => {
      const v = new THREE.Vector3(x, y, 0).project(cam);
      return [+v.x.toFixed(3), +v.y.toFixed(3)];
    });
    // 取景框在屏幕平面(z=0)上的可视范围
    const d = cam.position.z;
    const vh = 2 * d * Math.tan(cam.fov * Math.PI / 360);
    out.visibleAtScreen = { height: +vh.toFixed(3), width: +(vh * cam.aspect).toFixed(3) };
    // veil 部件
    const vp = [];
    RR.scene.traverse(o => { if (o.name && o.name.startsWith('veil')) vp.push({ n: o.name, pos: o.position.toArray().map(v=>+v.toFixed(2)), size: [o.geometry.parameters.width, o.geometry.parameters.height] }); });
    out.veilParts = vp;
    return out;
  })())`);
  console.log(JSON.stringify(JSON.parse(info), null, 2));
  process.exit(0);
});

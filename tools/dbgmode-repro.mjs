import { withPage } from './harness.mjs';

const r = await withPage({ page: 'tools/dbgmode-repro.html', width: 340, height: 200, readyTimeout: 60000, logConsole: true },
  async (page) => {
    await page.waitReady();
    return await page.eval(`JSON.stringify((function(){
      const S = window.__SCREEN__, RR = window.__RENDERER__, R = RR.renderer;
      const mat = S.material;
      const gl = R.getContext();
      const prog = R.properties.get(mat).currentProgram;
      const glp = prog.program;

      // 直接跑一次 GLSL，输出纯红，看画面是否变红 —— 判定 quad 是否真的走了我们的 shader
      const res = { progName: prog.name, matName: mat.name };

      // 取 uniform 的 location 并手动上传 uDebug=9
      const loc = gl.getUniformLocation(glp, 'uDebug');
      res.hasLoc = !!loc;

      // 列出所有 ACTIVE uniform 名字
      const n = gl.getProgramParameter(glp, gl.ACTIVE_UNIFORMS);
      const names = [];
      for (let i = 0; i < n; i++) { const u = gl.getActiveUniform(glp, i); if (u) names.push(u.name); }
      res.activeUniforms = names;

      // 诊断：把 uDebug 设成 9 后连续渲染两次，并读默认帧缓冲
      S.setDebugMode(9);
      S.update(1/60, S.light, RR.camera);
      S.renderShadow(RR.scene);
      RR.render(1/60);
      const px = new Uint8Array(4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(160, 90, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      res.pxAfterMode9 = Array.from(px);
      return res;
    })())`);
  });
console.log(JSON.stringify(JSON.parse(r), null, 2));
process.exit(0);

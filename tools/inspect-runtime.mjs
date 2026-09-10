import { withPage, sleep } from './harness.mjs';

const r = await withPage({
  page: 'tools/probe-screen.html', width: 240, height: 135, readyTimeout: 60000, logConsole: true,
}, async (page) => {
  await page.waitReady();
  await sleep(2000);
  return await page.eval(`JSON.stringify((function(){
    const S = window.__SCREEN__, RR = window.__RENDERER__, R = RR.renderer;
    const mat = S.material;
    const fs = mat.fragmentShader;
    const src = mat.fragmentShader;

    // uniform 指针
    let ptr = null;
    try { ptr = R.properties.get(mat).uniformsList ? R.properties.get(mat).uniformsList.map(u => u.id) : null; } catch (e) { ptr = 'err:' + e.message; }

    const prog = R.properties.get(mat).currentProgram;
    const gl = R.getContext();
    let uniformInfo = null;
    if (prog) {
      const glp = prog.program;
      const n = gl.getProgramParameter(glp, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const u = gl.getActiveUniform(glp, i);
        if (u && u.name === 'uDebug') uniformInfo = { name: u.name, type: u.type, size: u.size };
      }
    }
    return {
      hasDebugBlockInSource: fs.includes('uDebug > 0.5'),
      debugBlockIndex: fs.indexOf('uDebug > 0.5'),
      mainIndex: fs.indexOf('void main()'),
      sourceLen: fs.length,
      uniformsObjectHasDebug: 'uDebug' in mat.uniforms,
      uniformsDebugValue: mat.uniforms.uDebug.value,
      shaderSideUDebug: S.uniforms.uDebug.value,
      sameObject: mat.uniforms === S.uniforms,
      uniformInfo,
      programsVersion: R.properties.get(mat).currentProgram ? R.properties.get(mat).currentProgram.id : null,
      materialVersion: mat.version,
    };
  })())`);
});
console.log(JSON.stringify(JSON.parse(r), null, 2));
process.exit(0);

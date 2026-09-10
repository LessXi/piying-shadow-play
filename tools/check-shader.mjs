import { withPage, sleep } from './harness.mjs';

const r = await withPage({
  page: 'tools/probe-screen.html', width: 960, height: 540, readyTimeout: 90000, logConsole: true,
}, async (page) => {
  await page.waitReady();
  await sleep(2500);
  return await page.eval(`JSON.stringify((function(){
    const S = window.__SCREEN__, RR = window.__RENDERER__, R = RR.renderer;
    const fs = S.material.fragmentShader;
    return {
      shaderLen: fs.length,
      hasRedBlock: fs.includes('gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0)'),
      hasDebugGate: fs.includes('if (uDebug > 4.5 && uDebug < 5.5)'),
      hasShadowBlock: fs.includes('if (uDebug > 0.5)'),
      hasMixCol: fs.includes('vec3 col = mix(ambient, lit, shadow)'),
      hasComputeCall: fs.includes('float shadow = computeShadow();'),
      debugGateIdx: fs.indexOf('if (uDebug > 4.5 && uDebug < 5.5)'),
      shadowBlockIdx: fs.indexOf('if (uDebug > 0.5)'),
      colAssignIdx: fs.indexOf('gl_FragColor = vec4(col, 1.0);'),
      screenVisible: S.mesh.visible,
      screenInScene: (function(){ let f = false; RR.scene.traverse(o => { if (o === S.mesh) f = true; }); return f; })(),
      screenPos: S.mesh.position.toArray(),
      matSide: S.material.side,
      uDebugNow: S.uniforms.uDebug.value,
    };
  })())`);
});
console.log(JSON.stringify(JSON.parse(r), null, 2));
process.exit(0);

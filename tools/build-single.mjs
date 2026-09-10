// 把整个项目打成**单文件** index.html：three.js 与所有 src 模块内联进一个经典 <script>。
//
// 为什么必须这么做：Chrome / Edge 会以 CORS 为由**拒绝从 file:// 加载 ES module**
//   Access to script at 'file:///…/src/main.js' from origin 'null' has been blocked by CORS policy
// 所以"双击 index.html"这种最自然的打开方式下，原来的多文件 ES module 版本根本不会执行，
// 页面会永远停在静态加载文案上。单文件 + 经典脚本不涉及任何跨源请求，因此没有这个限制。
//
// 做法：把每个模块包进一个 IIFE，模块内部的 const/let/function 都留在自己的作用域里，
// 只把 export 出去的名字挂进一个命名空间表。这样既保留了 ES module 的隔离语义
// （否则 three.js 的 clamp/mix/lerp 会和 ease.js 的同名函数撞车），又不需要真正的打包器。
//
// 这是构建工具，不参与运行。改动 src/ 之后重新跑一次：
//   node tools/build-single.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = process.cwd();
const OUT = process.argv[2] || 'index.html';

// 依赖顺序：被依赖的必须在前（这几行就是整个项目的依赖图）
// ★ props.js 必须在 puppet.js 之前：puppet.js 会 re-export buildProps 以保持
//   历史导入路径兼容，所以它的求值依赖 props 模块已经就绪。
const ORDER = [
  'vendor/three.module.js',
  'src/textures.js',
  'src/materials.js',
  'src/rig.js',
  'src/shapes.js',
  'src/props.js',
  'src/puppet.js',
  'src/ease.js',
  'src/choreography.js',
  'src/screen.js',
  'src/compositor.js',
  'src/renderer.js',
  'src/stage.js',
  'src/main.js',
];

const SRC_ALIASES = {   // 模板写法 → 物理文件（用于将来的兼容层，目前为空）
};

/** 模块 id：路径 → 合法标识符片段 */
const modId = (i, rel) => `__m${i}_${path.basename(rel).replace(/[^a-zA-Z0-9]/g, '_')}`;

function parseModule(code, rel) {
  const exports = new Set();
  const exportAll = [];       // export * from '...'（本项目没用到，但保留处理）

  let body = code
    .replace(/\/\/#\s*sourceMappingURL=.*$/gm, '')
    // export { a, b as c } [from '...'] → 只记录名字，语句本身删掉
    .replace(/^[ \t]*export\s*\{([^}]*)\}\s*(?:from\s*['"][^'"]+['"]\s*)?;?[ \t]*$/gm, (m, names) => {
      for (const part of names.split(',')) {
        const t = part.trim();
        if (!t) continue;
        const as = t.split(/\s+as\s+/);
        exports.add((as[1] || as[0]).trim());
      }
      return '';
    })
    .replace(/^[ \t]*export\s*\*\s*from\s*['"][^'"]+['"]\s*;?[ \t]*$/gm, (m) => { exportAll.push(m); return ''; })
    // export default X → __default
    .replace(/^([ \t]*)export\s+default\s+/gm, (m, ind) => { exports.add('__default'); return ind + 'const __default = '; })
    // export const|let|var|function|class|async function
    .replace(/^([ \t]*)export\s+(const|let|var|function|class|async\s+function)\s+([A-Za-z_$][\w$]*)/gm,
      (m, ind, kind, name) => { exports.add(name); return `${ind}${kind} ${name}`; });

  // 收集 import：**逐行状态机**，正确处理多行 import（例如 puppet.js 里的
  //   import {
  //     a, b,
  //   } from './shapes.js';
  // 用单个正则很容易要么匹配不全、要么贪婪跨行吞掉后面的代码，所以按行扫。
  const imports = [];
  {
    const out = [];
    const srcLines = body.split('\n');
    for (let i = 0; i < srcLines.length; i++) {
      const line = srcLines[i];
      if (!/^[ \t]*import\b/.test(line)) { out.push(line); continue; }
      // 收集到一个完整语句（以 ; 结尾，或包含 from '...'）
      let stmt = line;
      let j = i;
      while (!/;\s*$/.test(stmt) && !/from\s*['"][^'"]+['"]\s*;?\s*$/.test(stmt) && j + 1 < srcLines.length) {
        j++;
        stmt += '\n' + srcLines[j];
      }
      i = j;
      const fromM = /from\s*['"]([^'"]+)['"]/.exec(stmt);
      if (!fromM) continue;                       // 裸 import 'x' → 直接丢弃
      const spec = fromM[1];
      const clause = stmt.replace(/^[ \t]*import\s*/, '').replace(/from[\s\S]*$/, '').trim();
      const parts = clause.replace(/[{}]/g, ' ').split(',').map((s) => s.trim()).filter(Boolean);
      for (const p of parts) {
        if (p.startsWith('*')) { imports.push({ ns: p.replace(/^\*\s*as\s*/, '').trim(), mod: spec }); continue; }
        const as = p.split(/\s+as\s+/);
        imports.push({ name: (as[1] || as[0]).trim(), orig: as[0].trim(), mod: spec });
      }
    }
    body = out.join('\n');
  }

  return { body, exports, imports };
}

// ---- 第一遍：解析所有模块，建立 id 与导出表 ----
const byPath = new Map();          // 规范化相对路径 → 模块
const mods = [];
ORDER.forEach((rel, i) => {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error('缺少文件: ' + rel);
  const code = fs.readFileSync(abs, 'utf8');
  const parsed = parseModule(code, rel);
  const norm = rel.replace(/\\/g, '/');
  const m = { rel: norm, idx: i, id: modId(i, rel), ...parsed };
  mods.push(m);
  byPath.set(norm, m);
});

/** 把模块里的 import 说明符解析成我们的模块（支持 'three' 与相对路径） */
function resolveSpec(fromRel, spec) {
  if (spec === 'three') return byPath.get('vendor/three.module.js');
  if (!spec.startsWith('.')) return byPath.get(spec);
  const base = path.posix.dirname(fromRel);
  let p = path.posix.normalize(path.posix.join(base, spec));
  if (byPath.has(p)) return byPath.get(p);
  if (byPath.has(p + '.js')) return byPath.get(p + '.js');
  // 兜底：按文件名匹配
  const base2 = path.posix.basename(p).replace(/\.js$/, '') + '.js';
  for (const m of mods) if (path.posix.basename(m.rel) === base2) return m;
  return null;
}

// ---- 第二遍：解析 import 的模块引用，生成代码 ----
const chunks = [];
for (const m of mods) {
  const lines = [];
  for (const imp of m.imports) {
    const target = resolveSpec(m.rel, imp.mod);
    if (!target) throw new Error(`${m.rel}: 找不到 import "${imp.mod}"`);
    if (imp.ns) {
      lines.push(`const ${imp.ns} = ${target.id};`);
    } else {
      if (target.exports.size > 0 && !target.exports.has(imp.orig)) {
        throw new Error(`${m.rel}: ${imp.mod} 没有导出 "${imp.orig}"`);
      }
      // 关键：起一个唯一别名，避免与模块内部的同名 const 撞车
      lines.push(`const ${imp.name} = ${target.id}.${imp.orig};`);
    }
  }
  const exportObj = m.exports.size
    ? `\nreturn { ${Array.from(m.exports).map((n) => (n === '__default' ? `__default` : n)).join(', ')} };`
    : '\nreturn {};';
  chunks.push(
    `/* ==================== ${m.rel} ==================== */\n` +
    `const ${m.id} = (function(){\n${lines.join('\n')}\n${m.body}${exportObj}\n})();`
  );
}

const bundle = `(function(){
'use strict';
${chunks.join('\n\n')}
})();`;

// ★ 必须转义：源码里可能出现字面量 `</script>`（three.js 里就有一处正则字符串），
//   HTML 解析器看到它会**提前闭合 script 元素**，剩下的代码变成正文 → SyntaxError。
//   在 JS 里 `<\/script` 与 `</script` 完全等价（`\/` 就是 `/`），所以转义后语义不变。
//   `<!--` 同样要处理：HTML 注释起始序列会切换 script 的解析状态。
const nScript = (bundle.match(/<\/script/gi) || []).length;
const nComment = (bundle.match(/<!--/g) || []).length;
const htmlSafe = bundle.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

// ---- 语法自检（原始 bundle + 转义后）----
try {
  new vm.Script(bundle, { filename: 'bundle.js' });
  new vm.Script(htmlSafe, { filename: 'bundle.htmlsafe.js' });
} catch (e) {
  console.error('\n打包结果有语法错误：' + e.message);
  for (const m of mods) {
    const one = `(function(){\n${chunks[m.idx]}\n})();`;
    try { new vm.Script(one, { filename: m.rel }); }
    catch (e2) { console.error(`  ✗ 模块 ${m.rel}: ${e2.message}`); }
  }
  process.exit(1);
}

// 读模板并注入
const html = fs.readFileSync(path.join(ROOT, 'index.template.html'), 'utf8');
const marker = '<!--BUNDLE-->';
if (!html.includes(marker)) throw new Error('index.template.html 里找不到 ' + marker);

// ★ 关键自检：在**最终 HTML** 上检查 script 元素是否会被提前闭合。
//   上一轮就是被一个悄悄混进来的 `<script>` 把字符串劈成两半，页面报
//   "SyntaxError: Invalid or unexpected token"，而 node 侧单独解析 bundle 却是好的 ——
//   所以这条检查必须在最终 HTML 上做，而不是在 bundle 上做。
fs.writeFileSync(path.join(ROOT, 'index.bundle.js'), bundle, 'utf8');
// ★ 用**函数式替换**，不要用字符串替换：
//   String.prototype.replace 会把替换串里的 `$&` / `$'` / "$`" / `$1` 当成特殊模式。
//   three.js 源码里就有 '\$' 这种字面量（正则锚点），`$'` 的含义是"匹配位置之后的全部内容"，
//   于是整个 bundle 被复制了一份插进去 → HTML 里凭空多出一个 </script>，
//   字符串被劈开 → 页面报 SyntaxError。这类坑和 PowerShell 的 `$&` 是同一个。
const finalHtml = html.replace(marker, () => `<script>\n${htmlSafe}\n</script>`);
{
  // 统计 HTML 里的 script 开合标签数：必须一一对应，且总数符合模板预期
  const opens = (finalHtml.match(/<script>/g) || []).length;
  const closes = (finalHtml.match(/<\/script>/g) || []).length;
  if (opens !== closes) {
    console.error(`\n最终 HTML 的 script 标签不配对：<script> ${opens} 个，</script> ${closes} 个`);
    process.exit(1);
  }
  // 把注入的 bundle 段单独取出来，再确认里面没有任何裸的 </script 或 <!--
  const start = finalHtml.indexOf('<script>\n(function(){');
  const end = finalHtml.indexOf('\n</script>', start);
  const injected = finalHtml.slice(start, end);
  if (/<\/script/i.test(injected) || /<!--/.test(injected)) {
    console.error('\n注入的 bundle 段里混进了会破坏 script 的序列');
    process.exit(1);
  }
}
console.log(`语法自检: OK（script 标签配对；转义了 ${nScript} 处 </script、${nComment} 处 <!--）`);

fs.writeFileSync(path.join(ROOT, OUT), finalHtml, 'utf8');

console.log(`\n模块 ${mods.length} 个，bundle ${(bundle.length / 1024).toFixed(0)} KB`);
console.log(`写出 ${OUT}  ${(finalHtml.length / 1024).toFixed(0)} KB（自包含单文件）`);

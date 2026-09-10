import fs from 'node:fs';
import path from 'node:path';

const ROOT = '.';
const SKIP = new Set(['node_modules', '.git', 'vendor', 'shots', 'dist']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const files = walk(ROOT);
// 验证工具与验收报告自己会**包含**被搜索的关键字（它们就是干这个的），要排除掉，否则是自指误报。
// 真正需要接受检查的是：index.html、src/**、assets/**、tools/ 下的其它脚本。
const SELF = /(^|[\\/])(VERIFICATION\.md|anti-svg-check\.mjs|verify-anti-svg\.mjs|verify-requirements\.mjs|verify-artifacts\.mjs)$/;
const codeFiles = files.filter((f) => /\.(js|mjs|html|css|json|md)$/i.test(f) && !SELF.test(f));
const selfFiles = files.filter((f) => SELF.test(f));

const patterns = [
  [/<svg[\s>]/i, 'SVG 元素'],
  [/image\/svg\+xml/i, 'SVG MIME'],
  [/createElementNS\s*\(\s*['"]http:\/\/www\.w3\.org\/2000\/svg/i, 'SVG 命名空间'],
  [/<path\s+d=/i, 'SVG path 数据'],
  [/new\s+Path2D/i, 'Path2D（不一定是 SVG，但要人工确认）'],
];

let hits = 0;
for (const f of codeFiles) {
  const txt = fs.readFileSync(f, 'utf8');
  for (const [re, name] of patterns) {
    if (re.test(txt)) {
      const lines = txt.split(/\r?\n/);
      lines.forEach((l, i) => { if (re.test(l)) { console.log(`HIT ${name}: ${f}:${i + 1}  ${l.trim().slice(0, 120)}`); hits++; } });
    }
  }
}

const svgFiles = files.filter((f) => /\.svg$/i.test(f));
console.log(`\n扫描 ${codeFiles.length} 个源码文件（已排除 ${selfFiles.length} 个验证工具本身：${selfFiles.map((f) => path.basename(f)).join(', ')}）`);
console.log(`SVG 文件: ${svgFiles.length}  ${svgFiles.join(', ') || '(无)'}`);
console.log(`SVG 相关命中: ${hits}`);

// canvas / webgl 证据
const idx = fs.readFileSync('index.html', 'utf8');
console.log(`\nindex.html 有 <canvas>: ${/<canvas/i.test(idx)}`);
console.log(`index.html 引用 src/main.js: ${/src\/main\.js/.test(idx)}`);
const pkg = fs.existsSync('package.json') ? JSON.parse(fs.readFileSync('package.json', 'utf8')) : null;
console.log(`package.json 依赖: ${pkg ? JSON.stringify(pkg.dependencies || {}) : '(无 package.json)'}`);
console.log(`vendor/three.module.js 大小: ${(fs.statSync('vendor/three.module.js').size / 1024 / 1024).toFixed(2)} MB`);

const ok = hits === 0 && svgFiles.length === 0;
console.log(`\n========== 反 SVG: ${ok ? 'PASS' : 'FAIL'} ==========`);
process.exit(ok ? 0 : 1);

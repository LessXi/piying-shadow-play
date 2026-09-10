// 导出一份**可以直接发给别人**的单文件：
//  1. 中文文件名，一眼知道是什么
//  2. 文件里带一条自检注释，确认没有任何外链（对方只需这一个文件）
//  3. 顺带报出大小，方便判断能不能走微信/QQ
//
//   node tools/export-share.mjs
import fs from 'node:fs';

const SRC = 'index.html';
// 用 ASCII 文件名：中文名在某些系统的 git / 压缩包里容易出问题，
// 发送前你自己重命名成中文即可（凭据：内容完全一样）。
const OUT = process.argv[2] || 'yingchuang-shadow-play.html';

const html = fs.readFileSync(SRC, 'utf8');

// ---- 自检：必须没有任何外部资源引用，否则对方只拿到一个文件会打不开 ----
const checks = [
  ['<script ... src=...>', /<script[^>]+\ssrc\s*=/i],
  ['<link ... href=...>', /<link[^>]+\shref\s*=/i],
  ['importmap（ES module 会走网络/CORS）', /type\s*=\s*["']importmap["']/i],
  ['type="module" 脚本', /type\s*=\s*["']module["']/i],
  ['引用 src/ 目录', /["']\.?\/?src\//],
  ['引用 vendor/ 目录', /["']\.?\/?vendor\//],
  ['引用 assets/ 目录', /["']\.?\/?assets\//],
  ['引用 ./ 或 ../ 相对路径（图片/字体等）', /(?:src|href)\s*=\s*["']\.\.?\//i],
];
let bad = 0;
for (const [name, re] of checks) {
  if (re.test(html)) { console.error('  ✗ 仍存在外链：' + name); bad++; }
  else console.log('  ✓ 无 ' + name);
}
if (bad) {
  console.error('\n这个文件不是自包含的，发给别人会打不开。请先跑 node tools/build-single.mjs');
  process.exit(1);
}

// ---- 统计内联了多少东西 ----
const inlineScripts = (html.match(/<script>/g) || []).length;
const hasThree = /REVISION/.test(html) && /WebGLRenderer/.test(html);
const hasChoreography = /影窗/.test(html) && /buildTimeline/.test(html);

// ---- 加一条"只需这一个文件"的说明注释（放在文件最开头，不影响解析） ----
const banner = `<!--
  影窗 · 夜巡 —— 一场实时渲染的皮影戏
  ==================================================================
  这是**自包含单文件**：three.js（r160）与全部源码都已内联，
  没有外链、没有依赖、不需要联网、不需要起服务器。

  直接双击用 Chrome / Edge 打开即可（手机上也能看，竖屏建议横过来）。

  技术要点：WebGL2 实时渲染。一盏真实的透视聚光灯在幕布后方，
  皮影的每个关节部件都是真实遮挡体，被渲染进 2048² 阴影贴图；
  幕布上的剪影是"光被挡住"的结果，镂空花纹是"光穿过孔洞"的结果。
  全文无 SVG、无位图资源 —— 织物、牛皮纸、花纹、道具全部程序化生成。
  ==================================================================
-->
`;
const out = banner + html;

fs.writeFileSync(OUT, out, 'utf8');
const kb = (out.length / 1024).toFixed(0);
console.log(`\n已导出：${OUT}`);
console.log(`  大小 ${kb} KB   内联脚本块 ${inlineScripts} 个`);
console.log(`  含 three.js: ${hasThree}   含编排时间轴: ${hasChoreography}`);
console.log(`\n发给朋友就发这一个文件。`);

// 临时工具：两张 PNG 的逐像素差异统计
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

function decodePng(buf) {
  let off = 8, w = 0, h = 0, colorType = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev ? prev[i] : 0, c = (prev && i >= ch) ? prev[i - ch] : 0;
      let v = raw[p + i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[i] = v & 0xff;
    }
    p += stride;
  }
  return { w, h, ch, data: out };
}
const L = (i, d) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;

const [a, b] = process.argv.slice(2).map((f) => decodePng(readFileSync(f)));
if (a.w !== b.w || a.h !== b.h) { console.log('尺寸不同', a.w, a.h, b.w, b.h); process.exit(1); }
let n = 0, sum = 0, mx = 0, gt8 = 0, gt20 = 0, maxAt = null;
let darkA = 0, darkB = 0;
for (let y = 0; y < a.h; y++) {
  for (let x = 0; x < a.w; x++) {
    const i = (y * a.w + x) * a.ch;
    const la = L(i, a.data), lb = L(i, b.data);
    const d = Math.abs(la - lb);
    sum += d; n++;
    if (d > mx) { mx = d; maxAt = [x, y]; }
    if (d > 0.03) gt8++;
    if (d > 0.08) gt20++;
    if (la < 0.6) darkA++;
    if (lb < 0.6) darkB++;
  }
}
console.log(`${process.argv[2]}  vs  ${process.argv[3]}`);
console.log(`  平均差 ${(sum / n).toFixed(4)}  最大差 ${mx.toFixed(4)} @${maxAt}   >3%的像素 ${gt8}  >8%的像素 ${gt20}  (共 ${n})`);
console.log(`  <0.6 的暗像素: A=${darkA}  B=${darkB}`);

// 行剖面：看剪影内部有没有"没被挡住"的亮斑
for (const yy of (process.argv[4] ? process.argv[4].split(',').map(Number) : [80, 150, 230, 310, 390, 460])) {
  if (yy >= a.h) continue;
  let s = '';
  for (let x = 100; x < a.w - 100; x += 8) {
    const i = (yy * a.w + x) * a.ch;
    const loss = L(i, a.data) - L(i, b.data);
    s += loss > 0.06 ? '#' : (loss > 0.025 ? '+' : (loss > 0.008 ? '.' : ' '));
  }
  console.log(`  y=${String(yy).padStart(3)} |${s}|`);
}
// 损失网格（16x10），定位"暗区到底在哪"
console.log('  损失网格（行=y 8 等分, 列=x 16 等分，数字=该格平均损失×100）:');
for (let gy = 0; gy < 10; gy++) {
  let row = '';
  for (let gx = 0; gx < 16; gx++) {
    let s = 0, n = 0;
    for (let y = Math.floor(gy * a.h / 10); y < Math.floor((gy + 1) * a.h / 10); y += 2) {
      for (let x = Math.floor(gx * a.w / 16); x < Math.floor((gx + 1) * a.w / 16); x += 2) {
        const i = (y * a.w + x) * a.ch;
        s += Math.max(0, L(i, a.data) - L(i, b.data)); n++;
      }
    }
    row += String(Math.round(s / Math.max(1, n) * 100)).padStart(4);
  }
  console.log('   ' + row);
}

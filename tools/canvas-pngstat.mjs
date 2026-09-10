// 临时工具：PNG 亮度统计 + 粗粒度等值图（调试阴影/镂空用）
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

function decodePng(buf) {
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
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

const lum = (img, x, y) => { const i = (y * img.w + x) * img.ch; const d = img.data; return (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255; };

for (const file of process.argv.slice(2)) {
  const img = decodePng(readFileSync(file));
  const at = (x, y) => { const i = (y * img.w + x) * img.ch; const d = img.data; return [d[i], d[i + 1], d[i + 2]]; };
  if (file.includes('RGB@')) {
    const [, coords] = file.split('RGB@');
    for (const c of coords.split(';')) {
      const [x, y] = c.split(',').map(Number);
      console.log(`  RGB(${x},${y}) = ${at(x, y).join(',')}`);
    }
    continue;
  }
  let mn = 1, mx = 0, sum = 0, n = 0;
  const hist = new Array(10).fill(0);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const v = lum(img, x, y); mn = Math.min(mn, v); mx = Math.max(mx, v); sum += v; n++;
    hist[Math.min(9, Math.floor(v * 10))]++;
  }
  console.log(`\n=== ${file}  ${img.w}x${img.h}  min=${mn.toFixed(3)} max=${mx.toFixed(3)} mean=${(sum / n).toFixed(3)}`);
  console.log('  直方图(0.1 一档): ' + hist.map((c, i) => (i / 10).toFixed(1) + ':' + c).join('  '));
  const step = Math.max(1, Math.floor(img.w / 78));
  const stepY = Math.max(1, Math.floor(img.h / 26));
  const chars = ' .:-=+*#%@';
  for (let y = 0; y < img.h; y += stepY) {
    let row = '';
    for (let x = 0; x < img.w; x += step) row += chars[Math.min(9, Math.floor(lum(img, x, y) * 10))];
    console.log('  ' + row);
  }
  // 中心竖线剖面
  const cx = img.w >> 1;
  const prof = [];
  for (let y = 0; y < img.h; y += Math.max(1, Math.floor(img.h / 24))) prof.push(lum(img, cx, y).toFixed(2));
  console.log('  中心竖线亮度: ' + prof.join(' '));
}

import { withPage, sleep } from './harness.mjs';
import { readPNG, meanLuma } from './harness.mjs';

await withPage({ page: 'tools/probe-screen.html', width: 960, height: 540, readyTimeout: 90000 },
  async (page) => {
    await page.waitReady();
    await sleep(2500);
    await page.setTime(3.0);
    await sleep(300);
    await page.shot('shots/edge-scan.png');
    return null;
  });

const img = readPNG('shots/edge-scan.png');
console.log('幕布水平剖面（取 y=0.30..0.40 高度带，避开演员）:');
const line = [];
for (let i = 0; i <= 20; i++) {
  const x = Math.round(i / 20 * (img.width - 20)) + 10;
  line.push(`${(x / img.width).toFixed(2)}:${meanLuma(img, x - 8, img.height * 0.28, x + 8, img.height * 0.40, 2).toFixed(3)}`);
}
console.log('  ' + line.join('  '));
console.log('\n幕布垂直剖面（取 x=0.30..0.40 宽度带，避开演员）:');
const vline = [];
for (let i = 0; i <= 12; i++) {
  const y = Math.round(i / 12 * (img.height - 20)) + 10;
  vline.push(`${(y / img.height).toFixed(2)}:${meanLuma(img, img.width * 0.28, y - 8, img.width * 0.40, y + 8, 2).toFixed(3)}`);
}
console.log('  ' + vline.join('  '));
process.exit(0);

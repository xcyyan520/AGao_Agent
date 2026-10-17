/* qr.mjs —— 把一段网址画成终端里的二维码。
 *
 * 用途：手机要打开隧道给的临时网址，那串随机字符手打是不可能的，
 * 盯着屏幕一个个敲基本会敲错。扫一下最省事。
 *
 * 命令行：
 *   node tools/qr.mjs https://xxx-yyy.trycloudflare.com
 *
 * 也当模块用：
 *   import { renderQR } from './tools/qr.mjs';
 *   console.log(renderQR(url));
 *
 * 渲染用的是「半块字符」：一个字符格子竖着塞两个模块，
 * 所以行数只有模块数的一半，终端里正好是方的（终端字符高约是宽的两倍）。
 * 深色底 + 浅色前景 = 浅色模块画成实心、深色模块留空，
 * 正好是二维码该有的样子。绝大多数扫码器也认反色的码，所以浅底终端同样能扫。
 *
 * 二维码算法来自 vendor/qr/（qrcode-terminal 的 vendor 目录，Apache-2.0；
 * 里面的 QRCode for JavaScript 是 Kazuhiko Arase 的 MIT 实现）。
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const QRCode = require(path.join(here, '..', 'vendor', 'qr', 'QRCode', 'index.js'));
const QRErrorCorrectLevel = require(path.join(here, '..', 'vendor', 'qr', 'QRCode', 'QRErrorCorrectLevel.js'));

/* 静区（quiet zone）：二维码四周必须留出的空白边。
 * 规范要求 4 个模块宽，少了识别率会明显掉——尤其对着手机屏幕扫的时候。
 * qrcode-terminal 自带的渲染只留 1 个模块，这里自己画，留够 4 个。 */
const QUIET = 4;

/* 一个字符格子 = 上下两个模块。四张脸：
 *   上浅下浅 = █   上浅下深 = ▀   上深下浅 = ▄   上深下深 = 空格
 * 「浅」= QR 的白色模块 = 终端前景色被画出来的地方。 */
const CELL = { '11': '█', '10': '▀', '01': '▄', '00': ' ' };

export function renderQR(text, { quiet = QUIET, level = 'L' } = {}) {
  const qr = new QRCode(-1, QRErrorCorrectLevel[level] ?? QRErrorCorrectLevel.L);
  qr.addData(String(text));
  qr.make();

  const n = qr.getModuleCount();
  const size = n + quiet * 2;

  // 带静区的点阵：1 = 浅（白），0 = 深（黑）
  const light = (r, c) =>
    r < quiet || c < quiet || r >= n + quiet || c >= n + quiet
      ? 1
      : (qr.modules[r - quiet][c - quiet] ? 0 : 1);

  // 半块字符一次吃两行，总行数必须是偶数；不够就在底部补一行浅色
  const rows = size % 2 ? size + 1 : size;

  const out = [];
  for (let r = 0; r < rows; r += 2) {
    let line = '';
    for (let c = 0; c < size; c++) {
      const top = r < size ? light(r, c) : 1;
      const bot = r + 1 < size ? light(r + 1, c) : 1;
      line += CELL[`${top}${bot}`];
    }
    out.push(line);
  }
  return out.join('\n');
}

/* 直接跑这个文件时：把参数当网址画出来 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.argv[2];
  if (!url) {
    console.error('用法：node tools/qr.mjs <网址>');
    process.exit(2);
  }
  console.log(renderQR(url));
}

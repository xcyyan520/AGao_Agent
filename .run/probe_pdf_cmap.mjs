/* 把 CMap 原文打出来 —— 上一版探针打出空，说明取流/解压那一环有问题。 */
import fs from 'node:fs';
import path from 'node:path';

const f = path.join(process.env.USERPROFILE || '', 'Downloads/附件2. 本专科生国家助学金申请表（2026—2027学年）.pdf');
const b = new Uint8Array(fs.readFileSync(f));
function latin1(u8) { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return s; }
const src = latin1(b);
const DS = globalThis.DecompressionStream;
async function inflate(bytes) {
  const ds = new DS('deflate');
  const s = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(s).arrayBuffer());
}

for (const objNum of ['10', '19', '28', '59']) {
  const objRe = new RegExp(`(?:^|[^0-9])${objNum}\\s+0\\s+obj\\b`);
  const om = objRe.exec(src);
  if (!om) { console.log(`obj${objNum} 找不到`); continue; }
  const start = om.index + om[0].length;
  const end = src.indexOf('endobj', start);
  const chunk = src.slice(start, end);
  const sIdx = chunk.indexOf('stream');
  console.log(`\n── obj${objNum} chunk=${chunk.length}B sIdx=${sIdx}`);
  if (sIdx < 0) { console.log(chunk.slice(0, 400)); continue; }
  let ds = sIdx + 6;
  while (chunk[ds] === '\r' || chunk[ds] === '\n') ds++;
  const de = chunk.lastIndexOf('endstream');
  const raw = b.subarray(start + ds, start + de);
  let t;
  try { t = latin1(await inflate(raw)); } catch (e) { t = latin1(raw); console.log('  解压失败:', e.message); }
  console.log(`  取到 ${t.length} 字节`);
  console.log('  ' + t.slice(0, 900).replace(/\n/g, '\n  '));
}

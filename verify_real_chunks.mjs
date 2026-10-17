// 用用户真实导出的面试记录，对比"旧切块"和"新切块"。
// 旧切块的结果就在导出的 json 里（那 31 块），新切块把它们的文字重新拼起来再切一遍。
import fs from 'node:fs';
import { Chunker } from './engine.mjs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('用法: node verify_real_chunks.mjs <interview-*.json> [...]');
  process.exit(2);
}

for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  // 导出的 history 每条就是一块，文字在 .text（没有 role 字段）
  const oldChunks = (j.history || []).filter(h => h.text);
  if (!oldChunks.length) { console.log(`\n### ${f}\n(没有 chunk，跳过)`); continue; }

  // 重新拼回候选人说的话。旧块是被 trim 过的，拼接处补空格会改变长度，
  // 所以直接紧挨着拼——这已经足够逼近原文，用来对比切块粒度。
  const fullText = oldChunks.map(c => c.text).join('');
  const oldTexts = oldChunks.map(c => c.text);

  const ch = new Chunker();
  const newChunks = [];
  ch.on('chunk', c => newChunks.push(c));
  // 按 4 字/100ms 喂，模拟真实口语速度
  for (let i = 0; i < fullText.length; i += 4) {
    ch.push(fullText.slice(i, i + 4));
    await sleep(100);
  }
  ch.flushNow('asrFinal');
  ch.close();

  const oldLen = oldTexts.map(t => t.length);
  const newLen = newChunks.map(c => c.text.length);
  const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;

  console.log(`\n${'═'.repeat(64)}`);
  console.log(`文件: ${f}`);
  console.log(`候选人共 ${fullText.length} 字`);

  console.log(`\n--- 旧切块 ${oldTexts.length} 块（平均 ${avg(oldLen)} 字，最短 ${Math.min(...oldLen)}）---`);
  oldTexts.forEach((t, i) => console.log(`  ${String(i + 1).padStart(2)}. [${String(t.length).padStart(3)}字] ${t}`));

  console.log(`\n--- 新切块 ${newChunks.length} 块（平均 ${avg(newLen)} 字，最短 ${Math.min(...newLen)}）---`);
  newChunks.forEach((c, i) =>
    console.log(`  ${String(i + 1).padStart(2)}. [${String(c.text.length).padStart(3)}字] ${c.reason.padEnd(9)} ${c.text}`));

  // 碎块统计：小于 12 字的块在旧方案里占多少
  const tinyOld = oldLen.filter(n => n < 12).length;
  const tinyNew = newLen.filter(n => n < 12).length;
  console.log(`\n  10 字以下的碎块：  旧 ${tinyOld}/${oldTexts.length}  →  新 ${tinyNew}/${newChunks.length}`);
  console.log(`  AI 调用次数：      旧 ${oldTexts.length} 次  →  新 ${newChunks.length} 次`);

  // 关键：有没有把英文词劈开
  const splitOld = oldTexts.filter(t => /[A-Za-z0-9]$/.test(t)).length;
  const splitNew = newChunks.filter(c => /[A-Za-z0-9]$/.test(c.text)).length;
  console.log(`  以字母/数字结尾(疑似劈词)： 旧 ${splitOld}  →  新 ${splitNew}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

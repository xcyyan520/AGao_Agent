// 用【同一个指标】重算各次真实语料跑的重复率，避免拿不同标准比出假结论。
// 指标 = normQuestion() 归一化（去标点空白 + 去句首虚词）后逐字相同。
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { normQuestion } from '../engine.mjs';

const files = globSync('.run/e2e_real_corpus.*.json')
  .map(f => ({ f, m: JSON.parse(readFileSync(f, 'utf8')) }))
  .sort((a, b) => a.m.S - b.m.S);

console.log('文件'.padEnd(46) + '速度  题数  唯一  重复率');
for (const { f, m } of files) {
  const qs = m.generated || [];
  const keys = qs.map(normQuestion).filter(Boolean);
  const uniq = new Set(keys).size;
  const rate = keys.length ? (1 - uniq / keys.length) : 0;
  const tag = f.includes('1792156449238') ? '  ← 软提示词修复后' : '';
  console.log(
    f.padEnd(46) +
    String(m.SPEED + '×').padEnd(6) +
    String(keys.length).padEnd(6) +
    String(uniq).padEnd(6) +
    (rate * 100).toFixed(0) + '%' + tag
  );
}

// 逐个跑，列出重复最多的题
for (const { m } of files) {
  const key2raw = new Map();
  for (const q of m.generated || []) {
    const k = normQuestion(q);
    if (!k) continue;
    if (!key2raw.has(k)) key2raw.set(k, []);
    key2raw.get(k).push(q);
  }
  const top = [...key2raw.entries()].sort((a, b) => b[1].length - a[1].length)
    .filter(([, v]) => v.length > 1).slice(0, 4);
  console.log(`\nSPEED=${m.SPEED} 出题 ${(m.generated || []).length}`);
  for (const [, v] of top) console.log(`   ${v.length}×  「${v[0]}」`);
}

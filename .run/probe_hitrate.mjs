// 检验「反向覆盖 3/3」这个结论是否可信。
// 疑点：4 道真实题全都含 LangGraph / Agent / 状态 / 图 这些共有的产品名词，
// 二元组相似度会被这些共有词抬高，于是「最佳匹配」可能只是同样提到 LangGraph 的题，
// 而不是真的问到了同一件事。
import { readFileSync } from 'node:fs';

const j = JSON.parse(readFileSync(process.argv[2] || '.run/e2e_real_corpus.corpus_1792157192358.json', 'utf8'));
const generated = j.generated;
const real = j.realQuestions;

const bigrams = (s) => {
  const t = String(s).replace(/[\s，。、：；！？（）()“”"'’\-—]/g, '');
  const g = new Set();
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
  return g;
};
const sim = (a, b) => {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return hit / A.size;
};

// 扣除掉「所有真实题共有」的高频词，看还剩多少
const STOP = ['langgraph', 'langchain', 'agent', '状态', '图', '的', '和', '与', '怎么', '什么', '区别', '差异'];
const strip = (s) => {
  let t = String(s).toLowerCase();
  for (const w of STOP) t = t.split(w).join('');
  return t;
};

console.log('真实题：');
real.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));

console.log('\n每道真实题的最佳匹配（原算法 vs 扣掉共有词后）：');
for (let i = 1; i < real.length; i++) {
  const rows = generated.map((g) => ({ g, s: sim(g, real[i]), s2: sim(strip(g), strip(real[i])) }));
  rows.sort((a, b) => b.s - a.s);
  const top = rows[0];
  const rows2 = [...rows].sort((a, b) => b.s2 - a.s2);
  const top2 = rows2[0];
  console.log(`\n  第 ${i + 1} 题：${real[i]}`);
  console.log(`    原算法   ${(top.s * 100).toFixed(0)}%  「${top.g}」`);
  console.log(`    扣词后   ${(top2.s2 * 100).toFixed(0)}%  「${top2.g}」`);
  console.log(`    ${top.g === top2.g ? '→ 同一个，说明不是靠共有词撑起来的' : '→ ⚠️ 换了！原来的高分是共有词撑的'}`);
}

// 同一道生成题是否同时成为多道真实题的最佳匹配
console.log('\n每道生成题被几道真实题选为最佳匹配：');
const winCount = new Map();
for (let i = 1; i < real.length; i++) {
  let best = null;
  generated.forEach((g) => { const s = sim(g, real[i]); if (!best || s > best.s) best = { g, s }; });
  winCount.set(best.g, (winCount.get(best.g) || 0) + 1);
}
for (const [g, n] of winCount) console.log(`  ${n}×  「${g}」`);

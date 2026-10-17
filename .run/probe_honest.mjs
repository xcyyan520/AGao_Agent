// 两个诚实性问题：
// A) 正向那 9 条「★命中 50~70%」是不是也被共有词抬高了？
// B) 逐字重复率 3% 看起来很好，但语义上是不是全挤在同一个话题上？
import { readFileSync } from 'node:fs';

const f = process.argv[2] || '.run/e2e_real_corpus.corpus_1792157192358.json';
const j = JSON.parse(readFileSync(f, 'utf8'));
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
const STOP = ['langgraph', 'langchain', 'agent', '状态', '图', '的', '和', '与', '怎么', '什么', '区别', '差异', 'langchain'];
const strip = (s) => {
  let t = String(s).toLowerCase();
  for (const w of STOP) t = t.split(w).join('');
  return t;
};

console.log('════ A) 正向 9 条「★命中」扣掉共有词后还剩多少 ════');
const rows = generated.map((g) => {
  let best = null;
  real.forEach((rq, ri) => { const s = sim(g, rq); if (!best || s > best.s) best = { s, ri, rq }; });
  const s2 = sim(strip(g), strip(best.rq));
  return { g, ...best, s2 };
});
const stars = rows.filter((r) => r.s >= 0.5).sort((a, b) => b.s - a.s);
console.log(`原算法 ≥50% 的有 ${stars.length} 条：\n`);
let survived = 0;
for (const r of stars) {
  const keep = r.s2 >= 0.3;
  if (keep) survived++;
  console.log(`  ${(r.s * 100).toFixed(0)}% → 扣词 ${(r.s2 * 100).toFixed(0)}%  ${keep ? '仍然命中 ✓' : '掉到无关 ✗'}  「${r.g}」`);
}
console.log(`\n  结论：原算法 ${stars.length} 条「命中」，扣掉共有词后只有 ${survived} 条站得住。`);
const avgRaw = stars.reduce((a, r) => a + r.s, 0) / (stars.length || 1);
const avgStr = stars.reduce((a, r) => a + r.s2, 0) / (stars.length || 1);
console.log(`  平均：${(avgRaw * 100).toFixed(1)}%  →  ${(avgStr * 100).toFixed(1)}%`);

console.log('\n════ 全量 77 题里，扣词后仍 ≥30% 的有几条 ════');
const strong = rows.filter((r) => r.s2 >= 0.3).sort((a, b) => b.s2 - a.s2);
strong.forEach((r) => console.log(`  ${(r.s2 * 100).toFixed(0)}%  「${r.g}」\n        ↳ 第 ${r.ri + 1} 题`));
console.log(`  共 ${strong.length} / 77 题 = ${((strong.length / 77) * 100).toFixed(1)}%`);

console.log('\n════ B) 语义集中度：77 题按主题归类 ════');
const themes = [
  ['checkpoint/断点恢复/持久化', /checkpoint|断点|恢复|持久|存哪|存储|失忆|MemorySaver/],
  ['循环/跑飞/失控/终止', /循环|跑飞|失控|转几圈|停下来|终止|死循环|无限/],
  ['状态传递/节点/图结构', /节点|状态|传|边|图|编排/],
  ['原生 Agent 对比 LangGraph', /原生\s*Agent|LangChain|不用 LangGraph|手写/],
  ['超时/预算/兜底', /超时|预算|兜底|几秒|等待/],
  ['thread_id/多客户隔离', /thread_id|客户|隔离|串台|前缀/],
  ['并发/锁/顺序', /并发|锁|顺序|乱|覆盖/],
];
const uniq = [...new Set(generated)];
console.log(`（去重后 ${uniq.length} 题）`);
const counted = new Set();
for (const [name, re] of themes) {
  const hits = uniq.filter((q) => re.test(q) && !counted.has(q));
  hits.forEach((q) => counted.add(q));
  console.log(`  ${String(hits.length).padStart(3)} 题  ${name}`);
}
const other = uniq.filter((q) => !counted.has(q));
console.log(`  ${String(other.length).padStart(3)} 题  其它`);
if (other.length) other.slice(0, 12).forEach((q) => console.log(`         · ${q}`));

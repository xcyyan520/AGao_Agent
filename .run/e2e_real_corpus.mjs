// 真实语料端到端：材料=云联-逐字稿.md（全文），问题=面试题.txt 第 1 题，
// 回放=逐字稿「模块四：AI Agent 编排模块」正文（去掉 markdown 记号和【】提示，
// 因为这些是"不用念出来"的书面标记，真人不会念）。
//
// 这个脚本回答的是文档里挂着的那条「没验证」：
//   出题质量只在两个 100 字上下的短样本上看过，真实面试里候选人会讲三五分钟、
//   跨好几个话题，那时候还抓不抓得住重点。
//
// 和之前所有测试最大的不同：这次有【标准答案】。面试题.txt 里那 4 个问题是
// 面试官真实问过的，所以可以量一量——AI 提前准备的下一题，命中了几个。
//
// 用法：
//   node .run/e2e_real_corpus.mjs            # 真实语速（约 11 分钟）
//   $env:SPEED=8; node .run/e2e_real_corpus.mjs   # 8 倍速（约 1.5 分钟）
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.BASE || 'http://127.0.0.1:8900';
// charsPer100ms：真人中文语速约 4~5 字/秒 = 0.4~0.5 字/100ms。
// SPEED 是加速倍数，默认 1（真实语速）。
const SPEED = Number(process.env.SPEED || 1);
const CHARS_PER_100MS = 0.45 * SPEED;
const S = 'corpus_' + Date.now();

/* ── 1. 读真实语料 ───────────────────────────────────────────── */
const transcript = readFileSync('云联-逐字稿.md', 'utf8');
const realQuestions = readFileSync('面试题.txt', 'utf8')
  .split('\n').map((s) => s.trim()).filter(Boolean);

// 抽「模块四：AI Agent 编排模块」正文（### 到下一个 --- 之前的 "
const m4start = transcript.indexOf('### 模块四：AI Agent 编排模块');
const m4end = transcript.indexOf('\n## 六、三个必答题');
if (m4start < 0 || m4end < 0) throw new Error('抽不到模块四，逐字稿结构变了');
const rawM4 = transcript.slice(m4start, m4end);

// 洗成"人念出来的样子"：去 markdown 加粗/标题/---，去【】提示，去 ★
const spoken = rawM4
  .replace(/^###.*$/gm, '')
  .replace(/\*\*/g, '')
  .replace(/【[^】]*】/g, '')
  .replace(/★/g, '')
  .replace(/`/g, '')
  .replace(/^\s*[-–—]{3,}\s*$/gm, '')
  .replace(/^\s*[-*]\s+/gm, '')
  .replace(/^\s*\d+\.\s+/gm, '')
  .replace(/[ \t]+/g, '')
  .replace(/\n{2,}/g, '\n')
  .replace(/\n+/g, '')
  .trim();

const ANSWER = spoken;
const QUESTION = realQuestions[0];

console.log('════════ 真实语料端到端 ════════');
console.log(`材料：云联-逐字稿.md 全文 ${transcript.length} 字`);
console.log(`面试官首问（面试题.txt 第 1 题）：${QUESTION}`);
console.log(`回放：模块四正文 ${ANSWER.length} 字，速度 ${SPEED}× （${CHARS_PER_100MS.toFixed(2)} 字/100ms）`);
console.log(`预计回放时长 ${Math.round(ANSWER.length / CHARS_PER_100MS / 10)}s\n`);
console.log('标准答案（面试官真实问过的 4 题）：');
realQuestions.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
console.log('');

/* ── 2. 订阅 SSE ─────────────────────────────────────────────── */
const t0 = Date.now();
const rel = () => String(Date.now() - t0).padStart(6) + 'ms';
const log = [];
const ac = new AbortController();
let done = false;

(async () => {
  const res = await fetch(`${BASE}/events?s=${S}`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done: d, value } = await reader.read();
      if (d) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          let m; try { m = JSON.parse(line.slice(6)); } catch { continue; }
          if (m.type === 'draft') {
            log.push({ t: Date.now() - t0, type: 'draft', q: m.question, ms: m.ms });
            console.log(`${rel()}  [首字 ${m.ms}ms] ${m.question}`);
          } else if (m.type === 'nextq') {
            log.push({ t: Date.now() - t0, type: 'nextq', q: m.question, reason: m.reason, kind: m.kind, basis: m.basis, ms: m.ms });
            console.log(`${rel()}  [定稿 ${m.ms}ms] ${m.question}`);
            console.log(`              理由=${m.reason}｜类型=${m.kind}｜依据=${m.basis}`);
          } else if (m.type === 'repeat') {
            log.push({ t: Date.now() - t0, type: 'repeat', q: m.question });
            console.log(`${rel()}  [重复！] ${m.question}`);
          } else if (m.type === 'merged') {
            log.push({ t: Date.now() - t0, type: 'merged', from: m.from, into: m.into });
            console.log(`${rel()}  [合并] ${m.from.join(',')} → ${m.into}`);
          } else if (m.type === 'judge_error') {
            log.push({ t: Date.now() - t0, type: 'error', msg: m.message });
            console.log(`${rel()}  [错误] ${m.message}`);
          } else if (m.type === 'stale') {
            log.push({ t: Date.now() - t0, type: 'stale', seq: m.seq });
            console.log(`${rel()}  [丢弃·乱序] seq=${m.seq}`);
          } else if (m.type === 'replay_end') {
            console.log(`${rel()}  [回放结束]`);
            done = true; ac.abort(); return;
          }
        }
      }
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; }
})();

await sleep(400);

/* ── 3. 走浏览器路径 ─────────────────────────────────────────── */
const post = (p, body) => fetch(`${BASE}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ session: S, ...body }),
}).then((r) => r.json());

const mat = await post('/api/materials', { materials: transcript });
console.log(`\n材料已存：${mat.chars} 字（= 逐字稿全文）`);
await post('/api/question', { question: QUESTION });
await post('/api/replay', { text: ANSWER, charsPer100ms: CHARS_PER_100MS });

// 等回放 + 在途请求收尾
const total = (ANSWER.length / CHARS_PER_100MS) * 100 + 30000;
const deadline = Date.now() + total;
while (!done && Date.now() < deadline) await sleep(500);
await sleep(6000);

/* ── 4. 结果 + 命中率 ───────────────────────────────────────── */
const st = await (await fetch(`${BASE}/api/state?s=${S}`)).json();

// 中文没有空格，用字符二元组做相似度：够稳，也不需要分词库
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
  return hit / A.size;   // 生成的问题有多少比例被标准答案覆盖
};

const generated = st.history.map((h) => h.question);
console.log('\n════════ 生成的问题 ════════');
st.history.forEach((h, i) => console.log(`  ${i + 1}. [${h.kind}] ${h.question}`));

console.log('\n════════ 与真实面试题的对照 ════════');
const rows = [];
for (const g of generated) {
  let best = null;
  realQuestions.forEach((rq, ri) => {
    const s = sim(g, rq);
    if (!best || s > best.s) best = { s, ri, rq };
  });
  rows.push({ g, ...best });
  const flag = best.s >= 0.5 ? '★命中' : best.s >= 0.3 ? '接近' : '无关';
  console.log(`  ${flag} ${(best.s * 100).toFixed(0).padStart(3)}%  「${g}」`);
  console.log(`        ↳ 最接近第 ${best.ri + 1} 题：${best.rq}`);
}
// 反向：4 个真实问题，有没有被覆盖到
console.log('\n  反向覆盖（真实问题有没有被 AI 提前想到）：');
for (let ri = 0; ri < realQuestions.length; ri++) {
  if (ri === 0) { console.log(`    第 1 题 = 已问过的那题（作为当前问题给定，不参与命中）`); continue; }
  let best = 0, bg = '';
  for (const g of generated) { const s = sim(g, realQuestions[ri]); if (s > best) { best = s; bg = g; } }
  console.log(`    第 ${ri + 1} 题 ${(best * 100).toFixed(0).padStart(3)}%  ${best >= 0.3 ? '✓' : '×'}  ${realQuestions[ri]}`);
  if (best > 0) console.log(`        最佳匹配：「${bg}」`);
}

const pct = (a, p) => {
  if (!a || !a.length) return '—';
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] + 'ms';
};
console.log('\n════════ 延迟与统计 ════════');
console.log(`块数 ${st.stats.chunks}｜出题 ${st.history.length}｜合并 ${st.stats.merged}｜失败 ${st.stats.failed}｜丢弃 ${st.stats.dropped}`);
console.log(`首字 p50 ${pct(st.stats.draftLatency, .5)}｜整轮 p50 ${pct(st.stats.latency, .5)}｜整轮 p90 ${pct(st.stats.latency, .9)}`);

// 重复率：引擎自己数的（归一化后逐字比对），比事后拿大二元组相似度猜可靠得多。
// 大二元组会被共同出现的产品名（LangChain / LangGraph）抬高，那个指标只做参考。
const rep = st.stats.repeated || 0;
console.log(`\n════════ 重复率 ════════`);
console.log(`引擎判定重复 ${rep} / ${st.history.length} 题 = ${(rep / st.history.length * 100).toFixed(0)}%`);
const hist = {};
for (const g of generated) hist[g] = (hist[g] || 0) + 1;
const top = Object.entries(hist).sort((a, b) => b[1] - a[1]).filter(([, n]) => n > 1);
console.log(top.length
  ? `逐字相同的题：${top.map(([q, n]) => `${n}×「${q}」`).join('；')}`
  : '没有逐字相同的题');

const out = `.run/e2e_real_corpus.${S}.json`;
writeFileSync(out, JSON.stringify({ S, QUESTION, ANSWER_chars: ANSWER.length, SPEED, generated, realQuestions, rows, stats: st.stats, log }, null, 2));
console.log(`\n明细已写入 ${out}`);
process.exit(0);

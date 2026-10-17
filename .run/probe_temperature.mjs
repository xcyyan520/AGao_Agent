// 隔离探针：只测【采样温度】对重复的影响，不掺管道动态。
//
// 背景：真实语料 e2e 里，78 道题 47% 重复，同一句连出 11 遍。
// 我加了「你刚才已经给过的建议」提示词块，模型甚至在理由里写
// 「已问过同题，换角度问状态传递」——然后照样把同一句话又输出一遍。
// 这说明问题不在「模型不知道」，而在「模型每次都挑同一个最可能的说法」，
// 那就指向 temperature（原代码写死 0.3）。
//
// 做法：固定材料 + 固定当前问题 + 固定输入块，同一个请求发 N 次，
// 数有多少种不同的题。这直接回答「低温度是不是复读机」，
// 而且 30 秒就能出结果，不用等 10 分钟的 e2e。
//
// 用法：node .run/probe_temperature.mjs
import { readFileSync } from 'node:fs';
import { IncrementalQuestioner } from '../engine.mjs';

const KEY = process.env.LLM_KEY || process.env.ALI_DEEPSEEK_API_KEY;
const BASE = 'https://dashscope.aliyuncs.com/compatible-mode';
const MODEL = 'deepseek-v4.1-flash';
if (!KEY) throw new Error('缺 LLM_KEY / ALI_DEEPSEEK_API_KEY');

const transcript = readFileSync('云联-逐字稿.md', 'utf8');
const realQuestions = readFileSync('面试题.txt', 'utf8')
  .split('\n').map((s) => s.trim()).filter(Boolean);

// 取模块四正文，和 e2e 同一段
const m4start = transcript.indexOf('### 模块四：AI Agent 编排模块');
const m4end = transcript.indexOf('\n## 六、三个必答题');
const spoken = transcript.slice(m4start, m4end)
  .replace(/^###.*$/gm, '').replace(/\*\*/g, '').replace(/【[^】]*】/g, '')
  .replace(/★/g, '').replace(/`/g, '').replace(/^\s*[-–—]{3,}\s*$/gm, '')
  .replace(/^\s*[-*]\s+/gm, '').replace(/^\s*\d+\.\s+/gm, '')
  .replace(/[ \t]+/g, '').replace(/\n{2,}/g, '\n').replace(/\n+/g, '').trim();

// 固定上下文：模拟"讲了一阵子"的中间态
const ANSWER = spoken.slice(0, 900);
const CHUNK = spoken.slice(900, 1020);

async function oneRun(temperature, n) {
  const q = new IncrementalQuestioner({
    baseUrl: BASE, apiKey: KEY, model: MODEL, temperature, disableThinking: true,
  });
  q.setContext({ materials: transcript });
  await q.newQuestion(realQuestions[0]);
  q.answer = ANSWER;

  const msgs = q._buildMessages({ seq: 7, text: CHUNK });
  const out = [];
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL, messages: msgs, temperature,
        max_tokens: 400, stream: false, enable_thinking: false,
      }),
    });
    if (!res.ok) { out.push(`HTTP${res.status}`); continue; }
    const j = await res.json();
    const txt = j?.choices?.[0]?.message?.content || '';
    const m = txt.match(/问\s*题\s*[：:]\s*([^\n]*)/);
    out.push({ q: (m ? m[1] : txt.slice(0, 30)).trim(), ms: Date.now() - t0 });
  }
  return out;
}

const N = 12;
console.log(`固定上下文：材料=逐字稿全文，当前问题=第1题，回答=${ANSWER.length}字，块=${CHUNK.length}字`);
console.log(`每个温度发 ${N} 次完全相同的请求\n`);

for (const T of [0.3, 0.8, 1.2]) {
  const runs = await oneRun(T, N);
  const qs = runs.map((r) => r.q);
  const uniq = new Set(qs).size;
  const lat = runs.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`── temperature = ${T} ──`);
  console.log(`   ${N} 次请求 → ${uniq} 种不同的题，重复率 ${((1 - uniq / N) * 100).toFixed(0)}%`);
  console.log(`   延迟 p50 ${lat[Math.floor(N * .5)]}ms  p90 ${lat[Math.floor(N * .9)]}ms`);
  const hist = {};
  for (const s of qs) hist[s] = (hist[s] || 0) + 1;
  for (const [s, c] of Object.entries(hist).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(c).padStart(2)}×  ${s}`);
  }
  console.log('');
}
process.exit(0);

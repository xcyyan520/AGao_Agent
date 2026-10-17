// 一次性探针：用真实阿里云 DashScope 接口跑一遍 engine 的提示词，
// 看三件事——肯不肯流式、肯不肯按四行格式输出、首字到底多快。
// 不进 engine，直接照 _buildMessages 的形状拼请求，方便看原始返回。
import { SYSTEM_PROMPT, parseNext, pickQuestion } from '../engine.mjs';

const base = (process.env.LLM_BASE || '').replace(/\/+$/, '');
const key = process.env.LLM_KEY;
const model = process.env.LLM_MODEL;

const MATERIALS = `候选人简历节选：
- 2023.03–至今 某电商平台 秒杀系统负责人
- 库存扣减：Redis 预减 + 消息队列（RocketMQ）异步落库，宣称扛住 3 万 QPS
- 上线后做过一次压测，结论是"性能没问题"
`;

const CHUNK = '我用了 Redis 的 DECR 做预减库存，然后发消息到 RocketMQ，下游异步落库。不过我们实际上没有做异步落库，是同步写库的，QPS 峰值大概 5000 左右。';

const sys = SYSTEM_PROMPT
  .replace('{MATERIALS}', MATERIALS)
  .replace('{CURRENT_QUESTION}', '讲讲你的秒杀系统怎么做库存扣减的');

const messages = [
  { role: 'system', content: sys },
  { role: 'user', content: '## 已经问过的问题\n\n（还没有问过任何问题，这是第一个问题）' },
  {
    role: 'user',
    content:
      `## 候选人到目前为止的回答\n\n${CHUNK}\n\n` +
      `## 刚听到的一块（第 1 块）\n\n${CHUNK}\n\n` +
      `现在给出面试官下一个该问的问题。只输出那四行。`,
  },
];

const t0 = Date.now();
const res = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 220, stream: true }),
});

console.log(`HTTP ${res.status} · content-type=${res.headers.get('content-type')}`);
if (!res.ok) { console.log(await res.text()); process.exit(1); }

let acc = '', ttft = 0, draftAt = 0, draftQ = '';
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    const p = s.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    let j; try { j = JSON.parse(p); } catch { continue; }
    const d = j?.choices?.[0]?.delta?.content;
    if (!d) continue;
    if (!ttft) ttft = Date.now() - t0;
    acc += d;
    if (!draftAt) { const q = pickQuestion(acc); if (q) { draftAt = Date.now() - t0; draftQ = q; } }
  }
}
const total = Date.now() - t0;

console.log('\n─── 原始输出 ───');
console.log(JSON.stringify(acc));
console.log('\n─── 渲染后 ───');
console.log(acc);
console.log('\n─── 计时 ───');
console.log(`首字(TTFT)      ${ttft}ms`);
console.log(`问题行完整      ${draftAt || '未捕获'}ms   ${draftQ}`);
console.log(`整轮结束        ${total}ms   共 ${acc.length} 字`);
console.log('\n─── 解析结果 ───');
console.log(JSON.stringify(parseNext(acc), null, 2));

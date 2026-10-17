// 验证猜想：这个模型会先吐 reasoning_content，而 max_tokens 是【思考+答案共用】的预算。
// 如果思考把预算吃光，content 就会被截断 —— 这正好解释 e2e 里那个孤零零的「那」。
// 用 e2e 里那个"矛盾场景"（简历写异步三万，候选人说同步五千）来复现，因为
// 越是需要动脑的场景，思考越长，越容易撑爆预算。
import { SYSTEM_PROMPT } from '../engine.mjs';

const base = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const key = process.env.LLM_KEY;
const model = process.env.LLM_MODEL;

const MATERIALS = `候选人简历节选（2023.03–至今 某电商平台 秒杀系统负责人）：
- 库存扣减：Redis 预减 + 消息队列（RocketMQ）异步落库，宣称扛住 3 万 QPS
- 分布式锁：用 Redis SETNX 做的，超时时间 30 秒
- 上线后做过一次压测，结论是"性能没问题"

候选人自述（上一轮面试记录）：
"这个秒杀系统是我主导做的，峰值确实到过三万，压测是我盯的。"`;

const ANSWER = `我用了 Redis 的 DECR 做预减库存，然后发消息到 RocketMQ，下游异步落库。\n不过我们实际上没有做异步落库，是同步写库的，QPS 峰值大概 5000 左右。`;
const CHUNK = '不过我们实际上没有做异步落库，是同步写库的，QPS 峰值大概 5000 左右。';

const sys = SYSTEM_PROMPT.replace('{MATERIALS}', MATERIALS).replace('{CURRENT_QUESTION}', '讲讲你的秒杀系统怎么做库存扣减的');

const messages = [
  { role: 'system', content: sys },
  { role: 'user', content: '## 已经问过的问题\n\n（还没有问过任何问题，这是第一个问题）' },
  { role: 'user', content: `## 候选人到目前为止的回答\n\n${ANSWER}\n\n## 刚听到的一块（第 2 块）\n\n${CHUNK}\n\n现在给出面试官下一个该问的问题。只输出那四行。` },
];

console.log('推理 token 是否计入 max_tokens？用同一份输入跑不同上限，看 finish_reason 和 content 长度。\n');
console.log('max_tokens | finish   | 思考字数 | 答案字数 | 答案原文');
console.log('-----------+----------+----------+----------+---------');

for (const mt of [220, 220, 220, 400, 1000]) {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: mt, stream: true }),
  });
  if (!res.ok) { console.log(`${mt} → HTTP ${res.status} ${(await res.text()).slice(0,100)}`); continue; }

  let acc = '', reasoning = '', finish = '', usage = null;
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      const s = line.trim(); if (!s.startsWith('data:')) continue;
      const p = s.slice(5).trim(); if (!p || p === '[DONE]') continue;
      let j; try { j = JSON.parse(p); } catch { continue; }
      if (j.usage) usage = j.usage;
      const ch = j?.choices?.[0]; if (!ch) continue;
      if (ch.delta?.reasoning_content) reasoning += ch.delta.reasoning_content;
      if (ch.delta?.content) acc += ch.delta.content;
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }
  const flag = finish === 'length' ? '  ← 被截断！' : '';
  console.log(`${String(mt).padEnd(10)} | ${finish.padEnd(8)} | ${String(reasoning.length).padStart(8)} | ${String(acc.length).padStart(8)} | ${JSON.stringify(acc)}${flag}`);
  if (usage) console.log(`           用量：${JSON.stringify(usage)}`);
}

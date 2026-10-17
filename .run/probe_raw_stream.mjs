// 抓原始 delta 流，看模型到底吐了什么 —— 特别是「问题：那」那种半截结果从哪来的。
// 关心三件事：有没有 reasoning_content、finish_reason 是不是 length、content 实际长什么样。
import { SYSTEM_PROMPT } from '../engine.mjs';

// engine.mjs:509 自己会拼 /v1/chat/completions，这里必须保持一致
const base = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const key = process.env.LLM_KEY;
const model = process.env.LLM_MODEL;

const MATERIALS = `候选人简历节选（2023.03–至今 某电商平台 秒杀系统负责人）：
- 库存扣减：Redis 预减 + 消息队列（RocketMQ）异步落库，宣称扛住 3 万 QPS
- 分布式锁：用 Redis SETNX 做的，超时时间 30 秒`;

const CHUNK = '我用了 Redis 的 DECR 做预减库存，然后发消息到 RocketMQ，下游异步落库。';

const sys = SYSTEM_PROMPT.replace('{MATERIALS}', MATERIALS).replace('{CURRENT_QUESTION}', '讲讲你的秒杀系统怎么做库存扣减的');

const messages = [
  { role: 'system', content: sys },
  { role: 'user', content: '## 已经问过的问题\n\n（还没有问过任何问题，这是第一个问题）' },
  { role: 'user', content: `## 候选人到目前为止的回答\n\n${CHUNK}\n\n## 刚听到的一块（第 1 块）\n\n${CHUNK}\n\n现在给出面试官下一个该问的问题。只输出那四行。` },
];

for (const mt of [220, 220, 220]) {
  const t0 = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: mt, stream: true }),
  });

  console.log(`\n===== max_tokens=${mt} · HTTP ${res.status} ${res.statusText} =====`);
  if (!res.ok) {
    console.log('错误响应体：');
    console.log(await res.text());
    continue;
  }

  let acc = '', reasoning = '', finish = '', nDelta = 0, firstDelta = null;
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      const s = line.trim(); if (!s.startsWith('data:')) continue;
      const p = s.slice(5).trim(); if (!p || p === '[DONE]') continue;
      let j; try { j = JSON.parse(p); } catch { continue; }
      const ch = j?.choices?.[0];
      if (!ch) continue;
      if (firstDelta === null) firstDelta = ch.delta;
      if (ch.delta?.reasoning_content) reasoning += ch.delta.reasoning_content;
      if (ch.delta?.content) { acc += ch.delta.content; nDelta++; }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }
  console.log(`\n===== max_tokens=${mt} · ${Date.now() - t0}ms · delta数=${nDelta} · finish=${finish} =====`);
  console.log('首个 delta 的字段：', JSON.stringify(firstDelta));
  console.log('reasoning_content 长度：', reasoning.length, reasoning ? '→ ' + reasoning.slice(0, 120) : '');
  console.log('content 长度：', acc.length);
  console.log('content 原文：');
  console.log(JSON.stringify(acc));
}

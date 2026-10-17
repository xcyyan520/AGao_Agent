// 找关掉思考的开关。
// 理由：这个内核的整个设计目标是"尽早出题"，而思考过程要花 2 秒才能吐出第一行答案，
// 而且它和答案共用 max_tokens 预算（已证实会截断）。对"25 字以内的一句话"来说，
// 思考是纯负担。所以优先找能关掉它的参数。
import { SYSTEM_PROMPT } from '../engine.mjs';

const base = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const key = process.env.LLM_KEY;

const MATERIALS = `候选人简历节选（2023.03–至今 某电商平台 秒杀系统负责人）：
- 库存扣减：Redis 预减 + 消息队列（RocketMQ）异步落库，宣称扛住 3 万 QPS`;

const sys = SYSTEM_PROMPT.replace('{MATERIALS}', MATERIALS).replace('{CURRENT_QUESTION}', '讲讲你的秒杀系统怎么做库存扣减的');
const messages = [
  { role: 'system', content: sys },
  { role: 'user', content: '## 已经问过的问题\n\n（还没有问过任何问题，这是第一个问题）' },
  { role: 'user', content: `## 候选人到目前为止的回答\n\n我用了 Redis 的 DECR 做预减库存。\n\n## 刚听到的一块（第 1 块）\n\n我用了 Redis 的 DECR 做预减库存。\n\n现在给出面试官下一个该问的问题。只输出那四行。` },
];

const variants = [
  { name: '基准（不传任何开关）', extra: {} },
  { name: 'enable_thinking:false', extra: { enable_thinking: false } },
  { name: 'thinking:{type:disabled}', extra: { thinking: { type: 'disabled' } } },
  { name: 'reasoning_effort:none', extra: { reasoning_effort: 'none' } },
  { name: 'reasoning_effort:minimal', extra: { reasoning_effort: 'minimal' } },
];

console.log('开关                          | HTTP | 首字耗时 | 思考字数 | 答案字数 | finish');
console.log('------------------------------+------+----------+----------+----------+-------');

for (const v of variants) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.LLM_MODEL, messages, temperature: 0.3, max_tokens: 220,
        stream: true, ...v.extra,
      }),
    });
  } catch (e) {
    console.log(`${v.name.padEnd(29)} | 网络错误 ${e.message}`);
    continue;
  }
  if (!res.ok) {
    const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 80);
    console.log(`${v.name.padEnd(29)} | ${res.status}  | —        | —        | —        | ${body}`);
    continue;
  }

  let acc = '', reasoning = '', finish = '', firstContentAt = null, firstAnyAt = null;
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      const s = line.trim(); if (!s.startsWith('data:')) continue;
      const p = s.slice(5).trim(); if (!p || p === '[DONE]') continue;
      let j; try { j = JSON.parse(p); } catch { continue; }
      const ch = j?.choices?.[0]; if (!ch) continue;
      if (ch.delta?.reasoning_content && firstAnyAt === null) firstAnyAt = Date.now() - t0;
      if (ch.delta?.reasoning_content) reasoning += ch.delta.reasoning_content;
      if (ch.delta?.content) {
        if (firstContentAt === null) firstContentAt = Date.now() - t0;
        acc += ch.delta.content;
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }
  const t = firstContentAt !== null ? firstContentAt + 'ms' : (firstAnyAt !== null ? '思考先到 ' + firstAnyAt + 'ms' : '—');
  console.log(`${v.name.padEnd(29)} | ${res.status}  | ${t.padEnd(8)} | ${String(reasoning.length).padStart(8)} | ${String(acc.length).padStart(8)} | ${finish}`);
  console.log(`   └─ 答案：${JSON.stringify(acc.replace(/\n/g, ' / '))}`);
}

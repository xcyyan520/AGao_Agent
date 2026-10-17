// 验证「截断时的降级路径」是否安全。
// 场景：网关不认 enable_thinking（思考照旧），把预算吃光，正文只剩半句。
// 关心两件事：
//   1. pickQuestion 会不会把半截话当成完整问题推给面试官（draft 事件）
//   2. parseNext 会不会把同一个半截话当成 ok=true 存进历史
import { pickQuestion, parseNext } from '../engine.mjs';

// 真实截断样本（来自 .run/probe_max_tokens.mjs 的实测输出）
const samples = [
  ['预算吃光，正文只剩一个字', '问题：那'],
  ['正文被截在理由行',        '问题：那预减之后的消息落库怎么保证不丢？\n理由：他只提了预减，漏说异步落库\n类型'],
  ['完整输出（对照组）',       '问题：Redis 扣到 0 之后，怎么防止继续超卖？\n理由：只说了预减，没说防超卖\n类型：追问\n依据：Redis 的 DECR 做预减'],
  ['模型完全不守格式',         '我觉得应该追问一下超卖的问题。'],
  ['有标签但漏了问题行',       '理由：他讲了异步落库\n类型：追问'],
];

for (const [name, raw] of samples) {
  const draft = pickQuestion(raw);
  const full = parseNext(raw);
  console.log(`【${name}】`);
  console.log(`  原文      ${JSON.stringify(raw)}`);
  console.log(`  draft     ${draft ? JSON.stringify(draft) + '  ← 会上屏' : '（不上屏，安全）'}`);
  console.log(`  nextq     question=${JSON.stringify(full.question)} ok=${full.ok} kind=${full.kind}`);
  if (full.raw) console.log(`            兜底 raw=${JSON.stringify(full.raw)}`);
  console.log('');
}

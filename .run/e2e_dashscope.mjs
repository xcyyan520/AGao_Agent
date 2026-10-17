// 端到端真实验证：完全按浏览器路径走一遍（/events SSE + /api/materials +
// /api/question + /api/replay），把每一次 draft / nextq 的时间和内容打出来。
// 目的是拿到真实模型下的【首字延迟】和【整轮延迟】——这两个数是这个工具能不能用的依据。
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'http://127.0.0.1:8900';
const S = 'real_' + Date.now();

const MATERIALS = `候选人简历节选（2023.03–至今 某电商平台 秒杀系统负责人）：
- 库存扣减：Redis 预减 + 消息队列（RocketMQ）异步落库，宣称扛住 3 万 QPS
- 分布式锁：用 Redis SETNX 做的，超时时间 30 秒
- 上线后做过一次压测，结论是"性能没问题"

候选人自述（上一轮面试记录）：
"这个秒杀系统是我主导做的，峰值确实到过三万，压测是我盯的。"`;

const ANSWER = `我用了 Redis 的 DECR 做预减库存，然后发消息到 RocketMQ，下游异步落库。不过我们实际上没有做异步落库，是同步写库的，QPS 峰值大概 5000 左右。锁的话我们没怎么用分布式锁，因为 Redis 本身是单线程的。压测是压过的，就在本机上跑了一下 JMeter，具体数字记不太清了。`;

const t0 = Date.now();
const rel = () => String(Date.now() - t0).padStart(5) + 'ms';

const events = [];
const ac = new AbortController();
let draftCount = 0, nextqCount = 0;

(async () => {
  const res = await fetch(`${BASE}/events?s=${S}`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const m = JSON.parse(line.slice(6));
          if (m.type === 'chunk') {
            console.log(`${rel()}  [块] ${JSON.stringify(m.text)}`);
          } else if (m.type === 'draft') {
            draftCount++;
            console.log(`${rel()}  [首字·${m.ms}ms] ${m.question}`);
          } else if (m.type === 'nextq') {
            nextqCount++;
            console.log(`${rel()}  [整轮·${m.ms}ms] ${m.question}`);
            console.log(`            理由=${m.reason}｜类型=${m.kind}｜依据=${m.basis}`);
          } else if (m.type === 'judge_error') {
            console.log(`${rel()}  [错误] ${m.message}`);
          } else if (m.type === 'merged') {
            console.log(`${rel()}  [合并] ${m.from.join(',')} → ${m.into}`);
          } else if (m.type === 'question') {
            console.log(`${rel()}  [面试官提问] ${m.question}`);
          } else if (m.type === 'replay_end') {
            console.log(`${rel()}  [回放结束]`);
            ac.abort(); return;
          }
        }
      }
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; }
})();

await sleep(400);

// 1. 材料
const mat = await (await fetch(`${BASE}/api/materials`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ session: S, materials: MATERIALS }),
})).json();
console.log(`\n材料已保存：${mat.chars} 字\n`);

// 2. 面试官的问题
await fetch(`${BASE}/api/question`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ session: S, question: '讲讲你的秒杀系统怎么做库存扣减的' }),
});
console.log(`── 开始回放（${ANSWER.length} 字，4 字/100ms，约 ${Math.round(ANSWER.length / 4 * 0.1)}s）──\n`);

// 3. 回放
await fetch(`${BASE}/api/replay`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ session: S, text: ANSWER, charsPer100ms: 4 }),
});

await sleep(ANSWER.length / 4 * 100 + 25000);

const st = await (await fetch(`${BASE}/api/state?s=${S}`)).json();
const pct = (a, p) => {
  if (!a.length) return '—';
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] + 'ms';
};
console.log('\n════════ 汇总 ════════');
console.log(`块数 ${st.stats.chunks}｜出题 ${st.history.length} 次｜合并 ${st.stats.merged}｜失败 ${st.stats.failed}｜丢弃 ${st.stats.dropped}`);
console.log(`首字 p50 ${pct(st.stats.draftLatency, .5)}  全部 ${JSON.stringify(st.stats.draftLatency)}`);
console.log(`整轮 p50 ${pct(st.stats.latency, .5)}  p90 ${pct(st.stats.latency, .9)}  全部 ${JSON.stringify(st.stats.latency)}`);
console.log(`\n出题历史：`);
for (const h of st.history) console.log(`  [${h.kind}] ${h.question}  (${h.ms}ms)`);
process.exit(0);

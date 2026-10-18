/* 验证「历史面试能加载整场」：对话流（lines）有没有真的落库。
   走的是真实 HTTP 路径：材料 -> 提问 -> 回放 -> 等出题 -> 查库。
   跑法：node .run/probe_lines.mjs */
const BASE = 'http://127.0.0.1:8900';
const S = 'probe_lines_' + Date.now().toString(36);

const jpost = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: S, ...body }),
  });
  return r.json();
};

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ← ' + extra : '')); }
};

const mats = '候选人简历：云联客服工单平台，Java + Python 双栈。Redis 预减库存用 DECR，消息投 Kafka。简历写异步落库三万 QPS。';
await jpost('/api/materials', { materials: mats });
await jpost('/api/question', { question: '介绍下你的项目' });

const replay = '我用的是 Redis 预减库存，DECR 扣完再发 Kafka。异步落库这块我们做到了三千 QPS，不是三万。';
await jpost('/api/replay', { text: replay, charsPer100ms: 12 });

// 等回放跑完 + 出题
await new Promise(r => setTimeout(r, 12000));

const st = await (await fetch(`${BASE}/api/state?s=${S}`)).json();
console.log(`\n内存状态：chunks=${st.stats.chunks} 出题=${st.history.length} transcript=${st.transcript.length}`);

const data = await (await fetch(`${BASE}/api/sessions/get?id=${S}`)).json();
console.log(`库里：lines=${(data.lines || []).length} turns=${(data.turns || []).length} suggestions=${(data.suggestions || []).length}\n`);

console.log('库里存的对话流：');
for (const l of data.lines || []) console.log(`  <${l.role}> ${l.text}`);

console.log('\n库里存的建议：');
for (const g of data.suggestions || []) console.log(`  · [${g.kind}] ${g.question}`);

console.log('\n=== 断言 ===');
ok('回放切出了块', st.stats.chunks > 0, `chunks=${st.stats.chunks}`);
ok('候选人的话落库了', (data.lines || []).some(l => l.role === 'candidate'), JSON.stringify((data.lines || []).map(l => l.role)));
ok('库里对话句子数和块数一致', (data.lines || []).filter(l => l.role === 'candidate').length === st.stats.chunks,
  `lines.candidate=${(data.lines || []).filter(l => l.role === 'candidate').length} chunks=${st.stats.chunks}`);
ok('候选人说的内容对得上', (data.lines || []).filter(l => l.role === 'candidate').map(l => l.text).join('').includes('DECR'));
ok('面试官那句在库里', (data.lines || []).some(l => l.role === 'interviewer' && l.text.includes('介绍下你的项目')));
ok('turns 里存了面试官的问题', (data.turns || []).some(t => t.question.includes('介绍下你的项目')));
ok('AI 出的题落库了', (data.suggestions || []).length === st.history.length,
  `db=${(data.suggestions || []).length} mem=${st.history.length}`);

const ls = await (await fetch(`${BASE}/api/sessions?limit=10`)).json();
const mine = (ls.items || []).find(x => x.id === S);
ok('列表里带上了句数', mine && mine.lines === (data.lines || []).length, JSON.stringify(mine));

/* 收尾：删掉这场。不删的话大厅和历史里会多一间 `probe_lines_xxx`
   （id 当名字），跑几次就淹掉真实房间——大厅只取前 24 条，
   垃圾够多时用户自己的面试会被挤出列表，看起来像数据丢了。 */
await fetch(`${BASE}/api/sessions/delete`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: S }),
}).catch(() => {});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

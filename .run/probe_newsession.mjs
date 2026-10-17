/* 验证「重置 = 结束这一场 + 起名 + 开一场新的」这条链路。
   走真实 HTTP，不用浏览器：这条链路的全部逻辑都在两个端点上，
   浏览器那侧只是把响应体里的 next 接住、换掉 SESSION、重连 SSE。 */
const BASE = 'http://127.0.0.1:8900';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const get = async p => (await fetch(BASE + p)).json();

const OLD = 'probe_new_' + Date.now();

console.log('=== 1. 造一场有内容的旧面试 ===');
await post('/api/materials', { session: OLD, materials: '我做过一个客服工单平台，用 Redis 预减库存，异步落库。', name: '探针材料' });
await post('/api/question', { session: OLD, question: '讲讲你的项目' });
await post('/api/replay', { session: OLD, text: '我用 Redis 做的预减，然后消息发到 Kafka。', charsPer100ms: 12 });
await new Promise(r => setTimeout(r, 9000));
await post('/api/stop-replay?s=' + OLD);

let st = await get('/api/state?s=' + OLD);
const oldChunks = st.stats.chunks;
ok('旧场切出了块', oldChunks > 0, `chunks=${oldChunks}`);

console.log('\n=== 2. 重置：带名字 ===');
const r1 = await post('/api/reset', { session: OLD, title: '云联科技 · 一面' });
ok('重置返回 ok', r1.json?.ok === true);
ok('返回了新场次的 id', typeof r1.json?.next === 'string' && r1.json.next.length > 0, r1.json?.next);
ok('返回的 next 和旧场不同', r1.json?.next !== OLD);
ok('带回名字', r1.json?.title === '云联科技 · 一面', r1.json?.title);
const NEW = r1.json.next;

console.log('\n=== 3. 旧场完整留在历史里（名字 + 内容都在）===');
const list = await get('/api/sessions?limit=50');
const found = (list.items || []).find(x => x.id === OLD);
ok('旧场还在历史里', !!found);
ok('旧场带着刚起的名字', found?.title === '云联科技 · 一面', found?.title);
ok('旧场保留着出过的题', (found?.suggestions || 0) > 0, `${found?.suggestions} 道`);
ok('旧场保留着对话记录', (found?.lines || 0) > 0, `${found?.lines} 句`);

const oldData = await get('/api/sessions/get?id=' + encodeURIComponent(OLD));
ok('旧场的对话内容读得出来', (oldData?.lines || []).length > 0);
ok('旧场的题目读得出来', (oldData?.suggestions || []).length > 0);
ok('旧场的提问记录在', (oldData?.turns || []).length > 0);

console.log('\n=== 4. 新场是干净的 ===');
st = await get('/api/state?s=' + NEW);
ok('新场没有出过题', (st.history || []).length === 0, `${(st.history || []).length} 条`);
ok('新场没有对话记录', (st.transcript || []).length === 0);
ok('新场没有块', (st.stats.chunks || 0) === 0);
ok('新场没有已问过的问题', (st.asked || []).length === 0);
/* 材料会跟着走吗？不会——新场是全新一行，material_id 为空。
   这是刻意的：材料是「这个人是谁」，但一场新面试可能换了个岗位。
   前端换场时不清输入框，人想复用直接点「保存材料」即可。 */
ok('新场不自动继承旧场材料', !st.persisted?.materialId, String(st.persisted?.materialId));

console.log('\n=== 5. 新场能正常出题（不是死场）===');
await post('/api/materials', { session: NEW, materials: '我做过一个客服工单平台，用 Redis 预减库存，异步落库。', name: '探针材料' });
await post('/api/question', { session: NEW, question: '再讲讲你怎么保证不丢消息' });
await post('/api/replay', { session: NEW, text: '消息发到 Kafka，消费者落库，失败就重试三次进死信。', charsPer100ms: 12 });
await new Promise(r => setTimeout(r, 12000));
await post('/api/stop-replay?s=' + NEW);
st = await get('/api/state?s=' + NEW);
ok('新场切出了块', (st.stats.chunks || 0) > 0, `chunks=${st.stats.chunks}`);
ok('新场出了题', (st.history || []).length > 0, `${(st.history || []).length} 道`);
if ((st.history || []).length) console.log(`    第一题：${st.history[0].question}`);

console.log('\n=== 6. 不带名字重置也能用 ===');
const r2 = await post('/api/reset', { session: NEW });
ok('不带名字也 ok', r2.json?.ok === true);
ok('不带名字时 title 为 null', r2.json?.title === null);
const NEW2 = r2.json.next;
const list2 = await get('/api/sessions?limit=50');
const f2 = (list2.items || []).find(x => x.id === NEW);
ok('没起名的旧场仍在历史里', !!f2);
ok('没起名时回退显示 id', f2 && !f2.title, f2?.title || '(无名字)');

console.log('\n=== 7. 起名接口单独可用 ===');
const r3 = await post('/api/sessions/rename', { session: NEW, title: '后补的名字' });
ok('改名接口返回 ok', r3.json?.ok === true);
const list3 = await get('/api/sessions?limit=50');
ok('改名生效', (list3.items || []).find(x => x.id === NEW)?.title === '后补的名字');

console.log('\n=== 清理 ===');
for (const id of [OLD, NEW, NEW2]) await post('/api/sessions/delete', { id });
for (const id of [OLD, NEW, NEW2]) await post('/api/reset', { session: id });
console.log('  已清掉探针造的会话');

console.log(`\n=== 结果 ===\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

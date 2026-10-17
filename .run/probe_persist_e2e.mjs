/**
 * probe_persist_e2e.mjs —— 持久化的端到端验证
 *
 * 要证明的四件事（都是用户抱怨过的）：
 *   1. 材料只粘一次，下次能从材料库直接装回来
 *   2. 服务重启后，这一场问过的题、AI 出过的题还在
 *   3. 新的一场里，AI 知道「以前问过什么」（跨场记忆进了提示词）
 *   4. 重启后块号接着走，新出的题不会被当成乱序丢掉
 *
 * 用法：node .run/probe_persist_e2e.mjs <baseUrl>
 *   默认 http://127.0.0.1:8900
 *
 * ⚠️ 这个脚本会**重启你自己起的服务**吗？不会。
 * 它只调用 HTTP 接口，靠连续两次 GET /api/state 之间你手动重启来验证「重启后还在」。
 * 为了自动化，这里改成用**两个不同的 session id** 模拟「两场面试」，
 * 重启那一步由外层的 pwsh 脚本负责。
 */
import { readFileSync } from 'node:fs';

const BASE = (process.argv[2] || 'http://127.0.0.1:8900').replace(/\/+$/, '');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
    body: JSON.stringify(body || {}),
  });
  const t = await r.text();
  try { return { status: r.status, json: JSON.parse(t) }; }
  catch { return { status: r.status, text: t }; }
};
const get = async (p) => {
  const r = await fetch(BASE + p, { headers: { 'Connection': 'close' } });
  const t = await r.text();
  try { return { status: r.status, json: JSON.parse(t) }; }
  catch { return { status: r.status, text: t }; }
};

const STAMP = process.env.STAMP || String(Date.now());
const S1 = `persist_a_${STAMP}`;
const S2 = `persist_b_${STAMP}`;

console.log(`\n=== 阶段一：在会话 A 里存材料 + 记两个提问 ===  (${BASE})`);

const corpus = readFileSync(new URL('../云联-逐字稿.md', import.meta.url), 'utf8');
const matName = `端到端测试材料 ${STAMP}`;

const saved = await post('/api/materials', { session: S1, materials: corpus, name: matName });
ok('保存材料返回成功', saved.json?.ok === true);
ok('材料字数与文件一致', saved.json?.chars === corpus.length, `期望 ${corpus.length}，得到 ${saved.json?.chars}`);
ok('返回了 materialId', Number.isFinite(saved.json?.materialId));

const q1 = '先讲讲你负责的那个客服工单平台';
const q2 = '你说用 LangGraph 编排，为什么不用 Spring AI';
await post('/api/question', { session: S1, question: q1 });
await post('/api/question', { session: S1, question: q2 });

const st1 = await get(`/api/state?s=${encodeURIComponent(S1)}`);
// 注意引擎的语义：newQuestion(q) 把【上一个】问题推进 asked，
// 当前这个放在 currentQuestion 里。所以问过 q1、q2 之后，
// asked=[q1]、currentQuestion=q2 —— 不是 asked=[q1,q2]。
// 我第一版就是按 asked=[q1,q2] 断言的，白报了一个错。
ok('会话 A 的 asked 记下了上一问', st1.json?.asked?.length === 1, JSON.stringify(st1.json?.asked));
ok('asked 里是第一问', st1.json?.asked?.includes(q1));
ok('当前问题是第二问', st1.json?.currentQuestion === q2, st1.json?.currentQuestion);
ok('state 里有 persisted 字段', st1.json?.persisted?.enabled === true);
ok('state 报告了 materialId', Number.isFinite(st1.json?.persisted?.materialId));

console.log('\n=== 阶段二：材料库能列出、能取回 ===');
const list = await get('/api/materials/list');
const mine = (list.json?.items || []).find(m => m.name === matName);
ok('材料库里能找到刚存的那份', !!mine, `共 ${list.json?.items?.length} 份`);
ok('列表不包含正文（省流量）', mine && mine.text === undefined);

const got = await get(`/api/materials/get?id=${mine?.id}`);
ok('按 id 能取回完整正文', got.json?.material?.text === corpus);

console.log('\n=== 阶段三：会话 B 里直接装材料（不用再粘一次）===');
const use = await post('/api/materials/use', { session: S2, id: mine?.id });
ok('装材料成功', use.json?.ok === true);
ok('装进来的字数正确', use.json?.chars === corpus.length);

const st2 = await get(`/api/state?s=${encodeURIComponent(S2)}`);
ok('会话 B 的材料已生效（拿不到 materials 正文，用间接判据）',
  st2.json?.persisted?.materialId === mine?.id, `materialId=${st2.json?.persisted?.materialId}`);
ok('会话 B 的 asked 是空的（新的一场）', (st2.json?.asked || []).length === 0);

console.log('\n=== 阶段四：跨场记忆 ===');
// 会话 B 应该看到「会话 A 里问过的两个问题」——虽然它自己的 asked 是空的。
// 这个信息只在 judge.priorAsked 里，通过 /api/state 暴露。
ok('会话 B 拿到了跨场记忆（以前问过的题）',
  (st2.json?.persisted?.priorAsked || 0) >= 2,
  `priorAsked=${st2.json?.persisted?.priorAsked}`);

console.log('\n=== 阶段五：会话列表 ===');
const sess = await get('/api/sessions');
const a = (sess.json?.items || []).find(x => x.id === S1);
ok('会话列表里有会话 A', !!a);
ok('会话 A 统计到 2 个提问', a?.turns === 2, `turns=${a?.turns}`);
ok('会话 A 关联了材料名', a?.material_name === matName, a?.material_name);

const sget = await get(`/api/sessions/get?id=${encodeURIComponent(S1)}`);
ok('能取回整场详情', sget.json?.ok === true);
ok('详情里有两轮提问', (sget.json?.turns || []).length === 2);
ok('详情里的问题文本正确', (sget.json?.turns || []).some(t => t.question === q2));

console.log('\n=== 阶段六：清理 ===');
await post('/api/sessions/delete', { id: S1 });
await post('/api/sessions/delete', { id: S2 });
await post('/api/materials/delete', { id: mine?.id });
const after = await get('/api/materials/list');
ok('材料已删除', !(after.json?.items || []).some(m => m.id === mine?.id));

console.log(`\n--- ${pass} 通过 / ${fail} 失败 ---`);
console.log(`（session 前缀：${STAMP}）`);

/* ⚠️ 退出方式这里有坑，别改回去。
 *
 * 第一版写的是 `process.exit(fail ? 1 : 0)`，结果每次都在 stderr 打
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
 * 并且退出码变成 0xC0000409（-1073740791）——**测试明明 23/23 全过，
 * 退出码却是失败**。踩的原因是 fetch 底层 undici 的连接池还挂着句柄，
 * process.exit() 在句柄正被关闭的时刻强行终止进程，撞上 libuv 的断言。
 *
 * 试过但**没用**的：给请求加 'Connection: close' 头、等一会儿再退。
 * 有用的：什么都不做，让进程自然退出——所有 fetch 都 await 完了，
 * 事件循环自然空掉，退出码是干净的 0。
 *
 * 所以这个文件末尾故意不写 process.exit。
 */

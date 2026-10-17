/**
 * test_engine.mjs —— 出题内核验证
 *
 * 验证的不是"题出得好不好"（那要靠真模型跑真面试才能量），而是这些**机制**：
 *   1. 流式提前上屏：问题那一行一到就推给前端，不等整轮推理结束
 *   2. 乱序丢弃：迟到的旧结果绝不覆盖新结果
 *   3. 换问题时清空本次回答、把旧问题记进"已问过"
 *   4. 前缀缓存形状：系统提示词和"已问过"块在会上保持不变
 *   5. 输出容错：模型不守格式时也要退化出东西，不能抛异常
 *   6. 错误与超时：不能把整条链路卡住
 *
 * 用法（不需要任何 API Key，测试自带桩服务）：
 *   node test_engine.mjs
 */

import http from 'node:http';
import {
  IncrementalQuestioner, parseNext, pickQuestion, cleanStr,
} from './engine.mjs';

let pass = 0, fail = 0;
const fails = [];

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; fails.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  ' + extra : ''}`); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return true;
    await sleep(10);
  }
  return false;
}

/** 起一个桩 LLM，返回它的 baseUrl。handler 自己决定怎么响应。 */
function stub(handler) {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {}
        Promise.resolve(handler(req, res, body)).catch(e => {
          try { res.destroy(e); } catch (_) {}
        });
      });
    });
    s.listen(0, '127.0.0.1', () => resolve({
      server: s,
      url: `http://127.0.0.1:${s.address().port}`,
      close: () => new Promise(r => s.close(r)),
    }));
  });
}

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const delta = (res, text) => sse(res, { choices: [{ index: 0, delta: { content: text } }] });

/** 正常的一轮：问题先到，隔一会儿才补齐后面三行。这是真模型的典型形状。 */
function normalHandler(gapMs = 300) {
  return async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.write(': open\n\n');
    await sleep(30);
    delta(res, '问题：消息要是没发出去呢？\n');
    await sleep(gapMs);                      // ← 这段就是"提前上屏"省下来的时间
    delta(res, '理由：他讲了异步落库，但没说可靠性\n');
    delta(res, '类型：追问\n');
    delta(res, '依据：异步落库\n');
    res.write('data: [DONE]\n\n');
    res.end();
  };
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n\x1b[1m【1】流式提前上屏：问题那一行先到\x1b[0m');
/* ══════════════════════════════════════════════════════════════════════ */
{
  const st = await stub(normalHandler(400));
  const q = new IncrementalQuestioner({ baseUrl: st.url, apiKey: 'x', model: 't' });

  const drafts = [], results = [];
  q.on('draft', d => drafts.push({ ...d, at: Date.now() }));
  q.on('nextq', r => results.push({ ...r, at: Date.now() }));

  const t0 = Date.now();
  q.submit('我用了 Redis 预减，然后发消息到 RocketMQ，下游异步落库。');

  await waitFor(() => results.length === 1);
  const draftMs = drafts[0] ? drafts[0].at - t0 : -1;
  const fullMs = results[0] ? results[0].at - t0 : -1;

  ok('产生了 draft 事件', drafts.length === 1, `drafts=${drafts.length}`);
  ok('draft 里是【完整】的问题，不是半句',
    drafts[0]?.question === '消息要是没发出去呢？', `实际=${JSON.stringify(drafts[0]?.question)}`);
  ok('draft 只发一次', drafts.length === 1, `${drafts.length} 次`);
  ok('draft 明显早于整轮结束',
    draftMs > 0 && fullMs - draftMs > 250, `draft=${draftMs}ms 整轮=${fullMs}ms（省了 ${fullMs - draftMs}ms）`);

  ok('整轮结果补齐理由', results[0]?.reason === '他讲了异步落库，但没说可靠性');
  ok('类型归一成代码 probe', results[0]?.kind === 'probe', `实际=${results[0]?.kind}`);
  ok('依据解析出来', results[0]?.basis === '异步落库');
  ok('结果标记 ok', results[0]?.ok === true);
  ok('记录了 draft 延迟统计', q.stats.draftLatency.length === 1);

  await st.close();
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n\x1b[1m【2】乱序丢弃：迟到的旧结果不许覆盖新结果\x1b[0m');
/* ══════════════════════════════════════════════════════════════════════ */
{
  const st = await stub(normalHandler(0));
  const q = new IncrementalQuestioner({ baseUrl: st.url, apiKey: 'x', model: 't' });

  const results = [], stales = [];
  q.on('nextq', r => results.push(r));
  q.on('stale', x => stales.push(x));

  // 伪造"已经应用过第 99 块"，那么接下来任何一块都是迟到的旧结果
  q.appliedSeq = 99;
  q.submit('这一块应当被丢掉。');
  await waitFor(() => stales.length === 1);

  ok('迟到结果被丢弃', stales.length === 1, `stale=${stales.length}`);
  ok('迟到结果没有上屏', results.length === 0, `nextq=${results.length}`);
  ok('计入 dropped 统计', q.stats.dropped === 1, `dropped=${q.stats.dropped}`);

  await st.close();
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n\x1b[1m【3】换问题：清空本次回答，旧问题进"已问过"\x1b[0m');
/* ══════════════════════════════════════════════════════════════════════ */
{
  const st = await stub(normalHandler(0));
  const q = new IncrementalQuestioner({ baseUrl: st.url, apiKey: 'x', model: 't' });

  await q.newQuestion('讲讲你的秒杀系统怎么做库存扣减的');
  q.submit('我用 Redis 的 DECR 做预减。');
  await waitFor(() => q.history.length === 1);

  ok('本次回答在累计', q.answer.includes('DECR'), `answer=${JSON.stringify(q.answer)}`);

  await q.newQuestion('那你压测过吗？');
  ok('换问题后本次回答清零', q.answer === '', `answer=${JSON.stringify(q.answer)}`);
  ok('上一个问题进了已问过',
    q.asked.length === 1 && q.asked[0] === '讲讲你的秒杀系统怎么做库存扣减的',
    JSON.stringify(q.asked));
  ok('当前问题已更新', q.currentQuestion === '那你压测过吗？');

  await q.newQuestion('那你压测过吗？');   // 再问一次：这一句现在已在"已问过"里
  ok('换问题时上一问被收进已问过', q.asked.length === 2, `asked=${q.asked.length}`);
  await q.newQuestion('那你压测过吗？');   // 第三次问同一句，不应再增加
  ok('已在已问过里的问题不会重复记录', q.asked.length === 2, `asked=${q.asked.length}`);
  ok('已问过里没有重复项', new Set(q.asked).size === q.asked.length, JSON.stringify(q.asked));

  await st.close();
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n\x1b[1m【4】前缀缓存形状：系统提示词与"已问过"块在会上不变\x1b[0m');
/* ══════════════════════════════════════════════════════════════════════ */
{
  const q = new IncrementalQuestioner({ baseUrl: 'http://127.0.0.1:1', apiKey: 'x', model: 't' });
  q.setContext({ materials: '候选人简历：负责秒杀系统。' });
  await q.newQuestion('Q1');

  const m1 = q._buildMessages({ seq: 1, text: '第一块' });
  q.answer = '第一块\n第二块更长一些的内容';
  const m2 = q._buildMessages({ seq: 2, text: '第二块' });

  ok('系统提示词整场逐字节不变（前缀缓存的关键）', m1[0].content === m2[0].content);
  ok('"已问过"块纯追加、本轮不变', m1[1].content === m2[1].content);
  ok('每轮变化的只在最后一条消息', m1[2].content !== m2[2].content);
  ok('材料进了系统提示词', m1[0].content.includes('候选人简历：负责秒杀系统。'));
  ok('当前问题进了系统提示词', m1[0].content.includes('Q1'));
  ok('没有留下未替换的占位符',
    !m1[0].content.includes('{MATERIALS}') && !m1[0].content.includes('{CURRENT_QUESTION}'));
  ok('本次回答进了最后一条消息', m2[2].content.includes('第二块更长一些的内容'));
  ok('块号进了最后一条消息', m2[2].content.includes('第 2 块'));

  // 没材料时要给出明确的空态，而不是留下空白让人猜
  const q2 = new IncrementalQuestioner({ baseUrl: 'http://127.0.0.1:1', apiKey: 'x', model: 't' });
  const m3 = q2._buildMessages({ seq: 1, text: 'x' });
  ok('无材料时给出空态说明', m3[0].content.includes('没有提供材料'));
  ok('没有已问过问题时给出空态说明', m3[1].content.includes('还没有问过任何问题'));
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n\x1b[1m【5】输出容错：模型不守格式也要退化出东西\x1b[0m');
/* ══════════════════════════════════════════════════════════════════════ */
{
  const t = (raw) => parseNext(raw);

  ok('标准四行', t('问题：A？\n理由：B\n类型：追问\n依据：C').question === 'A？');
  ok('中文冒号', t('问题：A？\n理由：B').question === 'A？');
  ok('半角冒号', t('问题: A？\n理由: B').question === 'A？');
  ok('类型=追问 → probe', t('问题：A\n类型：追问').kind === 'probe');
  ok('类型=新方向 → fresh', t('问题：A\n类型：新方向').kind === 'fresh');
  ok('类型=收尾 → wrap', t('问题：A\n类型：收尾').kind === 'wrap');
  ok('类型乱写但有依据 → 退回 probe', t('问题：A\n类型：banana\n依据：C').kind === 'probe');
  ok('类型乱写且无依据 → 退回 fresh', t('问题：A\n类型：banana').kind === 'fresh');
  ok('只有一行也能当问题用', t('那消息没发出去呢？').question === '那消息没发出去呢？');
  ok('剥掉 markdown 粗体', t('问题：**A？**').question === 'A？');
  ok('剥掉包裹的引号', t('问题：“带引号的问题？”').question === '带引号的问题？');
  ok('剥掉包裹的「」', t('问题：「中括号问题？」').question === '中括号问题？');
  ok('空输入不抛异常且 ok=false', t('').ok === false && t('').question === '');
  ok('全空白不抛异常', t('   \n  \n').ok === false);
  ok('缺问题但有其他字段时 ok=false', t('理由：B\n类型：追问').ok === false);
  ok('多写一句解释也不影响取问题',
    t('好的，我的建议如下：\n问题：A？\n理由：B').question === 'A？');
  ok('cleanStr 去不掉中间的字', cleanStr('  a b  ') === 'a b');

  /* ── 被 max_tokens 截断时，不能把残渣当题 ──────────────────────────────
     实测踩过：deepseek-v4.1-flash 这类推理模型会先吐 355 字的 reasoning_content，
     而思考和答案共用 max_tokens 预算，预算被吃光后 finish_reason=length，
     正文只剩「问题：那」两个字，面试官屏幕上真的出现过一个孤零零的「那」。
     下面这些断言盯着"截断残渣必须 ok=false"这件事。 */
  ok('截断残渣（1 个字）不进历史', t('问题：那').ok === false);
  ok('截断残渣（1 个字）question 为空', t('问题：那').question === '');
  ok('截断残渣带冒号也不放行', t('问题：那').ok === false && t('问题：好').ok === false);
  // 但不能误杀真实存在的短问句：阈值是 2，和 pickQuestion 一致。
  ok('两个字的短问句仍然放行', t('问题：多久？').question === '多久？');
  ok('截断在理由行仍能取出完整问题',
    t('问题：那预减之后的消息落库怎么保证不丢？\n理由：他只提了预减\n类型').question
      === '那预减之后的消息落库怎么保证不丢？');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n\x1b[1m【6】pickQuestion：半句话绝不能上屏\x1b[0m');
/* ══════════════════════════════════════════════════════════════════════ */
{
  ok('问题行还没结束时返回空', pickQuestion('问题：半个问') === '');
  ok('问题行还没结束时返回空（有冒号无内容）', pickQuestion('问题：') === '');
  ok('遇到换行即认为结束', pickQuestion('问题：完整？\n') === '完整？');
  ok('遇到"理由："即认为结束', pickQuestion('问题：完整？理由：x') === '完整？');
  ok('只有单个标点不算问题', pickQuestion('问题：。\n') === '');
  ok('没有"问题："前缀时返回空', pickQuestion('理由：x\n类型：追问') === '');
  ok('流式过程中确实能提前拿到',
    pickQuestion('问题：那消息要是没发出去呢？\n理由：他讲了异步落库') === '那消息要是没发出去呢？');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n\x1b[1m【7】错误与降级\x1b[0m');
/* ══════════════════════════════════════════════════════════════════════ */
{
  // (a) 上游 500：要发 error 事件，不能静默吞掉，也不能卡住队列
  {
    const st = await stub(async (req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('boom');
    });
    const q = new IncrementalQuestioner({ baseUrl: st.url, apiKey: 'x', model: 't' });
    const errs = [];
    q.on('error', e => errs.push(e));
    q.submit('随便一句。');
    await waitFor(() => errs.length === 1);
    ok('上游 500 触发 error 事件', errs.length === 1, `errs=${errs.length}`);
    ok('错误信息带上了状态码', String(errs[0]?.error?.message || '').includes('500'),
      String(errs[0]?.error?.message || ''));
    ok('计入 failed 统计', q.stats.failed === 1, `failed=${q.stats.failed}`);
    ok('busy 已复位，不会卡住后续', q.busy === false);
    await st.close();
  }

  // (b) 网关不认 stream：整包 JSON 也要能解析
  {
    const st = await stub(async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '问题：降级路径的问题？\n理由：r\n类型：新方向\n依据：b' } }],
      }));
    });
    const q = new IncrementalQuestioner({ baseUrl: st.url, apiKey: 'x', model: 't' });
    const results = [], drafts = [];
    q.on('nextq', r => results.push(r));
    q.on('draft', d => drafts.push(d));
    q.submit('一句。');
    await waitFor(() => results.length === 1);
    ok('非流式网关也能出题', results[0]?.question === '降级路径的问题？');
    ok('非流式路径同样发 draft', drafts.length === 1, `drafts=${drafts.length}`);
    ok('非流式路径类型正确', results[0]?.kind === 'fresh');
    await st.close();
  }

  // (c) 上游不响应：硬超时要能放弃
  {
    const st = await stub(async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': 挂着不回\n\n');
      await sleep(60000);
    });
    const q = new IncrementalQuestioner({ baseUrl: st.url, apiKey: 'x', model: 't', timeoutMs: 300 });
    const errs = [];
    q.on('error', e => errs.push(e));
    const t0 = Date.now();
    q.submit('一句。');
    await waitFor(() => errs.length === 1, 4000);
    const ms = Date.now() - t0;
    ok('不响应的上游被超时放弃', errs.length === 1, `errs=${errs.length}`);
    ok('放弃时间接近设定的超时', ms < 2500, `${ms}ms`);
    ok('超时后 busy 复位', q.busy === false);
    await st.close();
  }
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n\x1b[1m【8】背压：积压时合并而不是丢弃\x1b[0m');
/* ══════════════════════════════════════════════════════════════════════ */
{
  const st = await stub(normalHandler(250));
  const q = new IncrementalQuestioner({ baseUrl: st.url, apiKey: 'x', model: 't' });
  const merged = [], results = [];
  q.on('merged', m => merged.push(m));
  q.on('nextq', r => results.push(r));

  // 第一块还在推理中，紧接着灌入两块 —— 队列应当合并成一块
  q.submit('第一块内容。');
  q.submit('第二块内容。');
  q.submit('第三块内容。');

  await waitFor(() => results.length >= 2, 6000);

  ok('发生了合并而不是丢弃', merged.length >= 1, `merged=${merged.length}`);
  ok('所有块的内容都保留在回答里',
    q.answer.includes('第一块') && q.answer.includes('第二块') && q.answer.includes('第三块'),
    JSON.stringify(q.answer));
  ok('没有丢块', q.stats.dropped === 0, `dropped=${q.stats.dropped}`);
  ok('没有失败', q.stats.failed === 0, `failed=${q.stats.failed}`);
  ok('回答在累计', q.stats.answerChars.length === 3, `n=${q.stats.answerChars.length}`);

  await st.close();
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n\x1b[1m【9】回答长度上限：极端长回答不会把输入撑爆\x1b[0m');
/* ══════════════════════════════════════════════════════════════════════ */
{
  // 这一段只测「回答截断」，不测网络。上游故意指向一个死端口，
  // 所以必须自己吞掉 error 事件：EventEmitter 在没有 'error' 监听者时
  // 会把 emit('error') 抛成未捕获异常，直接崩掉整个测试进程。
  // （server.mjs 里有监听者，所以线上不会有这个问题；这是测试自己欠的债。）
  const q = new IncrementalQuestioner({
    baseUrl: 'http://127.0.0.1:1', apiKey: 'x', model: 't', answerLimit: 100,
  });
  q.on('error', () => {});
  for (let i = 0; i < 20; i++) q.submit('这是一段用来撑长度的回答内容' + i + '。');
  ok('回答被截到上限以内', q.answer.length <= 100, `len=${q.answer.length}`);
  ok('保留的是最近的内容（截断只砍头）',
    q.answer.includes('19。') && !q.answer.includes('回答内容0。'), q.answer.slice(0, 40));
  ok('截断本身没有报错', q.answer.length === 100, `len=${q.answer.length}`);
  // 等在途请求全部收尾，别把未处理的 rejection 漏给后面的段落。
  // 注意不能拿 chunks 当分母：submit 会把积压块合并，20 次 submit 只发出 2 个请求。
  await waitFor(() => !q.busy && !q.queue.length, 4000);
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n\x1b[1m【10】防重复：AI 自己给过的建议必须喂回提示词\x1b[0m');
/* ══════════════════════════════════════════════════════════════════════ */
{
  // 真实语料实测的失败形态：候选人一直说、面试官一直没开口，
  // asked 始终为空，模型看不到自己刚建议过什么，于是同一句出了 19 遍。
  // 这里用桩模型模拟"只要没被提醒就复读同一句"的模型。
  const SAME = '那 LangChain 原生 Agent 和 LangGraph 差在哪？';
  const st = await stub((req, res, body) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // 桩模型的行为：看提示词里有没有"你刚才已经给过的建议"，
    // 有就换一道新题，没有就继续复读。
    const all = JSON.stringify(body.messages || []);
    const reminded = all.includes('你刚才已经给过的建议');
    const q = reminded ? '那断点恢复具体是怎么实现的？' : SAME;
    const text = `问题：${q}\n理由：测试\n类型：追问\n依据：测试\n`;
    delta(res, text);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  const q = new IncrementalQuestioner({ baseUrl: st.url, apiKey: 'x', model: 't' });
  const results = [];
  q.on('nextq', (r) => results.push(r));

  q.submit('第一块回答。');
  await waitFor(() => results.length === 1);
  ok('第 1 轮没有提醒，模型复读出同一句', q.suggested.length === 1, `suggested=${q.suggested.length}`);
  ok('重复被引擎自己数出来了（不靠事后相似度猜）', q.stats.repeated === 0,
    `repeated=${q.stats.repeated}`);

  q.submit('第二块回答。');
  await waitFor(() => results.length === 2);

  ok('第 2 轮的提示词里带上了"给过的建议"',
    q._buildMessages({ seq: 3, text: 'x' })[2].content.includes('你刚才已经给过的建议'));
  ok('提示词里列出了上一轮那条原话',
    q._buildMessages({ seq: 3, text: 'x' })[2].content.includes(SAME));
  ok('被提醒之后模型换了新题',
    results[1] && results[1].question === '那断点恢复具体是怎么实现的？',
    `q2=${results[1] && results[1].question}`);
  ok('"给过的建议"没有进稳定前缀（否则每轮打掉前缀缓存）',
    !q._buildMessages({ seq: 3, text: 'x' })[0].content.includes('你刚才已经给过的建议') &&
    !q._buildMessages({ seq: 3, text: 'x' })[1].content.includes('你刚才已经给过的建议'));

  await st.close();
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n\x1b[1m【11】重复判定：抓得住变体，也不误杀真新题\x1b[0m');
/* ══════════════════════════════════════════════════════════════════════ */
{
  const q = new IncrementalQuestioner({ baseUrl: 'http://127.0.0.1:1', apiKey: 'x', model: 't' });
  q._remember('那 LangChain 原生 Agent 和 LangGraph 差在哪？');

  ok('逐字相同判为重复', q._isRepeat('那 LangChain 原生 Agent 和 LangGraph 差在哪？'));
  ok('少了句首"那"的变体也判为重复', q._isRepeat('LangChain 原生 Agent 和 LangGraph 差在哪？'));
  ok('标点不同仍判为重复', q._isRepeat('那 LangChain 原生 Agent 和 LangGraph 差在哪'));

  // 关键：不能把真正不同的题判成重复，那会让面试官少看到一道好题
  ok('真正不同的题不判为重复', !q._isRepeat('那断点恢复具体是怎么实现的？'));
  ok('同一产品名但问的是另一件事，不判为重复',
    !q._isRepeat('LangGraph 的 checkpointer 怎么选？'));
  ok('换了个角度的新问法不判为重复',
    !q._isRepeat('那不用 LangGraph，LangChain 原生 Agent 差在哪？'));

  ok('空题不污染列表', (q._remember(''), q.suggested.length === 1));
  ok('重复记两次只留一条',
    (q._remember('那 LangChain 原生 Agent 和 LangGraph 差在哪？'), q.suggested.length === 1),
    `suggested=${q.suggested.length}`);
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n' + '─'.repeat(60));
if (fail === 0) {
  console.log(`\x1b[32m全部通过：${pass} 通过 / 0 失败\x1b[0m`);
} else {
  console.log(`\x1b[31m${pass} 通过 / ${fail} 失败\x1b[0m`);
  console.log('失败项：\n  - ' + fails.join('\n  - '));
}
console.log('─'.repeat(60) + '\n');
process.exit(fail === 0 ? 0 : 1);

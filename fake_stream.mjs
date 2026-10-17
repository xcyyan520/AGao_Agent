/**
 * fake_stream.mjs —— 假的「下一个问题」接口，让整条链路在没有 API Key 的情况下也能跑通。
 *
 * 它做三件事：
 *   1. 模拟真实 LLM 的【首字延迟】和【逐字吐字】—— 这是「尽早出题」能不能成立的
 *      关键变量，必须在没有真 Key 的时候也能观察到，否则页面上的效果是假的。
 *   2. 按真实格式输出那四行（问题/理由/类型/依据），且【问题在第一行】。
 *      这样「流式解析第一行提前上屏」这条优化才能在无 Key 状态下被验证。
 *   3. 用关键词规则伪造一个"看起来像在出题"的助手，规则本身也是这套产品的
 *      出题优先级的写照：对不上 > 没说清 > 给不出细节 > 往下深挖 > 换方向。
 *
 * 用法：
 *   node fake_stream.mjs
 *   默认监听 http://127.0.0.1:8901
 *   页面「设置」里：厂商=自定义，Base URL=http://127.0.0.1:8901，模型名=fake，Key=随便填
 *
 * 可用环境变量模拟慢速网络：
 *   FAKE_TTFT=1500         首字延迟 1500ms（真 LLM 常见 300~2000ms）
 *   FAKE_TPOT=28           每字间隔 28ms
 *   FAKE_TTFT_JITTER=500   首字延迟抖动上限
 */

import http from 'node:http';

const PORT = Number(process.env.PORT || 8901);
const TTFT = Number(process.env.FAKE_TTFT || 700);          // time to first token
const TPOT = Number(process.env.FAKE_TPOT || 28);           // time per output token(字)
const JITTER = Number(process.env.FAKE_TTFT_JITTER || 500);

/* ────────────────────────── 出题规则（假 LLM 的"智能"） ──────────────────────────
 * 真接口靠 LLM 自己想问题；这里用关键词规则伪造一个"看得出来在听"的提问助手，
 * 目的是让页面的交互、计时、面板刷新、采纳流程能被真实验证。
 *
 * 顺序即优先级，命中就停：越靠前的越该先问。
 * ⚠️ 规则要允许关键词被切开（切块是按语义边界切的，但边界仍可能落在词中间），
 *    所以用 RocketMQ → rocket 这种半截匹配，别指望块里出现完整词。
 */
const Q_RULES = [
  // 1. 对不上 / 与常识冲突 —— 最值钱，排最前
  { re: /不\s*(?:需要|用).{0,8}(?:加锁|锁)/,
    q: '不加锁的话，两个请求同时扣同一件库存会怎样？',
    r: '这和我理解的不一样，想听他怎么解释',
    t: '追问', b: '不需要加锁' },
  { re: /(?:int|integer).{0,8}(?:21\s*亿|2147483648)/i,
    q: 'int 的上限到底是多少，你确定吗？',
    r: '数值边界他说错了',
    t: '追问', b: '21 亿' },

  // 2. 提到关键点但一句带过 —— 这是面试里最常出现的追问点
  { re: /(?:预减|decr|扣减)/i,
    q: '预减之后如果下单失败，库存怎么加回去？',
    r: '讲了扣减，没讲失败回滚',
    t: '追问', b: 'Redis 预减' },
  { re: /(?:rocket|mq|消息队列|异步落库)/i,
    q: '消息要是没发出去，这笔库存怎么办？',
    r: '提到异步落库但没说可靠性',
    t: '追问', b: '异步落库' },
  { re: /(?:分布式锁|redlock|setnx)/i,
    q: '锁超时了但业务还没跑完，会发生什么？',
    r: '提了分布式锁，没提续期',
    t: '追问', b: '分布式锁' },
  { re: /(?:缓存(?:穿透|击穿|雪崩)|一致性)/,
    q: '缓存和库不一致的那个窗口有多长？',
    r: '提到一致性但没给具体做法',
    t: '追问', b: '缓存一致性' },

  // 3. 给了数字，追问测量条件
  { re: /(?:qps|tps|峰值|并发|吞吐).{0,10}\d/i,
    q: '这个数字是在什么并发下压出来的？',
    r: '给了数字，没给测量条件',
    t: '追问', b: 'QPS 峰值' },
  { re: /(?:压测|jmeter|wrk|loadrunner)/i,
    q: '压测用的机器配置和数据量是多少？',
    r: '提到压测但没给环境',
    t: '追问', b: '压测过' },
  { re: /(?:优化|提升|降低|从\s*\d+).{0,10}(?:到|至)\s*\d+/,
    q: '优化前慢在哪里，你是怎么定位到的？',
    r: '给了前后对比，没给瓶颈',
    t: '追问', b: '从 X 提到 Y' },

  // 4. 给不出细节
  { re: /(?:大概|差不多|应该是|好像|记不清|忘了|反正)/,
    q: '这里能给个具体数字或者具体做法吗？',
    r: '他用了模糊说法，细节可能记不清',
    t: '追问', b: '大概 / 差不多' },
  { re: /(?:等等|什么的|之类的)/,
    q: '你刚才说的"这些"，能挑一个展开讲讲吗？',
    r: '用"之类的"收尾，通常没细节',
    t: '追问', b: '等等 / 之类的' },

  // 5. 往下深挖
  { re: /(?:索引|explain|慢查询|sql)/i,
    q: '这条 SQL 的执行计划你看过吗？',
    r: '提到 SQL，可以看执行计划',
    t: '追问', b: 'SQL / 索引' },
  { re: /(?:jvm|gc|线程池|内存模型)/i,
    q: '线上这套参数是怎么定下来的？',
    r: '提到 JVM，可以问参数来源',
    t: '追问', b: 'JVM / 线程池' },
  { re: /(?:k8s|kubernetes|docker|容器)/i,
    q: '发布的时候怎么保证不中断流量？',
    r: '提到容器化，可以问发布',
    t: '追问', b: '容器化' },
];

// 没有可追问的点时，换方向。轮着用，避免连着出同一句。
const FRESH = [
  '换个话题，讲讲你项目里最难的一个技术决策？',
  '这里面哪一块是你亲手写的？',
  '这套系统上线之后出过什么故障？',
  '如果流量再涨十倍，你最先动哪里？',
  '你和同事在技术方案上意见不一致过吗？',
  '这个项目如果重做一遍，你会改什么？',
];

let freshIdx = 0;

function nextQuestion(chunk) {
  const t = String(chunk || '').trim();

  for (const p of Q_RULES) {
    if (p.re.test(t)) return { question: p.q, reason: p.r, type: p.t, basis: p.b };
  }

  // 太短的话不足以出题，给一个方向性的问题
  if (t.length < 8) {
    return {
      question: '这一块有点短，能展开说说吗？',
      reason: '他这句话没说完，先接着听',
      type: '追问',
      basis: t.slice(0, 10),
    };
  }

  const q = FRESH[freshIdx++ % FRESH.length];
  return { question: q, reason: '这个话题问得差不多了，换一个方向', type: '新方向', basis: '' };
}

/** 按真实输出格式拼成四行。问题必须在第一行，这是前端提前上屏的前提。 */
function render(r) {
  return [
    `问题：${r.question}`,
    `理由：${r.reason}`,
    `类型：${r.type}`,
    `依据：${r.basis}`,
  ].join('\n');
}

/* ────────────────────────── HTTP + 流式吐字 ────────────────────────── */

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, ttft: TTFT, tpot: TPOT }));
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  let raw = Buffer.concat(chunks).toString('utf8');

  // Windows 上 curl --data-binary "@file" 可能带 BOM；JSON.parse 会因此失败而静默退化成 {}，
  // 表现为"服务端收到的 chunk 是空的"。这里显式剥掉 BOM。
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  raw = raw.trim();

  let body = {};
  try { body = JSON.parse(raw); }
  catch (e) {
    console.error('[fake-stream] 请求体不是合法 JSON：' + e.message +
      ' · 前80字符=' + JSON.stringify(raw.slice(0, 80)));
  }

  // 出题的依据是「刚听到的一块」。engine.mjs 的 _buildMessages 把它放在最后一条
  // user 消息里，格式是 `## 刚听到的一块（第 N 块）\n\n<text>\n\n现在给出...`。
  // 提取必须【非贪婪】并在提示句处收口，否则会把"现在给出面试官下一个该问的问题"
  // 这句提示词也当成候选人说的话，规则会被污染。
  const msgs = body.messages || [];
  const users = msgs.filter(m => m.role === 'user');
  const lastUser = users[users.length - 1];
  const lastText = typeof lastUser?.content === 'string' ? lastUser.content : '';
  const m = lastText.match(/##\s*刚听到的一块[^\n]*\n+([\s\S]*?)(?:\n+现在给出|$)/);
  const chunk = (m ? m[1] : lastText).trim();

  const r = nextQuestion(chunk);
  const text = render(r);

  const shared = {
    id: 'fake-' + Date.now(),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: body.model || 'fake',
  };

  const stream = body.stream === true;
  const ttft = TTFT + Math.random() * JITTER;

  console.log(`[fake-stream] chunk=${JSON.stringify(chunk.slice(0, 30))} → ${r.type}｜${r.question} (ttft≈${Math.round(ttft)}ms, ${text.length}字)`);

  if (!stream) {
    await sleep(ttft);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ...shared, object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: text.length, total_tokens: text.length },
    }));
  }

  // ── SSE 流式 ──
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const piece = (delta, finish = null) => send({
    ...shared,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  res.write(': fake stream open\n\n');
  await sleep(ttft);

  // 逐字吐（按 1~3 字一批，更像真实模型）。
  // 注意这里【按顺序】吐：问题那一段先到，前端因此能提前上屏。
  for (let i = 0; i < text.length;) {
    const step = 1 + Math.floor(Math.random() * 3);
    piece({ content: text.slice(i, i + step) });
    i += step;
    await sleep(TPOT * step);
  }
  piece({}, 'stop');
  res.write('data: [DONE]\n\n');
  res.end();
});

// 长连接不能因为 socket 空闲被误杀
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  假出题接口已启动: http://127.0.0.1:' + PORT);
  console.log('  ────────────────────────────────────────────');
  console.log('  模拟的首字延迟(TTFT): ' + TTFT + 'ms + 0~' + JITTER + 'ms 抖动');
  console.log('  模拟的每字间隔(TPOT): ' + TPOT + 'ms');
  console.log('');
  console.log('  想模拟"很慢的模型"看页面反应：');
  console.log('    $env:FAKE_TTFT=2000; node fake_stream.mjs');
  console.log('');
  console.log('  页面设置：厂商=自定义  Base URL=http://127.0.0.1:' + PORT);
  console.log('            模型名=fake       API Key=随便填');
  console.log('');
});

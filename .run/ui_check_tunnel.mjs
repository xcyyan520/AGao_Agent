// 通过 Cloudflare 隧道打开页面，验证「SSE 不通 → 轮询兜底」这条路真的能把题送上屏。
//
// 这是手机场景的唯一真实检验：直接开一个真实 Chrome 指向隧道网址，
// 喂一段话，然后只看「下一个问题」面板有没有出现题。
//
// 用法：
//   1) .\start_phone.ps1 跑着，记下它打印的网址
//   2) node .run/ui_check_tunnel.mjs https://xxx-yyy.trycloudflare.com
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TUNNEL = process.argv[2];
if (!TUNNEL) { console.error('用法：node .run/ui_check_tunnel.mjs <隧道网址>'); process.exit(2); }

const PORT = 9334;
const CHROME = [
  path.join(os.homedir(), '.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
].find(p => p && fs.existsSync(p));
if (!CHROME) { console.error('找不到 chrome.exe'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uitunnel-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--window-size=414,896',   // 手机尺寸
  'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    wsUrl = (await r.json()).webSocketDebuggerUrl;
    if (wsUrl) break;
  } catch {}
  await sleep(250);
}
if (!wsUrl) { chrome.kill(); console.error('CDP 没起来'); process.exit(2); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}, sessionId) => new Promise(res => {
  const myId = ++id;
  pending.set(myId, res);
  ws.send(JSON.stringify({ id: myId, method, params, ...(sessionId ? { sessionId } : {}) }));
});

const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });

const jsErrors = [], consoleErrs = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.sessionId !== sessionId) return;
  if (m.method === 'Runtime.exceptionThrown') jsErrors.push(m.params.exceptionDetails?.exception?.description || 'exception');
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrs.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
  }
});

await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
await send('Network.enable', {}, sessionId);

const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' :: ' + (r.result.exceptionDetails.exception?.description || ''));
  return r.result?.result?.value;
};

const results = [];
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond, extra }); };

/* ── 1. 打开隧道网址 ─────────────────────────────────────────────── */
console.log('打开：' + TUNNEL);
await send('Page.navigate', { url: TUNNEL }, sessionId);
await sleep(6000);

const title = await js('document.title');
ok('经隧道能打开页面', /边说边出题/.test(String(title || '')), '标题=' + title);

/* ── 2. 等 SSE 失败、轮询接管 ────────────────────────────────────── */
// 页面在 SSE 出错后把 connPill 改成「断线，改用轮询」
let pill = '';
for (let i = 0; i < 40; i++) {
  pill = await js(`document.getElementById('connPill')?.textContent || ''`);
  if (/轮询/.test(String(pill))) break;
  await sleep(500);
}
console.log('连接状态：' + pill);
ok('SSE 不通时降到轮询', /轮询/.test(String(pill)), 'connPill=' + pill);

/* ── 3. 填材料并保存 ─────────────────────────────────────────────── */
const MAT = [
  '候选人做的项目：企业级智能客服工单平台，服务连锁零售和电商客户。',
  '架构是微服务、前后端分离，Java 做骨架 Python 做大脑，业务侧 5 个服务用 Spring Boot 3.x + JDK 17。',
  '智能侧 2 个 Python 服务，FastAPI + LangChain + LangGraph，模型接 DeepSeek 和通义千问双通道。',
  'AI Agent 编排用 LangGraph 把 Agent 建模成状态机，支持循环、条件边、断点恢复、人工介入。',
  'LangGraph 负责状态图编排，LangChain 负责工具声明和文档处理，是同一生态里的两层。',
  '最大的坑是状态持久化：LangGraph 默认 MemorySaver 是纯内存的，多副本部署时会话会失忆，要换 Redis checkpointer。',
  'thread_id 必须带客户标识前缀，否则多客户交付会串台，是数据隔离事故。',
  '写操作必须加幂等键，查订单的顾客校验必须在 Java 侧做，绝不能信任模型或前端传的用户 ID。',
  '超时分四层：前端 8 秒 > Java 调 Python 6 秒 > Python 总预算 5 秒 > 单次 LLM 3 秒。',
].join('\n');

/* 注意 setter 必须从原型上摘下来单独调：直接 set.call(el, ...) 里 el 是
   HTMLTextAreaElement 实例没错，但把 descriptor.set 取出来当普通函数用会
   丢 this 绑定 —— 第一版写成「set.call(el, v)」是能用的，出问题的是
   我把 setter 事先取成了一个变量再 call，那样在 Chrome 里报
   TypeError: Illegal invocation。这里坚持每次现取。 */
const setTextarea = (id, value) => `(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;

await js(setTextarea('materials', MAT));
await js(`document.getElementById('btnSaveMat').click()`);
await sleep(3000);
const matStat = await js(`document.getElementById('matStat')?.textContent || ''`);
console.log('材料保存：' + matStat);
ok('材料经隧道保存成功', /\d+\s*字/.test(String(matStat)) && !/^0\s*字/.test(String(matStat)), 'matStat=' + matStat);

/* ── 5. 回放候选人说话 ───────────────────────────────────────────── */
const SPEECH = [
  '我们那个项目是企业级的智能客服工单平台，主要服务连锁零售和电商客户。',
  '整个架构是微服务前后端分离，Java 做骨架 Python 做大脑，业务侧五个服务都是 Spring Boot 3.x，JDK 17。',
  '智能侧两个 Python 服务，用 FastAPI 加 LangChain 加 LangGraph，模型接的是 DeepSeek 和通义千问双通道。',
  'AI Agent 编排这块我们是用 LangGraph 把 Agent 建模成一个状态机，这样才支持循环、条件边、断点恢复还有人工介入。',
  'LangGraph 负责状态图编排，LangChain 负责工具声明和文档处理，它是同一生态里的两层，不是二选一的关系。',
  '当时最大的坑是状态持久化，LangGraph 默认的 MemorySaver 是纯内存的，多副本部署的时候同一会话第二次请求打到另一副本，Agent 就失忆了。',
].join('');

await js(setTextarea('replayText', SPEECH));
await js(`(() => {
  const cps = document.getElementById('cps');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(cps, '3');
  cps.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('btnReplay').click();
  return true;
})()`);
await sleep(4000);

/* ── 6. 等题目从轮询补上屏（这是本次验证的核心） ──────────────────── */
let panelText = '';
let got = false;
for (let i = 0; i < 60; i++) {
  panelText = await js(`document.getElementById('nqQ')?.textContent || ''`);
  if (panelText && !/等待|听/.test(String(panelText)) && String(panelText).length >= 4) { got = true; break; }
  await sleep(1000);
}
console.log('面板上的题：' + panelText);
ok('题目经轮询上屏了', got, 'nqQ=' + panelText);

const feedCount = await js(`document.querySelectorAll('#feed .qlog').length`);
ok('出题日志也有内容', Number(feedCount) > 0, 'qlog=' + feedCount);

const heard = await js(`document.getElementById('stChunks')?.textContent || ''`);
const made = await js(`document.getElementById('stApplied')?.textContent || ''`);
console.log(`听到 ${heard} 块 / 出题 ${made} 次`);
ok('统计数字在跳（说明轮询活着）', Number(heard) > 0, `chunks=${heard}`);

/* ── 7. 干净度 ───────────────────────────────────────────────────── */
ok('没有 JS 异常', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
ok('没有 console.error', consoleErrs.length === 0, consoleErrs.slice(0, 3).join(' | '));

/* ── 汇总 ───────────────────────────────────────────────────────── */
console.log('\n' + '─'.repeat(60));
let pass = 0, fail = 0;
for (const r of results) {
  console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}${r.extra ? '  · ' + r.extra : ''}`);
  r.pass ? pass++ : fail++;
}
console.log('─'.repeat(60));
console.log(`  结果: ${pass} 通过 / ${fail} 失败`);

try { chrome.kill(); } catch {}
// 直接退出：ws 已经不在了，走自然退出会踩 libuv 的 UV_HANDLE_CLOSING 断言，
// 那个断言会把退出码盖掉，让失败看起来像成功。
process.exit(fail ? 1 : 0);

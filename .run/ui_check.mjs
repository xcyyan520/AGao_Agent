// 用真实 Chrome 走一遍界面：保存材料 → 回放 → 看题真的上屏。
// 不装 puppeteer，直接用 Node 24 自带的 WebSocket 讲 CDP。
//
// 用法：
//   1) 先起服务：node server.mjs          （8900）
//   2) 再跑本脚本：node .run/ui_check.mjs
//
// 会自己拉起一个无头 Chrome，用完关掉。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = 'http://127.0.0.1:8900';
const PORT = 9333;
const CHROME = [
  path.join(os.homedir(), '.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
].find(p => p && fs.existsSync(p));

if (!CHROME) { console.error('找不到 chrome.exe'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uicheck-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── 等 CDP 起来 ─────────────────────────────────────────────────────── */
let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    wsUrl = (await r.json()).webSocketDebuggerUrl;
    if (wsUrl) break;
  } catch { /* 还没起来 */ }
  await sleep(250);
}
if (!wsUrl) { chrome.kill(); console.error('CDP 没起来'); process.exit(2); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) events.push(m);
};
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const myId = ++id;
  pending.set(myId, res);
  ws.send(JSON.stringify({ id: myId, method, params, ...(sessionId ? { sessionId } : {}) }));
});

/* ── 开一个页面并挂上控制台/异常监听 ─────────────────────────────────── */
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });

const jsErrors = [];
const consoleErrs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.sessionId !== sessionId) return;
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    jsErrors.push(d.exception?.description || d.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrs.push(m.params.args.map(a => a.value ?? a.description).join(' '));
  }
});

await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);

const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description || 'eval 失败');
  }
  return r.result?.result?.value;
};

await send('Page.navigate', { url: APP }, sessionId);
await sleep(1800);

// 先重置，保证这次跑的是干净会话（否则上一轮的题会混进统计）
await fetch(`${APP}/api/reset`, { method: 'POST' });
await sleep(600);

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
};

console.log('\n═══ 界面加载 ═══');
const title = await evalJs('document.title');
check('页面标题正确', /边说边出题/.test(title), title);
check('没有 JS 异常', jsErrors.length === 0, jsErrors[0] || '');
check('没有 console.error', consoleErrs.length === 0, consoleErrs[0] || '');

const hasText = (s) => evalJs(`document.body.innerText.includes(${JSON.stringify(s)})`);
check('有材料输入框 #materials', await evalJs('!!document.getElementById("materials")'));
check('有回放文本框 #replayText', await evalJs('!!document.getElementById("replayText")'));
check('有「保存材料」按钮', await evalJs('!!document.getElementById("btnSaveMat")'));
check('有「开始回放」按钮', await evalJs('!!document.getElementById("btnReplay")'));

console.log('\n═══ 保存材料 ═══');
const MATERIAL = `候选人简历（节选）
秒杀系统：使用 Redis 做库存预减，消息队列异步落库，峰值 30000 QPS。
分布式锁：基于 Redis 实现。
压测：JMeter 全链路压测，有详细数据。`;

// 用真实的 setter 触发 input，这样页面上的 Vue/原生监听才会跑
const setVal = (sel, val) => evalJs(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return false;
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(val)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);

check('材料已填入', await setVal('#materials', MATERIAL));
await sleep(300);
check('材料字数已更新', !(await evalJs('document.getElementById("matStat").textContent')).startsWith('0'),
  await evalJs('document.getElementById("matStat").textContent'));

await evalJs('document.getElementById("btnSaveMat").click()');
await sleep(1200);
check('材料保存后字数仍显示', !(await evalJs('document.getElementById("matStat").textContent')).startsWith('0'),
  await evalJs('document.getElementById("matStat").textContent'));

console.log('\n═══ 回放 ═══');
const TRANSCRIPT = `我用了 Redis 的 DECR 做预减库存，然后发消息到 RocketMQ，下游异步落库。不过我们实际上没有做异步落库，是同步写库的，QPS 峰值大概 5000 左右。锁的话我们没怎么用分布式锁，因为 Redis 本身是单线程的。压测是压过的，就在本机上跑了一下 JMeter，具体数字记不太清了。`;
check('逐字稿已填入', await setVal('#replayText', TRANSCRIPT));
await sleep(300);

await evalJs('document.getElementById("btnReplay").click()');

// 等题目真的上屏
let apiQ = [];
let body = '';
for (let i = 0; i < 80; i++) {
  await sleep(500);
  const api = await (await fetch(`${APP}/api/state`)).json();
  apiQ = (api.history || []).map(h => h.question).filter(Boolean);
  if (apiQ.length >= 2) break;
}
// 回放结束后再给界面一点时间渲染
await sleep(1500);
body = await evalJs('document.body.innerText');

check('服务端出了题', apiQ.length > 0, `${apiQ.length} 条`);
const onScreen = apiQ.filter(q => body.includes(q.slice(0, 6)));
check('题目文字渲染在页面上', onScreen.length > 0,
  `${onScreen.length}/${apiQ.length} 条命中`);

console.log('\n  出题历史（服务端）：');
for (const q of apiQ) console.log(`    · ${q}`);
console.log('\n  页面上真的看得到的：');
for (const q of onScreen) console.log(`    · ${q}`);

check('没有单字残渣题', !apiQ.some(q => q.length < 2),
  apiQ.filter(q => q.length < 2).join(',') || '无');
check('题目都不是半句话（>=6 字）', apiQ.every(q => q.length >= 6),
  apiQ.filter(q => q.length < 6).join(',') || '无');
check('全程无 JS 异常', jsErrors.length === 0, jsErrors[0] || '');
check('全程无 console.error', consoleErrs.length === 0, consoleErrs[0] || '');

/* ── 两种宽度下有没有元素重叠/溢出 ─────────────────────────────────────
   文档里写了「桌面 / 手机两种宽度下没有元素重叠」，但原本没有可复跑的脚本。

   ⚠ 怎么写才对：一开始我用的是「两个区块的矩形相交就算重叠」，结果手机宽度下
   稳定报一个假的 SECTION ↔ DIV 重叠（19px）。查下去发现那不是重叠——
   `aside.side` 是 `overflow-y:auto` 的滚动容器，最后一行按钮超出 section 的高度
   正是它该滚动的部分，scrollIntoView 之后按钮完全可见、elementFromPoint 也命中的是
   按钮自己。矩形相交 ≠ 视觉重叠。

   所以这里改成两条真正说明问题的断言：
     (1) 横向不溢出（scrollWidth 不超过视口）；
     (2) 每个关键区块的中心点，elementFromPoint 命中的是它自己或它的后代
         —— 这才叫「没被别的东西盖住」；
     (3) 区块里每个按钮都够得着：滚进视野后完整可见且能命中。
*/
console.log('\n═══ 桌面 / 手机两种宽度 ═══');

const layoutProbe = `(() => {
  const vw = window.innerWidth;

  // (1) 横向溢出
  const overflowX = document.documentElement.scrollWidth - vw;

  // (2) 遮挡：区块中心点被谁接住了
  const blocks = [...document.querySelectorAll('header, aside > section, aside, footer')]
    .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const covered = [];
  for (const el of blocks) {
    const r = el.getBoundingClientRect();
    // 只测落在视口内的部分，否则 elementFromPoint 会返回 null
    const cx = Math.min(Math.max(r.left + r.width / 2, 1), vw - 1);
    const cy = Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1);
    if (r.bottom < 0 || r.top > window.innerHeight) continue;   // 滚出视野的跳过
    const hit = document.elementFromPoint(cx, cy);
    if (hit && !(el === hit || el.contains(hit))) {
      covered.push((el.id ? '#' + el.id : el.tagName.toLowerCase())
        + ' 被 ' + (hit.id ? '#' + hit.id : hit.tagName.toLowerCase()) + ' 盖住');
    }
  }

  // (3) 按钮可达性：滚进视野后完整可见 + 命中自己
  const unreachable = [];
  for (const btn of document.querySelectorAll('button')) {
    const r0 = btn.getBoundingClientRect();
    if (r0.width === 0 || r0.height === 0) continue;          // 隐藏的（如禁用的设置面板）
    btn.scrollIntoView({ block: 'center' });
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const visible = r.top >= 0 && r.bottom <= window.innerHeight + 1;
    if (!visible || !(hit === btn || (hit && btn.contains(hit)))) {
      unreachable.push((btn.id ? '#' + btn.id : btn.textContent.trim().slice(0, 8))
        + (visible ? ' 被遮挡' : ' 滚了也不可见'));
    }
  }
  window.scrollTo(0, 0);
  return { vw, overflowX, covered, unreachable, nBlocks: blocks.length,
           nButtons: document.querySelectorAll('button').length };
})()`;

for (const [label, w, h] of [['桌面 1440', 1440, 900], ['手机 390', 390, 844], ['手机 360×640', 360, 640]]) {
  await send('Emulation.setDeviceMetricsOverride',
    { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 }, sessionId);
  await sleep(900);
  const L = await evalJs(layoutProbe);
  check(`${label}：无横向溢出`, L.overflowX <= 2, `overflowX=${L.overflowX}px`);
  check(`${label}：区块没被遮挡`, L.covered.length === 0,
    L.covered.slice(0, 2).join('; ') || `${L.nBlocks} 个区块中心点都命中自己`);
  check(`${label}：按钮都够得着`, L.unreachable.length === 0,
    L.unreachable.slice(0, 2).join('; ') || `${L.nButtons} 个按钮可达`);
}
await send('Emulation.clearDeviceMetricsOverride', {}, sessionId);

const failed = results.filter(r => !r.pass);
console.log('\n' + '─'.repeat(60));
console.log(`界面检查：${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) for (const f of failed) console.log(`  ✗ ${f.name} ${f.detail}`);
console.log('─'.repeat(60));

ws.close();
chrome.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
// 直接退：留着 ws 让事件循环自然结束会踩到 libuv 的
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"，把退出码盖掉。
process.exit(failed.length ? 1 : 0);

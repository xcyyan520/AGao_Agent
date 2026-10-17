// 判定 Cloudflare 快速隧道到底能不能把 SSE 数据送过来。
//
// 背景：快速隧道最阴的失败模式不是「连不上」，而是「连上了但 body 被缓冲，
// 一条事件都到不了」。这种情况下页面的 connPill 会显示「已连接」，看起来一切正常。
//
// 做法：在隧道页面里另开一个 EventSource 指向 /events，同时从服务端喂数据，
// 数 15 秒内真正收到几条 message。收到 → SSE 通；一条没有 → 被缓冲。
//
// 用法：node .run/probe_sse_tunnel.mjs https://xxx.trycloudflare.com
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TUNNEL = process.argv[2];
if (!TUNNEL) { console.error('用法：node .run/probe_sse_tunnel.mjs <隧道网址>'); process.exit(2); }

const PORT = 9335;
const CHROME = [
  path.join(os.homedir(), '.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
].find(p => p && fs.existsSync(p));
if (!CHROME) { console.error('找不到 chrome.exe'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssetunnel-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); wsUrl = (await r.json()).webSocketDebuggerUrl; if (wsUrl) break; } catch {}
  await sleep(250);
}
if (!wsUrl) { chrome.kill(); console.error('CDP 没起来'); process.exit(2); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}, sessionId) => new Promise(res => {
  const myId = ++id; pending.set(myId, res);
  ws.send(JSON.stringify({ id: myId, method, params, ...(sessionId ? { sessionId } : {}) }));
});

const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
const js = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
  return r.result?.result?.value;
};

console.log('打开 ' + TUNNEL);
await send('Page.navigate', { url: TUNNEL }, sessionId);
await sleep(6000);

// 页面的 SSE 状态
console.log('页面 connPill = ' + await js(`document.getElementById('connPill')?.textContent`));

/* 另开一条 EventSource 亲自数事件。
   必须订同一个会话，否则永远收不到那条流的事件——第一版就写错了会话名，
   探针自己听 sse_probe_xxx 而数据喂给 default，数出来必然 0 条。 */
await js(`(() => {
  window.__probe = { opened:false, errors:0, msgs:0, samples:[] };
  const es = new EventSource('/events?s=default');
  window.__probeES = es;
  es.onopen = () => { window.__probe.opened = true; };
  es.onerror = () => { window.__probe.errors++; };
  es.onmessage = (ev) => {
    window.__probe.msgs++;
    if (window.__probe.samples.length < 5) window.__probe.samples.push(String(ev.data).slice(0, 120));
  };
  return true;
})()`);
await sleep(1500);

// 从服务端喂数据，制造事件
console.log('开始喂数据，制造事件…');
for (let i = 0; i < 8; i++) {
  const t = `这是第 ${i + 1} 段测试文本，用来触发切块和出题事件。候选人正在讲他做的客服工单平台，用了 LangGraph 做状态图编排。`;
  try {
    await fetch(`${TUNNEL}/api/feed`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: 'default', text: t, charsPer100ms: 6 }),
    });
  } catch (e) { console.log('  喂数据失败: ' + e.message); }
  await sleep(1200);
}

await sleep(12000);

const probe = await js(`JSON.stringify({ ...window.__probe, readyState: window.__probeES?.readyState })`);
console.log('\n隧道上 EventSource 实测：' + probe);

const pageState = await js(`document.getElementById('connPill')?.textContent`);
console.log('页面 connPill 最终 = ' + pageState);

const panel = await js(`document.getElementById('nqQ')?.textContent`);
const applied = await js(`document.getElementById('stApplied')?.textContent`);
console.log('面板题 = ' + panel + '  |  出题次数 = ' + applied);

const p = JSON.parse(probe);
console.log('\n' + '─'.repeat(60));
console.log(p.msgs > 0
  ? `结论：SSE 在隧道上【能通】，收到 ${p.msgs} 条事件。`
  : `结论：SSE 在隧道上【一条都没到】（onopen=${p.opened} errors=${p.errors}）——被缓冲了，靠轮询兜底。`);
console.log('─'.repeat(60));

// 清掉探针会话
try {
  await fetch(`${TUNNEL}/api/reset`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'default' }),
  });
} catch {}

try { chrome.kill(); } catch {}
process.exit(0);

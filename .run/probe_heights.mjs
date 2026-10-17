// 量 header / main / stream / side 的高度分配，找出为什么 stream 的内容会超出自己的盒子。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = 'http://127.0.0.1:8900';
const PORT = 9351;
const CHROME = [
  path.join(os.homedir(), '.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
].find(p => p && fs.existsSync(p));
if (!CHROME) { console.error('找不到 chrome.exe'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'probeh-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--window-size=360,640', 'about:blank',
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

const t = await send('Target.createTarget', { url: 'about:blank' });
const a = await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
const sessionId = a.result.sessionId;
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};

await send('Page.navigate', { url: APP }, sessionId);
await sleep(2600);

for (const [w, h] of [[360, 640], [390, 844], [1440, 900]]) {
  await send('Emulation.setDeviceMetricsOverride',
    { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 }, sessionId);
  await sleep(900);
  const out = await evalJs(`(() => {
    const R = el => { if (!el) return null; const b = el.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height),
               scrollH: el.scrollHeight, clientH: el.clientHeight,
               over: el.scrollHeight - el.clientHeight,
               overflowY: getComputedStyle(el).overflowY }; };
    const main = document.querySelector('main');
    const stream = document.querySelector('.stream');
    return {
      vh: window.innerHeight,
      body: R(document.body),
      header: R(document.querySelector('header')),
      main: R(main),
      stream: R(stream),
      side: R(document.querySelector('aside.side')),
      streamKids: [...stream.children].map(k => ({ cls: k.className || k.id, ...R(k) })),
      // stream 的内容总高 vs 盒子高
      streamContent: [...stream.children].reduce((s, k) => s + k.getBoundingClientRect().height, 0)
        + (parseFloat(getComputedStyle(stream.firstElementChild).marginTop) || 0)
    };
  })()`);
  console.log(`\n===== ${w}x${h} =====`);
  console.log(JSON.stringify(out, null, 2));
}

ws.close(); chrome.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);

// 查清 #btnAsk 在 360×640 下到底被谁盖住了。
// 只做一件事：量它的位置、量盖住它的那个元素、判断是不是真的点不到。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = 'http://127.0.0.1:8900';
const PORT = 9347;
const CHROME = [
  path.join(os.homedir(), '.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
].find(p => p && fs.existsSync(p));
if (!CHROME) { console.error('找不到 chrome.exe'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'probeask-'));
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
const targetId = t.result.targetId;
const a = await send('Target.attachToTarget', { targetId, flatten: true });
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

await send('Emulation.setDeviceMetricsOverride',
  { width: 360, height: 640, deviceScaleFactor: 1, mobile: true }, sessionId);
await sleep(1200);

const info = await evalJs(`(() => {
  const btn = document.getElementById('btnAsk');
  const out = { exists: !!btn };
  if (!btn) return out;

  // 记录滚动前的位置
  const r0 = btn.getBoundingClientRect();
  out.before = { top: r0.top, bottom: r0.bottom, left: r0.left, right: r0.right,
                 w: r0.width, h: r0.height, vh: window.innerHeight, vw: window.innerWidth };

  // 它所属的滚动容器是谁？逐级往上找 overflow。
  const chain = [];
  let p = btn.parentElement;
  while (p && p !== document.documentElement) {
    const cs = getComputedStyle(p);
    if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') {
      chain.push({ el: p.id ? '#' + p.id : p.className || p.tagName,
                   scrollH: p.scrollHeight, clientH: p.clientHeight });
    }
    p = p.parentElement;
  }
  out.scrollParents = chain;

  // 滚进视野
  btn.scrollIntoView({ block: 'center' });
  const r = btn.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const hit = document.elementFromPoint(cx, cy);

  // 命中者的完整祖先链，方便看出到底是哪一层盖的
  const hitChain = [];
  let h = hit;
  for (let i = 0; h && i < 6; i++) {
    hitChain.push(h.id ? '#' + h.id : (h.className ? '.' + String(h.className).split(' ')[0] : h.tagName));
    h = h.parentElement;
  }

  return {
    ...out,
    after: { top: r.top, bottom: r.bottom, vh: window.innerHeight, visible: r.top >= 0 && r.bottom <= window.innerHeight + 1 },
    covered: !(hit === btn || (hit && btn.contains(hit))),
    hit: hit ? (hit.id ? '#' + hit.id : (hit.className ? '.' + String(hit.className).split(' ')[0] : hit.tagName)) : null,
    hitChain,
    hitRect: hit ? (() => { const q = hit.getBoundingClientRect(); return { top: q.top, bottom: q.bottom, h: q.height }; })() : null,
    hitZ: hit ? getComputedStyle(hit).zIndex : null,
    hitPos: hit ? getComputedStyle(hit).position : null,
    btnZ: getComputedStyle(btn).zIndex,
    btnPos: getComputedStyle(btn).position
  };
})()`);

console.log(JSON.stringify(info, null, 2));

ws.close(); chrome.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);

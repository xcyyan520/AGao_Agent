// 手机宽度下「模拟候选人说话」被自己的按钮行撑破 19px，「开始回放」按钮底边
// 落在视口外（844 视口 / 按钮 bottom 862）。这里判定这是不是真 bug：
//   页面到底能不能滚到那个按钮？滚过去之后点得到吗？
// 另外扫几个常见的矮视口（老机型 / 横屏），看会不会更糟。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = 'http://127.0.0.1:8900';
const PORT = 9336;
const CHROME = [
  path.join(os.homedir(), '.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(p => p && fs.existsSync(p));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uiprobe3-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; if (wsUrl) break; } catch {}
  await sleep(250);
}
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}, sessionId) => new Promise(res => {
  const myId = ++id; pending.set(myId, res);
  ws.send(JSON.stringify({ id: myId, method, params, ...(sessionId ? { sessionId } : {}) }));
});

const { result: { targetId } } = await send('Target.createTarget', { url: APP });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description);
  return r.result?.result?.value;
};

await sleep(2000);

const reach = `(() => {
  const btn = document.getElementById('btnReplay');
  const scrollables = [];
  for (let el = btn; el && el !== document.documentElement; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (/auto|scroll/.test(cs.overflowY) || /auto|scroll/.test(cs.overflow)) {
      scrollables.push({ tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).trim().split(/\\s+/).join('.') : ''),
                         overflowY: cs.overflowY, scrollH: el.scrollHeight, clientH: el.clientHeight,
                         canScroll: el.scrollHeight > el.clientHeight + 1 });
    }
  }
  const r = btn.getBoundingClientRect();
  return { scrollables,
           docScrollH: document.documentElement.scrollHeight,
           docClientH: document.documentElement.clientHeight,
           bodyOverflowY: getComputedStyle(document.body).overflowY,
           asideOverflowY: getComputedStyle(document.querySelector('aside')).overflowY,
           rect: [Math.round(r.top), Math.round(r.bottom)] };
})()`;

const clickable = `(() => {
  const btn = document.getElementById('btnReplay');
  btn.scrollIntoView({ block: 'center' });
  const r = btn.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  return { after: [Math.round(r.top), Math.round(r.bottom)],
           vh: window.innerHeight,
           fullyVisible: r.top >= 0 && r.bottom <= window.innerHeight,
           hitIsSelf: hit === btn || (hit && btn.contains(hit)),
           hitTag: hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') : null };
})()`;

for (const [label, w, h] of [['手机 390×844', 390, 844], ['手机 360×640', 360, 640], ['横屏 844×390', 844, 390]]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 }, sessionId);
  await sleep(900);
  const a = await evalJs(reach);
  console.log(`\n═══ ${label} ═══`);
  console.log('  按钮初始位置 [top,bottom]:', a.rect, ' 视口高:', a.docClientH);
  console.log('  html scrollH/clientH:', a.docScrollH, '/', a.docClientH,
              ' body overflow-y:', a.bodyOverflowY, ' aside overflow-y:', a.asideOverflowY);
  console.log('  祖先里可滚动的:', a.scrollables.length ? JSON.stringify(a.scrollables) : '（没有）');
  const c = await evalJs(clickable);
  console.log('  scrollIntoView 之后:', JSON.stringify(c));
  console.log(c.fullyVisible && c.hitIsSelf ? '  → 可达、可点 ✅' : '  → 够不着或点不到 ❌');
}

ws.close(); chrome.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);

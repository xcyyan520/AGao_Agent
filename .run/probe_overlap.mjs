// 定位手机宽度下的重叠到底是哪两个元素。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = 'http://127.0.0.1:8900';
const PORT = 9334;
const CHROME = [
  path.join(os.homedir(), '.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(p => p && fs.existsSync(p));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uiprobe-'));
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
  return r.result?.result?.value;
};

await sleep(2000);
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
await sleep(1000);

const desc = (el) => `(() => {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const id = el.id ? '#' + el.id : '';
  const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
  const txt = (el.textContent || '').trim().slice(0, 28);
  return {
    sel: el.tagName.toLowerCase() + id + cls,
    rect: [Math.round(r.top), Math.round(r.bottom), Math.round(r.left), Math.round(r.right)],
    pos: cs.position, z: cs.zIndex, of: cs.overflowY, h: cs.height, minH: cs.minHeight,
    txt,
  };
})()`;

const report = await evalJs(`(() => {
  const boxes = [...document.querySelectorAll('section, header, footer, .row')]
    .map((el, i) => { el.dataset.__p = i; return { el, r: el.getBoundingClientRect() }; })
    .filter(o => o.r.width > 0 && o.r.height > 0);
  const out = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const v = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      const h = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const contained = (a.r.top <= b.r.top && a.r.bottom >= b.r.bottom && a.r.left <= b.r.left && a.r.right >= b.r.right)
                     || (b.r.top <= a.r.top && b.r.bottom >= a.r.bottom && b.r.left <= a.r.left && b.r.right >= a.r.right);
      if (v > 2 && h > 2 && !contained) out.push([a.el.dataset.__p, b.el.dataset.__p, Math.round(v), Math.round(h)]);
    }
  window.__boxes = boxes.map(o => o.el);
  return out;
})()`);

console.log('重叠对：', JSON.stringify(report));
for (const [i, j, v, h] of report) {
  console.log(`\n─── 垂直重叠 ${v}px / 水平 ${h}px ───`);
  for (const k of [i, j]) {
    const d = await evalJs(`(() => {
      const el = window.__boxes[${k}];
      ${desc().slice(6, -4)}
    })()`);
    console.log(' ', JSON.stringify(d, null, 0));
  }
}

// 再看页面结构里那两个区块的上下文
const ctx = await evalJs(`(() => {
  const b = window.__boxes;
  const out = [];
  for (const [i, j] of ${JSON.stringify(report.map(r => [r[0], r[1]]))}) {
    for (const k of [i, j]) {
      const el = window.__boxes[k];
      out.push({ sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
                 parent: el.parentElement.tagName.toLowerCase() + (el.parentElement.id ? '#' + el.parentElement.id : ''),
                 prevSib: el.previousElementSibling ? el.previousElementSibling.tagName.toLowerCase() + (el.previousElementSibling.id ? '#' + el.previousElementSibling.id : '') : null,
                 html: el.outerHTML.slice(0, 200) });
    }
  }
  return out;
})()`);
console.log('\n=== 上下文 ===');
console.log(JSON.stringify(ctx, null, 2));

ws.close(); chrome.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);

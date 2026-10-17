// 上一步发现：手机宽度下「模拟候选人说话」这个 section 被它自己的按钮行
// 撑破了 14px（子元素 bottom 超出父元素 bottom）。这里判断它到底是不是真问题：
//   A) section 有 overflow:hidden/auto → 按钮被裁掉，是真 bug
//   B) section overflow:visible → 只是父盒子矮了 14px，视觉上可能没事
// 再顺手确认「开始回放」按钮在两个宽度下都真的可点（elementFromPoint 命中它自己）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = 'http://127.0.0.1:8900';
const PORT = 9335;
const CHROME = [
  path.join(os.homedir(), '.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(p => p && fs.existsSync(p));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uiprobe2-'));
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

const probe = `(() => {
  const out = {};
  const secs = [...document.querySelectorAll('aside > section')];
  out.sections = secs.map((s, i) => {
    const r = s.getBoundingClientRect();
    const cs = getComputedStyle(s);
    const kids = [...s.children].map(c => {
      const cr = c.getBoundingClientRect();
      return { tag: c.tagName.toLowerCase() + (c.id ? '#' + c.id : '') + (c.className ? '.' + String(c.className).trim().split(/\\s+/).join('.') : ''),
               bottom: Math.round(cr.bottom), h: Math.round(cr.height) };
    });
    const cBottom = Math.max(...kids.map(k => k.bottom), r.bottom);
    return { i, h2: (s.querySelector('h2') || {}).textContent,
             top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height),
             overflowY: cs.overflowY, scrollH: s.scrollHeight, clientH: s.clientHeight,
             spills: Math.round(cBottom - r.bottom), kids };
  });
  // 下一个 section 的 top，看溢出的按钮会不会压到别人
  out.gaps = [];
  for (let i = 0; i < secs.length - 1; i++) {
    const a = secs[i].getBoundingClientRect(), b = secs[i + 1].getBoundingClientRect();
    out.gaps.push({ from: (secs[i].querySelector('h2')||{}).textContent,
                    to: (secs[i+1].querySelector('h2')||{}).textContent,
                    gap: Math.round(b.top - a.bottom) });
  }
  // 按钮能不能被点到（命中的是不是它自己）
  const btn = document.getElementById('btnReplay');
  const br = btn.getBoundingClientRect();
  const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
  out.replayBtn = { r: [Math.round(br.top), Math.round(br.bottom), Math.round(br.left), Math.round(br.right)],
                    visible: br.width > 0 && br.height > 0,
                    hitIsSelf: hit === btn || btn.contains(hit),
                    hitTag: hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') : null };
  // 视口内可见吗
  out.vh = window.innerHeight;
  out.btnInViewport = br.bottom <= window.innerHeight && br.top >= 0;
  return out;
})()`;

for (const [label, w, h] of [['桌面 1440', 1440, 900], ['手机 390', 390, 844]]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 }, sessionId);
  await sleep(900);
  const p = await evalJs(probe);
  console.log(`\n═══ ${label} (视口 ${p.vh}px) ═══`);
  for (const s of p.sections) {
    const flag = s.spills > 0 ? `  ⚠ 内容溢出父盒 ${s.spills}px` : '';
    console.log(`  [${s.i}] ${s.h2} h=${s.h} overflow-y=${s.overflowY} scrollH=${s.scrollH} clientH=${s.clientH}${flag}`);
  }
  console.log('  相邻区块间距:', p.gaps.map(g => `${g.gap}px`).join('  '));
  console.log('  回放按钮:', JSON.stringify(p.replayBtn));
  console.log('  按钮在首屏内:', p.btnInViewport);
}

ws.close(); chrome.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);

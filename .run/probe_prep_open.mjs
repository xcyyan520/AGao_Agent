/* 手机端「展开准备区」之后的几何实测。
   上一轮只修好了收起态；用户报「展开还是有话问题」。
   这里把展开态下每个区块的 top/bottom/高度/内容溢出量全打出来。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8900';
const PORT = 9343;
const CHROME = [
  path.join(os.homedir(), '.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
].find(p => fs.existsSync(p));
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cprof-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDir}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try { const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl; } catch (_) {}
    await sleep(200);
  }
  throw new Error('CDP 没起来');
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.waiting.has(m.id)) { const w = c.waiting.get(m.id); c.waiting.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); }
    };
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id; const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
  }
}

const MEASURE = `(() => {
  const rect = el => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height), w: Math.round(b.width) }; };
  const side = document.querySelector('.side');
  const sb = side.getBoundingClientRect();
  const rows = [];
  const add = (name, el, extra) => {
    if (!el) return;
    const r = rect(el);
    if (!r.h && !r.w) return;
    const cs = getComputedStyle(el);
    rows.push({ name, ...r, scrollH: el.scrollHeight, clientH: el.clientHeight,
      disp: cs.display, pos: cs.position, ov: cs.overflowY, fs: cs.fontSize,
      clippedBy: Math.max(0, Math.round(el.scrollHeight - el.clientHeight)),
      outOfScroll: Math.round(r.bottom - sb.bottom), ...(extra||{}) });
  };
  add('side', side);
  [...side.children].forEach(c => {
    add((c.id || c.className || c.tagName).toString().slice(0, 26), c);
    if (c.tagName === 'SECTION') {
      [...c.children].forEach(g => {
        if (g.classList.contains('row') || g.id) add('   ·' + (g.id || g.className).toString().slice(0, 22), g);
      });
    }
  });
  const toggle = document.getElementById('btnSideToggle');
  add('toggle', toggle);
  const mic = document.getElementById('btnMic');
  add('btnMic', mic);
  return { vh: window.innerHeight, vw: window.innerWidth, docH: document.documentElement.scrollHeight,
    sideRect: rect(side), sideScrollH: side.scrollHeight, sideClientH: side.clientHeight,
    prepOpen: side.classList.contains('prep-open'), rows };
})()`;

let cdp, sid;
const ev = async (e) => {
  const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

try {
  cdp = await CDP.connect(await wsUrl());
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  sid = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Page.navigate', { url: BASE + '/' }, sid);
  await sleep(1600);

  for (const [w, h] of [[390, 844], [360, 640]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true }, sid);
    await sleep(800);
    // 确保是收起态再点开
    await ev(`(() => { const s = document.querySelector('.side'); if (s.classList.contains('prep-open')) document.getElementById('btnSideToggle').click(); })()`);
    await sleep(500);
    const closed = await ev(MEASURE);
    await ev(`document.getElementById('btnSideToggle').click()`);
    await sleep(700);
    const open = await ev(MEASURE);

    console.log(`\n══════ ${w}x${h} ${'═'.repeat(20)}`);
    console.log(`  收起态：side h=${closed.sideRect.h} sideScroll=${closed.sideScrollH}/${closed.sideClientH} prepOpen=${closed.prepOpen}`);
    console.log(`  ★展开态：side ${open.sideRect.top}→${open.sideRect.bottom} h=${open.sideRect.h}  scroll=${open.sideScrollH}/client=${open.sideClientH} 溢出=${open.sideScrollH - open.sideClientH}  prepOpen=${open.prepOpen}  docH=${open.docH} vh=${open.vh}`);
    console.log(`  name                      top   bot    h     w   scrollH clientH clipped ov      disp`);
    for (const r of open.rows) {
      console.log(`  ${String(r.name).padEnd(24)} ${String(r.top).padStart(4)} ${String(r.bottom).padStart(5)} ${String(r.h).padStart(4)} ${String(r.w).padStart(4)}  ${String(r.scrollH).padStart(6)} ${String(r.clientH).padStart(6)} ${String(r.clippedBy).padStart(6)}  ${String(r.ov).padEnd(7)} ${r.disp}`);
    }
  }
} catch (e) {
  console.error('跑挂了：', e.message);
} finally {
  try { chrome.kill(); } catch (_) {}
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(0);
}

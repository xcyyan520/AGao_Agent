/* 展开态下每个控件的权威测量：x/y/w/h + 是否真被遮住（elementFromPoint）。
   同时报「矩形相交」和「实际命中」两种判据的差异，用来确认哪个才是真问题。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8900';
const PORT = 9345;
const CHROME = [
  path.join(os.homedir(), '.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
].find(p => fs.existsSync(p));
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cprof-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDir}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
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
let cdp, sid;
const ev = async (e) => {
  const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
};

const PROBE = `(() => {
  const side = document.querySelector('.side');
  const desc = el => {
    if (!el) return 'null';
    const id = el.id ? '#' + el.id : '';
    const cls = (typeof el.className === 'string' && el.className) ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
    return el.tagName.toLowerCase() + id + cls;
  };
  const all = [...side.querySelectorAll('button, textarea, input, .pill')];
  const vis = all.filter(el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
  });
  const rows = vis.map(el => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const inVp = cy >= 0 && cy <= window.innerHeight;
    const hit = inVp ? document.elementFromPoint(cx, cy) : null;
    return {
      who: desc(el), x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
      hit: desc(hit), ok: !inVp ? 'off' : (hit === el || el.contains(hit) || (hit && hit.contains(el))),
    };
  });
  // 矩形相交对（只看同一行的兄弟）
  const pairs = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i], b = rows[j];
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ox > 1 && oy > 1) pairs.push([a.who, b.who, ox, oy]);
  }
  const sb = side.getBoundingClientRect();
  return { rows, pairs, sb: { top: Math.round(sb.top), h: Math.round(sb.height) },
    scroll: { sh: side.scrollHeight, ch: side.clientHeight, can: side.scrollHeight > side.clientHeight + 1 },
    vh: window.innerHeight, docW: document.documentElement.scrollWidth, vw: window.innerWidth };
})()`;

try {
  cdp = await CDP.connect(await wsUrl());
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  sid = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Page.navigate', { url: BASE + '/' }, sid);
  await sleep(1600);

  for (const [w, h] of [[360, 640], [390, 844]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true }, sid);
    await sleep(600);
    // 塞点材料，模拟真实使用（空文本区比有内容时矮）
    await ev(`(() => {
      const ta = document.getElementById('materials');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(ta, ${JSON.stringify('项目背景'.repeat(60))});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const s = document.querySelector('.side');
      if (!s.classList.contains('prep-open')) document.getElementById('btnSideToggle').click();
    })()`);
    await sleep(700);
    const r = await ev(PROBE);
    console.log(`\n══════ ${w}x${h} 展开态 ══════`);
    console.log(`  抽屉 top=${r.sb.top} h=${r.sb.h}  内部滚动 sh=${r.scroll.sh} ch=${r.scroll.ch} can=${r.scroll.can}  docW=${r.docW}/${r.vw}`);
    for (const q of r.rows) {
      const flag = q.ok === true ? '✅' : q.ok === 'off' ? '⬇屏外' : '✗遮挡';
      console.log(`  ${flag} ${q.who.padEnd(26)} x=${String(q.x).padStart(3)} y=${String(q.y).padStart(3)} ${String(q.w).padStart(3)}x${String(q.h).padStart(3)}${q.ok === true ? '' : ' 命中=' + q.hit}`);
    }
    if (r.pairs.length) { console.log('  ── 矩形相交（可能是伪判据）──'); for (const p of r.pairs) console.log(`     ${p[0]} ↔ ${p[1]} 交 ${p[2]}x${p[3]}`); }
    else console.log('  ── 无矩形相交 ──');
  }
} catch (e) {
  console.error('跑挂了：', e.message);
} finally {
  try { chrome.kill(); } catch (_) {}
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(0);
}

/* 手机端抽屉展开后，到底有没有东西盖在它上面？
   判据不是「矩形相交」（那是伪判据，见 probe_overlap3 的教训），
   而是：抽屉里每个控件的几何中心点上，elementFromPoint 命中的是谁。
   命中的必须是那个控件自己或它的后代/祖先容器，不能是别的区块。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8900';
const PORT = 9344;
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
let cdp, sid;
const ev = async (e) => {
  const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
};

const PROBE = `(() => {
  const side = document.querySelector('.side');
  const sb = side.getBoundingClientRect();
  const desc = el => {
    if (!el) return 'null';
    const id = el.id ? '#' + el.id : '';
    const cls = (typeof el.className === 'string' && el.className) ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
    return el.tagName.toLowerCase() + id + cls;
  };
  // 抽屉里所有有意义的控件
  const targets = [...side.querySelectorAll('button:not([disabled]), textarea, input:not([type=file])')]
    .filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && el.tagName !== 'INPUT' || (el.type && el.type !== 'file' && r.height > 0);
    });
  const problems = [];
  const samples = [];
  for (const el of targets) {
    const r = el.getBoundingClientRect();
    const cx = Math.max(1, Math.min(window.innerWidth - 1, r.left + r.width / 2));
    const cy = Math.max(0, Math.min(window.innerHeight - 1, r.top + r.height / 2));
    const hit = document.elementFromPoint(cx, cy);
    const mine = hit === el || el.contains(hit) || (hit && hit.contains(el));
    samples.push({ who: desc(el), cx: Math.round(cx), cy: Math.round(cy), hit: desc(hit), mine });
    if (!mine) problems.push({ who: desc(el), hit: desc(hit), cx: Math.round(cx), cy: Math.round(cy) });
  }
  // 抽屉区域里有没有"外部元素"盖上去：采样抽屉矩形上的 5 个点
  const outside = [];
  for (const [fx, fy] of [[0.5, 0.1], [0.5, 0.35], [0.5, 0.6], [0.5, 0.9], [0.1, 0.5]]) {
    const cx = Math.max(1, Math.min(window.innerWidth - 1, sb.left + sb.width * fx));
    const cy = Math.max(0, Math.min(window.innerHeight - 1, sb.top + sb.height * fy));
    const hit = document.elementFromPoint(cx, cy);
    if (!(hit === side || side.contains(hit))) outside.push({ fx, fy, cx: Math.round(cx), cy: Math.round(cy), hit: desc(hit) });
  }
  // 抽屉背景色是否真被遮罩变暗（取抽屉上方 20px 处一个点）
  const above = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.max(0, Math.round(sb.top) - 20));
  return {
    sb: { top: Math.round(sb.top), bottom: Math.round(sb.bottom), h: Math.round(sb.height) },
    vh: window.innerHeight, n: targets.length, problems, outside,
    aboveDrawer: desc(above),
    sideZ: getComputedStyle(side).zIndex,
    sidePos: getComputedStyle(side).position,
    bodyOverflow: getComputedStyle(document.body).overflow,
    docH: document.documentElement.scrollHeight,
  };
})()`;

try {
  cdp = await CDP.connect(await wsUrl());
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  sid = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Page.navigate', { url: BASE + '/' }, sid);
  await sleep(1600);

  for (const [w, h] of [[390, 844], [360, 640], [414, 896]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true }, sid);
    await sleep(700);
    await ev(`(() => { const s = document.querySelector('.side'); if (!s.classList.contains('prep-open')) document.getElementById('btnSideToggle').click(); })()`);
    await sleep(600);
    const r = await ev(PROBE);
    console.log(`\n══════ ${w}x${h} ══════`);
    console.log(`  抽屉 ${r.sb.top}→${r.sb.bottom} (h=${r.sb.h}) 视口 ${r.vh}  pos=${r.sidePos} z=${r.sideZ}  docH=${r.docH}`);
    console.log(`  抽屉上方 20px 处命中：${r.aboveDrawer}`);
    console.log(`  控件 ${r.n} 个，被遮挡 ${r.problems.length} 个`);
    for (const p of r.problems) console.log(`    ✗ ${p.who} @(${p.cx},${p.cy}) 实际命中 ${p.hit}`);
    console.log(`  抽屉矩形内采 5 点，外部元素越界 ${r.outside.length} 处`);
    for (const o of r.outside) console.log(`    ✗ (${(o.fx*100)}%,${(o.fy*100)}%) @(${o.cx},${o.cy}) 命中 ${o.hit}`);
  }
} catch (e) {
  console.error('跑挂了：', e.message);
} finally {
  try { chrome.kill(); } catch (_) {}
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(0);
}

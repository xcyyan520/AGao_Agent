/* 手机端布局体检：把 390x844 下每个可见元素的盒子、字号、是否在首屏打出来。
   不靠截图——图看不出来「这个按钮 21px 高，拇指点不着」这种事，得量。
   用法：node .run/probe_mobile_ui.mjs [url] */
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8900/?s=default';
const CHROME = ['C:/Users/xia-shana/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
const PORT = 9351, prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-'));
const ch = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 60; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; break; }
  catch { await sleep(250); }
}
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const cmd = (method, params = {}, sessionId) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const { result: { targetId } } = await cmd('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await cmd('Target.attachToTarget', { targetId, flatten: true });
await cmd('Page.enable', {}, sessionId); await cmd('Runtime.enable', {}, sessionId);
const ev = async expr => (await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)).result?.result?.value;

async function measure(w, h) {
  await cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true }, sessionId);
  await cmd('Page.navigate', { url: URL_ }, sessionId);
  await sleep(2000);
  return await ev(`(() => {
    const out = [];
    const add = (name, e) => {
      if (!e) { out.push({name, missing:true}); return; }
      const b = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      out.push({ name, t:Math.round(b.top), b:Math.round(b.bottom), l:Math.round(b.left),
        w:Math.round(b.width), h:Math.round(b.height),
        fs: cs.fontSize, pad: cs.padding, disp: cs.display,
        sh: e.scrollHeight, ch: e.clientHeight,
        txt: (e.textContent||'').trim().slice(0,22) });
    };
    add('header', document.querySelector('header'));
    for (const el of document.querySelectorAll('header > *')) add('  hd:'+(el.id||el.tagName.toLowerCase()), el);
    add('main', document.querySelector('main'));
    add('stream', document.querySelector('.stream'));
    add('nextq', document.querySelector('.nextq'));
    add('nqQ', document.getElementById('nqQ'));
    add('qbar', document.querySelector('.qbar'));
    add('question', document.getElementById('question'));
    add('btnAsk', document.getElementById('btnAsk'));
    add('feed', document.querySelector('.feed'));
    add('stats', document.querySelector('.stats'));
    add('side', document.querySelector('.side'));
    for (const sec of document.querySelectorAll('.side > section')) add('  sec:'+(sec.id||'mat'), sec);
    add('btnMic', document.getElementById('btnMic'));
    add('materials', document.getElementById('materials'));
    add('btnSaveMat', document.getElementById('btnSaveMat'));
    add('matStat', document.getElementById('matStat'));
    add('btnRole', document.getElementById('btnRole'));
    add('micHint', document.getElementById('micHint'));
    return { vw: innerWidth, vh: innerHeight,
      docH: document.documentElement.scrollHeight,
      docW: document.documentElement.scrollWidth,
      items: out };
  })()`);
}

for (const [w, h] of [[390, 844], [360, 640]]) {
  const m = await measure(w, h);
  console.log(`\n══════ ${w}x${h}  docH=${m.docH} docW=${m.docW} vh=${m.vh} ══════`);
  console.log('name'.padEnd(20), 'top'.padStart(5), 'bot'.padStart(5), 'h'.padStart(4), 'w'.padStart(4), 'fs'.padStart(6), 'pad', 'shadow');
  for (const it of m.items) {
    if (it.missing) { console.log(it.name.padEnd(20), 'MISSING'); continue; }
    const flag = (it.b > m.vh ? ' ← 首屏外' : '') + (it.sh > it.ch + 1 ? ` [溢出 ${it.sh - it.ch}]` : '');
    console.log(it.name.padEnd(20), String(it.t).padStart(5), String(it.b).padStart(5),
      String(it.h).padStart(4), String(it.w).padStart(4), it.fs.padStart(6), it.pad, flag);
  }
  // 触摸目标太小的
  const small = m.items.filter(i => !i.missing && /btn|question/.test(i.name) && i.h < 40 && i.h > 0);
  if (small.length) console.log('⚠ 高度<40px（手机上不好点）：' + small.map(s => `${s.name}(${s.h})`).join(' '));
}
ws.close(); ch.kill(); try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
process.exit(0);

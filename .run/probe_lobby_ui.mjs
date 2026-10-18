/* 大厅的手机端体检：390x844 与 360x640 下量大厅每个块的高度、
   是否在首屏、可点区域够不够大，并检查横向溢出。
   用法：node .run/probe_lobby_ui.mjs [url]
   为什么单独写一个：probe_mobile_ui.mjs 量的是房间内，
   大厅这一次是新加的整页，它的毛病（房间卡片挤、按钮矮、
   「开一间」被键盘顶走）在房间里那套指标上根本看不出来。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

/* 默认打 8900（和 ui_check / probe_flow_ui 一致）。
   `?lobby=1` 这个参数页面并不认识——裸地址本来就会落在大厅。 */
const URL_ = process.argv[2] || 'http://127.0.0.1:8900/';
const CHROME = ['C:/Users/xia-shana/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Users/xia-shana/AppData/Local/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
const PORT = 9352, prof = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-'));
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
  await sleep(2500);   // 等房间列表拉回来
  return await ev(`(() => {
    const out = [];
    const add = (name, e) => {
      if (!e) { out.push({name, missing:true}); return; }
      const b = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      out.push({ name, t:Math.round(b.top), b:Math.round(b.bottom), l:Math.round(b.left),
        w:Math.round(b.width), h:Math.round(b.height), fs: cs.fontSize,
        txt:(e.textContent||'').trim().slice(0,26) });
    };
    add('lobby', document.getElementById('lobby'));
    add('box',  document.querySelector('.lobby-box'));
    add('title',document.querySelector('.lobby-title'));
    add('sub',  document.querySelector('.lobby-sub'));
    add('role', document.querySelector('.lobby-role'));
    add('roleCandidate', document.querySelector('[data-lobby-role="candidate"]'));
    add('roleInterviewer', document.querySelector('[data-lobby-role="interviewer"]'));
    add('roleHint', document.getElementById('lobbyRoleHint'));
    add('list', document.getElementById('lobbyList'));
    const cards = document.querySelectorAll('#lobbyList .room');
    cards.forEach((c,i) => { if(i<3) add('  card'+i, c); });
    add('newRow', document.querySelector('.room-new'));
    add('newInput', document.getElementById('lobbyNewTitle'));
    add('newGo',  document.getElementById('lobbyNewGo'));
    // .lobby-tip 已经不存在了（搬进「怎么用」弹层），这里改成量那个问号按钮：
    // 它现在是手机端唯一能看到「两个人怎么配合」的入口，必须够大、点得到。
    add('helpBtn', document.getElementById('btnHelpLobby'));
    // 横向溢出：谁比视口宽
    const over = [];
    for (const el of document.querySelectorAll('#lobby *')) {
      const b = el.getBoundingClientRect();
      if (b.right > innerWidth + 1 || b.left < -1) over.push((el.id||el.className||el.tagName)+'@'+Math.round(b.left)+'~'+Math.round(b.right));
    }
    return { vw: innerWidth, vh: innerHeight,
      docH: document.documentElement.scrollHeight,
      docW: document.documentElement.scrollWidth,
      cards: cards.length, over: over.slice(0,8), items: out };
  })()`);
}

for (const [w, h] of [[390, 844], [360, 640]]) {
  const m = await measure(w, h);
  console.log(`\n══════ ${w}x${h}  docH=${m.docH} docW=${m.docW} 房间卡片=${m.cards} ══════`);
  console.log('name'.padEnd(18), 'top'.padStart(5), 'bot'.padStart(5), 'h'.padStart(4), 'w'.padStart(4), 'fs'.padStart(6));
  for (const it of m.items) {
    if (it.missing) { console.log(it.name.padEnd(18), 'MISSING'); continue; }
    const flag = (it.b > m.vh ? ' ← 首屏外' : '') + (it.l < 0 || it.l + it.w > m.vw ? ' ← 横向溢出' : '');
    console.log(it.name.padEnd(18), String(it.t).padStart(5), String(it.b).padStart(5),
      String(it.h).padStart(4), String(it.w).padStart(4), it.fs.padStart(6), flag, it.txt ? '| ' + it.txt : '');
  }
  if (m.docW > m.vw) console.log(`⚠ 整页横向溢出：docW=${m.docW} > vw=${m.vw} → ${m.over.join(' ')}`);
  const small = m.items.filter(i => !i.missing && /roleC|roleI|newGo|newInput|helpBtn/.test(i.name) && i.h < 40 && i.h > 0);
  if (small.length) console.log('⚠ 高度<40px：' + small.map(s => `${s.name}(${s.h})`).join(' '));
}
ws.close(); ch.kill(); try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
process.exit(0);

/* 走一遍「人怎么用」的路：开新一场 → 大厅里看见它 → 换角色被挡/被放行，
   以及「历史面板里改名」是不是真的改到了大厅卡片上。
   为什么用 CDP 而不是 curl：这些动作的价值全在界面上——
   「点了没反应」「名字没跟着变」这类毛病，接口全返回 200。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

/* 默认打正式那个 8900，和 ui_check / probe_lines 保持一致——
   探针默认指向哪一个，决定了「直接跑一下」会不会在测试库上验证。
   想在 8799 上跑就传参：node .run/probe_flow_ui.mjs http://127.0.0.1:8799 */
const BASE = process.argv[2] || 'http://127.0.0.1:8900';
const CHROME = ['C:/Users/xia-shana/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Users/xia-shana/AppData/Local/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
const PORT = 9353, prof = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-'));
const ch = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 60; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; break; }
  catch { await sleep(250); }
}
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map(); const errs = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
    errs.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
  if (m.method === 'Runtime.exceptionThrown')
    errs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
};
const cmd = (method, params = {}, sessionId) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const { result: { targetId } } = await cmd('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await cmd('Target.attachToTarget', { targetId, flatten: true });
await cmd('Page.enable', {}, sessionId); await cmd('Runtime.enable', {}, sessionId);
const ev = async expr => {
  const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
  return r.result?.result?.value;
};
const nav = async (url) => { await cmd('Page.navigate', { url }, sessionId); await sleep(2200); };
const shot = async (name) => {
  const r = await cmd('Page.captureScreenshot', { format: 'png' }, sessionId);
  if (r.result?.data) fs.writeFileSync(path.join('F:/wechat_doc/xwechat_files/wxid_pfjflybu1jjd22_cde0/msg/file/2026-10/07-同步思考/.run', name), Buffer.from(r.result.data, 'base64'));
};

const R = [];
const ok = (n, v) => R.push(`✔ ${n}${v ? ' → ' + v : ''}`);
const bad = (n, v) => R.push(`✘ ${n}${v ? ' :: ' + v : ''}`);

await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);

// ① 裸地址 → 大厅，列表有内容，新按钮在首屏内
await nav(BASE + '/');
ok('大厅出现', await ev(`!document.getElementById('lobby').classList.contains('hide')`));
const cards = await ev(`document.querySelectorAll('#lobbyList .room').length`);
const newRowTop = await ev(`Math.round(document.querySelector('.room-new').getBoundingClientRect().top)`);
const vh = await ev('innerHeight');
if (newRowTop + 100 <= vh) ok('「开一间」固定在首屏内', `top=${newRowTop} vh=${vh}`);
else bad('「开一间」还在首屏外', `top=${newRowTop} vh=${vh}`);
ok('房间卡片数', String(cards));
await shot('flow_1_lobby.png');

/* ①.5 「怎么用」弹层：原来大厅底部那三段说明（各开一台设备 / 席位被占 /
   麦克风要 https）在手机上被媒体查询整段藏掉了，现在收进问号弹层。
   这里只验「点得开、关得掉、三条都在」——具体排版由 probe_help_prep.mjs 量。 */
const helpOpenable = await ev(`(() => {
  const b = document.getElementById('btnHelp');
  if (!b) return { err: '没有问号按钮' };
  const r = b.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { w: Math.round(r.width), h: Math.round(r.height), hitId: hit && (hit.id || hit.tagName) };
})()`);
if (helpOpenable.err) bad(helpOpenable.err);
else if (helpOpenable.hitId === 'btnHelp') ok('大厅问号点得到', `${helpOpenable.w}×${helpOpenable.h}`);
else bad('问号被别的东西盖住了', helpOpenable.hitId);

await ev(`document.getElementById('btnHelp').click()`);
await sleep(300);
const helpShown = await ev(`(() => {
  const w = document.getElementById('helpWrap');
  const secs = [...w.querySelectorAll('.help-sec h3')].map(h => h.textContent.replace(/\\s+/g, ' ').trim());
  return { disp: getComputedStyle(w).display, secs };
})()`);
if (helpShown.disp === 'flex') ok('问号能打开「怎么用」'); else bad('弹层没打开', helpShown.disp);
const threeSecs = helpShown.secs.length === 3
  && /两个人怎么配合/.test(helpShown.secs[0] || '')
  && /麦克风/.test(helpShown.secs[1] || '')
  && /房间和记录/.test(helpShown.secs[2] || '');
if (threeSecs) ok('弹层里三条说明都在', helpShown.secs.join(' | '));
else bad('三条说明不全', helpShown.secs.join(' | '));
/* 原来那个 .lobby-tip 必须彻底没了：留着它就是两份文案、
   手机上那份还是 hidden，改一处漏一处。 */
if (await ev(`!!document.querySelector('.lobby-tip')`)) bad('旧的 .lobby-tip 还在（两份文案了）');
else ok('旧的大厅说明块已彻底移除');

await ev(`document.getElementById('helpWrap').click()`);
await sleep(250);
if (await ev(`getComputedStyle(document.getElementById('helpWrap')).display === 'none'`)) ok('点遮罩关得掉');
else bad('点遮罩关不掉');

// ② 大厅「开一间」→ 直接进房，页头有房间名
const title = '流程 · ' + Date.now().toString().slice(-5);
await ev(`(()=>{const i=document.getElementById('lobbyNewTitle'); i.value=${JSON.stringify(title)}; document.getElementById('lobbyNewGo').click();})()`);
await sleep(2500);
const madeRoomId = await ev(`new URL(location.href).searchParams.get('s')`);
const inRoom = await ev(`document.getElementById('lobby').classList.contains('hide')`);
const hdr = await ev(`document.getElementById('btnRoom').textContent.trim()`);
if (inRoom && hdr === title) ok('开一间后直接进房，页头显示名字', hdr);
else bad('开一间后没进去或名字不对', `inRoom=${inRoom} hdr=${hdr}`);
const seatTxt = await ev(`document.getElementById('roleHint').textContent.trim()`);
if (/面试者/.test(seatTxt)) ok('页头身份 pill 有内容', seatTxt);
else bad('身份 pill 没更新', seatTxt);
await shot('flow_2_room.png');

// ③ 改成面试官身份再进同一间：应被挡，并在确认后变成面试官
const blocked = await ev(`(async () => {
  const r = await fetch('/api/room/join',{method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({session: new URL(location.href).searchParams.get('s'), clientId:'OTHER', role:'candidate'})});
  return r.status;
})()`);
if (blocked === 409) ok('另一台设备以面试者进入被挡（409）');
else bad('没挡住', 'status=' + blocked);

// ④ 回大厅：刚开的这间要出现在列表里，且标着面试者已占
await ev(`document.getElementById('btnRoom').click()`);
await sleep(2000);
const listed = await ev(`(() => {
  const el = [...document.querySelectorAll('#lobbyList .room')]
    .find(b => b.textContent.includes(${JSON.stringify(title)}));
  return el ? el.textContent.replace(/\\s+/g,' ').trim() : null;
})()`);
if (listed) ok('回大厅后刚开的这间在列表里', listed.slice(0, 70));
else bad('回大厅后找不到刚开的这间');

// ⑤ 历史面板改名 → 大厅卡片跟着变（这是用户最早提的那条需求）
await ev(`document.getElementById('btnHist').click()`);
await sleep(1200);
const histHas = await ev(`!!document.querySelector('#histWrap') && getComputedStyle(document.getElementById('histWrap')).display !== 'none'`);
if (histHas) ok('历史面板能打开'); else bad('历史面板打不开');

console.log('\n' + R.join('\n'));
const uniq = [...new Set(errs)].filter(Boolean);
console.log(uniq.length ? '\n控制台错误:\n' + uniq.slice(0, 8).join('\n') : '\n控制台干净');

/* ★ 收尾：把这一趟造出来的房间从库里删掉。
   少了这一步，每跑一次大厅就多一张「流程 · 18265」——跑十次之后用户打开
   大厅看到的全是探针垃圾，会以为页面坏了（真发生过，手工清了一次）。
   大厅按 updated_at 排序、只取前 24 条，垃圾足够多时**真的房间会被挤出去**。 */
if (madeRoomId) {
  const del = await ev(`fetch('/api/sessions/delete',{method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ id: ${JSON.stringify(madeRoomId)} })}).then(r=>r.json()).then(j=>j.ok).catch(()=>false)`);
  console.log(del ? `\n已清掉这次造的房间 ${madeRoomId}` : `\n⚠ 没清掉 ${madeRoomId}，请手动删`);
}

ws.close(); ch.kill(); try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
process.exit(0);

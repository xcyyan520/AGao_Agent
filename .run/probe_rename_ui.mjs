/* 改名这条链路的端到端：历史里改名 → 页头 / 标题 / 大厅卡片三处都要跟着变。
   为什么必须三处都测：接口返回 200 只证明库里改了，
   而人看到的是页头那个按钮、浏览器标题栏、大厅那张卡片——
   以前这三处一处都没跟着变，症状就是「改了没生效」。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8799';
const CHROME = ['C:/Users/xia-shana/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Users/xia-shana/AppData/Local/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
const PORT = 9354, prof = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-'));
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
let id = 0; const pend = new Map(); const errs = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown')
    errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
};
const cmd = (method, params = {}, sessionId) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const { result: { targetId } } = await cmd('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await cmd('Target.attachToTarget', { targetId, flatten: true });
await cmd('Page.enable', {}, sessionId); await cmd('Runtime.enable', {}, sessionId);
const ev = async expr => {
  const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
  return r.result?.result?.value;
};

const R = [];
const ok = (n, v) => R.push(`✔ ${n}${v ? ' → ' + v : ''}`);
const bad = (n, v) => R.push(`✘ ${n}${v ? ' :: ' + v : ''}`);

await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);

// 先在大厅开一间，名字用时间戳
const t0 = '改名前 · ' + Date.now().toString().slice(-5);
await cmd('Page.navigate', { url: BASE + '/' }, sessionId); await sleep(2200);
await ev(`(()=>{const i=document.getElementById('lobbyNewTitle'); i.value=${JSON.stringify(t0)}; document.getElementById('lobbyNewGo').click();})()`);
await sleep(2500);
/* 记住这一趟自己开的那间。后面一律用它，不再用 `items[0]` 猜——
   列表按 updated_at 排，改名本身就会把它顶到第一条，看起来能用，
   但只要中间有别人（或别的探针）动过库，`items[0]` 就换成别人的房间，
   探针会去改用户的真实面试。最后也要按这个 id 删干净。 */
const madeRoomId = await ev(`new URL(location.href).searchParams.get('s')`);
ok('进房后页头名', await ev(`document.getElementById('btnRoom').textContent.trim()`));

// 用真正的 UI 路径改名（prompt 用 stubbed 值，模拟人输入）
const t1 = '改名后 · ' + Date.now().toString().slice(-5);
await ev(`window.prompt = () => ${JSON.stringify(t1)}`);
await ev(`(async () => {
  await renameSession(${JSON.stringify(madeRoomId)}, ${JSON.stringify(t0)}, null);
})()`);
await sleep(1200);

const hdr = await ev(`document.getElementById('btnRoom').textContent.trim()`);
const dtl = await ev('document.title');
if (hdr === t1) ok('页头跟着变', hdr); else bad('页头没变', `hdr=${hdr} want=${t1}`);
if (dtl.startsWith(t1)) ok('浏览器标题跟着变', dtl); else bad('标题没变', dtl);

// 回大厅看卡片
await ev(`document.getElementById('btnRoom').click()`); await sleep(2200);
const card = await ev(`(() => {
  const el = [...document.querySelectorAll('#lobbyList .room')].find(b => b.textContent.includes(${JSON.stringify(t1)}));
  return el ? el.textContent.replace(/\\s+/g,' ').trim() : null;
})()`);
if (card) ok('大厅卡片跟着变', card.slice(0, 50)); else bad('大厅卡片还是旧名字');

// 清掉名字 → 页头要退回「未命名面试」，不能停留在旧值
await cmd('Page.navigate', { url: BASE + '/?s=' + madeRoomId }, sessionId); await sleep(2200);
await ev(`window.prompt = () => ''`);
await ev(`renameSession(${JSON.stringify(madeRoomId)}, ${JSON.stringify(t1)}, null)`);
await sleep(1000);
const hdr2 = await ev(`document.getElementById('btnRoom').textContent.trim()`);
if (hdr2 === '未命名面试') ok('清空名字后页头退回「未命名面试」', hdr2);
else bad('清空名字后页头不对', hdr2);

console.log('\n' + R.join('\n'));
const uniq = [...new Set(errs)].filter(Boolean);
console.log(uniq.length ? '\n控制台异常:\n' + uniq.slice(0, 6).join('\n') : '\n控制台无异常');

/* 收尾：删掉这一趟开的房间。不删的话大厅里会慢慢堆满
   「改名后 · 29755」这种卡片，而且大厅只取前 24 条——垃圾够多时
   用户真实的房间会被挤出去，看起来像「我的面试丢了」。 */
if (madeRoomId) {
  const del = await ev(`fetch('/api/sessions/delete',{method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ id: ${JSON.stringify(madeRoomId)} })}).then(r=>r.json()).then(j=>j.ok).catch(()=>false)`);
  console.log(del ? `已清掉这次造的房间 ${madeRoomId}` : `⚠ 没清掉 ${madeRoomId}，请手动删`);
}

ws.close(); ch.kill(); try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
process.exit(0);

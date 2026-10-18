/* 手机上进房之后，页面上到底有哪些「说明性长文字」是真的可见的。
   只列可见元素里字数 > 12 的纯文本块，按从上到下的顺序打出来。
   目的：把「哪些该收进使用说明」用实测数据定下来，不靠猜。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APP = 'http://127.0.0.1:8900';
const CHROME = [
  path.join(os.homedir(), '.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(p => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome'); process.exit(1); }
const PORT = 9351;
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'ptxt-'));
const ch = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check', `--user-data-dir=${prof}`, 'about:blank'],
  { stdio: 'ignore', windowsHide: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pend = new Map(); const errs = [];
for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch {} await sleep(250); }
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
ws = new WebSocket(webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const cmd = (method, params = {}, sessionId) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const { result: { targetId } } = await cmd('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await cmd('Target.attachToTarget', { targetId, flatten: true });
await cmd('Page.enable', {}, sessionId); await cmd('Runtime.enable', {}, sessionId);
const ev = async expr => {
  const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.result?.exceptionDetails) { console.error('页面报错:', r.result.exceptionDetails.exception?.description); return undefined; }
  return r.result?.result?.value;
};

const S = 'txtprobe_' + Date.now();
for (const [w, h] of [[390, 844], [360, 640]]) {
  await cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true }, sessionId);
  await cmd('Page.navigate', { url: `${APP}/?s=${S}` }, sessionId);
  await sleep(2400);

  const dump = await ev(`(() => {
    const out = [];
    const seen = new Set();
    const walk = el => {
      if (el.nodeType !== 1) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      // 只取"自己直接装了文字"的叶子块，避免把父容器重复算一遍
      const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').replace(/\\s+/g, ' ').trim();
      const ownLen = own.replace(/[，。、；：,.;:]/g, '').length;
      if (ownLen > 12) {
        const b = el.getBoundingClientRect();
        const key = (el.id || el.className || el.tagName) + '|' + own.slice(0, 20);
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ id: el.id || null, cls: (typeof el.className === 'string' ? el.className : '') || el.tagName,
            t: Math.round(b.top), h: Math.round(b.height), len: ownLen, fs: cs.fontSize, txt: own.slice(0, 120) });
        }
      }
      for (const c of el.children) walk(c);
    };
    walk(document.body);
    return out.sort((a, b) => a.t - b.t);
  })()`);
  console.log(`\n══════ ${w}x${h} 进房后的长文字块（>12 字）══════`);
  for (const d of dump) console.log(`  y=${String(d.t).padStart(4)} h=${String(d.h).padStart(3)} ${String(d.fs).padStart(6)} [${String(d.cls).slice(0, 18).padEnd(18)}] ${d.txt}`);
}
ws.close(); ch.kill(); try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
// 自清
try { await fetch(APP + '/api/sessions/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: S }) }); console.log(`\n已清掉 ${S}`); } catch {}
process.exit(0);

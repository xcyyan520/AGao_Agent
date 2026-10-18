/* 验「进房后那两句说明已经不在界面上，而在使用说明菜单里」。
   四件事：
     1) 进房后 #micHint 是空的、高度 0（不再占地方）
     2) 页头「更多」里有「? 使用说明」，点得开
     3) 弹层里第 1 节真的装着「各开一台设备 / 面试官可以有好几个」
     4) 桌面端页头直接就有这个按钮（不需要先点 ☰）
   两档手机 + 一档桌面。
*/
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
const PORT = 9352;
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'phelp-'));
const ch = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check', `--user-data-dir=${prof}`, 'about:blank'],
  { stdio: 'ignore', windowsHide: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pend = new Map();
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

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ✘ ${name}${extra ? '  ' + extra : ''}`); }
};

const S = 'helpprobe_' + Date.now();
for (const [w, h, desk] of [[390, 844, false], [360, 640, false], [1440, 900, true]]) {
  await cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: !desk }, sessionId);
  await cmd('Page.navigate', { url: `${APP}/?s=${S}` }, sessionId);
  await sleep(2500);
  console.log(`\n══════ ${w}x${h} ${desk ? '(桌面)' : '(手机)'} ══════`);

  const st = await ev(`(() => {
    const h = document.getElementById('micHint');
    const hr = h.getBoundingClientRect();
    const more = document.getElementById('btnHelp');
    const mr = more ? more.getBoundingClientRect() : null;
    return {
      hintText: (h.textContent || '').trim(),
      hintH: Math.round(hr.height),
      hintDisp: getComputedStyle(h).display,
      helpInActs: !!more,
      helpVisible: mr ? (getComputedStyle(more).display !== 'none' && mr.width > 0) : false,
      helpLabel: more ? more.textContent.trim() : null,
      actsOpen: document.getElementById('hdActs').classList.contains('open'),
      btnMoreDisp: getComputedStyle(document.getElementById('btnMore')).display,
    };
  })()`);
  ck('#micHint 进房后是空的', st.hintText === '', JSON.stringify(st.hintText.slice(0, 40)));
  ck('#micHint 高度为 0（不再占位）', st.hintH === 0, `h=${st.hintH} display=${st.hintDisp}`);
  ck('页头有「使用说明」按钮', st.helpInActs, st.helpLabel);
  if (!desk) ck('手机上它收在 ☰ 里（默认不可见）', !st.helpVisible && st.btnMoreDisp !== 'none',
    `visible=${st.helpVisible} btnMore=${st.btnMoreDisp}`);
  else ck('桌面上它直接可见', st.helpVisible);

  if (!desk) { await ev(`document.getElementById('btnMore').click()`); await sleep(200); }
  const open = await ev(`(() => {
    document.getElementById('btnHelp').click();
    return new Promise(res => setTimeout(() => {
      const w = document.getElementById('helpWrap');
      const secs = [...w.querySelectorAll('.help-sec')].map(s => s.querySelector('h3').textContent.replace(/\\s+/g,' ').trim());
      const txt = w.querySelector('.help-sec').textContent.replace(/\\s+/g,' ').trim();
      const body = w.querySelector('.help-body');
      const box = w.querySelector('.modal-box').getBoundingClientRect();
      res({ disp: getComputedStyle(w).display, secs,
        hasDevice: /各开一台设备/.test(txt), hasMulti: /面试官可以有好几个/.test(txt),
        hasSwitch: /切换/.test(txt), hasWhere: /喂给 AI 出题/.test(txt),
        boxTop: Math.round(box.top), boxH: Math.round(box.height), vh: innerHeight,
        scrollH: body.scrollHeight, clientH: body.clientHeight });
    }, 250));
  })()`);
  ck('点得开', open.disp === 'flex', `display=${open.disp}`);
  ck('弹层没超出屏幕', open.boxTop >= 0 && open.boxTop + open.boxH <= open.vh + 1,
    `top=${open.boxTop} h=${open.boxH} vh=${open.vh}`);
  ck('第 1 节装着「各开一台设备」', open.hasDevice);
  ck('第 1 节装着「面试官可以有好几个」', open.hasMulti);
  ck('第 1 节讲了「切换」选身份', open.hasSwitch);
  ck('第 1 节讲了谁说的话语料去向', open.hasWhere);
  if (open.scrollH > open.clientH) console.log(`    （正文要滚：${open.scrollH}/${open.clientH}）`);
  await ev(`document.getElementById('btnHelpClose').click()`);
  await sleep(150);
  ck('关得掉', await ev(`getComputedStyle(document.getElementById('helpWrap')).display === 'none'`));
}

ws.close(); ch.kill(); try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
try { await fetch(APP + '/api/sessions/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: S }) }); } catch {}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

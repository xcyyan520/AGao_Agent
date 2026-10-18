/* 量两处刚改的界面：① 大厅顶部的「怎么用」按钮和弹层；② 准备区抽屉把手。
   只看几何和可点性，不看颜色（模型没有图像输入，截图看了也白看）。 */
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

const PORT = 9336;
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'phelp-'));
const ch = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check', `--user-data-dir=${prof}`,
  '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const waiters = new Map();
async function cmd(method, params = {}, sessionId) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  return new Promise((res, rej) => {
    waiters.set(mid, { res, rej });
    setTimeout(() => { if (waiters.has(mid)) { waiters.delete(mid); rej(new Error(method + ' timeout')); } }, 30000);
  });
}
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch {}
  await sleep(250);
}
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
ws = new WebSocket(webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && waiters.has(m.id)) { const w = waiters.get(m.id); waiters.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result); }
});
const { targetId: newTarget } = await cmd('Target.createTarget', { url: 'about:blank' });
const sessionId = (await cmd('Target.attachToTarget', { targetId: newTarget, flatten: true })).sessionId;
await cmd('Page.enable', {}, sessionId); await cmd('Runtime.enable', {}, sessionId);
const evRaw = async expr => await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
const ev = async expr => {
  const r = await evRaw(expr);
  if (r.exceptionDetails) {
    console.error('页面里报错：', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return undefined;
  }
  return r.result?.value;
};

const R = `const r = el => { if(!el) return null; const b = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {t:Math.round(b.top),b:Math.round(b.bottom),l:Math.round(b.left),r:Math.round(b.right),
    w:Math.round(b.width),h:Math.round(b.height),fs:cs.fontSize,disp:cs.display,
    txt:(el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,30)}; };`;

/* 这个探针造出来的房间，收尾统一删。
   大厅按 updated_at 排序只取前 24 条，多跑几次探针真房间会被挤出去。 */
const madeRooms = [];

for (const [w, h] of [[390, 844], [360, 640], [1440, 900]]) {
  await cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 800 }, sessionId);
  await cmd('Page.navigate', { url: APP + '/?probe=' + Date.now() }, sessionId);
  await sleep(2600);

  const lobby = await ev(`(() => { ${R}
    const hb = document.getElementById('btnHelpLobby');
    const out = { vw:innerWidth, vh:innerHeight, help: r(hb), head: r(document.querySelector('.lobby-head')),
      titleR: r(document.querySelector('.lobby-title')), sub: r(document.querySelector('.lobby-sub')),
      tip: !!document.querySelector('.lobby-tip'), helpShown: getComputedStyle(document.getElementById('helpWrap')).display };
    // 问号有没有被别的东西盖住
    if (hb) { const b = hb.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width/2, b.top + b.height/2);
      out.helpHit = hit ? (hit.id || hit.className || hit.tagName) : null; }
    return out; })()`);
  console.log(`\n══════ 大厅 ${w}x${h} ══════`);
  console.log('helpBtn', JSON.stringify(lobby.help));
  console.log('head   ', JSON.stringify(lobby.head));
  console.log('sub    ', JSON.stringify(lobby.sub));
  console.log('lobby-tip 还在吗 =', lobby.tip, '  弹层初始 display =', lobby.helpShown, '  问号命中 =', lobby.helpHit);

  // 点问号
  const opened = await ev(`(() => { ${R}
    document.getElementById('btnHelpLobby').click();
    return new Promise(res => setTimeout(() => {
      const w = document.getElementById('helpWrap'), box = w.querySelector('.modal-box');
      const body = w.querySelector('.help-body');
      const secs = [...w.querySelectorAll('.help-sec')].map(s => ({ t: r(s), h3: s.querySelector('h3').textContent.trim(),
        ps: s.querySelectorAll('p').length }));
      // 「溢出」只查横向。纵向不能查：.help-body 是可滚动容器，正文比容器长
      // 是正常的，里面还没滚到的段落 bottom 当然超过框子 —— 拿它当判据会把
      // 每一段都报成溢出（实测 360x640 上假报 DIV.help-sec / P / B 共五条）。
      const bb = box.getBoundingClientRect();
      const over = [...w.querySelectorAll('.help-body *')].filter(e => {
        const b = e.getBoundingClientRect();
        return b.right > bb.right + 1 || b.left < bb.left - 1;
      }).map(e => e.tagName + '.' + (e.className||''));
      res({ disp: getComputedStyle(w).display, box: r(box), body: r(body),
        scrollH: body ? body.scrollHeight : 0, clientH: body ? body.clientHeight : 0,
        secs: secs.length, h3s: secs.map(s => s.h3), over: over.slice(0,6),
        closeBtn: r(document.getElementById('btnHelpClose')) });
    }, 250)); })()`);
  console.log('  弹层 display =', opened.disp, ' box =', JSON.stringify(opened.box));
  console.log('  正文 scrollH/clientH =', opened.scrollH, '/', opened.clientH,
    opened.scrollH > opened.clientH ? '（要滚，正常）' : '（不用滚）');
  console.log('  小节 =', opened.h3s.join(' | '), ' 溢出元素 =', opened.over.join(',') || '无');
  console.log('  关闭按钮 =', JSON.stringify(opened.closeBtn));

  // 点遮罩关掉
  await ev(`document.getElementById('helpWrap').click()`);
  const closed = await ev(`getComputedStyle(document.getElementById('helpWrap')).display`);
  console.log('  点遮罩后 display =', closed);

  if (w < 800) {
    // 进房间量准备区抽屉。★ 带 ?s= 进房会在库里留一间房，
    // 不收尾删掉就会积在大厅里（真发生过，见 使用说明.md）。
    const prepSession = 'prepprobe_' + Date.now();
    madeRooms.push(prepSession);
    await cmd('Page.navigate', { url: APP + '/?s=' + prepSession }, sessionId);
    await sleep(2200);
    const prep = await ev(`(() => { ${R}
      const tgl = document.getElementById('btnSideToggle');
      const out = { vh: innerHeight, collapsed: !tgl.parentElement.classList.contains('prep-open'),
        toggle: r(tgl), grip: r(document.querySelector('.st-grip')), icon: r(document.getElementById('sideToggleIcon')),
        label: r(document.getElementById('sideToggleLabel')), hint: r(document.getElementById('sideToggleHint')),
        arrow: r(document.getElementById('sideToggleArrow')),
        arrowGlyph: (getComputedStyle(document.querySelector('#sideToggleArrow i'), '::before').content || '').replace(/^["']|["']$/g, ''), hintText: document.getElementById('sideToggleHint').textContent,
        mic: r(document.getElementById('btnMic')) };
      // 收起态：整个把手必须是一个可点目标，且拇指够得着
      const b = tgl.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width/2, b.top + b.height/2);
      out.hit = hit ? (hit.id || hit.className || hit.tagName) : null;
      out.hitInside = !!(hit && (tgl.contains(hit) ));
      return out; })()`);
    console.log(`\n══════ 准备区（收起）${w}x${h} ══════`);
    console.log('把手', JSON.stringify(prep.toggle), ' 命中 =', prep.hit, ' 在把手内 =', prep.hitInside);
    console.log('抓手条', JSON.stringify(prep.grip), ' 图标', JSON.stringify(prep.icon));
    console.log('主标题', JSON.stringify(prep.label), ' 副标题', JSON.stringify(prep.hint), '→', prep.hintText);
    console.log('动作块', JSON.stringify(prep.arrow), ' 字形 =', JSON.stringify(prep.arrowGlyph),
      ' 开始说话 top =', prep.mic && prep.mic.t);

    const open = await ev(`(() => { ${R}
      document.getElementById('btnSideToggle').click();
      return new Promise(res => setTimeout(() => {
        const tgl = document.getElementById('btnSideToggle');
        const side = tgl.parentElement;
        const b = tgl.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + b.width/2, b.top + b.height/2);
        const secs = [...side.querySelectorAll(':scope > section')].map(s => ({ id: s.id || '(材料)',
          d: getComputedStyle(s).display, t: Math.round(s.getBoundingClientRect().top),
          h: Math.round(s.getBoundingClientRect().height) }));
        // 抽屉滚下去之后把手还够不够得到（sticky 有没有真的生效）
        side.scrollTop = 9999;
        const afterScroll = (() => { const bb = tgl.getBoundingClientRect();
          return { t: Math.round(bb.top), b: Math.round(bb.bottom) }; })();
        side.scrollTop = 0;
        res({ open: side.classList.contains('prep-open'),
          pos: getComputedStyle(tgl).position, toggle: r(tgl), hit: hit ? (hit.id||hit.className||hit.tagName) : null,
          hitInside: !!(hit && tgl.contains(hit)), labelText: document.getElementById('sideToggleLabel').textContent,
          hintText: document.getElementById('sideToggleHint').textContent,
          // 动作块的字形在 .st-x i::before 里（CSS 换字，不在 textContent 里），
          // 读 textContent 永远是空的——要读伪元素的实际 content。
          arrowText: (getComputedStyle(document.querySelector('#sideToggleArrow i'), '::before').content || '').replace(/^["']|["']$/g, ''),
          secs, afterScroll, sideScrollH: side.scrollHeight, sideH: Math.round(side.getBoundingClientRect().height) });
      }, 350)); })()`);
    console.log(`\n══════ 准备区（展开）${w}x${h} ══════`);
    console.log('展开 =', open.open, ' 把手 position =', open.pos, ' 把手', JSON.stringify(open.toggle));
    console.log('把手文案：', open.labelText, '/', open.hintText, ' 动作块 =', open.arrowText);
    console.log('把手命中 =', open.hit, ' 在把手内 =', open.hitInside);
    console.log('各段：', open.secs.map(s => `${s.id} d=${s.d} t=${s.t} h=${s.h}`).join('  |  '));
    console.log('抽屉 scrollH/H =', open.sideScrollH, '/', open.sideH, ' 滚到底后把手 =', JSON.stringify(open.afterScroll));

    // 再点一次收起
    await ev(`document.getElementById('btnSideToggle').click()`);
    await sleep(300);
    console.log('再点一次收起 =', await ev(`!document.getElementById('btnSideToggle').parentElement.classList.contains('prep-open')`),
      ' 文案回到 =', await ev(`document.getElementById('sideToggleLabel').textContent + ' / ' + document.getElementById('sideToggleHint').textContent`));
  }
}

ws.close(); ch.kill(); try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}

/* 收尾：删掉这个探针进过的房间。
   大厅按 updated_at 排序、只取前 24 条 —— 探针垃圾足够多时，用户真实的
   面试会被挤出列表，看起来像「我的面试丢了」（真发生过）。 */
for (const id of madeRooms) {
  try {
    const r = await fetch(APP + '/api/sessions/delete', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    const j = await r.json();
    console.log(j.ok ? `已清掉房间 ${id}` : `⚠ 没清掉 ${id}：${j.error || '服务端没答应'}`);
  } catch (e) { console.log(`⚠ 没清掉 ${id}：${e.message}`); }
}
process.exit(0);

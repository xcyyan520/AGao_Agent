/* 手机端「展开准备区」到底坏在哪。
   上一轮只量了收起态（.run/probe_mobile_ui.mjs），收起态是好的；
   用户说的是**展开之后**不对劲。这一段专量展开态：
   每个 section 的盒子、里面控件是否被压扁/重叠/滚不动。
   用法：node .run/probe_fold.mjs */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.APP || 'http://127.0.0.1:8900';
const PORT = 9336;

const CANDIDATES = [
  path.join(os.homedir(), '.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
];
const CHROME = CANDIDATES.find(p => fs.existsSync(p));
if (!CHROME) { console.error('找不到 chrome.exe'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'foldprobe-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--window-size=390,844', 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cdpWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch (_) {}
    await sleep(200);
  }
  throw new Error('CDP 没起来');
}

const ws = new WebSocket(await cdpWs());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}, sessionId) {
  const mid = ++id;
  const msg = { id: mid, method, params };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise(r => pending.set(mid, r));
}

const t = await send('Target.createTarget', { url: 'about:blank' });
const sessionId = (await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true })).result.sessionId;
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await sleep(300);

async function evalJs(expr) {
  const r = await send('Runtime.evaluate',
    { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
}

const PROBE = `(() => {
  // ⚠ 这里必须带上 left。第一版漏了，于是下面算探针点退化成了 x=r.w/2，
  //   整行三个控件（保存材料/上传文件/N 字）都被测在几乎同一个点上，
  //   全部报「被 #btnSaveMat 盖住」——纯假阳性。写探针时 rect 少一个字段
  //   就能凭空造出三个 bug，比不写还糟。
  const rect = el => { if(!el) return null; const r = el.getBoundingClientRect();
    return {left:Math.round(r.left), top:Math.round(r.top), right:Math.round(r.right),
            bot:Math.round(r.bottom), h:Math.round(r.height), w:Math.round(r.width)}; };
  const cs = el => el ? getComputedStyle(el) : {};
  const side = document.querySelector('.side');
  const out = {
    vw: innerWidth, vh: innerHeight,
    side: rect(side),
    sideClass: side ? side.className : null,
    sideOverflowY: side ? cs(side).overflowY : null,
    sideScroll: side ? { h: side.scrollHeight, c: side.clientHeight,
      canScroll: side.scrollHeight > side.clientHeight + 2 } : null,
    toggle: rect(document.getElementById('btnSideToggle')),
    sections: [],
  };
  for (const s of document.querySelectorAll('.side > section')) {
    const st = cs(s);
    const r = rect(s);
    out.sections.push({
      id: s.id || '(材料)',
      display: st.display,
      rect: r,
      scrollH: s.scrollHeight,
      clientH: s.clientHeight,
      // 内容比盒子高 → 被压扁了
      clipped: s.scrollHeight > s.clientHeight + 2,
      flex: st.flex, minH: st.minHeight, maxH: st.maxHeight,
    });
  }
  // 关键控件：逐个看有没有被压成 0 高、或被别的元素盖住
  const ctrls = ['materials','btnSaveMat','matStat','btnMatLib','btnMatLibClose','matLibList','btnMic','btnRole','micHint','matFile','btnUpload','replayText','btnReplay','cfgBase'];
  out.ctrls = ctrls.map(cid => {
    const el = document.getElementById(cid);
    if (!el) return { id: cid, missing: true };
    const r = rect(el);
    let covered = null;
    if (r && r.h > 0) {
      // 探针点 = 控件矩形的真实中心。之前写成 (r.w/2) 是错的（少了 left），
      // 会把这行三个控件都测到左边缘同一点上，导致假报遮挡。
      // 注意本段在模板字符串里，注释不能出现反引号，否则会把字符串截断。
      const cx = Math.max(0, Math.min(innerWidth - 1, Math.round(r.left + r.w / 2)));
      const cy = Math.max(0, Math.min(innerHeight - 1, Math.round(r.top + r.h/2)));
      const hit = document.elementFromPoint(cx, cy);
      covered = hit && (hit === el || el.contains(hit) || hit.contains(el)) ? null
        : (hit ? (hit.id || hit.tagName + '.' + (hit.className || '').toString().slice(0,20)) : 'null');
      if (r.top < 0 || r.bot > innerHeight) covered = covered || ('离屏 top=' + r.top + ' bot=' + r.bot);
    }
    return { id: cid, rect: r, display: cs(el).display, covered };
  });
  return out;
})()`;

async function snap(label) {
  const d = await evalJs(PROBE);
  console.log(`\n═══ ${label} ═══  viewport ${d.vw}x${d.vh}`);
  console.log(`side ${d.side ? d.side.h + 'px' : '?'}  class="${d.sideClass}"  overflowY=${d.sideOverflowY}`);
  console.log(`  scrollH=${d.sideScroll?.h} clientH=${d.sideScroll?.c} 能滚=${d.sideScroll?.canScroll}`);
  console.log(`toggle ${d.toggle ? d.toggle.top + '..' + d.toggle.bot + ' h=' + d.toggle.h : '(无)'}`);
  for (const s of d.sections) {
    const r = s.rect;
    console.log(`  [${s.id}] ${s.display} ${r ? `${r.top}..${r.bot} h=${r.h} w=${r.w}` : 'rect=null'} ` +
      `scrollH=${s.scrollH} clientH=${s.clientH}${s.clipped ? ' ⚠被压扁' : ''} flex=${s.flex} minH=${s.minH}`);
  }
  for (const c of d.ctrls) {
    if (c.missing) { console.log(`    ${c.id}: 不存在`); continue; }
    const r = c.rect;
    const flags = [];
    if (c.display === 'none') flags.push('display:none');
    if (r && r.h === 0 && c.display !== 'none') flags.push('⚠ 高 0');
    if (r && r.h > 0 && r.h < 32 && !/matStat/.test(c.id)) flags.push(`⚠ 矮(${r.h})`);
    if (c.covered) flags.push(`⚠ ${c.covered}`);
    console.log(`    ${c.id}: ${r ? `${r.top}..${r.bot} h=${r.h} w=${r.w}` : '?'} ${flags.join(' ')}`);
  }
  return d;
}

/* ★ 房间模式之后不能再拿 `?s=default` 当入口：裸地址和 default 都停在大厅，
   而 #lobby 是 position:fixed;inset:0;z-index:300，整页盖住——
   于是这里量到的 elementFromPoint 全是「被大厅盖住」，报一堆假遮挡。
   改成带自己的一次性 id 直接进房（和 ui_check / probe_help_prep 一致）。 */
const FOLD_SESSION = 'foldprobe_' + Date.now();
for (const [w, h] of [[390, 844], [360, 640]]) {
  await send('Emulation.setDeviceMetricsOverride',
    { width: w, height: h, deviceScaleFactor: 1, mobile: true }, sessionId);
  await send('Page.navigate', { url: `${APP}/?s=${FOLD_SESSION}` }, sessionId);
  await sleep(2200);
  await snap(`收起 ${w}x${h}`);
  await evalJs(`document.getElementById('btnSideToggle').click()`);
  await sleep(600);
  await snap(`展开 ${w}x${h}`);
}

/* 收尾自己删掉这场，否则大厅里会积一间 foldprobe_xxx
   （大厅按 updated_at 排序只取前 24 条，探针跑多了真房间会被挤出去）。 */
try {
  await fetch(APP + '/api/sessions/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: FOLD_SESSION })
  });
  console.log(`\n已清掉 ${FOLD_SESSION}`);
} catch (e) { console.log('清房间失败:', e.message); }

/* ★ 顺序有讲究：先关 WebSocket 再杀 chrome 再等待，最后才 exit。
   以前是 chrome.kill() 紧接 process.exit(0)，libuv 在拆 async handle 时
   正好撞上退出，Windows 上会打 "Assertion failed: !(handle->flags &
   UV_HANDLE_CLOSING), file src\win\async.c, line 76" 并以 exit code 1 结束——
   探针其实全跑完了，但看起来像失败。 */
try { ws.close(); } catch {}
chrome.kill();
await sleep(400);
process.exit(0);

/* 手机端三个用户报告问题的实测：
   1) 页面显示不全 —— 量出到底哪块被裁掉/够不着
   2) 点「保存材料」没反应 —— 点完到底有没有反馈、反馈出现在哪、看不看得见
   3) 语音转文字时灵时不灵 —— 查 asr 状态机与并发

   用 CDP，量 DOM 几何 + 拦网络请求，不靠肉眼。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8900';
const PORT = 9347;
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

/* 派上用场的关键量测：
   - 视口 vs 文档高度、横向溢出
   - 每个 section/关键按钮：getBoundingClientRect + 是否在视口内 + 是否被别的东西盖住
   - flash 消息渲染在哪、点完保存后它可见吗 */
const REPORT = `(() => {
  const R = el => { if(!el) return null; const r = el.getBoundingClientRect();
    return { x:Math.round(r.left), y:Math.round(r.top), w:Math.round(r.width), h:Math.round(r.height),
             bot:Math.round(r.bottom) }; };
  const hitAt = (el) => {
    const r = el.getBoundingClientRect();
    const cx = Math.min(innerWidth-1, Math.max(0, r.left + r.width/2));
    const cy = Math.min(innerHeight-1, Math.max(0, r.top + r.height/2));
    const h = document.elementFromPoint(cx, cy);
    return h && (h===el || el.contains(h) || h.contains(el));
  };
  const out = { vw:innerWidth, vh:innerHeight, docW:document.documentElement.scrollWidth,
                docH:document.documentElement.scrollHeight };
  // 关键控件是否看得到、点得到
  const keys = ['materials','btnSaveMat','btnUpload','matStat','btnMic','btnRole','btnSideToggle','btnMore','nextq'];
  out.controls = {};
  for (const id of keys) {
    const el = document.getElementById(id);
    if (!el) { out.controls[id] = { missing:true }; continue; }
    const cs = getComputedStyle(el);
    const r = R(el);
    out.controls[id] = {
      ...r, display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      inView: r.y >= 0 && r.bot <= innerHeight,
      hittable: cs.display!=='none' && cs.visibility!=='hidden' && hitAt(el),
    };
  }
  // 侧栏 / 抽屉当前状态
  const side = document.querySelector('.side');
  out.side = { class: side ? side.className : null, ...(side ? R(side) : {}) };
  out.sideScroll = side ? { sh: side.scrollHeight, ch: side.clientHeight } : null;
  // feed 在哪（flash 消息就渲染在里面）
  const feed = document.getElementById('feed');
  out.feed = feed ? R(feed) : null;
  // 页面里所有文字节点溢出容器的情况
  const overflows = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (el.scrollHeight > el.clientHeight + 4 && el.clientHeight > 0 && cs.overflowY === 'hidden') {
      overflows.push({ tag: el.tagName + (el.id?('#'+el.id):''), sh: el.scrollHeight, ch: el.clientHeight,
                       overflowY: cs.overflowY });
    }
  }
  out.clipped = overflows.slice(0, 12);
  return out;
})()`;

try {
  cdp = await CDP.connect(await wsUrl());
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  sid = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Network.enable', {}, sid);

  // 收集页面里的网络请求（看保存材料到底有没有发出去）
  const reqs = [];
  cdp.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Network.requestWillBeSent' && m.params?.request) {
      const u = m.params.request.url;
      if (u.includes('/api/')) reqs.push({ url: u.replace(BASE,''), method: m.params.request.method });
    }
    if (m.method === 'Network.responseReceived' && m.params?.response) {
      const u = m.params.response.url;
      if (u.includes('/api/')) {
        const hit = reqs.slice().reverse().find(r => u.endsWith(r.url) && !r.status);
        if (hit) hit.status = m.params.response.status;
      }
    }
  });

  for (const [w, h] of [[390, 844], [360, 640]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true }, sid);
    await cdp.send('Page.navigate', { url: BASE + '/' }, sid);
    await sleep(1800);
    const r = await ev(REPORT);
    console.log(`\n══════════ ${w}x${h} ══════════`);
    console.log(`  文档 ${r.docW}x${r.docH}  视口 ${r.vw}x${r.vh}  横向溢出=${r.docW - r.vw}px  纵向溢出=${r.docH - r.vh}px`);
    console.log(`  
  侧栏 class="${r.side.class}" y=${r.side.y} h=${r.side.h}  scroll sh/ch=${r.sideScroll?.sh}/${r.sideScroll?.ch}`);
    console.log('  ── 关键控件 ──');
    for (const [id, c] of Object.entries(r.controls)) {
      if (c.missing) { console.log(`     ${id.padEnd(14)} 不存在`); continue; }
      const flags = [];
      if (c.display === 'none') flags.push('display:none');
      else if (c.w === 0 || c.h === 0) flags.push('0x0（在收起的抽屉里）');
      if (c.display !== 'none' && c.w > 0 && !c.inView) flags.push(`⬇屏外(y=${c.y} bot=${c.bot})`);
      if (c.display !== 'none' && c.w > 0 && !c.hittable) flags.push('✗点不到(被盖)');
      console.log(`     ${id.padEnd(14)} y=${String(c.y).padStart(4)} ${String(c.w).padStart(3)}x${String(c.h).padStart(3)} ${flags.join(' ') || '✅'}`);
    }
    if (r.clipped.length) {
      console.log('  ── 内容被裁掉的容器 ──');
      for (const c of r.clipped) console.log(`     ${c.tag.padEnd(22)} scrollH=${c.sh} clientH=${c.ch} overflowY=${c.overflowY}`);
    } else console.log('  ── 无内容被裁 ──');
  }

  // ── 专门测「点保存材料」有没有反馈 ──
  console.log('\n══════════ 点「保存材料」的实际行为 ══════════');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sid);
  await cdp.send('Page.navigate', { url: BASE + '/' }, sid);
  await sleep(1800);
  reqs.length = 0;
  const before = await ev(`(() => {
    const s = document.querySelector('.side');
    if (s && s.classList.contains('prep-open')) document.getElementById('btnSideToggle').click();
    return { folded: true };
  })()`);
  await sleep(500);
  // 展开抽屉（手机上材料框默认是收起的）
  await ev(`document.getElementById('btnSideToggle').click()`);
  await sleep(600);
  // 填内容
  await ev(`(() => {
    const ta = document.getElementById('materials');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    set.call(ta, '# 测试材料\\n' + '这是用来验证保存反馈的内容。'.repeat(20));
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(300);
  const clicked = await ev(`(() => {
    const b = document.getElementById('btnSaveMat');
    const r = b.getBoundingClientRect();
    const cx = r.left + r.width/2, cy = r.top + r.height/2;
    const hit = document.elementFromPoint(cx, cy);
    b.click();
    return { rect:{x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)},
             hitSelf: hit===b || b.contains(hit),
             hitWhat: hit ? (hit.tagName + (hit.id?('#'+hit.id):'')) : 'null' };
  })()`);
  await sleep(1500);
  const after = await ev(`(() => {
    const feed = document.getElementById('feed');
    const stat = document.getElementById('matStat');
    const toast = document.getElementById('toast');
    const tr = toast ? toast.getBoundingClientRect() : null;
    const sr = stat ? stat.getBoundingClientRect() : null;
    const inView = r => r && r.top >= 0 && r.bottom <= innerHeight;
    // toast 有没有被别的东西盖住。
    // ★ 不能用 elementFromPoint / elementsFromPoint：toast 故意设了
    //   pointer-events:none（它绝不能吃掉任何一次点击），而这两个 API
    //   都会跳过 pointer-events:none 的元素，于是永远命中它下面那个 ——
    //   那是特性不是 bug，拿它当判据只能测出假失败（实测报
    //   「前3层: SPAN#matStat > DIV > SECTION」就是这个原因）。
    //   正确做法：量的时候临时把 pointer-events 打开，量完立刻还原，
    //   这样量到的是真实绘制层级，而不是「谁接收点击」。
    let toastHit = null, toastStack = null;
    if (toast && tr && tr.width > 0) {
      const prev = toast.style.pointerEvents;
      toast.style.pointerEvents = 'auto';
      const stack = document.elementsFromPoint(tr.left + tr.width/2, tr.top + tr.height/2);
      toast.style.pointerEvents = prev;
      toastStack = stack.slice(0, 3).map(e => e.tagName + (e.id ? ('#' + e.id) : ''));
      toastHit = stack[0] === toast;
    }
    return {
      matStat: stat ? stat.textContent : null,
      matStatInView: inView(sr),
      toastText: toast ? toast.textContent : null,
      toastOpacity: toast ? getComputedStyle(toast).opacity : null,
      toastRect: tr ? { y: Math.round(tr.top), bot: Math.round(tr.bottom), w: Math.round(tr.width) } : null,
      toastInView: inView(tr),
      toastOnTop: toastHit,
      toastStack: toastStack,
      // toast 是不是真的挂在 body 上（而不是又被塞回了被盖住的 feed）
      toastParent: toast ? toast.parentElement.id || toast.parentElement.tagName : null,
      feedScrollTop: feed.scrollTop,
      feedScrollH: feed.scrollHeight,
      feedClientH: feed.clientHeight,
      drawerOpen: document.querySelector('.side').classList.contains('prep-open'),
      // toast 关掉之后不该还挡着点击
      toastPointer: toast ? getComputedStyle(toast).pointerEvents : null,
    };
  })()`);
  console.log(`  按钮 ${JSON.stringify(clicked.rect)}  点到自己=${clicked.hitSelf}  (命中=${clicked.hitWhat})`);
  console.log(`  发出去的请求：${reqs.length ? reqs.map(r=>r.method+' '+r.url+' -> '+r.status).join(', ') : '（一个都没有！）'}`);
  console.log(`  matStat = ${JSON.stringify(after.matStat)}  在视口内=${after.matStatInView}`);
  console.log(`  toast   = ${JSON.stringify(after.toastText)}`);
  console.log(`           挂在=${after.toastParent}  opacity=${after.toastOpacity}  rect=${JSON.stringify(after.toastRect)}`);
  console.log(`           在视口内=${after.toastInView}  在最上层(没被盖)=${after.toastOnTop}  [前3层: ${(after.toastStack||[]).join(' > ')}]  指针事件=${after.toastPointer}`);
  console.log(`  feed 滚动位置 scrollTop=${after.feedScrollTop} scrollH=${after.feedScrollH} clientH=${after.feedClientH}`);
  console.log(`  抽屉还开着=${after.drawerOpen}`);
  console.log(`\n  ${after.toastText && after.toastInView && after.toastOnTop && after.toastParent === 'BODY'
    ? '✅ 反馈现在长在眼睛能看见的地方' : '❌ 反馈还是看不见'}`);
} catch (e) {
  console.error('跑挂了：', e.message);
} finally {
  try { chrome.kill(); } catch (_) {}
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(0);
}

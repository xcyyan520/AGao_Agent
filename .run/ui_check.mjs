// 用真实 Chrome 走一遍界面：保存材料 → 回放 → 看题真的上屏。
// 不装 puppeteer，直接用 Node 24 自带的 WebSocket 讲 CDP。
//
// 用法：
//   1) 先起服务：node server.mjs          （8900）
//   2) 再跑本脚本：node .run/ui_check.mjs
//
// 会自己拉起一个无头 Chrome，用完关掉。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = 'http://127.0.0.1:8900';
const PORT = 9333;
const CHROME = [
  path.join(os.homedir(), '.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
].find(p => p && fs.existsSync(p));

if (!CHROME) { console.error('找不到 chrome.exe'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uicheck-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── 等 CDP 起来 ─────────────────────────────────────────────────────── */
let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    wsUrl = (await r.json()).webSocketDebuggerUrl;
    if (wsUrl) break;
  } catch { /* 还没起来 */ }
  await sleep(250);
}
if (!wsUrl) { chrome.kill(); console.error('CDP 没起来'); process.exit(2); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) events.push(m);
};
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const myId = ++id;
  pending.set(myId, res);
  ws.send(JSON.stringify({ id: myId, method, params, ...(sessionId ? { sessionId } : {}) }));
});

/* ── 开一个页面并挂上控制台/异常监听 ─────────────────────────────────── */
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });

const jsErrors = [];
const consoleErrs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.sessionId !== sessionId) return;
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    jsErrors.push(d.exception?.description || d.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrs.push(m.params.args.map(a => a.value ?? a.description).join(' '));
  }
});

await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);

const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description || 'eval 失败');
  }
  return r.result?.result?.value;
};

await send('Page.navigate', { url: APP }, sessionId);
await sleep(1800);

// 先重置，保证这次跑的是干净会话（否则上一轮的题会混进统计）
await fetch(`${APP}/api/reset`, { method: 'POST' });
await sleep(600);

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
};

console.log('\n═══ 界面加载 ═══');
const title = await evalJs('document.title');
check('页面标题正确', /边说边出题/.test(title), title);
check('没有 JS 异常', jsErrors.length === 0, jsErrors[0] || '');
check('没有 console.error', consoleErrs.length === 0, consoleErrs[0] || '');

const hasText = (s) => evalJs(`document.body.innerText.includes(${JSON.stringify(s)})`);
check('有材料输入框 #materials', await evalJs('!!document.getElementById("materials")'));
check('有麦克风按钮 #btnMic', await evalJs('!!document.getElementById("btnMic")'));
check('有角色切换 #btnRole', await evalJs('!!document.getElementById("btnRole")'));
check('麦克风是主路径（默认可见）', await evalJs(
  'document.getElementById("micSec").style.display !== "none"'));
check('回放默认收起（不占地方）', await evalJs(
  'document.getElementById("replaySec").style.display === "none"'));
check('有「模拟回放」入口', await evalJs('!!document.getElementById("btnReplayOpen")'));

// 后面要测回放，先把那一段展开
await evalJs('document.getElementById("btnReplayOpen").click()');
await sleep(300);
check('点「模拟回放」能展开', await evalJs(
  'document.getElementById("replaySec").style.display !== "none"'));
check('有回放文本框 #replayText', await evalJs('!!document.getElementById("replayText")'));
check('有「开始回放」按钮', await evalJs('!!document.getElementById("btnReplay")'));

console.log('\n═══ 保存材料 ═══');
const MATERIAL = `候选人简历（节选）
秒杀系统：使用 Redis 做库存预减，消息队列异步落库，峰值 30000 QPS。
分布式锁：基于 Redis 实现。
压测：JMeter 全链路压测，有详细数据。`;

// 用真实的 setter 触发 input，这样页面上的 Vue/原生监听才会跑
const setVal = (sel, val) => evalJs(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return false;
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(val)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);

check('材料已填入', await setVal('#materials', MATERIAL));
await sleep(300);
check('材料字数已更新', !(await evalJs('document.getElementById("matStat").textContent')).startsWith('0'),
  await evalJs('document.getElementById("matStat").textContent'));

await evalJs('document.getElementById("btnSaveMat").click()');
await sleep(1200);
check('材料保存后字数仍显示', !(await evalJs('document.getElementById("matStat").textContent')).startsWith('0'),
  await evalJs('document.getElementById("matStat").textContent'));

console.log('\n═══ 回放 ═══');
const TRANSCRIPT = `我用了 Redis 的 DECR 做预减库存，然后发消息到 RocketMQ，下游异步落库。不过我们实际上没有做异步落库，是同步写库的，QPS 峰值大概 5000 左右。锁的话我们没怎么用分布式锁，因为 Redis 本身是单线程的。压测是压过的，就在本机上跑了一下 JMeter，具体数字记不太清了。`;
check('逐字稿已填入', await setVal('#replayText', TRANSCRIPT));
await sleep(300);

await evalJs('document.getElementById("btnReplay").click()');

// 等题目真的上屏
let apiQ = [];
let body = '';
for (let i = 0; i < 80; i++) {
  await sleep(500);
  const api = await (await fetch(`${APP}/api/state`)).json();
  apiQ = (api.history || []).map(h => h.question).filter(Boolean);
  if (apiQ.length >= 2) break;
}
// 回放结束后再给界面一点时间渲染
await sleep(1500);
body = await evalJs('document.body.innerText');

check('服务端出了题', apiQ.length > 0, `${apiQ.length} 条`);
const onScreen = apiQ.filter(q => body.includes(q.slice(0, 6)));
check('题目文字渲染在页面上', onScreen.length > 0,
  `${onScreen.length}/${apiQ.length} 条命中`);

console.log('\n  出题历史（服务端）：');
for (const q of apiQ) console.log(`    · ${q}`);
console.log('\n  页面上真的看得到的：');
for (const q of onScreen) console.log(`    · ${q}`);

check('没有单字残渣题', !apiQ.some(q => q.length < 2),
  apiQ.filter(q => q.length < 2).join(',') || '无');
check('题目都不是半句话（>=6 字）', apiQ.every(q => q.length >= 6),
  apiQ.filter(q => q.length < 6).join(',') || '无');
check('全程无 JS 异常', jsErrors.length === 0, jsErrors[0] || '');
check('全程无 console.error', consoleErrs.length === 0, consoleErrs[0] || '');

/* ── 两种宽度下有没有元素重叠/溢出 ─────────────────────────────────────
   文档里写了「桌面 / 手机两种宽度下没有元素重叠」，但原本没有可复跑的脚本。

   ⚠ 怎么写才对：一开始我用的是「两个区块的矩形相交就算重叠」，结果手机宽度下
   稳定报一个假的 SECTION ↔ DIV 重叠（19px）。查下去发现那不是重叠——
   `aside.side` 是 `overflow-y:auto` 的滚动容器，最后一行按钮超出 section 的高度
   正是它该滚动的部分，scrollIntoView 之后按钮完全可见、elementFromPoint 也命中的是
   按钮自己。矩形相交 ≠ 视觉重叠。

   所以这里改成两条真正说明问题的断言：
     (1) 横向不溢出（scrollWidth 不超过视口）；
     (2) 每个关键区块的中心点，elementFromPoint 命中的是它自己或它的后代
         —— 这才叫「没被别的东西盖住」；
     (3) 区块里每个按钮都够得着：滚进视野后完整可见且能命中。
*/
console.log('\n═══ 桌面 / 手机两种宽度 ═══');

const layoutProbe = `(() => {
  const vw = window.innerWidth;

  // (1) 横向溢出
  const overflowX = document.documentElement.scrollWidth - vw;

  // (2) 遮挡：区块中心点被谁接住了
  const blocks = [...document.querySelectorAll('header, aside > section, aside, footer')]
    .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const covered = [];
  for (const el of blocks) {
    const r = el.getBoundingClientRect();
    // 只测落在视口内的部分，否则 elementFromPoint 会返回 null
    const cx = Math.min(Math.max(r.left + r.width / 2, 1), vw - 1);
    const cy = Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1);
    if (r.bottom < 0 || r.top > window.innerHeight) continue;   // 滚出视野的跳过
    const hit = document.elementFromPoint(cx, cy);
    if (hit && !(el === hit || el.contains(hit))) {
      covered.push((el.id ? '#' + el.id : el.tagName.toLowerCase())
        + ' 被 ' + (hit.id ? '#' + hit.id : hit.tagName.toLowerCase()) + ' 盖住');
    }
  }

  // (3) 按钮可达性：滚进视野后完整可见 + 命中自己
  const unreachable = [];
  for (const btn of document.querySelectorAll('button')) {
    const r0 = btn.getBoundingClientRect();
    if (r0.width === 0 || r0.height === 0) continue;          // 隐藏的（如禁用的设置面板）
    btn.scrollIntoView({ block: 'center' });
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const visible = r.top >= 0 && r.bottom <= window.innerHeight + 1;
    if (!visible || !(hit === btn || (hit && btn.contains(hit)))) {
      unreachable.push((btn.id ? '#' + btn.id : btn.textContent.trim().slice(0, 8))
        + (visible ? ' 被遮挡' : ' 滚了也不可见'));
    }
  }
  window.scrollTo(0, 0);
  return { vw, overflowX, covered, unreachable, nBlocks: blocks.length,
           nButtons: document.querySelectorAll('button').length };
})()`;

for (const [label, w, h] of [['桌面 1440', 1440, 900], ['手机 390', 390, 844], ['手机 360×640', 360, 640]]) {
  await send('Emulation.setDeviceMetricsOverride',
    { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 }, sessionId);
  await sleep(900);
  const L = await evalJs(layoutProbe);
  check(`${label}：无横向溢出`, L.overflowX <= 2, `overflowX=${L.overflowX}px`);
  check(`${label}：区块没被遮挡`, L.covered.length === 0,
    L.covered.slice(0, 2).join('; ') || `${L.nBlocks} 个区块中心点都命中自己`);
  check(`${label}：按钮都够得着`, L.unreachable.length === 0,
    L.unreachable.slice(0, 2).join('; ') || `${L.nButtons} 个按钮可达`);
}
await send('Emulation.clearDeviceMetricsOverride', {}, sessionId);

/* ══ 麦克风：真浏览器 + 假麦克风设备 ══════════════════════════════════
   这一段是整个「接语音」改动里最容易自欺的地方：
   服务端的 ASR 链路可以用 WAV 文件单独验证（.run/probe_asr_e2e.mjs），
   但那验证不了浏览器侧——AudioContext 能不能起来、降采样对不对、
   PCM 有没有真的发出去、按钮状态跟不跟得上。

   Chrome 的 --use-file-for-fake-audio-capture 能把一个 WAV 当成麦克风
   输入，于是整条「浏览器采集 → 转码 → 上传 → 识别 → 出题」可以真跑。
   这个开关只在带这个参数启动的浏览器里有效，所以本脚本单独用一个
   Chrome 进程跑这一段。                                              */
console.log('\n═══ 麦克风（假麦克风设备喂一段语音）═══');

const MIC_WAV = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tts_test.wav');
if (!fs.existsSync(MIC_WAV)) {
  check('找得到测试语音 tts_test.wav', false, '先生成：见文档「语音」一节的 ffmpeg / SAPI 命令');
} else {
  const PORT2 = 9334;
  const profile2 = fs.mkdtempSync(path.join(os.tmpdir(), 'uimic-'));
  const chrome2 = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT2}`,
    `--user-data-dir=${profile2}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--window-size=1440,900',
    // 假麦克风：把 WAV 当输入。不 loop，放完就静音。
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${MIC_WAV}%noloop`,
    // 无头 Chrome 默认拒绝麦克风权限，要显式放行这一个源
    '--unsafely-treat-insecure-origin-as-secure=http://127.0.0.1:8900',
    'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl2 = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT2}/json/version`);
      wsUrl2 = (await r.json()).webSocketDebuggerUrl;
      if (wsUrl2) break;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }

  if (!wsUrl2) {
    check('第二个 Chrome（假麦克风）能起来', false);
    chrome2.kill();
  } else {
    const ws2 = new WebSocket(wsUrl2);
    await new Promise((res, rej) => { ws2.onopen = res; ws2.onerror = rej; });
    let id2 = 0;
    const pending2 = new Map();
    const jsErr2 = [];
    ws2.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending2.has(m.id)) { pending2.get(m.id)(m); pending2.delete(m.id); }
      else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        jsErr2.push(d.exception?.description || d.text);
      }
    };
    const send2 = (method, params = {}, sid) => new Promise((res) => {
      const myId = ++id2;
      pending2.set(myId, res);
      ws2.send(JSON.stringify({ id: myId, method, params, ...(sid ? { sessionId: sid } : {}) }));
    });
    const { result: { targetId: t2 } } = await send2('Target.createTarget', { url: 'about:blank' });
    const { result: { sessionId: s2 } } = await send2('Target.attachToTarget', { targetId: t2, flatten: true });
    await send2('Runtime.enable', {}, s2);
    await send2('Page.enable', {}, s2);
    // 麦克风权限：不给的话 getUserMedia 直接抛 NotAllowedError
    await send2('Browser.grantPermissions', {
      origin: APP,
      permissions: ['audioCapture'],
    });
    const eval2 = async (expr) => {
      const r = await send2('Runtime.evaluate',
        { expression: expr, awaitPromise: true, returnByValue: true }, s2);
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval 失败');
      return r.result?.result?.value;
    };

    const MIC_SESSION = 'uimic_' + Date.now();
    await send2('Page.navigate', { url: `${APP}/?s=${MIC_SESSION}` }, s2);
    await sleep(1500);

    // 这一场也要有材料，否则出题没有依据（但出不出题不是这段的重点）
    await eval2(`(async () => {
      await fetch('/api/materials', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ session: ${JSON.stringify(MIC_SESSION)}, materials: '候选人：我用 LangGraph 把 Agent 建模成状态机。' }) });
      return true;
    })()`);

    check('麦克风区域默认可见', await eval2(
      'document.getElementById("micSec").style.display !== "none"'));

    // 点「开始说话」
    const started = await eval2(`(async () => {
      document.getElementById('btnMic').click();
      // 采集链路是异步的（要 getUserMedia + 起 AudioContext），等它落定
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 250));
        if (document.getElementById('btnMic').textContent.includes('正在说话')) break;
      }
      return {
        label: document.getElementById('btnMic').textContent,
        cls: document.getElementById('btnMic').className
      };
    })()`);
    check('点「开始说话」后按钮变成正在说话', /正在说话/.test(started.label), started.label);
    check('按钮有记录中的样式', /on/.test(started.cls), started.cls);

    // 服务端那一路要真的开起来
    await sleep(1200);
    const live = await fetch(`${APP}/api/state?s=${MIC_SESSION}`).then(r => r.json());
    check('服务端那一路识别已开', live.asr && live.asr.candidate === 'listening', JSON.stringify(live.asr));

    // 等 WAV 放完、识别出字
    let micText = '';
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const s = await fetch(`${APP}/api/state?s=${MIC_SESSION}`).then(r => r.json());
      const got = (s.transcript || []).filter(l => l.role === 'candidate').map(l => l.text).join('');
      if (got.length >= 6) { micText = got; break; }
    }
    check('浏览器采到的声音被识别成了文字', micText.length > 0,
      micText ? `「${micText.slice(0, 40)}」` : '一句都没识别出来');
    check('识别出来的内容像是那段话', /LangGraph|状态机|语言|模型/i.test(micText), micText.slice(0, 40));

    // 点「停止」
    const stopped = await eval2(`(async () => {
      document.getElementById('btnMic').click();
      await new Promise(r => setTimeout(r, 1200));
      return { label: document.getElementById('btnMic').textContent };
    })()`);
    check('再点一下能停下来', /开始说话/.test(stopped.label), stopped.label);

    await sleep(900);
    const after = await fetch(`${APP}/api/state?s=${MIC_SESSION}`).then(r => r.json());
    check('停下来之后服务端那一路也关了', after.asr && after.asr.candidate === 'off',
      JSON.stringify(after.asr));

    // 角色切换
    const roleNow = await eval2(`(() => {
      document.getElementById('btnRole').click();
      return { who: document.getElementById('micWho').textContent,
               ls: localStorage.getItem('micRole') };
    })()`);
    check('能切成面试官', /面试官/.test(roleNow.who), roleNow.who);
    check('角色记在本地（刷新不丢）', roleNow.ls === 'interviewer', String(roleNow.ls));

    check('麦克风这段没有 JS 异常', jsErr2.length === 0, jsErr2[0] || '');

    // 清掉这一场，别在库里留垃圾。
    // 光删内存会话不够 —— 材料库和「历史面试」读的是 SQLite，
    // 得再走一遍 /api/sessions/delete 才真把这行删掉。
    await fetch(`${APP}/api/reset?s=${MIC_SESSION}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: MIC_SESSION }),
    }).catch(() => {});
    await fetch(`${APP}/api/sessions/delete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: MIC_SESSION }),
    }).catch(() => {});

    ws2.close();
    chrome2.kill();
  }
}

/* ══ 持久化界面：材料库 + 历史面试 ══════════════════════════════════════
   这两块是新加的，之前没有任何检查盯着。
   检查的不是「按钮存在」，而是「点下去真的出现数据」——按钮存在但接口
   404 的话，用户看到的是永远转圈的「加载中…」，比没有按钮更糟。        */
console.log('\n═══ 材料库 / 历史面试 ═══');

await evalJs('document.getElementById("btnMatLib").click()');
await sleep(700);
const lib = await evalJs(`(() => {
  const el = document.getElementById('matLib');
  const items = el.querySelectorAll('.lib-item');
  const empty = el.querySelector('.lib-empty');
  return {
    open: el.style.display !== 'none',
    n: items.length,
    empty: empty ? empty.textContent : '',
    first: items.length ? items[0].querySelector('.nm').textContent : '',
    chars: items.length ? items[0].querySelector('.ch').textContent : ''
  };
})()`);
check('材料库能展开', lib.open);
check('材料库里有存过的材料', lib.n > 0, `空态 "${lib.empty}"` || `${lib.n} 份`);
check('材料名不是空的', !!(lib.first && lib.first.trim()), lib.first);
check('材料带字数', /\d+\s*字/.test(lib.chars || ''), lib.chars);

// 点一下装载：文本框要被填满、字数要显示出来
await evalJs(`(() => {
  const it = document.querySelector('#matLib .lib-item .nm');
  if (it) it.click();
})()`);
await sleep(900);
const used = await evalJs(`({
  chars: document.getElementById('matStat').textContent,
  textLen: document.getElementById('materials').value.length,
  closed: document.getElementById('matLib').style.display === 'none'
})`);
check('点材料能装载进文本框', used.textLen > 0, `textarea ${used.textLen} 字`);
check('装载后字数对得上', /\d+\s*字/.test(used.chars), used.chars);
check('装载后材料库自动收起', used.closed);

await evalJs('document.getElementById("btnHist").click()');
await sleep(800);
const hist = await evalJs(`(() => {
  const w = document.getElementById('histWrap');
  const items = w.querySelectorAll('.hist-item');
  return {
    open: w.style.display !== 'none',
    n: items.length,
    stat: document.getElementById('histStat').textContent,
    empty: (w.querySelector('.lib-empty') || {}).textContent || ''
  };
})()`);
check('历史面试弹层能打开', hist.open);
check('历史里有别的场次', hist.n > 0, hist.empty || `${hist.n} 场`);
check('底部统计有数字', /共\s*\d+\s*场/.test(hist.stat) || hist.n === 0, hist.stat);

// 展开一场：要真的列出题目，不是一直「载入中…」
await evalJs(`(() => { const it = document.querySelector('#histWrap .hist-item'); if (it) it.click(); })()`);
await sleep(900);
const expanded = await evalJs(`(() => {
  const qs = document.querySelector('#histWrap .hist-item .qs');
  if (!qs) return { none: true };
  return { text: qs.innerText, loading: /载入中/.test(qs.innerText),
           lines: qs.querySelectorAll('div').length };
})()`);
check('展开一场能看到题目列表', !expanded.none && !expanded.loading && expanded.lines > 0,
  expanded.none ? '没有场次' : (expanded.loading ? '还是载入中' : `${expanded.lines} 行`));

// 关掉弹层，别把后面的布局检查搅了
await evalJs('document.getElementById("btnHistClose").click()');
await sleep(300);
check('历史弹层能关掉', await evalJs('document.getElementById("histWrap").style.display === "none"'));

const failed = results.filter(r => !r.pass);
console.log('\n' + '─'.repeat(60));
console.log(`界面检查：${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) for (const f of failed) console.log(`  ✗ ${f.name} ${f.detail}`);
console.log('─'.repeat(60));

ws.close();
chrome.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
// 直接退：留着 ws 让事件循环自然结束会踩到 libuv 的
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"，把退出码盖掉。
process.exit(failed.length ? 1 : 0);

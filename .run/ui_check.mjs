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

/* ★ 首屏必须带 ?s=<房间> 进来，不能停在裸地址。
   裸地址现在是**大厅**——底下那个界面整个被 #lobby 盖着，后面所有
   「点某个按钮看结果」的检查都会在量一个被遮住的页面：
   elementFromPoint 命中的永远是 #lobby，提示条被判「被遮住」，
   题目被判「没渲染到页面上」，全都是假的。
   （房间里才会跑真正的界面，这也是用户实际的用法：从大厅点进一间。） */
const TEST_SESSION = 'uibase_' + Date.now();
await send('Page.navigate', { url: `${APP}/?s=${TEST_SESSION}` }, sessionId);
await sleep(1800);

/* 不再调 /api/reset 了：新 id 本来就是干净的一场，而 reset 会把这一场从
   内存里删掉——页面正连着它，删完 SSE 断开、后面的检查全在测一具尸体。 */

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

/* 保存成功之后必须有看得见的反馈。
   ★ 这条是补的，起因是用户报「手机端点保存文档没反应」。
     查下来功能一直是好的、请求 200、字数也更新了——问题在于反馈
     被渲染进了 #feed 里的一行 12px 小字，而手机上抽屉是 position:fixed
     盖住半屏，#feed 被压在下面还滚到了 2340px 处，那行字压根不在视口里。
     现在是挂在 body 上的浮层 #toast。 */
const toastInfo = await evalJs(`(() => {
  const t = document.getElementById('toast');
  if (!t) return { missing: true };
  const r = t.getBoundingClientRect();
  /* 层级得用 elementsFromPoint，而且必须临时把 pointer-events 打开：
     toast 故意设了 none（不许吃点击），而命中测试会跳过 none 的元素，
     不临时打开就只能测出假失败。 */
  const prev = t.style.pointerEvents;
  t.style.pointerEvents = 'auto';
  const stack = document.elementsFromPoint(r.left + r.width/2, r.top + r.height/2);
  t.style.pointerEvents = prev;
  return {
    text: t.textContent,
    parent: t.parentElement.id || t.parentElement.tagName,
    inView: r.top >= 0 && r.bottom <= innerHeight && r.width > 0,
    onTop: stack[0] === t,
    stack: stack.slice(0, 3).map(e => e.tagName + (e.id ? '#' + e.id : '')),
    opacity: getComputedStyle(t).opacity,
    pointer: getComputedStyle(t).pointerEvents
  };
})()`);
check('保存后弹出提示条', !toastInfo.missing && !!toastInfo.text && toastInfo.opacity !== '0',
  JSON.stringify(toastInfo.text));
check('提示条挂在 body 上（不会被抽屉或 feed 埋掉）', toastInfo.parent === 'BODY', toastInfo.parent);
check('提示条在视口里', toastInfo.inView, JSON.stringify(toastInfo));
check('提示条在最上层（没被遮住）', toastInfo.onTop, (toastInfo.stack || []).join(' > '));
check('提示条不吃点击', toastInfo.pointer === 'none', toastInfo.pointer);

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

/* ══ 手机端：准备区折叠 + 主路径按钮要在首屏内 ══════════════════════════
   这是修「手机上太丑而且不明确」的验证。修之前实测 360x640：
   侧栏从 371px 起、材料区独占 236px，「开始说话」被顶到 top=648，
   正好掉出 640 的屏幕外——而它是手机上最该先按的按钮。
   光看「按钮可达」（滚一下就能点到）是发现不了这个的：
   那 20 个按钮在布局段里全是绿的，但它们不在**首屏**。

   所以这里量的是三件布局段量不到的事：
     (1) 折叠把手在手机上看得见、桌面上看不见；
     (2) 默认收起状态下，「开始说话」和「下一个问题」都在首屏内（不用滚）；
     (3) 展开之后材料框真的出现了。
*/
console.log('\n═══ 手机端：准备区折叠 ═══');
/* ⚠️ 先把回放段收回去。
   前面测回放时点过「模拟回放」，那个动作会把 #micSec 隐藏（两者互斥）。
   不收回去的话，这一段量到的是「麦克风被回放顶掉了」，
   而不是折叠逻辑本身——第一版就栽在这里，报了个假失败。 */
await evalJs(`(() => {
  const rs = document.getElementById('replaySec');
  if (rs && rs.style.display !== 'none') document.getElementById('btnReplayClose').click();
})()`);
await sleep(400);
await send('Emulation.setDeviceMetricsOverride',
  { width: 360, height: 640, deviceScaleFactor: 1, mobile: true }, sessionId);
await sleep(900);

const foldState = await evalJs(`(() => {
  const t = document.getElementById('btnSideToggle');
  const style = getComputedStyle(t);
  const r = el => { const b = el.getBoundingClientRect(); return {top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height)}; };
  return {
    toggleShown: style.display !== 'none',
    toggleRect: r(t),
    prepOpen: t.parentElement.classList.contains('prep-open'),
    sectionsVisible: [...document.querySelectorAll('.side > section')]
      .filter(s => getComputedStyle(s).display !== 'none').map(s => s.id || '(材料)'),
    micRect: r(document.getElementById('btnMic')),
    nextqRect: r(document.getElementById('nextq')),
    innerH: window.innerHeight,
    matDisplay: getComputedStyle(document.querySelector('.side > section')).display,
  };
})()`);
check('手机上折叠把手可见', foldState.toggleShown, `高 ${foldState.toggleRect.h}px`);
check('默认是收起的', foldState.prepOpen === false);
check('收起时材料框不显示', foldState.matDisplay === 'none', foldState.matDisplay);
check('收起时「说话」区还露着', foldState.sectionsVisible.includes('micSec'),
  foldState.sectionsVisible.join(',') || '(一个都没有)');
check('「开始说话」在首屏内',
  foldState.micRect.top >= 0 && foldState.micRect.bottom <= foldState.innerH,
  `top=${foldState.micRect.top} bottom=${foldState.micRect.bottom} / 视口 ${foldState.innerH}`);
check('「下一个问题」在首屏内',
  foldState.nextqRect.top >= 0 && foldState.nextqRect.top < foldState.innerH,
  `top=${foldState.nextqRect.top}`);
/* 手机上「下一个问题」必须在整个准备区**前面**：
   面试进行中该一直盯的是题，材料和设置是准备动作。
   这一条对应 CSS 里的 .stream{order:1} / .side{order:2}，
   把顺序写在断言里，以后谁调 CSS 调反了会立刻红。 */
check('手机上题目面板在准备区上面',
  foldState.nextqRect.top < foldState.micRect.top,
  `nextq ${foldState.nextqRect.top} / mic ${foldState.micRect.top}`);

await evalJs('document.getElementById("btnSideToggle").click()');
await sleep(600);
const openState = await evalJs(`(() => {
  const t = document.getElementById('btnSideToggle');
  const sec = document.querySelector('.side > section');
  return {
    prepOpen: t.parentElement.classList.contains('prep-open'),
    matDisplay: getComputedStyle(sec).display,
    label: document.getElementById('sideToggleLabel').textContent,
  };
})()`);
check('点把手能展开', openState.prepOpen === true, openState.label);

/* 动作块那个圆块的字形要在两态之间真的换。
   ⚠️ 字形是 CSS 的 ::before content（见 index.html 的 .st-x i::before），
   **不在 textContent 里** —— 读 textContent 永远是空串，会让这条断言变成
   恒真的假测试。第一版就写错过一次，量出来的「展开后是 ✕」其实是图标那个 span。 */
const glyph = await evalJs(`(() => {
  const g = s => getComputedStyle(document.querySelector('#sideToggleArrow i'), '::before').content || '';
  const strip = s => s.replace(/^["']|["']$/g, '');
  const open = strip(g());
  return { open, label: document.getElementById('sideToggleLabel').textContent };
})()`);
check('展开后动作块是 ✕（不是还写着 ▴）', glyph.open === '✕', `实际「${glyph.open}」`);
check('展开后主标题变成「收起准备区」', /收起/.test(glyph.label), glyph.label);
check('展开后材料框出现', openState.matDisplay !== 'none', openState.matDisplay);
await evalJs('document.getElementById("btnSideToggle").click()');
await sleep(500);
check('再点一次能收起',
  await evalJs('!document.getElementById("btnSideToggle").parentElement.classList.contains("prep-open")'));
check('收起后动作块回到 ▴',
  (await evalJs(`(getComputedStyle(document.querySelector('#sideToggleArrow i'),'::before').content||'').replace(/^["']|["']$/g,'')`)) === '▴');
check('收起后副标题报材料字数（收起时看不见输入框，这是唯一线索）',
  /材料 \d+ 字/.test(await evalJs('document.getElementById("sideToggleHint").textContent')),
  await evalJs('document.getElementById("sideToggleHint").textContent'));

await send('Emulation.setDeviceMetricsOverride',
  { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
await sleep(700);
check('桌面上折叠把手不出现',
  await evalJs('getComputedStyle(document.getElementById("btnSideToggle")).display === "none"'));
check('桌面上侧栏常开（材料框一直看得见）',
  await evalJs('getComputedStyle(document.querySelector(".side > section")).display !== "none"'));
await send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
await sleep(400);

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
/* 麦克风这一场要留到收尾一起删（TEST_SESSION / HIST_SESSION / RESET_PROBE
   都在模块顶层，收尾那段在同一个作用域里）。
   ★ 必须在这里就声明成 null，不能像以前那样在下面 else 块里 `const`——
   块级作用域的东西收尾时访问不到，会直接 ReferenceError 崩掉整个脚本，
   连前面 100 多项断言的结果都打不出来（真踩过）。 */
let MIC_SESSION = null;
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

    MIC_SESSION = 'uimic_' + Date.now();
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

    // 服务端那一条音轨要真的开起来。
    // 查的是 tracks 里有没有一条 candidate 且 listening——不是查
    // asr.candidate（那是单音轨时代的字段，已经没有了）。
    await sleep(1200);
    const live = await fetch(`${APP}/api/state?s=${MIC_SESSION}`).then(r => r.json());
    const candTrack = (live.tracks || []).find(t => t.role === 'candidate');
    check('服务端那条音轨已开', !!(candTrack && candTrack.listening),
      candTrack ? `track=${candTrack.track} label=${candTrack.label}` : `tracks=${JSON.stringify(live.tracks)}`);

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

    /* ═══ 「有时候灵有时候不灵」：音轨在服务端掉了，前端要自己接回来 ═══
       这是用户报的第三个问题。查到的主要暗路是：服务端那条音轨如果没了
       （被重置、被顶掉、WS 僵住），/api/asr/feed 会**静默**返回 accepted:0
       —— 它不报错，因为「点了停止之后还有半秒在途音频」是正常的。
       而前端以前从不看这个字段，于是一边按钮亮着「正在说话」、一边
       音频全被丢掉，用户看到的就是「有时候认得有时候一个字都不出」。

       测法：麦克风开着的时候，从外面把那条音轨掐掉（等价于服务端重启，
       或者另一台设备把它顶了），然后什么都不做，等前端自己发现并重连。 */
    const beforeRevive = await fetch(`${APP}/api/state?s=${MIC_SESSION}`).then(r => r.json());
    const trk = (beforeRevive.tracks || []).find(t => t.role === 'candidate');
    check('掉线测试前音轨是活的', !!(trk && trk.listening), JSON.stringify(trk || null));

    await fetch(`${APP}/api/asr/stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: MIC_SESSION, track: trk.track })
    });
    await sleep(600);
    const killed = await fetch(`${APP}/api/state?s=${MIC_SESSION}`).then(r => r.json());
    check('音轨已经被掐掉（模拟掉线）',
      !(killed.tracks || []).some(t => t.track === trk.track && t.listening),
      JSON.stringify(killed.tracks || []));

    // 什么都不做，等前端自己发现（轮询 2 秒一轮 + 连丢 6 次音频块）
    let revived = null;
    for (let i = 0; i < 30; i++) {
      await sleep(700);
      const s = await fetch(`${APP}/api/state?s=${MIC_SESSION}`).then(r => r.json());
      const t2 = (s.tracks || []).find(t => t.track === trk.track);
      if (t2 && t2.listening) { revived = t2; break; }
    }
    check('前端自己把音轨接回来了（没让人再点一次）', !!revived,
      revived ? JSON.stringify(revived) : '等了 21 秒还是没动静');

    // 接回来之后按钮必须还亮着，否则人会以为得重新点一次
    const stillOn = await eval2('document.getElementById("btnMic").textContent');
    check('接回来之后按钮仍然显示正在说话', /正在说话/.test(stillOn), stillOn);

    /* 而且音频要真的又能进去。
       ★ 这里不能等「识别出新句子」：假麦克风的 WAV 只有 7.5 秒，
         早就放完了，后面全是静音，静音当然识别不出字。
         看 bytes（服务端累计收到的音频字节）有没有继续涨就够了——
         它涨说明这条连接真的在收，而不是只是状态字段显示 listening。 */
    const b0 = ((await fetch(`${APP}/api/state?s=${MIC_SESSION}`).then(r => r.json()))
      .tracks || []).find(t => t.track === trk.track)?.bytes || 0;
    let bytesGrew = 0;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const s = await fetch(`${APP}/api/state?s=${MIC_SESSION}`).then(r => r.json());
      const b1 = (s.tracks || []).find(t => t.track === trk.track)?.bytes || 0;
      if (b1 > b0) { bytesGrew = b1 - b0; break; }
    }
    check('接回来之后音频真的又能送进去了', bytesGrew > 0,
      bytesGrew ? `又收进了 ${bytesGrew} 字节` : `bytes 还是 ${b0}，连接没真的活过来`);

    // 点「停止」
    const stopped = await eval2(`(async () => {
      document.getElementById('btnMic').click();
      await new Promise(r => setTimeout(r, 1200));
      return { label: document.getElementById('btnMic').textContent };
    })()`);
    check('再点一下能停下来', /开始说话/.test(stopped.label), stopped.label);

    await sleep(900);
    const after = await fetch(`${APP}/api/state?s=${MIC_SESSION}`).then(r => r.json());
    // 停了之后这条轨应该从表里消失（服务端 stopAsr 会 delete），
    // 或者还在但 listening=false。两种都算关掉了。
    const afterCand = (after.tracks || []).find(t => t.role === 'candidate');
    check('停下来之后服务端那条轨也关了', !afterCand || afterCand.listening === false,
      afterCand ? JSON.stringify(afterCand) : 'tracks 里已经没有了');

    // 角色切换
    const roleNow = await eval2(`(() => {
      document.getElementById('btnRole').click();
      return { who: document.getElementById('micWho').textContent,
               ls: localStorage.getItem('micRole') };
    })()`);
    check('能切成面试官', /面试官/.test(roleNow.who), roleNow.who);
    check('角色记在本地（刷新不丢）', roleNow.ls === 'interviewer', String(roleNow.ls));

    /* ═══ 多音轨：页面上看得见「还有谁在听」 ═══
       这一段验的是这次改造的核心承诺：
       一个候选人 + 两个面试官同时在场时，每个人的音轨要在**所有**设备的
       页面上都显示出来。以前只显示自己那一路，于是「另一个面试官已经在
       听了」这件事在屏幕上没有任何痕迹——两个人会同时开口，或者都以为
       对方没在听。 */
    console.log('\n═══ 多音轨：谁在听 ═══');

    /* 先把麦克风开回来。
       前面那一段已经点过「停止」了，服务端把候选人那条轨删掉了——
       所以此刻只有我自己没在听。不先开回来，这里就只剩两条面试官，
       「自己那条被标出来」也就无从谈起（断言恒等于假）。 */
    await eval2(`(async () => {
      if (!document.getElementById('btnMic').textContent.includes('正在说话')) {
        document.getElementById('btnMic').click();
        for (let i = 0; i < 40; i++) {
          await new Promise(r => setTimeout(r, 250));
          if (document.getElementById('btnMic').textContent.includes('正在说话')) break;
        }
      }
      return document.getElementById('btnMic').textContent;
    })()`);

    // 用 HTTP 直接开第二、第三个面试官（模拟另外两台设备）
    for (const [track, label] of [['iv_testA', '张工'], ['iv_testB', '李工']]) {
      await fetch(`${APP}/api/asr/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: MIC_SESSION, track, role: 'interviewer', label }),
      });
    }
    // 让页面轮询把音轨表捞一次（2 秒一轮，等够）
    await sleep(3000);

    const pills = await eval2(`(() => {
      const el = document.getElementById('trackList');
      return {
        has: !!el,
        n: el ? el.querySelectorAll('.tpill').length : 0,
        labels: Array.from(el ? el.querySelectorAll('.tpill b') : []).map(x => x.textContent),
        mine: el ? el.querySelectorAll('.tpill.mine').length : 0
      };
    })()`);
    check('页面上有音轨胶囊容器', pills.has);
    check('三个人的音轨都显示出来了', pills.n >= 3, `实际 ${pills.n} 个：${pills.labels.join('/')}`);
    check('两个面试官的名字都在', pills.labels.includes('张工') && pills.labels.includes('李工'),
      pills.labels.join('/'));
    check('自己那条被标出来了', pills.mine >= 1, `mine=${pills.mine}`);

    /* 换角色不该把麦克风断掉。
       以前这里是 stopMic() 再 startMic()，实测 2~3 秒空白，
       而那两三秒正好卡在「他刚说完一句、你要接话」的地方。
       现在只换标签，采集一秒都不断。

       ★ 两个坑（都是我的测试写错，不是产品 bug）：
         1. 不能无条件 click btnMic —— 上一段已经把麦克风开着了，
            再点一下是「停止」。必须先看按钮文案再决定点不点。
         2. `before` 不能在 stopMic 还没收尾时读。stopMic 是异步的：
            它同步地把 micRunning 置 false，但要 await 完 /api/asr/stop
            才调 syncMicUI()，中间那几百毫秒按钮还写着「正在说话」。
            照着旧文案断言，等于在测一个幻觉。 */
    const switched = await eval2(`(async () => {
      const btn = document.getElementById('btnMic');
      const sleepMs = ms => new Promise(r => setTimeout(r, ms));
      // 确保开着的（已开就不要碰，点一下反而是关）
      if (!btn.textContent.includes('正在说话')) {
        btn.click();
        for (let i = 0; i < 40; i++) {
          await sleepMs(250);
          if (btn.textContent.includes('正在说话')) break;
        }
      }
      // 等按钮状态彻底落定再记录
      for (let i = 0; i < 8; i++) {
        await sleepMs(200);
        if (btn.textContent.includes('正在说话')) break;
      }
      const before = btn.textContent;

      document.getElementById('btnRole').click();
      await sleepMs(1200);
      return {
        before,
        after: btn.textContent,
        who: document.getElementById('micWho').textContent,
        mine: (trackState.find(t => t.track === myTrack) || {}).role || null
      };
    })()`);
    check('换角色前麦克风确实是开着的', /正在说话/.test(switched.before), switched.before);
    check('换角色后麦克风还在开（没断）', /正在说话/.test(switched.after),
      `${switched.before} -> ${switched.after}`);
    check('换角色后身份跟着变', /面试者|候选人/.test(switched.who), switched.who);

    // 那个新开的面试官音轨这会儿应该还在（换角色不该顺手关掉别人的）
    const st2 = await fetch(`${APP}/api/state?s=${MIC_SESSION}`).then(r => r.json());
    const ivs = (st2.tracks || []).filter(t => t.label === '张工' || t.label === '李工');
    check('换角色没把别人的音轨关掉', ivs.length === 2, `还剩 ${ivs.length} 条`);

    // 收尾：把这些探针音轨关掉，别在服务端留一堆空连接白烧额度
    for (const t of (st2.tracks || [])) {
      await fetch(`${APP}/api/asr/stop`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: MIC_SESSION, track: t.track }),
      }).catch(() => {});
    }

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

/* 先造一场「两个人真的说过话」的场次。
   ------------------------------------------------------------------
   为什么必须自己造：这个检查要验证的是「面试官说的话也能被还原」，
   而它原来靠挑库里第一场有提问记录的数据。跑得越久越容易翻车——
   某次清理之后库里只剩候选人独白的场次，检查就红了，看起来像产品
   坏了，其实只是没有样本。（实际就红过一次：0 块面试官。）
   自己造样本还有个好处：内容固定，失败时能一眼看出是加载错了还是
   数据本来就不对。                                                     */
const HIST_SESSION = 'uihist_' + Date.now();
const HIST_Q = '那你这个状态是怎么持久化的？多副本会不会串台？';
const HIST_A = '状态存在 Redis 里，thread_id 带客户前缀。';

await fetch(`${APP}/api/materials`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ session: HIST_SESSION, materials: '历史样本材料：讲 Redis 和 LangGraph。' }),
});
// 候选人先说一段（走 feed，和真实链路同一个入口）
await fetch(`${APP}/api/feed`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ session: HIST_SESSION, text: HIST_A }),
});
// 面试官再问一句：这一步会把 interviewer 行写进对话流
await fetch(`${APP}/api/question`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ session: HIST_SESSION, question: HIST_Q }),
});
await sleep(400);

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

/* ── 「加载这场」：把整场面试还原到左边面板 ──
   这是用户提的「点击历史就加载历史」。要检查的不是按钮在不在，
   而是点下去对话面板里**真的出现了两个人的话**——包括语音识别出来的
   面试官提问和候选人回答。只加载题目不加载对话，等于没加载。 */
/* 判据不能用「变长了」。加载是把面板整个换成那一场的内容，
   比原来短是完全正常的（原来那场说得更多）。要判的是
   「面板里确实出现了那一场的内容」。 */
const beforeFeed = await evalJs(`document.getElementById('feed').innerText.length`);
await evalJs(`(() => {
  /* 挑一场**有提问记录**的场次点。
     原来直接点第一个，而列表按 updated_at 排，第一个往往刚好是刚才麦克风
     那段——那场只有建议、没有面试官提问，于是「对话里有面试官」必然挂。
     这不是产品 bug，是选错了样本。 */
  const items = [...document.querySelectorAll('#histWrap .hist-item')];
  const pick = items.find(it => /[1-9]\\d*\\s*次提问/.test(it.querySelector('.meta').textContent)) || items[0];
  const b = pick && pick.querySelector('button[data-act="load"]');
  if (b) b.click();
})()`);
await sleep(1600);
const loaded = await evalJs(`(() => {
  const f = document.getElementById('feed');
  const t = f.innerText;
  return {
    len: t.length,
    closed: document.getElementById('histWrap').style.display === 'none',
    hasWho: t.includes('面试官'),
    hasCand: f.querySelectorAll('.saidblock:not(.q):not(.sugg)').length,
    hasInterv: f.querySelectorAll('.saidblock.q').length,
    saysReadonly: /只读/.test(t),
    saysCount: /句对话/.test(t)
  };
})()`);
check('点「加载这场」能把历史还原到面板', loaded.len > 0 && loaded.saysReadonly, `${beforeFeed} → ${loaded.len} 字`);
check('还原后自动关掉弹层', loaded.closed);
check('还原出的对话里有面试官说的话', loaded.hasInterv > 0, `${loaded.hasInterv} 块`);
check('还原出的对话里有候选人的话', loaded.hasCand > 0, `${loaded.hasCand} 块`);
check('还原的是对话流不是光秃秃的题目', loaded.hasWho && loaded.hasCand && loaded.hasInterv);
check('明确标了这是只读回放', loaded.saysReadonly);
check('标了这场有多少句对话', loaded.saysCount);

// 关掉弹层，别把后面的布局检查搅了
await evalJs('document.getElementById("btnHistClose").click()');
await sleep(300);
check('历史弹层能关掉', await evalJs('document.getElementById("histWrap").style.display === "none"'));

/* ══ 开新的一场：从界面点进去走完整条路 ══════════════════════════════
   这条链路最容易错的地方全在浏览器这一侧，服务端反而是简单的：
     · 点「开新的一场」要弹出命名框，且预填一个能用的默认名字
     · 确认之后 SESSION 要换掉、地址栏要跟着换
     · ★ EventSource 必须重连。不重连的话它还钉在旧场上，
       页面上一题不出、而服务端的 chunks 数在涨——这个坑非常难猜。
     · 面板要清空（新的一场不该还挂着上一场的题）
     · 旧场要带着名字出现在历史里，而且内容一句不少
   所以这一段必须用真浏览器跑，光测端点（.run/probe_newsession.mjs）
   测不到上面任何一条。 */
console.log('\n═══ 开新的一场（界面）═══');

/* ⚠️ 先跳到一场专门给这段用的空场次上。
   不这么做的话，「开新的一场」会把**用户当前那场**（通常是 default）
   改成探针名字，等于在人家库上动手。测自己的副作用要隔离。 */
const RESET_PROBE = 'uireset_' + Date.now();
await send('Page.navigate', { url: `${APP}/?s=${RESET_PROBE}` }, sessionId);
await sleep(2200);

/* 先往这一场里塞点内容，否则「旧场内容没丢」这条测的是"0 道题还在不在"，
   恒等于真——第一版就是这么写的，报了个假的失败（其实那场本来就是空的）。
   塞内容用接口最快，而且走的是和界面同一条路（addTurn + addLine）。 */
await fetch(`${APP}/api/materials`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ session: RESET_PROBE, materials: '探针材料：个税 App，用 Redis 预减库存。', name: '探针材料' }),
}).catch(() => {});
await fetch(`${APP}/api/question`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ session: RESET_PROBE, question: '这一场是有内容的，重置之后它应该还在' }),
}).catch(() => {});
await sleep(900);

const beforeReset = await evalJs(`(() => ({
  session: new URL(location.href).searchParams.get('s'),
  hasQs: document.getElementById('feed').innerText.length,
}))()`);

// 点「开新的一场」→ 弹层应该出现，并且预填了默认名字
await evalJs('document.getElementById("btnReset").click()');
await sleep(500);
const modalState = await evalJs(`(() => {
  const w = document.getElementById('newWrap');
  const t = document.getElementById('newTitle');
  return {
    shown: getComputedStyle(w).display !== 'none',
    prefill: t.value,
    focused: document.activeElement === t,
  };
})()`);
check('点「开新的一场」弹出命名框', modalState.shown);
check('命名框预填了默认名字', !!modalState.prefill, modalState.prefill);

const NEW_TITLE = '探针场次 ' + new Date().toISOString().slice(11, 19);
await setVal('#newTitle', NEW_TITLE);
await sleep(200);
await evalJs('document.getElementById("btnNewGo").click()');
await sleep(2500);

const afterReset = await evalJs(`(() => {
  const u = new URL(location.href);
  return {
    session: u.searchParams.get('s'),
    modalHidden: getComputedStyle(document.getElementById('newWrap')).display === 'none',
    feedEmpty: !document.getElementById('feed').innerText.includes('QPS') || document.getElementById('feed').innerText.length < 200,
    nqText: document.getElementById('nqQ').textContent,
    connText: document.getElementById('connPill').textContent,
  };
})()`);
check('换场后地址栏带上了新 id',
  !!afterReset.session && afterReset.session !== beforeReset.session,
  `${beforeReset.session} → ${afterReset.session}`);
check('命名框自动关掉', afterReset.modalHidden);
check('面板被清空（新的一场是干净的）', afterReset.feedEmpty,
  `feed ${await evalJs('document.getElementById("feed").innerText.length')} 字`);
check('面板回到等待态', /等他说完|题目就会跟着来|开始了/.test(afterReset.nqText),
  afterReset.nqText.slice(0, 30));

/* ★ SSE 真的重连到新场了吗？
   判据：从页面内部去读它连的是哪个 URL——不行，EventSource 不暴露 url
   （其实是暴露的，但重连后的实例才是我们要的）。
   更实在的判据是行为：往新场灌一段话，它必须能出新题。
   SSE 还钉在旧场的话，服务端出了题页面也收不到（这正是要防的那个 bug）。 */
console.log('  往新场灌一段话，验证新场真的活着…');
await setVal('#replayText', '我用 Redis 做预减库存，然后发消息到 Kafka，下游异步落库。消息发失败就重试三次，进死信队列。');
await sleep(300);
await evalJs('document.getElementById("btnReplayOpen").click()');
await sleep(300);
await evalJs('document.getElementById("btnReplay").click()');

let newQs = [];
for (let i = 0; i < 60; i++) {
  await sleep(500);
  const api = await (await fetch(`${APP}/api/state?s=${afterReset.session}`)).json();
  newQs = (api.history || []).map(h => h.question).filter(Boolean);
  if (newQs.length >= 1) break;
}
await sleep(1200);
const newBody = await evalJs('document.body.innerText');
check('新场真的能出题（SSE 重连成功）', newQs.length > 0, `${newQs.length} 道`);
check('新题出现在新场的页面上', newQs.some(q => newBody.includes(q.slice(0, 6))),
  newQs.slice(0, 1).join(''));
if (newQs.length) console.log(`    新场第一题：${newQs[0]}`);

// 旧场必须带着名字、且内容完整地留在历史里
await evalJs('document.getElementById("btnHist").click()');
await sleep(1400);
const histAfter = await evalJs(`(() => {
  const items = [...document.querySelectorAll('#histWrap .hist-item')];
  return items.map(it => ({
    ttl: it.querySelector('.ttl').textContent,
    meta: it.querySelector('.meta').textContent,
  }));
})()`);
const renamed = histAfter.find(h => h.ttl === NEW_TITLE);
check('旧场带着新名字留在历史里', !!renamed,
  histAfter.map(h => h.ttl).slice(0, 4).join(' | '));
check('旧场的内容没丢', !!renamed && /[1-9]\d*\s*句对话/.test(renamed.meta),
  renamed ? renamed.meta : '(没找到)');

/* 起名 / 删除按钮真的能用吗？
   只验证接口存在是不够的——它们挂在动态生成的 .hist-item 里，
   用事件委托时最容易漏的就是 dataset.act 的拼写和冒泡。 */
const hasRename = await evalJs(
  '!!document.querySelector("#histWrap .hist-item button[data-act=\\"rename\\"]")');
const hasDel = await evalJs(
  '!!document.querySelector("#histWrap .hist-item button[data-act=\\"del\\"]")');
check('历史项上有「起名」按钮', hasRename);
check('历史项上有「删除」按钮', hasDel);
await evalJs('document.getElementById("btnHistClose").click()');
await sleep(300);

/* 收尾：把本段造出来的场次从库里删掉，别在用户的历史里越积越多。
   要删的是**这个脚本自己造的每一场**：
     TEST_SESSION（首屏那场，出过题、落过对话）
     MIC_SESSION（假麦克风那场，进程中间已单独删过，这里再删一次无妨）
     HIST_SESSION（材料库那段造的）
     RESET_PROBE（开新一场那段造的）
     afterReset.session（从界面点出来的新房）
   ★ 以前漏了 TEST_SESSION，于是每跑一次 ui_check 大厅里就多一间
   「uibase_1792295239631」这种 id 当名字的房间——大厅只取前 24 条，
   垃圾够多时用户真实的房间会被挤掉，看起来像数据丢了（真发生过）。 */
for (const sid of [TEST_SESSION, MIC_SESSION, HIST_SESSION, RESET_PROBE, afterReset.session].filter(Boolean)) {
  await fetch(`${APP}/api/sessions/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: sid }),
  }).catch(() => {});
}

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

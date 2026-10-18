/* ══ 两台设备同时用：真的跑一次，不是靠推测 ═════════════════════════════
   文档里一直有一条「没验证」：两个人各拿一台手机、各说各的话，两边的字
   能不能同时进到对方的屏幕上。以前只在同一台机器上开两个标签页模拟过，
   而那不算数——同一个浏览器进程共享 AudioContext 和权限，很多时序问题
   根本不会暴露。

   这个脚本起**两个独立的 Chrome 进程**，各自带一个假麦克风 WAV：
     A 设备 → 角色「面试者」，麦克风放 tts_test.wav（候选人在讲项目）
     B 设备 → 角色「面试官」，麦克风放 tts_q.wav（面试官在提问）
   两个进程互相不知道对方存在，唯一的联系是同一个服务端的同一个 session——
   和两台真手机的关系完全一样（只是省掉了网络那一段）。

   要验证的是四件事，少一件这个场景就不成立：
     1. B 说的话出现在 A 的屏幕上（面试官提问，候选人要看到）
     2. A 说的话出现在 B 的屏幕上（候选人回答，面试官要看到）
     3. A 屏幕上自动填进输入框的是 B 刚说的那句（省掉手打）
     4. 服务端两条音轨各自独立（asr.candidate / asr.interviewer 同时在听）

   跑法：先 node server.mjs，再 node .run/ui_check_twodevice.mjs
   ═══════════════════════════════════════════════════════════════════ */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = 'http://127.0.0.1:8900';
const SESSION = `twodev_${Date.now()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = [
  path.join(os.homedir(), '.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
].find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!CHROME) { console.error('找不到 chrome.exe'); process.exit(2); }

const WAV_CAND = path.join(HERE, 'tts_test.wav');
const WAV_INTERV = path.join(HERE, 'tts_q.wav');

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`); }
}

/* 一个设备 = 一个 Chrome 进程 + 一条 CDP 连接。
   两个设备各跑一份，除了端口、profile、WAV、角色之外完全对称——
   这样才验得出「谁说的」是靠角色区分的，不是靠谁先连上。 */
async function launch(name, port, wav, asRole) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `twodev-${name}-`));
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--window-size=1100,900',
    // 假麦克风：把这个 WAV 当成输入设备。%noloop 放完就静音，不循环。
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}%noloop`,
    // 无头 Chrome 把 127.0.0.1 之外都当不安全源，麦克风直接拒。
    // 这里显式信任本机地址，免得 getUserMedia 抛 NotAllowedError。
    `--unsafely-treat-insecure-origin-as-secure=${APP}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      wsUrl = (await r.json()).webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  if (!wsUrl) { proc.kill(); throw new Error(`${name}: CDP 没起来`); }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const jsErr = [];
  const consoleErr = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      jsErr.push(d.exception?.description || d.text);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErr.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  };
  const send = (method, params = {}, sid) => new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params, ...(sid ? { sessionId: sid } : {}) }));
  });

  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId: sid } } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sid);
  await send('Page.enable', {}, sid);

  // 不授权的话 getUserMedia 直接抛 NotAllowedError，而报错信息长得像代码 bug
  await send('Browser.grantPermissions', { origin: APP, permissions: ['audioCapture'] });

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate',
      { expression: expr, awaitPromise: true, returnByValue: true }, sid);
    const ex = r.result?.exceptionDetails;
    if (ex) throw new Error(ex.exception?.description || ex.text || 'eval 失败');
    return r.result?.result?.value;
  };

  await send('Page.navigate', { url: `${APP}/?s=${encodeURIComponent(SESSION)}` }, sid);
  await sleep(1800);

  // 角色：靠点按钮切，和真人操作一致。切完会写进 localStorage。
  if (asRole === 'interviewer') {
    await evalJs(`document.getElementById('btnRole').click()`);
    await sleep(400);
  }

  return { name, wav, asRole, ws, send, evalJs, jsErr, consoleErr, proc, sid };
}

async function closeDevice(d) {
  try { d.ws.close(); } catch { /* 已经断了 */ }
  try { d.proc.kill(); } catch { /* 已经退了 */ }
}

if (!fs.existsSync(WAV_CAND) || !fs.existsSync(WAV_INTERV)) {
  console.error('缺测试语音。先跑 .run/make_tts.ps1 生成 tts_test.wav 与 tts_q.wav');
  process.exit(2);
}

// 先把 session 清干净。不清的话上一轮的对话会混进来，断言就看不出「这一轮说的」。
await fetch(`${APP}/api/reset`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ session: SESSION }),
});

console.log(`\n=== 两台设备 · session ${SESSION} ===`);
const A = await launch('A-candidate', 9341, WAV_CAND, 'candidate');
const B = await launch('B-interviewer', 9342, WAV_INTERV, 'interviewer');

try {
  console.log('\n═══ 角色与初始状态 ═══');
  const roleA = await A.evalJs(`document.getElementById('micWho').textContent`);
  const roleB = await B.evalJs(`document.getElementById('micWho').textContent`);
  check('A 设备自报是面试者', /面试者/.test(roleA || ''), roleA);
  check('B 设备自报是面试官', /面试官/.test(roleB || ''), roleB);

  console.log('\n═══ 两边同时开麦 ═══');
  // 几乎同时点：真实场景就是两个人同时说话。先开 B 一点点，
  // 好让「面试官先开口、候选人后答」这个自然顺序成立。
  await B.evalJs(`document.getElementById('btnMic').click()`);
  await sleep(700);
  await A.evalJs(`document.getElementById('btnMic').click()`);

  // 等音频放完 + ASR 定稿（服务端 max_sentence_silence 默认 1300ms）
  // + 面试官那一路的 800ms 防抖 + 出题延迟。给到 40 秒。
  /* 两条音轨同时在听，是这个场景的前提，不是附带现象：
     如果服务端只能同时开一路，那两个人就永远没法一起说话。
     必须轮询等一下——点按钮之后 /api/asr/start 是异步的，
     紧接着就读 state 会读到 off，那不是没开，是还没开完。 */
  let bothOn = false;
  for (let i = 0; i < 20; i++) {
    const st = await (await fetch(`${APP}/api/state?s=${SESSION}`)).json();
    if (st.asr?.candidate === 'listening' && st.asr?.interviewer === 'listening') {
      bothOn = true; break;
    }
    await sleep(300);
  }
  check('两条音轨能同时在听（不然两个人没法一起说话）', bothOn);

  console.log('\n═══ 等两边的话互相到达（最多 45 秒）═══');
  let snap = null;
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    snap = await (await fetch(`${APP}/api/state?s=${SESSION}`)).json();
    const roles = new Set((snap.transcript || []).map((l) => l.role));
    if (roles.has('candidate') && roles.has('interviewer')) break;
  }

  const lines = snap.transcript || [];
  const cand = lines.filter((l) => l.role === 'candidate');
  const interv = lines.filter((l) => l.role === 'interviewer');
  console.log(`  服务端对话流: ${lines.length} 句（候选人 ${cand.length} / 面试官 ${interv.length}）`);
  for (const l of lines) console.log(`    [${l.role}] ${l.text.slice(0, 46)}`);

  check('两条音轨都在服务端留下了字', cand.length > 0 && interv.length > 0,
    `候选 ${cand.length} / 面试官 ${interv.length}`);

  console.log('\n═══ 各自屏幕上看到了对方的话 ═══');
  // A 是候选人，他要看到面试官的问题
  const aFeed = await A.evalJs(`document.getElementById('feed').innerText`);
  // B 是面试官，他要看到候选人的回答
  const bFeed = await B.evalJs(`document.getElementById('feed').innerText`);

  const intervText = interv.map((l) => l.text).join('');
  const candText = cand.map((l) => l.text).join('');
  /* 用前 8 个字做判据：ASR 定稿可能和最终文本有一个字的出入，
     整句严格相等会因为一个标点就误判。
     ★ 两边都要去空白。界面上的文本会被切块拼出来，块与块之间、
       中英文之间可能夹着空格或换行；只把干草堆去空白、针不去（或者反过来）
       就会因为一个空格判失败——我第一次就是这么假红了一次。 */
  const flat = (s) => String(s || '').replace(/\s/g, '');
  const head = (s, n = 8) => flat(s).slice(0, n);
  const aFlat = flat(aFeed), bFlat = flat(bFeed);
  check('面试官说的话出现在候选人的屏幕上',
    intervText && aFlat.includes(head(intervText)), head(intervText));
  check('候选人说的话出现在面试官的屏幕上',
    candText && bFlat.includes(head(candText)), head(candText));

  console.log('\n═══ 省掉手打：面试官那句自动进了候选人的输入框 ═══');
  const qInput = await A.evalJs(`document.getElementById('question').value`);
  check('候选人那台自动填好了问题，不用手打',
    qInput && head(qInput, 6) === head(intervText, 6), qInput.slice(0, 30));

  console.log('\n═══ 候选人的话没有被画两遍 ═══');
  /* 候选人的话有两条来源：chunk 事件（切块器）和 asr_line 事件。
     两处都画就会在屏幕上出现两遍——这个坑很隐蔽，因为两条来源
     「都是对的」，只是重复了。这里数一下候选人那段文本块的实际数量。 */
  const candBlocksA = await A.evalJs(
    `[...document.querySelectorAll('#feed .saidblock:not(.q):not(.sugg)')].length`);
  check('候选人那段话在界面上只是一块，没被画两遍', candBlocksA <= 1, `${candBlocksA} 块`);

  console.log('\n═══ 断开与异常 ═══');
  for (const d of [A, B]) {
    check(`${d.name} 没有 JS 异常`, d.jsErr.length === 0, d.jsErr[0] || '');
    check(`${d.name} 没有 console.error`, d.consoleErr.length === 0, d.consoleErr[0] || '');
  }

  // 收尾：把两路识别停掉，否则 WebSocket 一直挂在服务端烧额度
  await fetch(`${APP}/api/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: SESSION }),
  });
  /* reset 只放掉内存，库里那一行还在——不删的话大厅和历史里会一直多一间
     `twodev_1792290…`（id 当名字），跑几次就淹掉真实房间。
     大厅只取前 24 条，垃圾够多时用户自己的面试会被挤出列表。 */
  await fetch(`${APP}/api/sessions/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: SESSION }),
  }).catch(() => {});
} finally {
  await closeDevice(A);
  await closeDevice(B);
}

console.log('\n' + '─'.repeat(60));
console.log(`两台设备检查：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log('  失败项：'); for (const f of fails) console.log(`    ✗ ${f}`); }
console.log('─'.repeat(60) + '\n');

/* 不用 process.exit()：WS 已经 close 过，正常退出会让 libuv 在
   Windows 上抛一个 handle closing 的断言，把退出码盖掉。 */
process.exit(fail ? 1 : 0);

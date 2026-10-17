/* 上传文件 → 材料框 的端到端验证（真浏览器）
   ─────────────────────────────────────────────────────────────
   验证点：
     1) filetext.mjs 能被页面以 ESM 方式 import（服务端 MIME 要对）
     2) 选文件后材料框真的多出字，且字数 pill 同步
     3) 追加而不是覆盖（原来有内容时不能丢）
     4) 不支持的类型给出人话提示，而不是静默什么都不发生
     5) 解析出错时不会把页面卡死（fileBusy 要复位）
   用 CDP 的 DOM.setFileInputFiles 注入文件，避免真的弹文件选择器。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASE = process.env.BASE || 'http://127.0.0.1:8900';
const PORT = 9341;

const CHROME = [
  path.join(os.homedir(), '.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
].find(p => fs.existsSync(p));
if (!CHROME) { console.error('找不到 chrome.exe'); process.exit(2); }

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' ' + extra : ''}`); }
};

/* 造三个测试文件：正常 md、带 BOM 的 md、不支持的 .doc */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'up-'));
const fMd = path.join(tmp, '逐字稿.md');
fs.writeFileSync(fMd, '# 云联客服工单平台\n\n## 一、自我介绍\n\n我做的是工单平台，负责会话消息和 Agent 编排。\n\n## 二、技术选型\n\nJava + Python 双栈，LangGraph 做编排。\n', 'utf8');
const fBom = path.join(tmp, 'bom.md');
fs.writeFileSync(fBom, '\uFEFF这是带 BOM 的中文文件，第 0 个字符必须被吃掉。', 'utf8');
const fDoc = path.join(tmp, 'old.doc');
fs.writeFileSync(fDoc, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]));

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cprof-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cdpEndpoints() {
  for (let i = 0; i < 60; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      if (v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl;
    } catch (_) {}
    await sleep(200);
  }
  throw new Error('CDP 没起来');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.sessions = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.waiting.has(m.id)) {
        const { resolve, reject } = c.waiting.get(m.id);
        c.waiting.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      }
      if (m.method && c.sessions.has(m.sessionId)) {
        const h = c.sessions.get(m.sessionId);
        if (h[m.method]) h[m.method](m.params);
      }
    };
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
  }
}

let cdp, sid;
async function ev(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
}

try {
  const ver = await cdpEndpoints();
  cdp = await CDP.connect(ver);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const att = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  sid = att.sessionId;
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('DOM.enable', {}, sid);

  const jsErrors = [];
  cdp.sessions.set(sid, {
    'Runtime.exceptionThrown': (p) => jsErrors.push(p.exceptionDetails?.text || 'exception'),
    'Runtime.consoleAPICalled': (p) => {
      if (p.type === 'error') jsErrors.push(p.args.map(a => a.value ?? a.description ?? '').join(' '));
    },
  });

  await cdp.send('Page.navigate', { url: BASE + '/' }, sid);
  await sleep(1400);
  ok('页面加载', await ev('document.readyState === "complete"'));

  // ── 1. filetext.mjs 能不能被 import ──
  const modOk = await ev(`(async () => {
    try {
      const m = await import('./filetext.mjs');
      return { ok: true, fns: Object.keys(m).join(',') };
    } catch (e) { return { ok: false, err: e.message }; }
  })()`);
  ok('页面里能 import filetext.mjs', modOk.ok, modOk.ok ? `导出：${modOk.fns}` : modOk.err);
  ok('导出里有 extractText', modOk.ok && modOk.fns.includes('extractText'));

  // ── 2. 上传按钮存在 ──
  ok('材料区有「上传文件」按钮', await ev(`!!document.getElementById('btnUpload')`));
  ok('有隐藏的 file input', await ev(`(() => { const e = document.getElementById('fileInput'); return e && e.type === 'file'; })()`));

  // ── 3. 注入 md 文件，看材料框 ──
  await ev(`document.getElementById('materials').value = ''`);
  const { root } = await cdp.send('DOM.getDocument', {}, sid);
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' }, sid);
  await cdp.send('DOM.setFileInputFiles', { files: [fMd], nodeId }, sid);
  await sleep(1200);
  const afterMd = await ev(`({
    text: document.getElementById('materials').value,
    stat: document.getElementById('matStat').textContent,
    fileStat: document.getElementById('fileStat').textContent,
    shown: getComputedStyle(document.getElementById('fileStat')).display !== 'none'
  })`);
  ok('md 文件读出了内容', afterMd.text.includes('云联客服工单平台'), `${afterMd.text.length} 字`);
  ok('md 里的二级标题也在', afterMd.text.includes('技术选型'));
  ok('字数 pill 同步了', afterMd.stat === afterMd.text.length + ' 字', afterMd.stat);
  ok('给了「已追加，点保存才生效」的提示', afterMd.shown && /保存材料/.test(afterMd.fileStat), afterMd.fileStat.slice(0, 60));

  // ── 4. 再传一次，必须是追加不是覆盖 ──
  const before = afterMd.text.length;
  await cdp.send('DOM.setFileInputFiles', { files: [fBom], nodeId }, sid);
  await sleep(1200);
  const afterTwo = await ev(`document.getElementById('materials').value`);
  ok('第二次上传是追加不是覆盖', afterTwo.length > before && afterTwo.includes('云联客服工单平台'), `${before} → ${afterTwo.length} 字`);
  ok('BOM 被吃掉了', !afterTwo.includes('\uFEFF'));
  ok('两份内容之间有分隔', /\n\n/.test(afterTwo));

  // ── 5. 不支持的 .doc 要给提示，不能静默 ──
  await cdp.send('DOM.setFileInputFiles', { files: [fDoc], nodeId }, sid);
  await sleep(900);
  const docStat = await ev(`({
    fileStat: document.getElementById('fileStat').textContent,
    shown: getComputedStyle(document.getElementById('fileStat')).display !== 'none',
    text: document.getElementById('materials').value
  })`);
  ok('.doc 给了明确提示', docStat.shown && /doc|另存/.test(docStat.fileStat), docStat.fileStat.slice(0, 70));
  ok('.doc 没有污染材料框', docStat.text.length === afterTwo.length);

  // ── 6. 解析完按钮要恢复可用（否则第二次就点不动了）──
  ok('上传按钮已恢复可用', await ev(`!document.getElementById('btnUpload').disabled`));

  // ── 7. 无 JS 异常 ──
  ok('全程无 JS 异常', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));

  console.log(`\n${pass} 通过 / ${fail} 失败`);
} catch (e) {
  console.error('跑挂了：', e.message);
  fail++;
} finally {
  try { chrome.kill(); } catch (_) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
}

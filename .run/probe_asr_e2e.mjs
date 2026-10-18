/* 验证「说话 → 文字 → 出题」整条链，不用麦克风也不用浏览器。
 *
 * 做法：把一个 WAV 文件解码成 16k 单声道 PCM，按 250ms 一片
 * 喂给 /api/asr/feed，同时监听 /events 看服务端有没有把识别结果吐回来。
 *
 * 为什么值得单独写一个：麦克风这条路在无头环境里没法测
 * （headless Chrome 的假麦克风只能放固定的音调，识别不出中文），
 * 而真正容易坏的是中间这段——采样率、PCM 格式、分片大小、角色分流。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'http://127.0.0.1:8900';
const SESSION = 'asrprobe_' + Date.now();
const TRACK = (process.argv[2] === 'interviewer' ? 'iv_probe' : 'candidate');
const ROLE = process.argv[2] === 'interviewer' ? 'interviewer' : 'candidate';
const WAV = process.argv[3] || join(__dirname, 'tts_test.wav');

/** 解析 WAV：只认 16bit PCM 单/双声道，够用了。
 *  返回 {rate, pcm: Float32Array(单声道), sec} */
function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('不是 RIFF/WAV');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, body + size);
    }
    off = body + size + (size % 2); // 块按偶数字节对齐
  }
  if (!fmt || !data) throw new Error('缺 fmt 或 data 块');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`只支持 16bit PCM，实际 format=${fmt.format} bits=${fmt.bits}`);

  const n = data.length / 2 / fmt.channels;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // 双声道就取左声道：SAPI 默认可能录成双声道，混成单声道会让幅度减半
    out[i] = data.readInt16LE(i * 2 * fmt.channels) / 32768;
  }
  return { rate: fmt.rate, pcm: out, sec: n / fmt.rate };
}

/** 线性插值降采样。这个探针只关心「识别得出来吗」，
 *  不追求抗混叠质量——浏览器里走的是 OfflineAudioContext 的正经重采样。 */
function to16k(pcm, rate) {
  if (rate === 16000) return pcm;
  const n = Math.floor(pcm.length * 16000 / rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * rate / 16000;
    const i0 = Math.floor(x), i1 = Math.min(pcm.length - 1, i0 + 1);
    out[i] = pcm[i0] + (pcm[i1] - pcm[i0]) * (x - i0);
  }
  return out;
}

function toPcmBuf(f32) {
  const b = Buffer.alloc(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    b.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), i * 2);
  }
  return b;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 先订 SSE，别把开头的识别结果漏掉 ──
/* Node 24 的 EventSource 要 --experimental-eventsource 才有，
   这里手写一个极简 SSE 解析，省掉那个 flag。
   只认 data: 行，正好是这个项目用的全部协议。 */
const seen = [];
let esCtl = null;
(async () => {
  esCtl = new AbortController();
  try {
    const res = await fetch(`${BASE}/events?s=${encodeURIComponent(SESSION)}`, {
      signal: esCtl.signal,
      headers: { Accept: 'text/event-stream' },
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      // SSE 以空行分帧
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
        if (!data) continue;
        let m; try { m = JSON.parse(data); } catch { continue; }
        if (m.type === 'hb') continue;
        seen.push(m);
        const t = new Date().toISOString().slice(11, 23);
        if (m.type === 'asr_live') console.log(`${t}  [中间] ${m.role}: ${m.text}`);
        else if (m.type === 'asr_line') console.log(`${t}  [定稿] ${m.role}: ${m.text}`);
        else if (m.type === 'asr_state') console.log(`${t}  [状态] ${m.role}: ${m.state}${m.message ? ' — ' + m.message : ''}`);
        else if (m.type === 'chunk') console.log(`${t}  [切块] ${m.text}`);
        else if (m.type === 'draft') console.log(`${t}  [上屏] ${m.question}`);
        else if (m.type === 'nextq') console.log(`${t}  [定稿题] ${m.question}  (${m.kind}, ${m.ms}ms)`);
        else if (m.type === 'question') console.log(`${t}  [提问] ${m.question}`);
        else if (m.type === 'judge_error') console.log(`${t}  [出错] ${m.message}`);
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') console.log('  (SSE 断开)', e.message);
  }
})();

await sleep(600);

console.log('=== 材料 ===');
const mat = readFileSync(join(__dirname, '..', '云联-逐字稿.md'), 'utf8');
const mr = await fetch(`${BASE}/api/materials`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ session: SESSION, materials: mat, name: 'probe' }),
});
console.log('材料已装：', await mr.json());

console.log('\n=== 解码音频 ===');
const { rate, pcm, sec } = decodeWav(readFileSync(WAV));
console.log(`原始 ${rate}Hz / ${sec.toFixed(2)} 秒`);
const p16 = to16k(pcm, rate);
const total = toPcmBuf(p16);
console.log(`转 16k 后 ${p16.length} 个样本 / ${total.length} 字节 PCM`);

console.log('\n=== 开识别 ===');
const sr = await fetch(`${BASE}/api/asr/start`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ session: SESSION, role: ROLE, track: TRACK, label: ROLE === 'interviewer' ? '面试官' : '候选人' }),
});
console.log('start:', await sr.json());
if (!sr.ok) { console.log('开不了，停在这里'); process.exit(1); }

console.log('\n=== 喂音频（250ms 一片，模拟真实节奏）===');
const BYTES_PER_CHUNK = 16000 * 2 * 0.25; // 8000 字节
const t0 = Date.now();
for (let off = 0; off < total.length; off += BYTES_PER_CHUNK) {
  const piece = total.subarray(off, Math.min(total.length, off + BYTES_PER_CHUNK));
  const fr = await fetch(`${BASE}/api/asr/feed?s=${encodeURIComponent(SESSION)}&track=${TRACK}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: piece,
  });
  if (!fr.ok) { console.log('  feed 失败', fr.status); break; }
  await sleep(250);   // 真实节奏：这样服务端才能按「停顿」来断句
}
console.log(`喂完，用时 ${Date.now() - t0}ms`);

console.log('\n=== 停识别（等最后一句定稿）===');
const tr = await fetch(`${BASE}/api/asr/stop`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ session: SESSION, role: ROLE, track: TRACK, label: ROLE === 'interviewer' ? '面试官' : '候选人' }),
});
console.log('stop:', await tr.json());
await sleep(1500);

// 出题是异步的，再等一会儿
await sleep(3500);

const finals = seen.filter(m => m.type === 'asr_line');
const drafts = seen.filter(m => m.type === 'draft');
const nexts = seen.filter(m => m.type === 'nextq');
const questions = seen.filter(m => m.type === 'question');

console.log('\n=== 结果 ===');
console.log(`定稿句子 ${finals.length} 条：`);
for (const f of finals) console.log(`  [${f.role}] ${f.text}`);
console.log(`出题 ${drafts.length} 次 / 定稿题 ${nexts.length} 条`);
for (const n of nexts) console.log(`  ★ ${n.question}  (${n.kind}, ${n.ms}ms)`);
if (questions.length) {
  console.log(`面试官提问 ${questions.length} 条：`);
  for (const q of questions) console.log(`  ? ${q.question}`);
}

const st = await (await fetch(`${BASE}/api/state?s=${encodeURIComponent(SESSION)}`)).json();
console.log(`\n服务端状态：transcript=${st.transcript.length} 条 / 出题 ${st.history.length} 条 / tracks=${JSON.stringify((st.tracks||[]).map(x=>x.track+':'+x.role))}`);

const ok = finals.length > 0;
console.log(`\n${ok ? '✅ 识别通了' : '❌ 一条定稿都没拿到'}`);
esCtl?.abort();
process.exit(ok ? 0 : 1);

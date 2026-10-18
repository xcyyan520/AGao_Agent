/* 延迟分解：把「说完最后一个字」到「题目上屏」拆成三段，分别计时。
 *
 * 为什么需要这个：以前只有「出题 ms」一个数（2000~2400ms），
 * 那是从【切块完成后】开始算的，看不见前面还有多少时间花在等 ASR 定稿上。
 * 人感受到的延迟 = 三段之和，只看最后一段会得出「优化到 1.5 秒了」这种假结论。
 *
 * 三段：
 *   ① 停嘴 → ASR 定稿   (max_sentence_silence 决定的，不在我们的代码里)
 *   ② 定稿 → 切块       (切块器的兜底等待)
 *   ③ 切块 → 题目上屏   (大模型首字延迟 + 一行字的生成)
 *
 * 用法：node .run/probe_latency_breakdown.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'http://127.0.0.1:8900';
const SESSION = 'lat_' + Date.now();
const WAV = path.join(DIR, 'tts_test.wav');
if (!fs.existsSync(WAV)) { console.error('缺 .run/tts_test.wav，先跑 .run/make_tts.ps1'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 把 WAV 解成 16k 单声道 PCM。和 probe_asr_e2e.mjs 同一套逻辑。 */
function decodeWav(buf) {
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + sz);
    if (id === 'fmt ') fmt = { ch: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    else if (id === 'data') { data = body; break; }
    off += 8 + sz + (sz & 1);
  }
  if (!fmt || !data) throw new Error('WAV 解析失败');
  const { ch, rate, bits } = fmt;
  const bps = bits / 8;
  const frames = Math.floor(data.length / (bps * ch));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const p = i * bps * ch;
    mono[i] = bits === 16 ? data.readInt16LE(p) / 32768 : data[p] / 128 - 1;
  }
  if (rate === 16000) return mono;
  // 简单线性重采样。测试音频是干净合成音，够用。
  const ratio = rate / 16000;
  const out = new Float32Array(Math.floor(frames / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio, a = Math.floor(x), b = Math.min(a + 1, frames - 1);
    out[i] = mono[a] + (mono[b] - mono[a]) * (x - a);
  }
  return out;
}

function toPcm(f32) {
  const b = Buffer.alloc(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    b.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return b;
}

const ev = [];
const marks = {};

/* SSE：手写解析。Node 24 的 EventSource 要 --experimental-eventsource，
   这里三行就能自己解，不给自己找麻烦。 */
async function openSSE() {
  const res = await fetch(`${BASE}/events?s=${encodeURIComponent(SESSION)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop();
      for (const f of frames) {
        const line = f.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        let m; try { m = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (m.type === 'hb') continue;
        ev.push({ ...m, t: Date.now() });
        if (m.type === 'asr_line' && m.role === 'candidate' && m.final) marks.asrFinal ??= Date.now();
        /* 起名坑：服务端把这个事件叫 `judging`（判词在上屏前就先到，
           所以叫 judging），不叫 submitted。`submitted` 是引擎内部的
           EventEmitter 事件名，没有透传到前端的 SSE 里。
           第一次写成 'submitted' 时第②③段一直是「—」。 */
        if (m.type === 'judging') marks.chunked ??= Date.now();
        if (m.type === 'nextq') marks.nextq ??= Date.now();
      }
    }
  })().catch(() => {});
}

const say = (k, v) => { marks[k] = v; };

(async () => {
  console.log('会话', SESSION);
  await fetch(`${BASE}/api/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: SESSION }) }).catch(() => {});
  await openSSE();
  await sleep(300);

  const pcm = toPcm(decodeWav(fs.readFileSync(WAV)));
  const TRACK = 'lat_c_' + Date.now();

  const r = await fetch(`${BASE}/api/asr/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: SESSION, role: 'candidate', track: TRACK }),
  });
  if (!r.ok) { console.error('asr/start 失败', await r.text()); process.exit(1); }
  await sleep(600);

  // 按 250ms 一片喂，模拟真人说话
  const chunk = 16000 * 2 * 0.25;
  let sent = 0;
  const feedStart = Date.now();
  for (let o = 0; o < pcm.length; o += chunk) {
    await fetch(`${BASE}/api/asr/feed?s=${encodeURIComponent(SESSION)}&role=candidate&track=${TRACK}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
      body: pcm.subarray(o, o + chunk),
    });
    sent += Math.min(chunk, pcm.length - o);
    const due = feedStart + (sent / 32000) * 1000;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
  }

  /* ★ 这就是「说完最后一个字」的精确时刻。之后的一切都是延迟。 */
  say('spoke', Date.now());
  console.log(`喂完音频，已经「说完」了（${((Date.now() - feedStart) / 1000).toFixed(1)} 秒音频）`);

  /* ★★ 必须继续送【静音】，不能就此停手。
   *
   * max_sentence_silence 判的是「音频流里的静音」，不是「没有数据」。
   * 不送音频，服务端就认为人还在说（只是麦克风卡了一下），永远不定稿。
   * 真麦克风是持续采样的，静音也会送上去，所以真实场景没这个问题；
   * 但探针如果喂完就停，会一直等到超时——第一次踩的就是这个坑。
   *
   * 这里送 2.5 秒静音，足够覆盖 600ms 的定稿阈值。 */
  console.log('继续送 2.5 秒静音（模拟人停嘴之后麦克风还在采）…');
  const SIL = Buffer.alloc(32000);        // 1 秒 16k 单声道 = 32000 字节
  const silStart = Date.now();
  for (let k = 0; k < 5; k++) {           // 5 × 500ms
    await fetch(`${BASE}/api/asr/feed?s=${encodeURIComponent(SESSION)}&role=candidate&track=${TRACK}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
      body: SIL.subarray(0, 16000),
    });
    await sleep(Math.max(0, silStart + (k + 1) * 500 - Date.now()));
  }
  console.log('等定稿与出题…');

  // 不主动 stop：让它靠静音自然定稿，测的才是真实路径
  for (let i = 0; i < 60 && !marks.nextq; i++) await sleep(200);

  const { spoke, asrFinal, chunked, nextq } = marks;
  const seg = (a, b) => (a && b ? `${b - a}ms` : '—');
  console.log('\n══════ 延迟分解 ══════');
  console.log(`  ① 停嘴 → ASR 定稿    ${seg(spoke, asrFinal)}`);
  console.log(`  ② 定稿 → 切出块      ${seg(asrFinal, chunked)}`);
  console.log(`  ③ 切块 → 题目上屏    ${seg(chunked, nextq)}`);
  console.log(`  合计（人感受到的）   ${seg(spoke, nextq)}`);

  const n = ev.find(e => e.type === 'nextq');
  if (n) console.log(`\n题目：${n.question}  （引擎自报 ${n.ms}ms，只含第③段）`);
  else console.log('\n⚠️ 没等到出题');

  await fetch(`${BASE}/api/asr/stop`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: SESSION, role: 'candidate', track: TRACK }),
  }).catch(() => {});
  await fetch(`${BASE}/api/sessions/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: SESSION }),
  }).catch(() => {});

  process.exit(marks.nextq ? 0 : 1);
})();

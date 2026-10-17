// 只验证「能连上 + run-task 被接受」，不验证识别准确度（那要靠真麦克风）。
// 目的：在花时间写前端之前，先排除「Key 不对 / 端点写错 / 协议理解错」这三种可能。
const KEY = process.env.ASR_KEY || process.env.ALI_DEEPSEEK_API_KEY;
const URL_WS = process.env.ASR_WS || 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
const MODEL = process.env.ASR_MODEL || 'fun-asr-realtime';

if (!KEY && !process.env.__INHERIT) {
  // 从系统环境变量取，避免把 Key 写进文件
  const { execSync } = await import('node:child_process');
  try {
    const k = execSync('powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'ALI_DEEPSEEK_API_KEY\',\'Machine\')"', { encoding: 'utf8' }).trim();
    if (k) process.env.ASR_KEY = k;
  } catch {}
}

const key = process.env.ASR_KEY;
if (!key) { console.error('没有 Key'); process.exit(1); }

console.log('连接', URL_WS);
console.log('模型', MODEL);
console.log('Key 长度', key.length);

const ws = new WebSocket(URL_WS, { headers: { Authorization: `Bearer ${key}` } });

const taskId = crypto.randomUUID();
let done = false;

const finish = (code, msg) => {
  if (done) return;
  done = true;
  console.log(msg);
  try { ws.close(); } catch {}
  setTimeout(() => process.exit(code), 100);
};

const t0 = Date.now();
const timer = setTimeout(() => finish(1, `✗ 超时 ${Date.now() - t0}ms 没有 task-started`), 12000);

ws.onopen = () => {
  console.log(`✓ 握手成功（${Date.now() - t0}ms），发 run-task`);
  ws.send(JSON.stringify({
    header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
    payload: {
      task_group: 'audio',
      task: 'asr',
      function: 'recognition',
      model: MODEL,
      parameters: { format: 'pcm', sample_rate: 16000, heartbeat: true },
      input: {},
    },
  }));
};

ws.onmessage = (ev) => {
  let m;
  try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
  const e = m?.header?.event;
  if (e === 'task-started') {
    console.log(`✓ task-started（${Date.now() - t0}ms）—— 协议与鉴权都对`);
    // 发 1 秒静音（16k 单声道 16bit = 32000 字节），确认音频通道也被接受
    const silence = Buffer.alloc(32000);
    ws.send(silence);
    setTimeout(() => {
      ws.send(JSON.stringify({
        header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
        payload: { input: {} },
      }));
      console.log('✓ 已发 1 秒静音 + finish-task');
    }, 400);
  } else if (e === 'task-finished') {
    clearTimeout(timer);
    finish(0, '✓ task-finished —— 全链路通');
  } else if (e === 'task-failed') {
    clearTimeout(timer);
    finish(1, `✗ task-failed: ${m.header.error_code} / ${m.header.error_message}`);
  } else if (e === 'result-generated') {
    const s = m.payload?.output?.sentence;
    if (s && s.text) console.log(`  识别：${JSON.stringify(s.text)} end=${s.sentence_end}`);
  }
};

ws.onerror = (e) => {
  clearTimeout(timer);
  finish(1, `✗ 连接错误：${e?.message || e?.error || '未知'}`);
};

ws.onclose = (e) => {
  if (!done) {
    clearTimeout(timer);
    finish(1, `✗ 连接被关闭 code=${e.code} reason=${e.reason || '(空)'}`);
  }
};

/**
 * asr.mjs —— 把浏览器采到的麦克风音频，桥接到阿里云 DashScope 的【实时语音识别】
 *
 * 为什么要在服务端做桥接，而不是浏览器直连：
 *   1. DashScope 的 WebSocket 要在握手时带 `Authorization: Bearer <key>` 请求头，
 *      而浏览器的 WebSocket 构造函数**不允许设请求头**（只能塞进子协议或 URL，
 *      这两条路都会把 Key 暴露在浏览器里）。
 *   2. Key 放浏览器 = 任何人打开页面都能拿走，拿去烧额度。
 *
 * 协议（已实测，2026-10 验证通过）：
 *   端点：wss://dashscope.aliyuncs.com/api-ws/v1/inference
 *   握手：HTTP 升级时带上 Authorization 头。Node 内置的 WebSocket 支持第二参数
 *         传 { headers }（它走 undici，会透传到握手请求），已实测可用。
 *   建任务：发一条 JSON
 *     { header: { action:'run-task', task_id, streaming:'duplex' },
 *       payload: { task_group:'audio', task:'asr', function:'recognition',
 *                  model:'fun-asr-realtime',
 *                  parameters:{ format:'pcm', sample_rate:16000, heartbeat:true },
 *                  input:{} } }
 *   送音频：**直接发二进制帧**（裸 PCM，16bit 小端、单声道），不是 base64，
 *          也不是包在 JSON 里。发错了服务端不报错，只是识别不出东西——
 *          这类静默失败最难查，所以这里写死成 Buffer。
 *   收结果：JSON 帧，事件名在 header.event：
 *     task-started / result-generated / task-finished / task-failed
 *     识别文本在 payload.output.sentence.text，
 *     sentence_end === true 表示这句定了（后面不会再改），false 是中间结果。
 *   收尾：发一条 { header:{ action:'finish-task', task_id, streaming:'duplex' },
 *                  payload:{ input:{} } }，等 task-finished。
 *
 * ⚠️ 说话人分离（diarization）这里**刻意不做**：
 *   用户要的是「面试官一台设备、候选人另一台设备」。两个人各用自己的麦克风，
 *   音轨天然就是分开的——谁连上来的就标谁，比任何声纹分离都准。
 *   阿里云实时 ASR 本身也不支持 diarization（只有录音文件转写支持），
 *   硬要在一个麦克风上分两个人反而会引入「判错人」的风险。
 */

import { EventEmitter } from 'node:events';

export const DEFAULT_ASR = {
  url: process.env.ASR_WS || 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
  model: process.env.ASR_MODEL || 'fun-asr-realtime',
  sampleRate: 16000,
  format: 'pcm',
  // 连不上/建任务超时。实时识别本来就要快，8 秒还没 task-started 基本就是
  // Key 错了、模型名错了、或者网络到了墙外——早点报出来，别让人干等。
  connectTimeoutMs: 8000,
};

/**
 * 一条 ASR 连接 = 一个角色的一路麦克风。
 *
 * 事件：
 *   'started'  {}                       建任务成功，可以送音频了
 *   'interim'  { text }                 中间结果（会变，只用来刷屏）
 *   'final'    { text, begin, end }     这句定了，可以拿去切块/当问题
 *   'error'    { error }                出错（含服务端 task-failed）
 *   'closed'   { code, reason }         连接关了（不论是主动还是被动）
 */
export class AsrStream extends EventEmitter {
  constructor(opt = {}) {
    super();
    this.opt = { ...DEFAULT_ASR, ...opt };
    this.ws = null;
    this.taskId = null;
    this.started = false;
    this.closed = false;
    this._startPromise = null;
    this._startResolve = null;
    this._startReject = null;
    this._timer = null;
    // 没挂 error 监听者时，EventEmitter 会把 emit('error') 抛成未捕获异常，
    // 直接崩进程。这里先垫一个空的，调用方愿意听再自己加。
    this.on('error', () => {});
    this.bytes = 0;      // 送出去多少字节，排查「音频到底送了没」用
    this.lines = [];     // 收到的定稿句，stop() 之后可以直接取
  }

  /** 建连接 + 建任务。resolve 时已经收到 task-started。 */
  start() {
    if (this._startPromise) return this._startPromise;

    this._startPromise = new Promise((resolve, reject) => {
      this._startResolve = resolve;
      this._startReject = reject;

      const { url, connectTimeoutMs } = this.opt;
      let ws;
      try {
        ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.opt.apiKey}` } });
      } catch (e) {
        reject(new Error('建 WebSocket 失败: ' + e.message));
        return;
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';

      this._timer = setTimeout(() => {
        const e = new Error(`ASR 连接超时：${connectTimeoutMs}ms 没等到 task-started`);
        this._fail(e);
        try { ws.close(); } catch (_) {}
      }, connectTimeoutMs);
      this._timer.unref?.();

      ws.onopen = () => {
        this.taskId = crypto.randomUUID();
        ws.send(JSON.stringify({
          header: { action: 'run-task', task_id: this.taskId, streaming: 'duplex' },
          payload: {
            task_group: 'audio',
            task: 'asr',
            function: 'recognition',
            model: this.opt.model,
            parameters: {
              format: this.opt.format,
              sample_rate: this.opt.sampleRate,
              // 心跳：服务端会定期发事件。没有它，讲得慢的时候连接可能被中间的
              // 代理当成空闲连接掐掉，症状是「说一半突然不出字了」。
              heartbeat: true,
            },
            input: {},
          },
        }));
      };

      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); }
        catch { return; }

        const evName = m?.header?.event;
        if (evName === 'task-started') {
          this.started = true;
          clearTimeout(this._timer);
          this._startResolve?.();
          this.emit('started', {});
          return;
        }
        if (evName === 'result-generated') {
          const sen = m?.payload?.output?.sentence || {};
          const text = String(sen.text || '').trim();
          if (!text) return;
          if (sen.sentence_end === true) {
            this.lines.push(text);
            this.emit('final', { text, begin: sen.begin_time, end: sen.end_time });
          } else {
            this.emit('interim', { text });
          }
          return;
        }
        if (evName === 'task-finished') {
          this.closed = true;
          this.emit('closed', { code: 1000, reason: 'task-finished' });
          return;
        }
        if (evName === 'task-failed') {
          const msg = `${m?.header?.error_code || ''} ${m?.header?.error_message || ''}`.trim();
          this._fail(new Error('ASR 任务失败: ' + (msg || '未知原因')));
        }
      };

      ws.onerror = (e) => {
        // 浏览器的 error 事件不给细节，Node 的也只给一个 message。
        // 最常见的两种：Key 不对（401 升级被拒）、端点写错（DNS/404）。
        this._fail(new Error('ASR 连接出错: ' + (e?.message || e?.error?.message || '网络错误')));
      };

      ws.onclose = (e) => {
        this.closed = true;
        clearTimeout(this._timer);
        // 还没 started 就关了 = 建任务失败，必须让 start() 的 promise 也失败，
        // 否则调用方会一直 await 一个永远不来的 task-started。
        if (!this.started) this._fail(new Error(`ASR 连接被关闭 code=${e.code} reason=${e.reason || '(空)'}`));
        this.emit('closed', { code: e.code, reason: e.reason });
      };
    });

    return this._startPromise;
  }

  _fail(err) {
    clearTimeout(this._timer);
    const rej = this._startReject;
    this._startResolve = null;
    this._startReject = null;
    this.emit('error', { error: err });
    rej?.(err);
  }

  /** 送一段裸 PCM。started 之前送的会被丢掉（DROP，不排队——
   *  实时识别的音频排队没有意义，等送出去时早就过期了）。 */
  push(buf) {
    if (!this.started || this.closed || !this.ws) return false;
    if (this.ws.readyState !== 1) return false;
    try {
      this.ws.send(buf);
      this.bytes += buf.length;
      return true;
    } catch (e) {
      this._fail(new Error('送音频失败: ' + e.message));
      return false;
    }
  }

  /** 收尾：finish-task，等一小会儿让服务端把最后一句吐完再关。
   *  return 最终拿到的定稿句。 */
  async stop(graceMs = 1200) {
    if (!this.ws || this.closed) return this.lines;
    try {
      if (this.started) {
        this.ws.send(JSON.stringify({
          header: { action: 'finish-task', task_id: this.taskId, streaming: 'duplex' },
          payload: { input: {} },
        }));
      }
    } catch (_) {}
    // 等最后一两句结果回来。不等的话，用户说「点到停为止」的最后一个字会丢，
    // 而那句话往往正是问题的关键半句。
    await new Promise(r => {
      const t = setTimeout(r, graceMs);
      t.unref?.();
      this.once('closed', () => { clearTimeout(t); r(); });
    });
    try { this.ws.close(); } catch (_) {}
    this.closed = true;
    return this.lines;
  }
}

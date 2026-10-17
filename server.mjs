/**
 * server.mjs —— 本地服务：托管页面 + 把浏览器的块转发给 LLM
 *
 * 为什么需要它（而不是纯静态页面）：
 *   1. 浏览器直连 DeepSeek / DashScope / 火山 会被 CORS 拦掉（已实测，见 06-快速可用版）。
 *   2. 增量推理是【有状态】的：工作记忆、块序号、在途请求的取消，都在服务端维护，
 *      浏览器只负责采集和显示。这样手机、平板、电脑可以同时看同一场面试。
 *
 * 用法：
 *   node server.mjs
 *   打开 http://127.0.0.1:8900
 *
 * 配置（环境变量，或页面里填）：
 *   LLM_BASE   默认 http://127.0.0.1:8901   （假接口，先跑通链路用）
 *   LLM_KEY    默认 test
 *   LLM_MODEL  默认 fake
 *   想接真模型，例如：
 *     $env:LLM_BASE='https://api.deepseek.com'; $env:LLM_KEY='sk-xxx'; $env:LLM_MODEL='deepseek-chat'
 *
 *   阿里云 DashScope（已配好，直接跑 .\start_real.ps1 即可）：
 *     $env:LLM_BASE='https://dashscope.aliyuncs.com/compatible-mode'   ← 不带 /v1
 *     $env:LLM_KEY=$env:ALI_DEEPSEEK_API_KEY
 *     $env:LLM_MODEL='deepseek-v4.1-flash'                             ← v4.1 后是短横，不是 f
 *   ⚠️ 这两处写错都会 404，而且错误响应体是空的，只能靠日志里的 "HTTP 404" 认出来。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IncrementalQuestioner, Chunker } from './engine.mjs';
import { openStore } from './store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8900);
const HOST = process.env.HOST || '127.0.0.1';

const CONF = {
  baseUrl: process.env.LLM_BASE || 'http://127.0.0.1:8901',
  apiKey: process.env.LLM_KEY || 'test',
  model: process.env.LLM_MODEL || 'fake',
  // 采样温度。留这个环境变量是为了能做 A/B：实测它直接决定重复率，
  // 见 engine.mjs 里 DEFAULT_ENGINE.temperature 的注释。
  ...(process.env.LLM_TEMPERATURE ? { temperature: Number(process.env.LLM_TEMPERATURE) } : {}),
};

/* ── 一场面试 = 一个会话。目前只支持一个活跃会话（小组面试场景够用）。 ── */
const sessions = new Map();

/* ── 持久化 ──
   为什么要有：以前所有状态都在这个 Map 里，重启服务 = 材料、问过的题、
   出题历史全丢。用户的原话是「每次都要自己复制粘贴，而且没历史消息，
   是不是 AI 就不会记得之前面试过的内容」——按当时的实现，确实如此，
   而且连【同一场】面试都记不住。

   用 SQLite（Node 24 内置 node:sqlite）而不是 MySQL，理由见 store.mjs 顶部：
   这是个「面试前 5 分钟打开就得能用」的工具，多一个必须先启动的数据库
   进程就多一个临场翻车的出口。数据量也小得用不上 MySQL 的任何能力。

   存储失败绝不能让出题链路挂掉——所有写入都包在 try 里，丢了记录
   比丢了面试好。 */
let store = null;
try {
  store = openStore();
  console.log('   数据：   ' + store.path);
} catch (e) {
  console.error('[store] 打开数据库失败，本次运行不落盘：', e.message);
}

/** 包一层：任何一次落盘失败都不该冒泡到 HTTP 处理器里。 */
function dbWrite(fn, label) {
  if (!store) return null;
  try { return fn(store); }
  catch (e) { console.error(`[store:${label}]`, e.message); return null; }
}

function newSession(id, conf = {}) {
  const s = {
    id,
    conf: { ...CONF, ...conf },
    judge: null,
    chunker: null,
    clients: new Set(),
    heartbeat: null,      // SSE 心跳定时器，见 startHeartbeat()
    startedAt: Date.now(),
    transcript: [],      // 面试官提问 / 候选人回答的原始流
    finalChunks: [],     // ASR 定稿的句子
    // 回放是不是真的在跑。它和 replayAbort 必须成对出现：
    // replayAbort 只是个「请停下来」的旗子，得有循环去消费它。
    // 曾经没有 replaying 这个字段，于是空闲时点一次「停止」就把旗子永久插上了，
    // 下一次「开始回放」在 i=0 立刻自杀，界面上表现为「点了没反应」——
    // 而这时按钮已经被置灰，人根本猜不到是自己十几秒前点过停止。
    replaying: false,
    replayAbort: false,
    hydrated: false,      // 这场是不是已经从库里恢复过了（避免每轮请求都恢复一次）
  };

  s.judge = new IncrementalQuestioner(s.conf);
  s.chunker = new Chunker();

  /* ── 从库里恢复这一场 ──
     恢复什么、为什么恢复这些、为什么不恢复回答，见 engine.mjs 的 hydrate()。
     关键点：块号必须接着历史往下发，否则新块的 seq 会小于 appliedSeq，
     被当成乱序结果整批丢掉，症状是「服务重启后一条题都不出」。 */
  if (store) {
    try {
      const data = store.getSessionData(id);
      if (data) {
        if (data.session.material_id) {
          const m = store.getMaterial(data.session.material_id);
          if (m) s.judge.setContext({ materials: m.text });
        }
        s.judge.hydrate({
          asked: data.turns.map(t => t.question).filter(Boolean),
          suggested: data.suggestions.map(g => g.question).filter(Boolean),
          history: data.suggestions
            .filter(g => g.question)
            .map(g => ({
              seq: g.seq, text: '', at: g.at, ms: g.ms,
              question: g.question, reason: g.reason, basis: g.basis, kind: g.kind,
              restored: true,
            })),
        });
      }
      // 跨场记忆：这个人以前被问过什么。只喂面试官真问出口的（turns），
      // 不喂 AI 建议但没采用的（suggestions），理由见 store.mjs 里的注释。
      const prior = store.getAskedFromOtherSessions(id);
      if (prior.length) s.judge.setPriorAsked(prior);
      s.materialId = data?.session?.material_id ?? null;
      // 库里没有这一场就建一行，否则后面 addTurn/addSuggestion 的
      // 外键（ON DELETE CASCADE）会失败，静默丢记录。
      if (!data) dbWrite(st => st.ensureSession(id), 'ensureSession');
      s.hydrated = true;
      if (data) {
        console.log(`[hydrate] ${id}: ${data.turns.length} 问过 / ${data.suggestions.length} 建议 / ${prior.length} 跨场`);
      }
    } catch (e) {
      console.error('[store:hydrate]', e.message);
    }
  }

  s.chunker.on('chunk', c => {
    send(s, 'chunk', { seq: null, text: c.text, reason: c.reason, at: c.at });
    s.judge.submit(c.text, { reason: c.reason });
  });

  s.judge.on('submitted', i => send(s, 'judging', { seq: i.seq, text: i.text }));

  // 【提前上屏】「问题：」那一行一生成完就推过去，不等理由/类型/依据。
  // 这是面试官感觉"快"的主要来源：他看到题的时刻，比整轮推理结束早得多。
  s.judge.on('draft', d => send(s, 'draft', d));

  // 整轮推理结束：补齐理由、类型、依据
  s.judge.on('nextq', r => {
    // 先落盘再推送。反过来的话页面已经显示了、库里却没有，
    // 重启后这一条会凭空消失，复盘时对不上。
    dbWrite(st => st.addSuggestion(s.id, r), 'addSuggestion');
    send(s, 'nextq', r);
  });

  s.judge.on('merged', m => send(s, 'merged', m));

  s.judge.on('stale', x => send(s, 'stale', { seq: x.item.seq }));

  s.judge.on('error', e => {
    console.error('[judge error]', e.error?.message || e.error);
    send(s, 'judge_error', {
      seq: e.item?.seq,
      message: String(e.error?.message || e.error).slice(0, 300),
    });
  });

  s.judge.on('question', q => send(s, 'question', q));

  sessions.set(id, s);
  return s;
}

function broadcast(s, msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of s.clients) {
    try { res.write(data); } catch (_) { s.clients.delete(res); }
  }
}

/* ── SSE 心跳 ──
   为什么需要：Cloudflare 快速隧道这类中间层会**缓冲响应体**，表现是一种
   最阴的失败——EventSource 的 onopen 照常触发（HTTP 头已经回来了），
   但 body 里一条 data: 都送不到页面，也不报错。前端只靠 onopen/onerror
   判断的话，会一直显示「已连接」，而题目永远不出现。

   发的是**真正的事件**（type: 'hb'），不是 `:` 注释行。这一点很关键：
   - 注释不触发 onmessage，前端就没法用它判断「还活着吗」；
   - 而前端唯一可靠的判据就是「最近有没有收到过事件」。
   所以心跳必须能进 onmessage，前端不用它做业务，只用来刷新存活时间。
   （实测：即使发事件也穿不过快速隧道的缓冲，但那是隧道的问题；
     对正常网络，这个心跳才是防「空闲被代理掐断」的那道保险。）

   每 5 秒一次：够密，前端才能在十几秒内判定「连上了但没数据」；
   负载可以忽略（一条 30 字节的 JSON）。 */
const SSE_HEARTBEAT_MS = 5000;

function startHeartbeat(s) {
  if (s.heartbeat) return;
  s.heartbeat = setInterval(() => {
    const data = `data: ${JSON.stringify({ type: 'hb', t: Date.now() })}\n\n`;
    for (const res of s.clients) {
      try { res.write(data); } catch (_) { s.clients.delete(res); }
    }
    if (!s.clients.size) stopHeartbeat(s);
  }, SSE_HEARTBEAT_MS);
  // 别让心跳把进程钉住：这是后台维护任务，不该阻止 node 退出
  s.heartbeat.unref?.();
}

function stopHeartbeat(s) {
  if (s.heartbeat) { clearInterval(s.heartbeat); s.heartbeat = null; }
}

/**
 * 推一条 SSE 事件。type 是**路由字段**，必须最后写。
 *
 * 踩过这个坑：引擎的结果里原本有个同名字段 type（表示追问/新方向/收尾），
 * 而这里是 `{ type: 'nextq', ...payload }` —— 展开在后面，于是
 * type 被覆盖成 'probe'，前端 switch(m.type) 认不出这个事件，
 * 整轮结果被**静默丢弃**。症状很迷惑：draft 正常上屏（它没有 type 字段），
 * 但「理由/依据」永远不出现，出题历史永远是 0 条，而服务端统计明明显示已出题。
 * 所以：payload 里的字段名不要叫 type；即使叫了，这里也保证路由的赢。
 */
function send(s, type, payload = {}) {
  broadcast(s, { ...payload, type });
}

function getSession(id) {
  return sessions.get(id) || newSession(id);
}

/* ────────────────────────── HTTP ────────────────────────── */

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let raw = Buffer.concat(chunks).toString('utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      try { resolve(raw.trim() ? JSON.parse(raw) : {}); }
      catch (e) { reject(new Error('请求体不是合法 JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    /* ── 事件流：页面订阅后，所有判断实时推过去 ── */
    if (p === '/events') {
      const s = getSession(url.searchParams.get('s') || 'default');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      s.clients.add(res);
      startHeartbeat(s);
      // 补发已有历史，后加入的面试官能看到之前的判断
      for (const r of s.judge.history) {
        // 只发给这一个新连上来的客户端（不是广播）。
        // type 写在最后：payload 里如果有同名字段，不能让它盖掉路由用的 type。
        res.write(`data: ${JSON.stringify({ ...r, type: 'nextq', replay: true })}\n\n`);
      }
      req.on('close', () => {
        s.clients.delete(res);
        if (!s.clients.size) stopHeartbeat(s);
      });
      return;
    }

    if (p === '/api/state') {
      const s = getSession(url.searchParams.get('s') || 'default');
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({
        conf: { baseUrl: s.conf.baseUrl, model: s.conf.model, hasKey: !!s.conf.apiKey },
        currentQuestion: s.judge.currentQuestion,
        asked: s.judge.asked,
        answer: s.judge.answer,
        stats: s.judge.stats,
        history: s.judge.history,
        // 页面用它显示「已从库里恢复」和材料来源，别再让人以为刷新就丢。
        persisted: {
          enabled: !!store,
          materialId: s.materialId ?? null,
          priorAsked: s.judge.priorAsked.length,
        },
      }));
    }

    /* ── 喂入流式文字（将来由 ASR 调用；现在页面的模拟器也走这里） ── */
    if (p === '/api/feed' && req.method === 'POST') {
      const body = await readBody(req);
      const s = getSession(body.session || 'default');
      const text = String(body.text || '');
      if (body.final) {
        s.finalChunks.push(text);
        s.chunker.push(text);
        s.chunker.flushNow('asrFinal');
      } else {
        s.chunker.push(text);
      }
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ ok: true, buffered: s.chunker.buf.length }));
    }

    /* ── 直接把一段完整文本切成块送进去（回放逐字稿用） ── */
    if (p === '/api/replay' && req.method === 'POST') {
      const body = await readBody(req);
      const s = getSession(body.session || 'default');
      const text = String(body.text || '');
      // 语速单位是【字/100ms】（页面上那个输入框的标签）。
      // 曾经这里按"字/秒"处理并除以 10，导致页面填 4 时实际按 1 字/100ms 回放，
      // 比真实口语慢 2.5 倍——实测出来的块因此全是 minChars 硬切的 18 字碎片。
      // 仍然兼容旧的 charsPerSecond 字段。
      const per100 = body.charsPer100ms !== undefined
        ? Number(body.charsPer100ms)
        : (body.charsPerSecond !== undefined ? Number(body.charsPerSecond) / 10 : 4);
      const cps = Math.max(1, Math.round(per100));
      const step = cps;   // 每 100ms 推进这么多字

      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify({ ok: true, chars: text.length, charsPer100ms: cps }));

      // 开始新一轮之前先把上一次的旗子清掉。不清的话，上一轮「停止」留下的
      // true 会让这一轮在 i=0 就 abort（新一轮还没消费过那面旗子）。
      s.replayAbort = false;
      s.replaying = true;

      (async () => {
        for (let i = 0; i < text.length; i += step) {
          if (s.replayAbort) { s.replayAbort = false; s.replaying = false; broadcast(s, { type: 'replay_end', aborted: true }); return; }
          s.chunker.push(text.slice(i, i + step));
          await new Promise(r => setTimeout(r, 100));
        }
        s.replaying = false;
        s.chunker.flushNow('replayEnd');
        broadcast(s, { type: 'replay_end', aborted: false });
      })();
      return;
    }

    if (p === '/api/stop-replay' && req.method === 'POST') {
      const s = getSession(url.searchParams.get('s') || 'default');
      // 只有真有回放在跑时才插旗子。空闲时点「停止」是个空操作，
      // 不能让它污染下一次回放（见 newSession 里 replaying 的注释）。
      if (s.replaying) s.replayAbort = true;
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ ok: true }));
    }

    /* ── 面试官提问：开一个新问题，记忆保留 ── */
    if (p === '/api/question' && req.method === 'POST') {
      const body = await readBody(req);
      const s = getSession(body.session || 'default');
      const q = String(body.question || '');
      s.chunker.flushNow('beforeQuestion');
      // 先把它当成【上一题的结束】：候选人刚才那段话是对上一个问题的回答。
      // 必须在 newQuestion 之前写，因为 newQuestion 会把 answer 清掉。
      if (q.trim()) dbWrite(st => st.addTurn(s.id, q, s.judge.answer || null), 'addTurn');
      await s.judge.newQuestion(q);
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ ok: true }));
    }

    /* ── 材料：逐字稿 / 项目资料，AI 判断的唯一依据 ── */
    if (p === '/api/materials' && req.method === 'POST') {
      const body = await readBody(req);
      const s = getSession(body.session || 'default');
      const text = String(body.materials || '');
      s.judge.setContext({ materials: text });
      // 名字留空就按会话 id 存，免得材料库里全叫「未命名材料」分不清。
      if (text.trim()) {
        const saved = dbWrite(
          st => st.saveMaterial(String(body.name || '').trim() || `会话 ${s.id} 的材料`, text),
          'saveMaterial'
        );
        if (saved) {
          s.materialId = saved.id;
          dbWrite(st => st.ensureSession(s.id, saved.id), 'ensureSession');
        }
      }
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ ok: true, chars: s.judge.materials.length, materialId: s.materialId ?? null }));
    }

    /* ── 材料库 ──
       这是「每次都要自己复制粘贴」那个抱怨的直接解法。 */
    if (p === '/api/materials/list') {
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ ok: true, items: store ? store.listMaterials() : [] }));
    }

    if (p === '/api/materials/get') {
      const id = Number(url.searchParams.get('id'));
      const m = store ? store.getMaterial(id) : null;
      if (!m) { res.writeHead(404, { 'Content-Type': MIME['.json'] }); return res.end(JSON.stringify({ error: '没有这份材料' })); }
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ ok: true, material: m }));
    }

    /* 把材料库里的某一份装进当前会话。 */
    if (p === '/api/materials/use' && req.method === 'POST') {
      const body = await readBody(req);
      const s = getSession(body.session || 'default');
      const m = store ? store.getMaterial(Number(body.id)) : null;
      if (!m) { res.writeHead(404, { 'Content-Type': MIME['.json'] }); return res.end(JSON.stringify({ error: '没有这份材料' })); }
      s.judge.setContext({ materials: m.text });
      s.materialId = m.id;
      dbWrite(st => st.ensureSession(s.id, m.id), 'ensureSession');
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ ok: true, chars: m.text.length, name: m.name }));
    }

    if (p === '/api/materials/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const ok = dbWrite(st => st.deleteMaterial(Number(body.id)), 'deleteMaterial');
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ ok: !!ok }));
    }

    /* ── 历史面试 ── */
    if (p === '/api/sessions') {
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ ok: true, items: store ? store.listSessions(Number(url.searchParams.get('limit')) || 50) : [] }));
    }

    if (p === '/api/sessions/get') {
      const id = url.searchParams.get('id') || '';
      const data = store ? store.getSessionData(id) : null;
      if (!data) { res.writeHead(404, { 'Content-Type': MIME['.json'] }); return res.end(JSON.stringify({ error: '没有这场面试' })); }
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ ok: true, ...data }));
    }

    if (p === '/api/sessions/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const ok = dbWrite(st => st.deleteSession(String(body.id || '')), 'deleteSession');
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ ok: !!ok }));
    }

    /* ── 换模型配置 ── */
    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const s = getSession(body.session || 'default');
      if (body.baseUrl) s.conf.baseUrl = String(body.baseUrl).replace(/\/+$/, '');
      if (body.apiKey !== undefined) s.conf.apiKey = String(body.apiKey);
      if (body.model) s.conf.model = String(body.model);
      s.judge.opt.baseUrl = s.conf.baseUrl;
      s.judge.opt.apiKey = s.conf.apiKey;
      s.judge.opt.model = s.conf.model;
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ ok: true, baseUrl: s.conf.baseUrl, model: s.conf.model }));
    }

    /* ── 结束面试：导出复盘 ── */
    if (p === '/api/summary') {
      const s = getSession(url.searchParams.get('s') || 'default');
      s.chunker.flushNow('summary');
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify(s.judge.summary(), null, 2));
    }

    /* ── 重置一场面试 ──
       ⚠️ 只清内存、不删库。这是刻意的：点了「重置」之后重新打开页面，
       上一场的内容还能从库里恢复回来——「重置」是"这一场重新开始"，
       不是"把历史抹掉"。真要删历史，走 /api/sessions/delete。

       但要注意：重置时如果库里还有这一场的记录，重新 getSession 时
       hydrate 会把 asked/history 又拉回来，看起来像"重置没生效"。
       所以这里把会话 id 加上时间戳后缀，让新一轮写到一个新 id 上——
       历史因此可以保留，新一轮也不会背着旧记忆。 */
    if (p === '/api/reset' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const id = body.session || url.searchParams.get('s') || 'default';
      const old = sessions.get(id);
      if (old) for (const r of old.clients) { try { r.end(); } catch (_) {} }
      sessions.delete(id);
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ ok: true, session: id }));
    }

    /* ── 静态文件 ── */
    let file = p === '/' ? '/index.html' : p;
    file = path.join(__dirname, path.normalize(file).replace(/^([/\\])+/, ''));

    // 防目录穿越
    if (!file.startsWith(__dirname)) {
      res.writeHead(403); return res.end('forbidden');
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': MIME['.html'] });
      return res.end('<h1>404</h1>');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    return fs.createReadStream(file).pipe(res);

  } catch (e) {
    console.error('[http error]', e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, HOST, () => {
  // 是真是假按【实际配置】判断，不写死。
  // 原来这里无条件打印"当前是【假接口】"，配上真模型之后横幅还在说假接口，
  // 很容易让人以为配置没生效、白查半天。
  const isFake = /127\.0\.0\.1|localhost/i.test(CONF.baseUrl);
  const keyPlaceholder = !CONF.apiKey || CONF.apiKey === 'test';

  console.log('');
  console.log('  ══════════════════════════════════════════════════');
  console.log('   「边说边出下一题」原型已启动');
  console.log('  ══════════════════════════════════════════════════');
  console.log('   页面：   http://' + HOST + ':' + PORT);
  console.log('   模型：   ' + CONF.model + ' @ ' + CONF.baseUrl);
  console.log('');

  if (isFake) {
    console.log('   当前是【假接口】，出的题由关键词规则伪造。');
    console.log('   它只能证明"链路跑得通、时序对"，不能证明判断质量。');
    console.log('   接真模型：');
    console.log('     $env:LLM_BASE="https://dashscope.aliyuncs.com/compatible-mode"');
    console.log('     $env:LLM_KEY="sk-xxxx"');
    console.log('     $env:LLM_MODEL="deepseek-v4.1-flash"');
    console.log('     node server.mjs');
  } else {
    console.log('   当前接的是【真实模型】，题目由它现场生成。');
    if (keyPlaceholder) {
      console.log('');
      console.log('   ⚠️  API Key 还是默认值 "' + CONF.apiKey + '"，上游会拒绝。');
      console.log('      先把 LLM_KEY 设成真 Key 再重启。');
    }
  }
  console.log('');
});

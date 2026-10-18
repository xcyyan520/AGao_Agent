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
import { AsrStream } from './asr.mjs';

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

    /* ── 语音识别：按【音轨】开连接，不按【角色】 ──
       一条音轨 = 一台设备的麦克风。每条音轨有自己的 id、角色和标签。

       ★ 为什么从「两个固定角色槽」改成「任意多条音轨」：
         原来这里只有 { candidate, interviewer } 两个槽，同一角色开第二路
         会走 startAsr 里的 stopAsr 把第一路顶掉。症状非常迷惑：
         两个人各自选了「面试官」，后点的那个人一开口，前一个人的音轨就
         无声无息地死了——他那边按钮还亮着、页面还显示「聆听中」，
         但说出来的话一句都不进对话流。这就是「语音时灵时不灵」的一大来源。

         而且原来的设计逼着人频繁切角色：一个候选人 + 两个面试官（一面
         二面同时在场）时，第二个人必须先把第一个人的角色抢过来。切换要
         停麦、重开 WS、重连识别，整套两三秒——正好卡在「他刚说完一句、
         你要接话」的节奏上。

         现在：面试官可以有任意多条音轨，各自独立、互不干扰；
         切换角色只改这条音轨的标签，不重连。 */
    tracks: new Map(),    // trackId -> { id, role, label, stream, bytes, startedAt }
    // 还没定稿的中间结果，按音轨记。只用来刷屏，绝不拿去出题（它会变）。
    live: {},
    // 面试官说的话先攒在这里（按音轨分别攒），等他真的停下来再当成一个问题发出去。
    qBuf: new Map(),      // trackId -> 待提交的问题文本
    qTimer: new Map(),    // trackId -> 防抖定时器

    /* ── 房间 ──
       一场面试 = 一个房间。房间名就是 session 的 title（可以起名）。
       `lastActiveAt` 是空房回收的依据，任何请求进来都会 touch 一下。
       没有它的话，内存里的 sessions Map 只增不减：开过多少场就常驻多少场，
       每场还各带一个 judge（内含整份材料）+ chunker 定时器。 */
    title: null,
    lastActiveAt: Date.now(),

    /* 候选人席位：整个房间只有一个。
       ★ 为什么要在【开麦之前】就锁住，而不是靠音轨判断：
         一个人打开页面、还没点「开始说话」之前，音轨是 0 条；
         这时第二个人也打开页面并选了「我是面试者」，两个人都不算冲突，
         等第一个人按下开始说话，才发现被顶掉了。
         席位必须在「进房间」这一步就定，早了才能给出清楚的拒绝。
       结构：{ clientId, label, since, touchedAt } */
    seatCandidate: null,
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
        // 房间名：从库里带回来。缺了它刷新页面后自己这间的名字就变成 id 了。
        s.title = data.session.title || null;
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
      /* 对话流也恢复回来。没有这一步的话，服务重启（或者页面刷新后
         触发重建）之后对话面板一片空白，而库里明明存着两个人刚才说的话。
         只取最后 200 条，和内存里的上限一致。 */
      if (data?.lines?.length) {
        s.transcript = data.lines.slice(-200).map(l => ({
          role: l.role === 'interviewer' ? 'interviewer' : 'candidate',
          text: l.text, at: l.at, final: true,
          // 音轨标签也恢复：页面上要能分清「是哪个面试官说的」。
          // 老数据没有这两列，就退回 null，界面按角色显示即可。
          track: l.track || null,
          label: l.label || null,
        }));
      }
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
    /* ★ 候选人说的话在这里统一落库。
       真麦克风和模拟回放两条输入路径都会汇到 chunker.push，所以这里是
       【唯一】该写的地方。写在 onAsrFinal 里的话，接麦克风时同一句话会
       在历史里出现两遍（一遍是 ASR 定稿的整句，一遍是切块器重切出的块）。
       role 一律记 candidate：切块器的输入按定义就是候选人在说话。 */
    dbWrite(st => st.addLine(s.id, { role: 'candidate', text: c.text, at: c.at }), 'addLine');
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

  /* 面试官问出一个新问题。
     ★ 这是【唯一】推送 'question' 的地方：/api/question、面试官的语音识别、
       以后可能加的别的入口，全都走 judge.newQuestion()，由它 emit。
       别在调用处再补一句 send('question')——实测那样会让同一句推两遍，
       页面上出现两条一模一样的「你实际问出口了」。 */
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
  /* 取会话 = 有人正在用这个房间。在这里统一续命，而不是让每个路由自己
     touchRoom 一次——路由有十几个，漏掉一个就会出现「一直在用却
     被当成空房回收」这种极难复现的问题。 */
  const s = sessions.get(id);
  if (s) { touchRoom(s); return s; }
  const fresh = newSession(id);
  touchRoom(fresh);
  return fresh;
}

/* ────────────────────── 房间 ──────────────────────

   用户的原话：「每次创建一个面试，他都开一个新的房间一样，这样子别人每次
   进来可以选择房间进入，而且每个房间只能有一个面试者。不同会话是不同房间，
   然后没有人的房间就不开。」

   三条需求对应三处设计：

   1) 「可选房间进入」→ 大厅列表（/api/rooms）。房间的元信息（名字、材料、
      出过几道题、几个人在）全部来自 SQLite，不依赖进程内存——服务重启后
      大厅里该有的房间一个不少。

   2) 「每个房间只能有一个面试者」→ 席位（seatCandidate）。这一条不是防御
      性代码，是业务规则：两个人同时以为自己是被面试的，两条音轨都会被
      当成 candidate 灌进同一个切块器，切出来的句子一半是甲的一半是乙的，
      出来的题会问到一个根本没人在意的方向上去。
      ★ 席位必须在【进房间】时定，不能等到开麦时靠音轨判断：
        第二个人完全可能在第一个人点「开始说话」之前就进来了。

   3) 「没有人的房间就不开」→ 房间是**懒创建**的：大厅里列一个还没人进过的
      房间不会把它实例化；只有 GET /api/room/join 才 newSession。
      再配一个回收定时器，把长时间没人碰的房间从内存里放掉（库里的记录不动）。
      这样「开过 50 场」不会变成 50 个 judge 常驻内存、每个都揣着整份逐字稿。
*/

/** 房间多久没人碰就从内存里放掉。库里的数据一律不动。 */
const ROOM_IDLE_MS = 40 * 60 * 1000;     // 40 分钟
/** 席位多久没心跳就算人走了。占着席位不开麦、也不轮询，等于人已经离开。 */
const SEAT_STALE_MS = 130 * 1000;        // 130 秒（前端每 20 秒碰一次）
const ROOM_SWEEP_MS = 60 * 1000;         // 每分钟扫一次

function touchRoom(s) {
  if (!s) return;
  s.lastActiveAt = Date.now();
  // 席位跟着请求一起续命：只有真在用这个页面的人才会发请求。
  if (s.seatCandidate && Date.now() - s.seatCandidate.touchedAt > SEAT_STALE_MS) {
    s.seatCandidate = null;
  } else if (s.seatCandidate) {
    s.seatCandidate.touchedAt = Date.now();
  }
}

/** 这个席位还归不归他。超时未续 = 人走了，席位自动放出。 */
function candidateSeatHolder(s) {
  const seat = s.seatCandidate;
  if (!seat) return null;
  if (Date.now() - seat.touchedAt > SEAT_STALE_MS) { s.seatCandidate = null; return null; }
  return seat;
}

/** 大厅里每个房间要显示的东西。只读库 + 内存里的活跃度，不实例化房间。 */
function roomList() {
  const rows = store ? store.listSessions(200) : [];
  const now = Date.now();
  const out = rows.map(r => {
    const live = sessions.get(r.id);
    const seat = live ? candidateSeatHolder(live) : null;
    return {
      id: r.id,
      title: live?.title || r.title || null,
      material_name: r.material_name || null,
      suggestions: r.suggestions || 0,
      turns: r.turns || 0,
      lines: r.lines || 0,
      started_at: r.started_at,
      updated_at: r.updated_at,
      // 内存里有没有这个房间 = 现在有没有人在用
      open: !!live,
      // 有没有人在里面（活跃 + 至少一条连接的音轨，或者刚有请求）
      people: live ? live.clients.size : 0,
      /* 候选人席位是否已被占。大厅上要能一眼看出来，
         否则第二个人点进去之后才被拒绝，体验很差。 */
      candidate_taken: !!seat,
      candidate_label: seat?.label || null,
      candidates_listening: live ? [...live.tracks.values()].filter(t => t.stream && t.role === 'candidate').length : 0,
      interviewers_listening: live ? [...live.tracks.values()].filter(t => t.stream && t.role === 'interviewer').length : 0,
    };
  })
  /* ★ 大厅只列「有名有姓、还用得上」的房间，不列全部历史。
     第一版把库里 200 场全铺出来，结果是 69 张卡片，绝大多数是
     调试留下的 `uimic_1792290414130`、`tracks_1792290397626`——
     用户第一次打开就看到一堆机器名，判断是「这页面坏了」。

     留下的两类：
       · open —— 内存里还活着，现在确实有人在用
       · title —— 起过名字（人有意建的；没起名的会在 createRoom 里
                  自动补一个「面试 · 10-18 11:20」，所以这里不会是空）
     「历史面试」面板本来就负责翻旧账，大厅不该重复它。 */
  .filter(r => r.open || r.title)
  .sort((a, b) => {
    // 有人的排最前，其次按最近活跃
    if (a.open !== b.open) return a.open ? -1 : 1;
    if (b.interviewers_listening !== a.interviewers_listening) return b.interviewers_listening - a.interviewers_listening;
    return (b.updated_at || 0) - (a.updated_at || 0) || String(b.id).localeCompare(String(a.id));
  })
  .slice(0, 24);
  return out;
}

/** 没起名字的房间给个能认的默认名。
 *  ★ 这不是"美观"问题：大厅是按「有没有名字」筛的，名字为空等于
 *    这间房永远不会出现在大厅里——人开了一间、刷新一下，就不见了。
 *    所以「起个名字」是建房的必经步骤，不是可选美化。 */
function defaultRoomTitle() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `面试 · ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 建一个空房间（只有 id 和名字，不实例化会话）。
 *  没给名字就现起一个：大厅按「有没有名字」筛，空名字的房间
 *  等于开完就不见了（见 defaultRoomTitle 的说明）。 */
function createRoom({ title = null, materialId = null } = {}) {
  const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const t = title || defaultRoomTitle();
  const r = dbWrite(st => st.ensureSession(id, materialId, t), 'ensureSession');
  return { id, title: t, session: r?.session || null };
}

/** 空房回收：把长时间没人碰的房间从内存里放掉。
 *  只删 sessions 里的那个对象，库里一行不动——历史面试照旧能加载。 */
async function sweepRooms() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - (s.lastActiveAt || 0) < ROOM_IDLE_MS) continue;
    // 还有人在线就不动：连接还挂着的房间，无论多久都算活的
    if (s.clients.size) continue;
    for (const trackId of [...s.tracks.keys()]) {
      await stopAsr(s, trackId).catch(() => {});
    }
    try { s.chunker.close(); } catch (_) {}
    stopHeartbeat(s);
    sessions.delete(id);
    console.log(`[room] 回收空房 ${id}（${Math.round((now - s.lastActiveAt) / 60000)} 分钟没人）`);
  }
}

const roomSweeper = setInterval(() => { sweepRooms().catch(() => {}); }, ROOM_SWEEP_MS);
roomSweeper.unref?.();

/* ────────────────────── 语音识别（ASR）──────────────────────

   形态：面试官一台设备、候选人另一台设备，各自打开同一个网址，
   各自点自己那一栏的「开始」。服务端给每个角色开一路独立的识别连接。

   ★ 为什么不做说话人分离：
     两个人各用自己的麦克风，音轨在物理上就是分开的——谁连上来的就标谁，
     比任何声纹算法都准。硬要在一个麦克风上分两个人，反而会引入「判错人」
     的风险，而判错人的后果是候选人的话被当成问题、出题依据全乱。
     （另外，阿里云实时 ASR 本身也不支持 diarization，只有录音文件转写支持。）

   ★ 为什么音频走服务端而不是浏览器直连 DashScope：
     那个 WebSocket 握手要带 Authorization 头，而浏览器的 WebSocket
     构造函数不允许设请求头。想直连就得把 Key 塞进页面 = 谁都能拿走。
     代价是音频要多走一跳（同机或局域网内可忽略）。 */

/** ASR 用哪个 Key：优先独立的 ASR_KEY，否则复用 LLM 的 Key。
 *  两家本来就是同一个百炼账号，绝大多数人不用配第二个。 */
function asrKey() {
  const k = process.env.ASR_KEY || (CONF.apiKey !== 'test' ? CONF.apiKey : '');
  return k;
}

/** 往对话流里加一行，并且推给所有设备。
 *  persist 决定要不要落库——候选人那一路是切块器写库的（见 chunk 事件），
 *  从这里再写一遍就会重复，所以它传 false。
 *  track / label 只用于界面上区分「是哪个麦克风说的」——
 *  三个面试官各说一句时，光看 role 分不出是谁。 */
function addTranscriptLine(s, role, text, { persist = true, track = null, label = null } = {}) {
  const t = String(text || '').trim();
  if (!t) return null;
  const line = { role, text: t, at: Date.now(), final: true };
  if (track) line.track = track;
  if (label) line.label = label;
  s.transcript.push(line);
  // 只留最近 200 条：面板最多显示这么多，再多只是占内存
  if (s.transcript.length > 200) s.transcript.splice(0, s.transcript.length - 200);
  if (persist) dbWrite(st => st.addLine(s.id, line), 'addLine');
  send(s, 'asr_line', line);
  return line;
}

/** 一句话定稿后要做的事，按角色分岔。
 *  这是整个语音方案的分水岭：同样一句识别结果，
 *  面试官说的要去当「问题」，候选人说的要去当「回答」。 */
function onAsrFinal(s, role, text, track = null, label = null) {
  if (role === 'candidate') {
    /* 候选人的话 = 回答。走和「模拟回放」完全一样的切块入口，
       这样接真麦克风之后，切块策略、背压合并、出题链路全都不用改。

       ★ 候选人的这一句【不在这里落库】。两条输入路径（真麦克风、模拟
         回放）到这里会汇合成 chunker.push，统一在 chunk 事件里落库。
         如果在两处都写，接麦克风时同一句话会在历史里出现两遍——
         一遍是 ASR 定稿的整句，一遍是切块器重新切的块。
         但它【要】进对话流：面板上得实时看见他在说什么。 */
    addTranscriptLine(s, 'candidate', text, { persist: false, track, label });
    /* `{ final: true }` 是延迟优化的关键一环：这是 ASR 的【定稿】，
       说话人此刻已经停了。切块器看到这个标志就把兜底等待从 700ms
       缩到 200ms（DEFAULT_CHUNKER.finalWaitMs），不必再假设「后面还有字」。
       回放那条路径传的是 false —— 文本是匀速喂的，没人真的停下来。 */
    s.chunker.push(text, { final: true });
    return;
  }

  /* 面试官的话 = 问题。
     不逐句当问题：他可能先「嗯，好」再说正事，逐句发会把「嗯」也
     当成一个问题记进历史，污染跨场记忆。
     先攒起来（按音轨分别攒），停顿 800ms 再一起发——他真要问的时候
     会连着说完一句。
     ★ 必须按音轨分别攒：两个人几乎同时开口时，共用一个 qBuf 会把
       甲的后半句接到乙的前半句上，搓出一句谁都没说过的问题。 */
  addTranscriptLine(s, 'interviewer', text, { persist: true, track, label });
  const key = track || 'interviewer';
  const prev = s.qBuf.get(key) || '';
  s.qBuf.set(key, (prev ? prev + text : text).trim());
  clearTimeout(s.qTimer.get(key));
  const timer = setTimeout(() => {
    const q = (s.qBuf.get(key) || '').trim();
    s.qBuf.delete(key);
    s.qTimer.delete(key);
    if (q.length < 2) return;         // 「嗯」「好」这种不算问题
    askAsrQuestion(s, q);
  }, ASR_QUESTION_DEBOUNCE_MS);
  timer.unref?.();
  s.qTimer.set(key, timer);
}

/** 把面试官亲口说出来的那句话，当成一个正式的提问处理。
 *  路径和页面上的「记录并提问」完全一致，保证两条入口行为不岔。 */
async function askAsrQuestion(s, q) {
  try {
    s.chunker.flushNow('beforeQuestion');
    // 先当上一题结束落盘（newQuestion 会清空 answer，必须写在前面）
    dbWrite(st => st.addTurn(s.id, q, s.judge.answer || null), 'addTurn');
    /* 注意：这里【不要】再 send('question')。
       newQuestion() 内部会 emit('question')，上面已经有一份监听器把它转成
       SSE 推下去了。再补一句的结果是同一句话推两遍——实测面试官说一句，
       页面上会出现两条一模一样的「你实际问出口了」。
       这个 bug 特别隐蔽：两处代码单独看都是对的，只有连起来才重复。 */
    await s.judge.newQuestion(q);
    // 和 /api/question 那条路一样：换了问题就把提示词尾巴补热
    s.judge.warmup().catch(() => {});
  } catch (e) {
    console.error('[asr:question]', e.message);
  }
}

/* ── 音轨（一台设备一条） ──
 *
 * ★ 为什么音轨 id 由**客户端**生成并保存到 localStorage：
 *   刷新页面、断网重连之后要能接回原来那条音轨。用服务端随机 id 的话，
 *   刷新一次就变成一条新音轨，页面上会冒出「面试官 2」「面试官 3」，
 *   而旧的几条还挂在服务端白烧额度（它们没有音源，但 WS 还开着）。
 *   客户端持 id，服务端就永远只有真实存在的那么几条。
 */

/** 取一条音轨。没有就返回 null。 */
function getTrack(s, trackId) {
  return s.tracks.get(trackId) || null;
}

/** 这条音轨上现在有没有活着的识别连接。 */
function isListening(s, trackId) {
  const t = s.tracks.get(trackId);
  return !!(t && t.stream);
}

/** 通知所有设备「音轨列表变了」。
 *  单独一个事件而不是塞进 asr_state：前端要的是**整张表**，
 *  不是某一条的增量——两台设备各自维护自己的视图时，增量很容易对不齐。
 *  （实测过的坑：只推增量的话，一台设备关掉麦克风后另一台还在显示
 *   「面试官 2 聆听中」，而那条音轨早就没了。） */
function broadcastTracks(s) {
  send(s, 'asr_tracks', { tracks: trackList(s) });
}

/** 把 Map 转成前端好用的数组，附带每个人现在说到哪了。 */
function trackList(s) {
  const out = [];
  for (const t of s.tracks.values()) {
    out.push({
      track: t.id,
      role: t.role,
      label: t.label,
      listening: !!t.stream,
      live: s.live[t.id] || '',
      bytes: t.bytes || 0,
      startedAt: t.startedAt || null,
    });
  }
  // 候选人的排前面：页面上「谁在回答」比「谁在问」更值得先看一眼
  out.sort((a, b) => (a.role === b.role ? (a.startedAt || 0) - (b.startedAt || 0) : a.role === 'candidate' ? -1 : 1));
  return out;
}

/** 停掉一条音轨的识别连接，并把音轨本身删掉。
 *  可重复调用（没开就是空操作）。 */
async function stopAsr(s, trackId) {
  const t = s.tracks.get(trackId);
  if (!t) return false;
  s.tracks.delete(trackId);
  s.live[trackId] = '';
  const pending = s.qTimer.get(trackId);
  if (pending) { clearTimeout(pending); s.qTimer.delete(trackId); }
  s.qBuf.delete(trackId);

  if (t.stream) {
    try {
      const lines = await t.stream.stop();
      console.log(`[asr:${trackId}] 停了（${t.role}），${t.stream.bytes} 字节音频 / ${lines.length} 句`);
    } catch (e) {
      console.error(`[asr:${trackId}] 停止时出错：`, e.message);
    }
  }
  send(s, 'asr_state', { track: trackId, role: t.role, state: 'stopped' });
  broadcastTracks(s);
  return true;
}

/** 开一条音轨（或复用已存在的）。
 *
 *  ★ 关键行为：同一条音轨重复点「开始」= 幂等，不重连。
 *    以前这里是「先 stopAsr 再新建」，于是连点两下就会把正在用的连接
 *    拆了重建一次，中间那两三秒说的话全丢——而按钮看起来一直是「聆听中」。
 *    这是「语音时灵时不灵」的另一个来源。
 *
 *  ★ 换角色也不重连：role 只是这条音轨的标签，改标签不影响已经在跑的
 *    识别连接。原来切一次角色要停麦、重开 WS，两三秒的空白正好卡在
 *    「他刚说完一句、你要接话」的节奏上。 */
async function startAsr(s, { track, role = 'candidate', label = null, force = false } = {}) {
  const trackId = String(track || role);
  const role0 = role === 'interviewer' ? 'interviewer' : 'candidate';

  const existing = s.tracks.get(trackId);
  if (existing) {
    // 已有音轨：更新标签，不碰连接
    existing.role = role0;
    if (label) existing.label = label;
    if (existing.stream && !force) {
      send(s, 'asr_state', { track: trackId, role: role0, state: 'listening' });
      broadcastTracks(s);
      return { ok: true, reused: true, track: trackId };
    }
    // force，或者这条音轨没有活连接（上次失败了）：走下面的重建
    if (existing.stream) await existing.stream.stop().catch(() => {});
    existing.stream = null;
  }

  const key = asrKey();
  if (!key) {
    const msg = '没有可用的 API Key：设置 ASR_KEY，或把模型 Key 配好（两者可以是同一个）';
    send(s, 'asr_state', { track: trackId, role: role0, state: 'error', message: msg });
    return { ok: false, error: msg };
  }

  const a = new AsrStream({ apiKey: key });
  const rec = existing || { id: trackId, role: role0, label: label || role0, bytes: 0, startedAt: Date.now() };
  rec.role = role0;
  if (label) rec.label = label;
  rec.stream = a;
  rec.startedAt = rec.startedAt || Date.now();
  rec.bytes = 0;
  s.tracks.set(trackId, rec);

  a.on('interim', p => {
    // 中间结果只刷屏，绝不进切块/出题——它下一秒就会变。
    s.live[trackId] = p.text;
    send(s, 'asr_live', { track: trackId, role: rec.role, text: p.text });
  });
  a.on('final', p => {
    s.live[trackId] = '';
    rec.bytes = a.bytes;
    onAsrFinal(s, rec.role, p.text, trackId, rec.label);
    // 每定稿一句推一次进度：调用方要靠它显示「已经听到多少字」，
    // 否则人分不清「没开麦」和「开了但一直没识别到」。
    send(s, 'asr_live', { track: trackId, role: rec.role, text: '', final: p.text });
  });
  a.on('error', p => {
    console.error(`[asr:${trackId}]`, p.error.message);
    send(s, 'asr_state', { track: trackId, role: rec.role, state: 'error', message: p.error.message });
  });
  a.on('closed', () => {
    // 只有仍然是当前连接时才动状态：被替换掉的旧连接晚到的 closed
    // 不该把新音轨标成「已关闭」（那会让按钮骗人）。
    const cur = s.tracks.get(trackId);
    if (cur && cur.stream === a) {
      cur.stream = null;
      s.live[trackId] = '';
      send(s, 'asr_state', { track: trackId, role: cur.role, state: 'closed' });
      broadcastTracks(s);
    }
  });

  send(s, 'asr_state', { track: trackId, role: role0, state: 'connecting' });
  try {
    await a.start();
  } catch (e) {
    const cur = s.tracks.get(trackId);
    if (cur && cur.stream === a) cur.stream = null;
    send(s, 'asr_state', { track: trackId, role: role0, state: 'error', message: e.message });
    broadcastTracks(s);
    return { ok: false, error: e.message };
  }
  send(s, 'asr_state', { track: trackId, role: role0, state: 'listening' });
  broadcastTracks(s);
  return { ok: true, track: trackId };
}

/** 面试官停顿多久算「问完了」。太短会把一句话拆成两个问题，
 *  太长又会让出题等太久——他问完就想要下一题。 */
const ASR_QUESTION_DEBOUNCE_MS = 800;


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

/** 收原始二进制（音频帧用它，不用上面的 JSON 解析——PCM 不是 JSON）。
 *  maxBytes 是硬上限：麦克风一旦漏了「停止」，没人拦着就会一直往内存里灌。 */
function readRaw(req, maxBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > maxBytes) { req.destroy(); return reject(new Error('音频块太大')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
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
      // 对话流也补一遍：另一台设备后打开时，前面说过的话要能看见，
      // 否则两个人屏幕上看到的内容对不上，会以为对方没在说话。
      for (const line of s.transcript) {
        res.write(`data: ${JSON.stringify({ ...line, type: 'asr_line', replay: true })}\n\n`);
      }
      req.on('close', () => {
        s.clients.delete(res);
        if (!s.clients.size) stopHeartbeat(s);
      });
      return;
    }

    if (p === '/api/state') {
      const s = getSession(url.searchParams.get('s') || 'default');
      touchRoom(s);
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({
        conf: { baseUrl: s.conf.baseUrl, model: s.conf.model, hasKey: !!s.conf.apiKey },
        /* 房间自己的信息。页头要显示房间名，人得能确认自己进的是哪一间——
           手机上同时开着两个标签页时，光看题目分不出这是哪一场。 */
        room: {
          id: s.id,
          title: s.title || null,
          members: s.clients.size,
          startedAt: s.startedAt,
          width: 0,     // 占位，前端不用；留着免得结构随版本变
        },
        /* 席位：谁是被面试的那个。
           前端靠它决定「开始说话」要不要允许点、显示成什么角色。
           mine 要算：手机刷新页面之后唯一能确认"这个席位是不是我的"
           的办法就是让服务端拿 clientId 对一下——
           本地 localStorage 在换设备、清缓存之后会说瞎话。 */
        seat: (() => {
          const held = candidateSeatHolder(s);
          const me = url.searchParams.get('c') || '';
          return {
            taken: !!held,
            mine: !!(held && me && held.clientId === me),
            label: held?.label || null,
            since: held?.since || null,
          };
        })(),
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
        /* ── 两边同步用 ──
           面试官和候选人各看一台屏幕，靠这几项保持一致：
           - transcript：已经定稿的对话流（谁说的、说了什么、什么时候）
           - live：还没定稿的中间结果，只用来显示「他正在说…」
           - tracks：每一路麦克风的完整状态表（见下）
           注意 transcript 是【全量】的：一场面试几百句，几十 KB，
           两秒拉一次没有压力，而且省掉了增量同步的复杂度。 */
        transcript: s.transcript,
        live: s.live,
        /* ★ tracks 是数组，不是 {candidate, interviewer} 两个槽。
           因为一场面试可能是 1 个候选人 + 多个面试官，每人一条音轨；
           用固定两个槽时，第二个面试官一开口就把第一个顶掉（表现为
           「A 说完 B 说，A 的麦克风就自己关了」）。 */
        tracks: trackList(s),
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

    /* ── 语音识别 ──
       四个端点：开、喂音频、停、列音轨。
       音频用 POST 原始字节（不经 base64）：一秒钟的 16k 单声道 PCM 是 32KB，
       base64 之后变 43KB 而且要多一次编解码。每 250ms 一发，不值得。

       ★ 音轨 id 由客户端给（body.track），不是服务端分配。
         这样刷新页面、断网重连后能接回同一条，不会在页面上冒出
         「面试官 2」「面试官 3」而旧的几条还挂在服务端白烧额度。 */
    if (p === '/api/asr/start' && req.method === 'POST') {
      const body = await readBody(req);
      const s = getSession(body.session || 'default');
      const r = await startAsr(s, {
        track: body.track || body.role,
        role: body.role,
        label: body.label,
        force: !!body.force,
      });
      res.writeHead(r.ok ? 200 : 500, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify(r));
    }

    if (p === '/api/asr/feed' && req.method === 'POST') {
      const s = getSession(url.searchParams.get('s') || 'default');
      const trackId = url.searchParams.get('track') || url.searchParams.get('role') || 'candidate';
      const a = getTrack(s, trackId);
      const buf = await readRaw(req);
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      /* 没开着识别就静默丢弃。这里报错没意义：用户点了「停止」之后，
         浏览器那边还有半秒在途的音频块，那是正常的收尾。
         另一个常见情形是多设备：两台都以为自己是候选人，其中一台的音轨
         被另一台覆盖了，它继续往一条已经不存在的轨上推——静默丢弃
         比让那台设备弹红字好，它其实什么事都没做错。 */
      if (!a || !a.stream || !buf.length) return res.end(JSON.stringify({ ok: true, accepted: 0 }));
      const ok = a.stream.push(buf);
      a.bytes = a.stream.bytes;
      return res.end(JSON.stringify({ ok: true, accepted: ok ? buf.length : 0 }));
    }

    if (p === '/api/asr/stop' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const s = getSession(body.session || url.searchParams.get('s') || 'default');
      const trackId = body.track || body.role || url.searchParams.get('track') || url.searchParams.get('role') || 'candidate';
      await stopAsr(s, trackId);
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ ok: true, tracks: trackList(s) }));
    }

    /* 只读：让任何一台设备随时能把音轨表拿全（SSE 断了也有兜底）。 */
    if (p === '/api/asr/tracks') {
      const s = getSession(url.searchParams.get('s') || 'default');
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ ok: true, tracks: trackList(s) }));
    }

    /* ── 面试官提问：开一个新问题，记忆保留 ── */
    if (p === '/api/question' && req.method === 'POST') {
      const body = await readBody(req);
      const s = getSession(body.session || 'default');
      const q = String(body.question || '');
      s.chunker.flushNow('beforeQuestion');
      // 先把它当成【上一题的结束】：候选人刚才那段话是对上一个问题的回答。
      // 必须在 newQuestion 之前写，因为 newQuestion 会把 answer 清掉。
      if (q.trim()) {
        dbWrite(st => st.addTurn(s.id, q, s.judge.answer || null), 'addTurn');
        /* 面试官的话也要进对话流，否则「历史面试」加载出来只剩候选人在
           自言自语，看不出他是在回答什么。语音识别那条路已经在
           onAsrFinal 里写了，此处是手打/回车那条路，两条必须等价——
           实测漏了这句，加载历史时面试官的提问一条都不显示。 */
        addTranscriptLine(s, 'interviewer', q, { persist: true });
      }
      await s.judge.newQuestion(q);
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify({ ok: true }));
      /* 换了问题就再预热一次。
         当前问题是系统提示词的**最后一行**，前面前缀（材料那一大段）是
         逐字不变的，所以这次预热只需要把尾巴补进去，很便宜。
         值得做的理由：面试官问完问题到候选人开口，中间通常有几秒
         （他在思考），这几秒正好把缓存补热，下一块出题就能走缓存。 */
      if (q.trim()) s.judge.warmup().catch(() => {});
      return;
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
      /* chars 是【实际进提示词】的字数，dropped 是被上限砍掉的。
         两个都给出来：只报 chars 会让人以为材料完整吃进去了，
         而后面的题目质量对不上他手上那份 20 万字的稿子。 */
      res.end(JSON.stringify({
        ok: true,
        chars: s.judge.materials.length,
        dropped: s.judge.materialsDropped || 0,
        materialId: s.materialId ?? null,
      }));
      /* 材料一进来就立刻预热前缀缓存，不等面试官先开口。
         这是白赚的：人粘完材料总要去泡杯水、跟候选人打个招呼，
         那几秒足够把 1.7 万字的系统前缀打进网关。等第一个问题来了，
         首字就不用再等冷启动（实测冷 2199ms / 热 815ms）。
         不 await，失败也无所谓 —— warmup 自己吞掉所有异常。 */
      if (text.trim()) s.judge.warmup().catch(() => {});
      return;
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
      res.end(JSON.stringify({
        ok: true,
        chars: s.judge.materials.length,
        dropped: s.judge.materialsDropped || 0,
        name: m.name,
      }));
      // 和 /api/materials 一样：换材料等于换了前缀，缓存要重打
      s.judge.warmup().catch(() => {});
      return;
    }

    if (p === '/api/materials/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const ok = dbWrite(st => st.deleteMaterial(Number(body.id)), 'deleteMaterial');
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ ok: !!ok }));
    }

    /* ── 房间：大厅 ──
       列表只要库；新建只写库。两者都不实例化会话，
       所以「大厅里躺着一百个历史房间」不会变成一百个常驻的 judge。 */
    if (p === '/api/rooms' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ ok: true, items: roomList() }));
    }

    if (p === '/api/rooms' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const title = String(body.title || '').trim().slice(0, 80) || null;
      const r = createRoom({ title, materialId: body.materialId ? Number(body.materialId) : null });
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ ok: true, id: r.id, title: r.title }));
    }

    /* ── 进房间 ──
       这是「每个房间只能有一个面试者」的唯一执行点。
       前端在打开房间时先调它，被拒就停在门口（显示「这间的面试者已经有人了」
       + 一个「以面试官身份进入」的按钮），而不是让人先进去、说到一半才发现
       自己的话没进对话流。 */
    if (p === '/api/room/join' && req.method === 'POST') {
      const body = await readBody(req);
      const s = getSession(body.session || url.searchParams.get('s') || 'default');
      touchRoom(s);
      const clientId = String(body.clientId || '').trim() || `c${Math.random().toString(36).slice(2, 8)}`;
      const role = body.role === 'interviewer' ? 'interviewer' : 'candidate';
      const label = String(body.label || '').trim().slice(0, 24) || null;

      let seatInfo = null;
      if (role === 'candidate') {
        const held = candidateSeatHolder(s);
        if (held && held.clientId !== clientId) {
          res.writeHead(409, { 'Content-Type': MIME['.json'] });
          return res.end(JSON.stringify({
            ok: false,
            error: `这一场的面试者席位已经被「${held.label || '另一台设备'}」占了`,
            seat: { taken: true, label: held.label || null, since: held.since || null },
          }));
        }
        const now = Date.now();
        s.seatCandidate = {
          clientId,
          label: label || '面试者',
          since: held?.since || now,
          touchedAt: now,
        };
        seatInfo = { taken: true, mine: true, label: s.seatCandidate.label, since: s.seatCandidate.since };
        console.log(`[room] ${s.id} 面试者席位 → ${s.seatCandidate.label} (${clientId})`);
        broadcastTracks(s);
        send(s, 'room_seat', { seat: seatInfo });
      }

      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({
        ok: true,
        clientId,
        room: {
          id: s.id,
          title: s.title || null,
          materialId: s.materialId ?? null,
          materialsChars: s.judge.materials.length,
          currentQuestion: s.judge.currentQuestion,
        },
        seat: seatInfo || { taken: !!s.seatCandidate, mine: false, label: s.seatCandidate?.label || null },
        tracks: trackList(s),
      }));
    }

    /** 主动让出席位（换角色、离开房间时调）。 */
    if (p === '/api/room/leave' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const s = sessions.get(String(body.session || '')) || null;
      const clientId = String(body.clientId || '');
      if (s && s.seatCandidate && s.seatCandidate.clientId === clientId) {
        s.seatCandidate = null;
        broadcastTracks(s);
        send(s, 'room_seat', { seat: { taken: false, mine: false, label: null } });
      }
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ ok: true, seat: { taken: !!(s && s.seatCandidate), label: s?.seatCandidate?.label || null } }));
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

    /* 给一场面试起名 / 改名。
       名字是这个功能能不能被人用起来的关键：历史里躺着一串
       `s1792154859667` 那种 id 谁都不想点开。改名走同一个接口——
       刚开一场时命名和后来改名在数据层是同一件事（UPDATE title）。 */
    if (p === '/api/sessions/rename' && req.method === 'POST') {
      const body = await readBody(req);
      const id = String(body.session || body.id || '').trim();
      const title = String(body.title || '').trim().slice(0, 80);
      if (!id) {
        res.writeHead(400, { 'Content-Type': MIME['.json'] });
        return res.end(JSON.stringify({ ok: false, error: '缺少 session' }));
      }
      const r = dbWrite(st => st.ensureSession(id, null, title || null), 'ensureSession');
      // 内存里那份也同步，否则同一进程里再读 /api/state 还是旧标题
      const live = sessions.get(id);
      if (live) live.title = title || null;
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ ok: true, id, title, session: r?.session || null }));
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

    /* ── 重置 = 结束这一场，开一场新的 ──
       ⚠️ 只清内存、不删库。这是刻意的：点了「重置」之后这一场仍然能在
       「历史面试」里找到、能加载回来。重置是"这一场已经结束了，我要开始
       下一场"，不是"把历史抹掉"。真要删历史，走 /api/sessions/delete。

       返回体里给出建议的新会话 id（`next`）：前端拿到之后会带上它重连，
       于是新一轮的录音、切片、出题全部写到一个干净的 id 上，旧场的
       asked/history 不会跟着背过来。名字（title）如果传了就顺手存到
       【旧场】上——人是在结束这一场的时候给它起名的，很直觉。 */
    if (p === '/api/reset' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const id = body.session || url.searchParams.get('s') || 'default';
      const title = String(body.title || '').trim().slice(0, 80);
      const old = sessions.get(id);
      if (old) {
        /* 重置时要把所有音轨都关掉，否则那几条 WebSocket 会一直挂着
           往一个已经没人看的会话里灌音频，白烧额度。
           注意是遍历全部音轨，不是只关候选人和面试官两条——
           现在一场里可能有好几个面试官各占一条。 */
        for (const trackId of [...old.tracks.keys()]) await stopAsr(old, trackId);
        for (const r of old.clients) { try { r.end(); } catch (_) {} }
      }
      // 给刚结束的这场起名。库里有行就改行；没有行先建一行再起名。
      if (title) dbWrite(st => st.ensureSession(id, null, title), 'ensureSession');
      sessions.delete(id);

      // 新一场的 id：时间戳，一眼能看出先后顺序，也不会和旧场撞。
      const next = `s${Date.now()}`;
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ ok: true, session: id, ended: id, next, title: title || null }));
    }

    /* ── 开一场新的：只发一个新 id，不动旧场（旧场原样留在历史里）──
       /api/reset 会顺手把旧场从内存里删掉并关麦克风，适合"这一场跑完了"；
       这个端点则完全不动旧场，适合"我要另起一面，原来那面还想留着继续"。 */
    if (p === '/api/sessions/new' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const next = String(body.id || '').trim() || `s${Date.now()}`;
      const title = String(body.title || '').trim().slice(0, 80);
      if (title) dbWrite(st => st.ensureSession(next, null, title), 'ensureSession');
      else dbWrite(st => st.ensureSession(next), 'ensureSession');
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ ok: true, session: next, title: title || null }));
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

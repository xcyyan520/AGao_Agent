
const $ = id => document.getElementById(id);
const SESSION = new URLSearchParams(location.search).get('s') || 'default';

/* ── 出题类型的中文名 ── */
const TYPE_LABEL = { probe:'追问', fresh:'新方向', wrap:'收尾' };

/* 进度显示用：把"第几块"还原成"面试者的第几句话"。
   块号是给机器看的，面试官看的是候选人说到第几句了。 */
const CN = n => {
  const d = ['零','一','二','三','四','五','六','七','八','九'];
  if(n <= 10) return n === 10 ? '十' : d[n];
  if(n < 20) return '十' + d[n-10];
  return String(n);
};

let saidEl = null;       // 候选人这一段回答累积在哪个元素里
let nqSeq = -1;          // 顶部面板上这条建议对应的块号
let gotDraft = false;    // 这一块的问题是否已经提前上屏过

/* 已经完整画进面板的最大块号（只增不减）。
   注意 draft 不抬这个数：draft 只画了问题那一行，理由/依据还没到，
   要是它把水位抬上去，轮询就不会再来补全那一条了。
   抬水位的只有 showNext（整轮结束）。 */
let ceilSeq = -1;
/* 上一轮轮询看到的历史条数。只增不减，用它跳过重复的补行工作。 */
let histLen = -1;
/* SSE 当前是不是通的。不通时页面靠 2 秒轮询拿题——
   手机走 Cloudflare 快速隧道时不支持 SSE，这时它就是唯一的上屏通道。 */
let esOpen = false;

/* ── 事件流 ── */
/* SSE 断了以后 EventSource 会自己重连，但重连成功与否最晚要等下一次
   onopen/onerror 才知道。轮询那边靠 esOpen 判断该不该接管，
   所以这里给一个「多久没消息就算不通」的保守兜底。 */
let lastMsgAt = 0;

function connect(){
  const es = new EventSource(`/events?s=${encodeURIComponent(SESSION)}`);

  es.onopen = () => {
    esOpen = true;
    $('connPill').textContent = '已连接';
    $('connPill').className = 'pill live';
  };
  es.onerror = () => {
    esOpen = false;
    $('connPill').textContent = '断线，改用轮询';
    $('connPill').className = 'pill warn';
    $('connPill').title = '这个网络不走 SSE（Cloudflare 快速隧道就是这样）。题目改由每 2 秒一次的轮询送上屏，最多慢 2 秒，不影响用。';
  };

  es.onmessage = ev => {
    lastMsgAt = Date.now();
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    handle(m);
  };
}

function handle(m){
  switch(m.type){
    case 'chunk':
      // 一块被切出来了，先把它接到候选人"正在说"的那段话后面
      appendSaid(m.text);
      break;

    case 'judging':
      // 这一块的推理开始了。别让面板还停在上一题上让人误会。
      showThinking(m);
      break;

    case 'draft':
      // 问题那一行先从流里出来了 —— 立刻上屏，不等理由
      showDraft(m);
      break;

    case 'nextq':
      showNext(m);
      break;

    case 'merged':
      flash(`AI 没跟上语速，已把第 ${CN(m.from[0])}、${CN(m.from[1])} 块合并后一起出题（内容没丢）`);
      break;

    case 'stale':
      // 迟到结果本来就不该覆盖新结果，是设计行为，不必打扰面试官
      break;

    case 'question':
      addNotice(`— 你实际问出口了：${esc(m.question)} —`);
      resetPanel();
      break;

    case 'judge_error':
      addNotice(`出题失败：${esc(m.message)}`, true);
      setState('出题失败', 'warn');
      break;

    case 'replay_end':
      $('btnReplay').disabled = false;
      $('btnStop').disabled = true;
      addNotice(m.aborted ? '回放已中止。' : '回放结束。');
      refreshState();
      break;
  }
}

/* ── 渲染 ── */
function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function hideEmpty(){ const e = $('emptyHint'); if(e) e.remove(); }

/* 候选人说的话按「一段回答」累积成一块。
   不能每切一块就在屏幕上多一个方块——面试官要看的是他讲了什么，
   不是切块器的输出。切块是给 AI 用的，不是给他看的。 */
function appendSaid(text){
  hideEmpty();
  if(!saidEl){
    saidEl = document.createElement('div');
    saidEl.className = 'saidblock';
    $('feed').appendChild(saidEl);
  }
  saidEl.textContent += text;
  scroll();
}

function setState(txt, cls){
  const p = $('nqState');
  p.textContent = txt;
  p.className = 'pill' + (cls ? ' ' + cls : '');
}

/* 这一块的推理开始了。只有在这一块还没提前上屏过的时候才把状态压回
   「正在想」——否则会把刚显示出来的问题又盖掉。 */
function showThinking(m){
  if(nqSeq !== m.seq){ nqSeq = m.seq; gotDraft = false; }
  if(!gotDraft) setState('正在想…', 'warn');
}

/* ── 关键的一步 ──
   问题那一行刚从模型的流里出来就先上屏，不等「理由 / 依据」生成完。
   省下的这一段，正是面试官最需要的时间：候选人还在说，他已经能读到题了。 */
function showDraft(m){
  if(!m.question || m.seq < nqSeq) return;
  hideEmpty();
  gotDraft = true;
  nqSeq = m.seq;
  $('nqQ').textContent = m.question;
  $('nqQ').className = 'nq-q';
  $('nqMeta').innerHTML =
    '<span class="nq-cursor">▌</span> <span style="color:var(--dim2)">理由还在生成…</span>';
  $('nextq').className = 'nextq ready';
  setState('题已出，可以先看', 'live');
  scroll();
}

/* 整轮推理结束：补齐类型 / 理由 / 依据，并把这条建议记进历史 */
function showNext(m){
  hideEmpty();
  if(m.question && m.seq >= nqSeq){
    gotDraft = true;
    nqSeq = m.seq;
    $('nqQ').textContent = m.question;
    $('nqQ').className = 'nq-q';
    $('nextq').className = 'nextq ready';
    $('nqMeta').innerHTML =
      `<div><span class="k">理由</span>${esc(m.reason || '—')}</div>` +
      (m.basis ? `<div><span class="k">依据</span>${esc(m.basis)}</div>` : '');
    $('nqMs').textContent = m.ms != null ? m.ms + 'ms' : '';
    setState(TYPE_LABEL[m.kind] || '建议', m.kind === 'wrap' ? 'live' : '');
  } else if(!m.question){
    // 模型没给出可用的问题（格式崩了）：如实说，不要装作没事
    setState('这一块没出题', 'warn');
  }
  // 已经定稿的块号：轮询靠它判断面板要不要换题，所以只有走到这一支才抬。
  if(m.question && m.seq > ceilSeq) ceilSeq = m.seq;
  if(m.question && !document.getElementById('qlog-' + m.seq)){
    // 按 seq 去重：SSE 断开重连时服务端会把整段历史补发一遍，
    // 不去重屏幕上就会出现两行一模一样的问题，面试官会以为 AI 问重复了。
    const d = document.createElement('div');
    d.className = 'qlog';
    d.id = 'qlog-' + m.seq;
    d.innerHTML =
      `<span class="t">第${CN(m.seq)}块</span>` +
      `<span class="badge ${m.kind || 'probe'}">${TYPE_LABEL[m.kind] || '建议'}</span>` +
      `<span class="qq">${esc(m.question)}</span>` +
      (m.replay ? '<span class="pill">历史</span>' : '');
    $('feed').appendChild(d);
    scroll();
  }
  // 立刻刷新统计，别让「已出题 N 次」在最长 2 秒里和上面的历史行数对不上——
  // 面试官会盯着这个数判断 AI 跟不跟得上，它自相矛盾比慢一点更伤信任。
  if(!m.replay) refreshState();
}

/* 面试官问出了新问题：上一条建议已经过期，面板回到等待态，
   同时从他这一句开始的回答要另起一块。 */
function resetPanel(){
  /* 注意 ceilSeq 故意不在这里归零。它记的是「AI 已经定稿到第几块」，
     和面板现在摆的是哪一题无关；归零的话 2 秒后的轮询会立刻把上一题
     重新顶回面板，看起来就像 AI 又推荐了一遍同一道题。 */
  nqSeq = -1;
  gotDraft = false;
  $('nqQ').textContent = '等他说完这一段，我会跟着他的话出下一道题。';
  $('nqQ').className = 'nq-q wait';
  $('nqMeta').innerHTML = '';
  $('nqMs').textContent = '';
  $('nextq').className = 'nextq';
  setState('等下一块');
  saidEl = null;
}

function addNotice(text, isErr){
  const d = document.createElement('div');
  d.style.cssText = 'text-align:center; font-size:12px; padding:4px; color:' +
    (isErr ? 'var(--err)' : 'var(--dim2)');
  d.textContent = text;
  $('feed').appendChild(d);
  scroll();
}

let flashEl = null;
function flash(msg){
  if(!flashEl){
    flashEl = document.createElement('div');
    flashEl.style.cssText =
      'font-size:12px; color:var(--vague); text-align:center; padding:4px; transition:opacity .4s';
    $('feed').appendChild(flashEl);
  }
  flashEl.textContent = msg;
  clearTimeout(flashEl._t);
  flashEl._t = setTimeout(() => { flashEl.style.opacity = '0'; }, 2500);
}

function scroll(){
  const f = $('feed');
  // 只有当用户已经在底部附近时才自动滚动，否则会打断往上翻的人
  const near = f.scrollHeight - f.scrollTop - f.clientHeight < 120;
  if(near) f.scrollTop = f.scrollHeight;
}

/* ── 轮询兜底 ──
   题目原本只走 SSE。可有些网络环境下 SSE 根本走不通——最典型的就是
   Cloudflare 快速隧道（官方明确不支持），手机从外面连进来时表现为：
   页面能开、统计数字每 2 秒在跳，但「下一个问题」永远停在初始文案，
   看起来就像这个功能坏了。
   所以每次轮询都顺带看一眼 /api/state 里的 history：SSE 通的时候它什么
   都不做（面板早就跟上来了），SSE 不通的时候它就是唯一的上屏通道，
   代价最多是题目晚 2 秒出现。 */
const BACKFILL_MAX = 30;   // 首次最多往回补多少条日志，长面试能攒到几十条

function pollBackfill(history){
  const items = (history || []).filter(r => r && r.question);
  if(!items.length) return;

  // 会话被重置过，历史缩水了：当作全新一场重新补
  if(items.length < histLen) histLen = -1;

  if(histLen < 0){
    // 第一次拿到历史。手机刚打开页面时日志是空的，面试官会以为之前
    // 什么都没出过，所以把这一段补上并标成「历史」；只补最后
    // BACKFILL_MAX 条，再往前的翻也翻不到。
    const from = Math.max(0, items.length - BACKFILL_MAX);
    for(let i = from; i < items.length; i++) showNext({ ...items[i], replay: true });
  } else if(items.length > histLen){
    // SSE 漏掉了几条（通道不通，或者中途断过）。这几条刚出炉，不标历史。
    for(let i = histLen; i < items.length; i++) showNext({ ...items[i] });
  }
  histLen = items.length;

  /* 面板该不该换题：看有没有「已经定稿、但从来没上过面板」的那一条。
     这里用 ceilSeq 而不是 nqSeq —— 面试官问出新问题时 resetPanel() 会把
     nqSeq 打回 -1，要是拿它做判据，轮询马上会把上一题又顶回面板，
     面试官会以为 AI 在重复推荐。ceilSeq 只涨不跌，正好避开这个。 */
  const last = items[items.length - 1];
  if(last.seq > ceilSeq) showNext({ ...last });
}

/* ── 状态刷新 ── */
async function refreshState(){
  try{
    const s = await (await fetch(`/api/state?s=${encodeURIComponent(SESSION)}`)).json();
    const heard = s.stats.chunks || 0;
    const made = (s.history || []).length;

    pollBackfill(s.history);


    $('stChunks').textContent = heard;
    $('stApplied').textContent = made;
    $('stMerged').textContent = s.stats.merged;
    $('stMem').textContent = (s.answer || '').length;

    /* AI 落后多少块：这是整个方案最该被盯着的一个数。
       它一旦持续为正并且越来越大，说明模型跟不上这个人说话的语速，
       面试官就会在候选人说完之后才开始等题——那就白做了。 */
    const behind = heard - made;
    $('progPill').textContent = `已出题 ${made} 次`;
    $('progPill').className = 'pill' + (behind > 2 ? ' warn' : (heard && behind <= 0 ? ' live' : ''));
    $('progPill').title = behind > 0
      ? `AI 还有 ${behind} 块没出题（正在合并追进度）`
      : (heard ? 'AI 跟得上，没有积压' : '还没开始');

    const pctOf = arr => p => {
      if(!arr || !arr.length) return '—';
      const a = [...arr].sort((x,y)=>x-y);
      return a[Math.min(a.length-1, Math.floor(a.length*p))] + 'ms';
    };
    $('stFirst').textContent = pctOf(s.stats.draftLatency)(.5);
    $('stP50').textContent = pctOf(s.stats.latency)(.5);
    $('stP90').textContent = pctOf(s.stats.latency)(.9);

    $('modelPill').textContent = s.conf.model + ' @ ' + s.conf.baseUrl.replace(/^https?:\/\//,'');
  }catch(_){}
}

/* ── 交互 ── */
$('btnSaveMat').onclick = async () => {
  const r = await fetch('/api/materials', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ session:SESSION, materials:$('materials').value })
  });
  const j = await r.json();
  $('matStat').textContent = j.chars + ' 字';
  flash('材料已保存，之后的出题会以它为依据');
};

$('materials').addEventListener('input', e => {
  $('matStat').textContent = e.target.value.length + ' 字';
});

$('btnAsk').onclick = askQuestion;
$('question').addEventListener('keydown', e => { if(e.key === 'Enter') askQuestion(); });

async function askQuestion(){
  const q = $('question').value.trim();
  if(!q) return;
  await fetch('/api/question', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ session:SESSION, question:q })
  });
  $('question').value = '';
}

$('btnReplay').onclick = async () => {
  const text = $('replayText').value.trim();
  if(!text) return flash('先贴一段回答');
  $('btnReplay').disabled = true;
  $('btnStop').disabled = false;
  await fetch('/api/replay', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      session:SESSION, text, charsPer100ms: Number($('cps').value) || 4
    })
  });
};

$('btnStop').onclick = async () => {
  await fetch(`/api/stop-replay?s=${encodeURIComponent(SESSION)}`, { method:'POST' });
  $('btnReplay').disabled = false;
  $('btnStop').disabled = true;
};

$('btnReset').onclick = async () => {
  if(!confirm('清空这场面试的材料、回答和出题记录？')) return;
  await fetch('/api/reset', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ session:SESSION })
  });
  $('feed').innerHTML = '<div class="empty" id="emptyHint">已重置。</div>';
  flashEl = null;
  resetPanel();
  refreshState();
};

$('btnSummary').onclick = async () => {
  const s = await (await fetch(`/api/summary?s=${encodeURIComponent(SESSION)}`)).json();
  const blob = new Blob([JSON.stringify(s, null, 2)], { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'interview-' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-') + '.json';
  a.click();
};

$('btnSettings').onclick = () => {
  const el = $('settings');
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
};

$('btnSaveCfg').onclick = async () => {
  const r = await fetch('/api/config', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      session:SESSION,
      baseUrl: $('cfgBase').value.trim(),
      model: $('cfgModel').value.trim(),
      apiKey: $('cfgKey').value
    })
  });
  const j = await r.json();
  $('cfgStat').textContent = '已应用';
  flash('模型已切到 ' + j.model + ' @ ' + j.baseUrl);
  refreshState();
};

/* ── 启动 ── */
(async () => {
  connect();
  try{
    const s = await (await fetch(`/api/state?s=${encodeURIComponent(SESSION)}`)).json();
    $('cfgBase').value = s.conf.baseUrl;
    $('cfgModel').value = s.conf.model;
    $('modelPill').textContent = s.conf.model + ' @ ' + s.conf.baseUrl.replace(/^https?:\/\//,'');
    $('matStat').textContent = '0 字';
  }catch(e){
    $('connPill').textContent = '服务未启动';
    $('connPill').className = 'pill warn';
  }
  refreshState();
  setInterval(refreshState, 2000);
})();


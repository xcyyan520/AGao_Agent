/**
 * engine.mjs —— 「边说边出下一题」内核
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 这个文件解决的问题
 * ═══════════════════════════════════════════════════════════════════════
 * 用户原话（m01663）：
 *   "也不需要判断每个话对不对，最主要的是根据他说的话能尽早的给出下一个问题"
 *
 * 所以这个内核【不做对错判断、不打分】。它只干一件事：
 * 一边听候选人说，一边把面试官下一个该问的问题准备好。
 * 该不该信、要不要挂，是面试官的事，不是这个工具的事。
 *
 * 这条改动的由来：v1 每收一块就输出「对/错/模糊 + 点评」。实测下来那个方向
 * 有两个问题——一是误报会直接摧毁面试官对工具的信任；二是它回答的其实不是
 * 面试官当场最缺的东西。面试官最缺的，是一个能立刻念出口的问题。
 * 而且「发现矛盾」这件事没有被丢掉，它从一条独立结论变成了出题的理由
 * （"你材料里写异步落库，刚才说同步写库，到底哪个？"），反而更有用、更可核对。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么「尽早」是核心指标，以及怎么做到
 * ═══════════════════════════════════════════════════════════════════════
 * 面试官真正需要问题的时刻，是候选人【说完停下】的那一秒。
 * 如果工具在那一秒之后才开始生成，就已经晚了——他会冷场 2~4 秒。
 *
 * 所以本内核做的是【投机生成】：候选人每说出一句完整的话，就立刻重出一版下一问。
 * 等他停下来时，问题已经躺在屏幕上了，等待时间约等于 0。
 *
 * 三个让问题尽早出现的具体手段：
 *
 * 1. 【问题排在输出的第一行，并且流式解析】
 *    LLM 调用开 stream，一旦「问题：」这一行输出完整就立刻推给前端，
 *    不等后面的「理由/类型/依据」生成完。可见延迟因此只取决于首字延迟 + 一行字的时长。
 *
 * 2. 【不再维护滚动工作记忆】
 *    v1 每轮让模型重写一份 300 字的工作记忆，光生成这段就要几秒，反而拖慢出题。
 *    现在每轮只发三样东西：
 *      已问过的问题（追加式，每次只多一行）+ 面试官当前问题 + 本次回答到目前为止
 *    「本次回答」是有限的（一个问题最多几百字）；「已问过」虽随面试增长，
 *    但它是纯追加的——正好是前缀缓存最喜欢的形状，成本几乎不涨。
 *
 * 3. 【串行，一次只跑一个请求】
 *    后一块的出题依赖前面听到的内容，并行会读到同一份旧上下文，导致出的题重复。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 三条硬性约束（都有原因，不要随手改）
 * ═══════════════════════════════════════════════════════════════════════
 * 1. 【乱序必须丢弃】每一块带单调递增的 seq，迟到的旧结果绝不覆盖新结果。
 *    否则面试官会看到屏幕上的题"往回想"，这在面试现场是致命的。
 *
 * 2. 【只允许一个在途请求】不做并发出题，理由见上面第 3 点。
 *
 * 3. 【积压时合并，而不是丢弃】早期版本在队列满时直接丢掉最旧的块，结果正常
 *    语速下就丢了大量面试内容（实测 8 句只处理了 2 句）。"AI 跟不上"不应该让
 *    面试内容消失。现在改成把积压的块合并后再送：输入长一点，但内容零丢失，
 *    队列长度被压在 ≤1，延时有界。
 */

import { EventEmitter } from 'node:events';

/* ══════════════════════════════════════════════════════════════════════
 * 提示词
 * ══════════════════════════════════════════════════════════════════════ */

export const SYSTEM_PROMPT = `你是一场技术模拟面试里的【提问助手】。你坐在面试官旁边，和他一起听候选人说话。

你的唯一任务：给出面试官【下一个最该问的问题】。

面试官会一边听一边看你给的题，然后直接念出来。所以你的输出必须短、必须快、必须是一句人能直接开口说出来的话。

## 出题的优先级（从上往下，命中就停）

1. **对不上**：候选人说的和材料矛盾（材料写「异步落库」，他说「同步写库」；材料写 QPS 3 万，他说峰值 5000）。这是最值钱的问题——把两边的说法摆出来让他解释。
2. **没说清**：他提到一个关键点却一句带过（说「用了 Redis 预减」但没说怎么防超卖；说「压测过」但没说压到什么程度）。
3. **给不出细节**：他用了模糊说法（大概、差不多、应该是、记不清）。
4. **往下深挖**：他给了一个具体数字或方案，追问边界条件（失败了怎么办、回滚怎么办、数据量翻十倍呢、机器挂一半呢）。
5. **换方向**：这个话题问透了，材料里还有别的项目或技术点没聊到，换一个。

## 硬性规则

1. **一句话，25 字以内，口语化**，像真人面试官开口说的话。
   - 好：那消息要是没发出去呢？
   - 差：建议深入考察候选人对于消息可靠性的理解，可追问消息丢失的补偿机制。
2. **一次只问一件事**。不要用「同时」「以及」「另外」把两个问题堆在一起。
3. **不要重复**。看下面「已经问过的问题」，也看你前面已经给过的建议。
   同一个点如果确实还没答到，**换个角度重问**——比如从「怎么做的」换成
   「做不成怎么办」，从「为什么选它」换成「不选它会怎样」。
   **绝不要把同一句话再写一遍。** 连续好几轮出同一道题，面试官会以为这功能坏了。
4. **不知道就问，不要断言**。你拿不准的技术细节，用提问的方式抛出去，绝不要用肯定语气下结论。
5. **不要评价候选人**。不出对错、不打分、不写点评。你只出问题，判断留给面试官。
6. **不要复述**。理由里不要长篇引用候选人原话，一两个词点明出处就够。

## 输出格式（严格遵守）

只输出下面四行。不要 markdown、不要代码块、不要任何多余文字、不要在前后加解释：

问题：<25 字以内，面试官能直接念出来的一句话>
理由：<20 字以内，为什么问这个>
类型：追问 | 新方向 | 收尾
依据：<10 字以内，触发这个问题的原话片段>

「类型」只能是这三个取值之一，不要写别的：
- 追问：顺着候选人刚说的话往深里问
- 新方向：这个话题问完了，换一个话题或换一个技术点
- 收尾：这一轮该结束了，问一个总结性的、有分量的问题

## 材料

{MATERIALS}

## 当前面试官的问题

{CURRENT_QUESTION}
`;

/* ══════════════════════════════════════════════════════════════════════
 * 切块器：把流式文字切成"值得送进 AI"的块
 * ══════════════════════════════════════════════════════════════════════
 * 为什么不能每来几个字就送一次：LLM 一次调用要几百毫秒到两秒，
 * 如果按字触发，请求会疯狂堆积，而且单字没有语义，判断全是 noise。
 *
 * 为什么不能等整句说完：那就回到"等说完才发"的老路了。
 *
 * 切块的原则：【先找语义边界，边界找不到才按字数硬切】。
 *
 * 早期版本是"字数一到 18 就切"，实测证明这是错的——它会在复合词中间下刀，
 * 切出来的块单独看没毛病，合起来却是漏判。真实语料里的例子：
 *   "…然后发消息到 Rocket" | "MQ，下游异步落库。这样能扛住三万" | "QPS。"
 * 第 1、2 块把 RocketMQ 劈成两半，第 3 块短到只剩"QPS。"，
 * 模型只能给 uncertain——这三块加起来也判不出"到底用没用消息队列"。
 *
 * 所以现在按下面的优先级切（先满足的先生效）：
 *   - 句末边界（。！？；换行）且长度 ≥ minChars  → 最理想的单位
 *   - 子句边界（，、：）且长度 ≥ preferChars      → 退而求其次
 *   - 长度 ≥ preferChars 且无标点               → 在词/脚本边界切，不劈开英文词
 *   - 停顿够久（maxWaitMs）                     → 说话人换气，天然边界
 *   - 硬超时（hardMaxMs）                       → 语速慢/一直在说时的兜底
 *   - 长度 ≥ maxChars                           → 绝不超过的硬上限
 *
 * 代价是平均延迟略高（要多等一个标点），换来的是每块都有完整的语义单元。
 */

export const DEFAULT_CHUNKER = {
  minChars: 24,      // 低于这个字数绝不切：太短的单块模型只能判 uncertain
  preferChars: 60,   // 一个标点都没有时的忍耐心：再长就按词边界硬切
  maxChars: 120,     // 硬上限，防止一口气说一大段撑爆上下文
  maxWaitMs: 700,    // 静音这么久说明他停下来了，可以切
  hardMaxMs: 3000,   // 再慢也要切，保证 AI 有输出节奏
};

/* 语义边界。强边界=句子结束，弱边界=子句分隔。 */
const STRONG_END = /[。！？；!?;\n]/;
const WEAK_END = /[，、：,]/;
/* 英文/数字词的字符集：切点落在这两种字符中间就会把词劈开 */
const WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * 材料正文的硬上限（字符数）。
 *
 * 8 万字这个数不是拍脑袋：实测 10 万字开始，单次请求会随机撞上
 * timeoutMs（默认 8 秒）而静默失败——材料越长输入 token 越多，
 * 首字延迟跟着涨，过了半山腰就时快时慢地不题。详细数据见 `_capMaterials`。
 *
 * 8 万字对这个工具已经很宽了：岗位描述 + 简历 + 一段项目陈述通常在两万字以内。
 */
export const MATERIAL_HARD_CAP = 80000;

/** 从 floor 往后找第一个能当切点的边界位置（返回"切到哪"，即下标+1）。 */
function firstBoundary(str, re, floor) {
  for (let i = Math.max(0, floor); i < str.length; i++) {
    if (re.test(str[i])) return i + 1;
  }
  return -1;
}

/** 从 from 往前找最后一个能当切点的边界位置（返回"切到哪"，即下标+1）。 */
function lastBoundary(str, re, floor, ceil = Infinity) {
  const hi = Math.min(str.length, ceil);
  for (let i = hi - 1; i >= floor; i--) {
    if (re.test(str[i])) return i + 1;
  }
  return -1;
}

/**
 * 在 want 附近找一个不会把英文/数字词劈开的位置。
 * 例如 want 正好落在 "Rocket|MQ" 中间时，会挪到 "RocketMQ" 之后，
 * 而不是留下 "…发消息到 Rocket" + "MQ，下游…" 这种两块都看不懂的碎片。
 *
 * hardLimit 是绝不能越过的硬上限：碰上一个超长的连续 token（比如一长串
 * 没有空格的字母数字）时，宁可把这个 token 劈开，也不能让块无限变大。
 */
function safeCut(str, want, hardLimit = Infinity) {
  const limit = Math.min(want, hardLimit, str.length);
  if (limit <= 0) return 0;
  const i = limit;
  if (i >= str.length) return str.length;
  // 切点不在词中间：直接用
  if (!(WORD_CHAR.test(str[i - 1]) && WORD_CHAR.test(str[i]))) return i;

  // 正落在词中间：先尝试往后走到词尾（连同紧随其后的逗号一起切走）
  let j = i;
  while (j < str.length && WORD_CHAR.test(str[j]) && j - i < 24) j++;
  if (j < str.length && j <= hardLimit) {
    return (WEAK_END.test(str[j]) && j + 1 <= hardLimit) ? j + 1 : j;
  }

  // 后面还有很长的词或者已经触顶：往前退到词首，避免整块被截断
  let k = i;
  while (k > 0 && WORD_CHAR.test(str[k - 1]) && i - k < 24) k--;
  return k > 0 ? k : i;
}

export class Chunker extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opt = { ...DEFAULT_CHUNKER, ...opts };
    this.buf = '';
    this.firstCharAt = 0;
    this.lastCharAt = 0;
    this.timer = null;
    this.closed = false;
  }

  /** 喂入新到达的文字（来自 ASR 的中间结果或定稿结果） */
  push(text) {
    if (this.closed) return;
    const now = Date.now();
    if (!this.buf) this.firstCharAt = now;
    this.buf += text;
    this.lastCharAt = now;
    this._try();
  }

  /** 每次有新字进来就重新判断：现在能不能切、切在哪。 */
  _try() {
    const n = this.buf.length;

    // 1. 硬上限：无论如何不能超。退回不超过上限的最后一个边界处下刀。
    if (n >= this.opt.maxChars) {
      const cap = this.opt.maxChars;
      const s = lastBoundary(this.buf, STRONG_END, this.opt.minChars - 1, cap);
      const w = lastBoundary(this.buf, WEAK_END, this.opt.minChars - 1, cap);
      const best = Math.max(s, w);
      return this._cut(best > 0 ? best : safeCut(this.buf, cap, cap), 'maxChars');
    }

    // 2. 句末边界：够 minChars 之后遇到的【第一个】句子结束，立即切。
    //    这里必须是"第一个"而不是"最后一个"——找最后一个会让第一块一直
    //    憋到 maxChars 才吐出来（实测 519 字的回答要等 3 秒才看到第一条判断），
    //    那就不再是"边说边判"了。找一个最早的完整句子，才是又准又快。
    const s = firstBoundary(this.buf, STRONG_END, this.opt.minChars - 1);
    if (s !== -1) return this._cut(s, 'sentence');

    // 3. 子句边界：攒到 preferChars 才切，否则块会碎
    if (n >= this.opt.preferChars) {
      const w = firstBoundary(this.buf, WEAK_END, this.opt.minChars - 1);
      if (w !== -1) return this._cut(w, 'clause');

      // 4. 够长了但一个标点都没有（口播/连读）：在词边界切，不劈开英文词
      return this._cut(safeCut(this.buf, this.opt.preferChars, this.opt.maxChars), 'segment');
    }

    // 还没到能切的程度：交给 pause / hardTimeout 兜底
    this._arm();
  }

  _arm() {
    clearTimeout(this.timer);
    // 一旦已经攒够 preferChars，就不该再无限等下去：
    // 把"最长等待"限制在一个较短的窗口内，保证 AI 的输出节奏。
    const sinceLast = Date.now() - this.lastCharAt;
    const sinceFirst = Date.now() - this.firstCharAt;

    // 距离硬上限还剩多久
    const untilHard = Math.max(0, this.opt.hardMaxMs - sinceFirst);
    // 距离"算作停顿"还剩多久
    const untilPause = Math.max(0, this.opt.maxWaitMs - sinceLast);

    this.timer = setTimeout(() => {
      if (!this.buf || this.closed) return;
      const now = Date.now();
      if (now - this.firstCharAt >= this.opt.hardMaxMs) return this._force('hardTimeout');
      if (now - this.lastCharAt >= this.opt.maxWaitMs) return this._force('pause');
      this._arm();
    }, Math.min(untilHard, untilPause) + 5);
  }

  /** pause / hardTimeout 触发的强制切：仍然优先落在边界上。 */
  _force(reason) {
    const cap = this.opt.maxChars;
    const floor = this.opt.minChars - 1;
    const strong = firstBoundary(this.buf, STRONG_END, floor);
    if (strong !== -1) return this._cut(strong, reason);
    const weak = firstBoundary(this.buf, WEAK_END, floor);
    if (weak !== -1) return this._cut(weak, reason);
    // 一个字面边界都没有：整块冲掉，别再等（说话人已经停下来了）
    return this._cut(safeCut(this.buf, this.opt.preferChars, cap), reason);
  }

  /**
   * 从 buf 开头切掉 n 个字符。注意只切前面这一段——
   * 边界之后往往还有刚到的内容，留在 buf 里等下一轮，不必一起冲掉。
   */
  _cut(n, reason) {
    clearTimeout(this.timer);
    this.timer = null;
    const take = Math.max(0, Math.min(n, this.buf.length));
    const text = this.buf.slice(0, take).trim();
    this.buf = this.buf.slice(take);
    this.firstCharAt = this.buf ? Date.now() : 0;
    if (text) this.emit('chunk', { text, reason, at: Date.now() });
    // 切完可能剩下的部分本身又够切了（一次 push 进来很多字时会发生）
    if (this.buf) this._try();
  }

  _flush(reason) {
    clearTimeout(this.timer);
    this.timer = null;
    const text = this.buf.trim();
    this.buf = '';
    this.firstCharAt = 0;
    if (text) this.emit('chunk', { text, reason, at: Date.now() });
  }

  /** 面试官问完 / 候选人说完了，把残余强制切出来 */
  flushNow(reason = 'manual') {
    this._flush(reason);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.flushNow('close');
  }
}
/* ══════════════════════════════════════════════════════════════════════
 * 增量出题内核
 * ══════════════════════════════════════════════════════════════════════ */

export const DEFAULT_ENGINE = {
  baseUrl: 'http://127.0.0.1:8901',
  apiKey: 'test',
  model: 'fake',
  // 单块出题的硬超时。超了就放弃这一块并记录，不能让整条链路卡住。
  // 真 LLM 首字延迟常见 300~2000ms，出题只要几十个字，8s 已经是宽裕上限。
  timeoutMs: 8000,
  // ⚠️ 必须关掉「思考」模式，这一条是实测踩出来的，别删。
  //
  // 背景：deepseek-v4.1-flash 这类带推理的模型会先吐一大段 reasoning_content，
  // 再吐正文，而且【思考 token 和答案 token 共用 max_tokens 预算】。
  //
  // 实测（同一份输入，max_tokens=220）：
  //   思考 355 字 → 预算被吃光 → finish_reason=length → 正文 0 字
  //   content 只剩「问题：那」——面试官屏幕上真会出现一个孤零零的「那」。
  //
  // 更致命的是延迟：思考要 2.4s 才轮到正文，而这个内核的全部设计目标
  // 就是「候选人停下那一秒，问题已经在屏幕上」。实测同一句话：
  //   不开思考 2388ms 首字  →  开 enable_thinking:false 后 684~759ms 首字
  // 快了 3.5 倍。对「25 字以内的一句话」来说，思考是纯负担。
  //
  // 实测有效的三个写法（选它是因为它最标准、别家网关也认）：
  //   enable_thinking:false  → 759ms   ✅ 用这个
  //   thinking:{type:disabled} → 755ms   同效，备选
  //   reasoning_effort:none   → 684ms   同效，但语义是"少想"不是"不想"
  //   reasoning_effort:minimal → 1823ms 仍会思考，无效
  disableThinking: true,
  // 输出上限。压住它能逼模型别啰嗦，也顺带压住尾延迟：
  // 在途请求越早结束，下一块的出题就能越早开始。
  //
  // 数值从 220 提到 400：正常四行输出只要 ~100 token，多出来的是给
  // 「不认识 disableThinking 开关、照旧思考」的网关留的余量，
  // 免得又退化成上面那种截断。max_tokens 只是上限、不是预留，给多了不花钱。
  maxTokens: 400,
  // 采样温度。原来写死 0.3，实测在真实语料上会退化成复读机：
  // 同一场面试里「那原生 Agent 的中间结果，怎么传给下一步？」连出 11 遍，
  // 78 道题里 47% 是重复的（归一化后逐字相同）。低温 + 高度相似的连续
  // 上下文 = 模型每轮都挑同一个最可能的说法。
  //
  // 但也不能开高：出题是要「稳、准、短」，温度过高会开始胡编技术细节，
  // 而面试官是要照着念的，编出来的东西比重复更糟。0.8 是个折中，
  // 目的是把「同一句话」的采样概率摊开，不是求多样性。
  temperature: 0.8,
  // 「本次回答到目前为止」保留的字符数。正常回答碰不到，只在极端长回答时兜底。
  answerLimit: 1200,
};

export class IncrementalQuestioner extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opt = { ...DEFAULT_ENGINE, ...opts };

    this.seq = 0;                 // 已分配的块号
    this.appliedSeq = -1;         // 已应用的最高块号
    this.materials = '';          // 逐字稿 / 项目资料，整场不变
    this.materialsDropped = 0;    // 因为超长被砍掉的字数（见 _capMaterials）
    this.currentQuestion = '';    // 面试官当前的问题
    this.asked = [];              // 已经问过的问题，按时间顺序，纯追加
    // 本场 AI 自己给过的建议，按时间顺序，纯追加。
    //
    // ⚠️ 这个列表是必须的，不是锦上添花。没有它的时候，asked 只在
    // newQuestion() 里增长——而「边说边出题」的主场景是候选人一直说、
    // 面试官一直没开口，asked 就一直是空的，模型完全看不到自己刚才
    // 建议过什么，于是同一个「信息缺口」每块都重新触发一次同样的题。
    //
    // 真实语料实测（云联逐字稿模块四，2235 字，真实语速）：
    //   78 次出题里有 19 次是逐字重复的「那 LangChain 原生 Agent 和
    //   LangGraph 差在哪？」，另有 10 次是它的轻微变体——重复率 41%。
    //   8 倍速那次更短，也重复了 12%。
    //   面试官屏幕上连着滚出 19 遍同一句话，这功能看着就是坏的。
    this.suggested = [];          // AI 自己给过的建议，纯追加，用于防重复
    this._suggestedKeys = new Set();   // 上面那个列表的归一化去重键
    // 以前几场面试里问过的问题。跟 asked 的区别是：asked 是【这一场】，
    // 这个是【历史上所有场】。它让 AI 第二次面同一个候选人时不会把
    // 上一场已经问透的东西再问一遍。
    // 只存进提示词、不进 asked，因为它不是"本场已经问过"，
    // 混进去会让模型以为这一场已经进行到很后面了。
    this.priorAsked = [];
    this.answer = '';             // 本次回答到目前为止
    this.history = [];            // 已应用的结果，供回看
    this.busy = false;
    this.queue = [];              // 等待出题的块
    this.abort = null;            // 在途请求的取消句柄
    this.stats = {
      chunks: 0, dropped: 0, merged: 0, failed: 0, repeated: 0,
      latency: [], draftLatency: [], answerChars: [],
    };
  }

  setContext({ materials, currentQuestion } = {}) {
    if (materials !== undefined) this.materials = this._capMaterials(materials);
    if (currentQuestion !== undefined) this.currentQuestion = currentQuestion;
  }

  /**
   * 材料超长时截断到 MATERIAL_HARD_CAP，并把截掉多少记下来。
   *
   * 为什么需要它：`materials` 是唯一没有上限的输入，而整份材料会**每一个块**
   * 都拼进系统提示词重发一遍（见 `_buildMessages`）。花的是输入 token，
   * 而且直接压在首字延迟上。实测（`deepseek-v4.1-flash`，同一段话发一次）：
   *
   *     1.7 万字 → 1.9s（正常，这就是那份 423 行逐字稿的量级）
   *     3 万字   → 4.5s
   *     7 万字   → 4.1s
   *    10 万字   → 8.0s ← 撞上默认 timeoutMs，请求被 abort
   *    14 万字   → 6.8s
   *    20 万字   → 8.0s ← abort
   *
   * 注意 10 万那次失败和 14 万那次成功并存 —— 这不是一条干净的容量线，
   * 而是**延迟随长度上升，在半山腰随机超时**。也就是说材料一旦过了某个量级，
   * 表现不是「报错」而是「时快时慢地出不题」，最难查的那种。
   *
   * 8 万字以上对这个工具没有实际意义（面试材料是简历和项目陈述，不是一本书），
   * 所以砍在这里。砍掉的部分按字符数算，写到 `materialsDropped` 上，
   * 界面读 `summary()` 就能显示出来提醒人——静默截断比报错更坏。
   */
  _capMaterials(text) {
    const s = String(text || '');
    if (s.length <= MATERIAL_HARD_CAP) {
      this.materialsDropped = 0;
      return s;
    }
    this.materialsDropped = s.length - MATERIAL_HARD_CAP;
    return s.slice(0, MATERIAL_HARD_CAP);
  }

  /**
   * 设置「以前几场问过的问题」，让模型知道哪些话题已经聊过了。
   *
   * 为什么只喂最近 PAST_ASKED_KEEP 条：完整的历史可能有几百条，
   * 全塞进去既贵又会把模型的注意力从「他刚说的这句」拉走。
   * 最近若干条已经够它避开重复。
   *
   * 注意它和 suggested 一样，**必须放在最后一条 user 消息里**，
   * 不能进稳定前缀——否则每开一场面试就把前缀缓存全打掉。
   */
  setPriorAsked(list) {
    if (!Array.isArray(list)) return;
    const seen = new Set();
    const out = [];
    for (const q of list) {
      const t = String(q || '').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    this.priorAsked = out.slice(-PAST_ASKED_KEEP);
  }

  /**
   * 从存下来的状态恢复一场面试。
   *
   * 为什么需要这个方法：在没有它之前，整个引擎是纯内存的，`server.mjs`
   * 重启、或者页面带着新的 ?s= 打开，一切从零开始。用户的原话是
   * 「没历史消息，AI 是不是就不记得之前面试过的内容」——是的，而且
   * 连**同一场**面试都记不住。
   *
   * 恢复三样东西（都是纯追加的列表，恢复起来没有一致性风险）：
   *   - asked        面试官真问出口的问题 → 模型据此知道自己问到哪了
   *   - suggested    AI 给过的建议         → 防重复的那道防线要重新立起来
   *   - history      已应用的出题结果     → 页面上的日志能接着往下滚
   *
   * **不恢复** answer：候选人的回答是逐块累积的滑动窗口，存了整个
   * `answerLimit` 窗口也没意义——恢复后他继续说的新内容会自然填进来。
   * 硬塞一段旧的反而会让模型把「上一场最后说的话」当成「这一场刚说的」。
   *
   * @param {{asked?:string[], suggested?:string[], history?:object[]}} state
   */
  hydrate(state = {}) {
    const { asked, suggested, history } = state;

    if (Array.isArray(asked)) {
      for (const q of asked) {
        const t = String(q || '').trim();
        if (t && !this.asked.includes(t)) this.asked.push(t);
      }
    }

    if (Array.isArray(suggested)) {
      for (const q of suggested) this._remember(q);
    }

    if (Array.isArray(history)) {
      for (const r of history) {
        if (!r || !r.question) continue;
        // 按 seq 去重：同一个块恢复两次不该在日志里出现两行。
        if (this.history.some(x => x.seq === r.seq && x.question === r.question)) continue;
        this.history.push(r);
        if (typeof r.seq === 'number' && r.seq > this.appliedSeq) this.appliedSeq = r.seq;
      }
    }

    // 块号要从恢复出来的最高值接着往下发，否则新块会撞上旧 seq，
    // 触发 `item.seq <= this.appliedSeq` 那条乱序丢弃分支，新题全被丢掉。
    const maxSeq = this.history.reduce((m, r) => Math.max(m, Number(r.seq) || 0), -1);
    if (maxSeq >= this.seq) this.seq = maxSeq;

    this.emit('hydrated', { asked: this.asked.length, suggested: this.suggested.length, history: this.history.length });
  }

  /**
   * 面试官换了问题（不管是采纳 AI 出的题，还是他自己手写的）。
   * 两个必须做的动作：
   *   1. 把上一个问题记进「已问过」，否则新出的题会重复问同一件事。
   *   2. 把「本次回答」清零，并把还在排队的块丢掉——它们属于上一个问题，
   *      留着会让 AI 把上一题的答案当成这一题的上下文，出的题跑偏。
   */
  /** 记下一条自己给过的建议，用于让下一轮别再说同一句话。 */
  _remember(q) {
    const t = String(q || '').trim();
    if (!t) return;
    const key = normQuestion(t);
    if (!key || this._suggestedKeys.has(key)) return;
    this._suggestedKeys.add(key);
    this.suggested.push(t);
  }

  /** 这道题是不是已经给过（含轻微变体）。用来统计重复率，不拦。 */
  _isRepeat(q) {
    const key = normQuestion(q);
    if (!key) return false;
    return this._suggestedKeys.has(key);
  }

  async newQuestion(q) {
    const prev = this.currentQuestion;
    if (prev && !this.asked.includes(prev)) this.asked.push(prev);
    this.currentQuestion = q || '';
    this.answer = '';
    this.queue = [];
    this.emit('question', { question: this.currentQuestion, askedCount: this.asked.length });
  }

  /**
   * 送入一块文字。立即返回，不阻塞调用方——这是「边说边出题」的前提：
   * 采集端绝不能等推理结果。
   */
  submit(text, meta = {}) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;

    const item = { seq: ++this.seq, text: trimmed, at: Date.now(), ...meta };
    this.stats.chunks++;

    // 本次回答累计。这里【不做概括】，原文直接给模型——
    // 「他到底怎么说的」正是出题的依据，概括会把出题的由头磨掉。
    this.answer = (this.answer ? this.answer + '\n' : '') + trimmed;
    if (this.answer.length > this.opt.answerLimit) {
      this.answer = this.answer.slice(-this.opt.answerLimit);
    }
    this.stats.answerChars.push(this.answer.length);

    this.emit('submitted', item);
    this.queue.push(item);

    // ── 背压策略：合并，而不是丢弃 ────────────────────────────────────────
    // 早期版本在这里直接丢弃最旧的排队项，结果在正常语速下就丢掉了大量内容
    // （实测：8 句只处理了 2 句）。那是错的——「AI 跟不上」不该让【面试内容】消失。
    //
    // 所以：把积压的块合并成一块再送。输入变长一点，但内容零丢失，
    // 而且合并后模型看到的是连续的一段回答，出的题反而更准。
    // 队列长度因此被压在 ≤1，延时有界。
    while (this.queue.length > 1) {
      const older = this.queue.shift();
      const newer = this.queue.shift();
      const merged = { ...newer, text: older.text + newer.text, mergedFrom: [older.seq, newer.seq] };
      this.queue.unshift(merged);
      this.stats.merged++;
      this.emit('merged', { from: [older.seq, newer.seq], into: newer.seq });
    }

    this._pump();
    return item.seq;
  }

  async _pump() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    const item = this.queue.shift();

    try {
      const t0 = Date.now();
      const result = await this._infer(item);
      const ms = Date.now() - t0;

      // 约束 1：乱序丢弃。迟到结果绝不覆盖新结果，
      // 否则面试官会看到屏幕上的题"往回想"，那比题目晚到更难接受。
      if (item.seq <= this.appliedSeq) {
        this.stats.dropped++;
        this.emit('stale', { item, ms });
      } else {
        this.appliedSeq = item.seq;
        this.stats.latency.push(ms);

        // 重复检测：提示词里写了「不要重复」，但那是软的，模型不一定听。
        // 这里做一次确定性的判定，把结果标出来——不是为了拦，
        // 而是为了【量得准】：以前重复率只能靠事后拿大二元组相似度去猜，
        // 那个指标会被共同出现的产品名（LangChain / LangGraph）抬高，
        // 不可靠。引擎自己数，才是准的。
        const dup = this._isRepeat(result.question);
        if (dup) this.stats.repeated++;

        const rec = { seq: item.seq, text: item.text, at: item.at, ms, repeat: dup, ...result };
        this.history.push(rec);
        // 把这条建议记进「给过的建议」，下一轮出题时它会出现在提示词里。
        // 记的是【定稿】而不是 draft：draft 可能被后面更完整的正式结果取代，
        // 记进去会污染列表。
        this._remember(result.question);
        if (dup) this.emit('repeat', { seq: item.seq, question: result.question });
        this.emit('nextq', rec);
      }
    } catch (e) {
      this.stats.failed++;
      this.emit('error', { item, error: e });
    } finally {
      this.busy = false;
      this.abort = null;
      if (this.queue.length) setImmediate(() => this._pump());
    }
  }

  _buildMessages(item) {
    // 前缀缓存的形状：【系统提示词整场不变】。
    // 材料放在系统提示词里；已问过的问题放在第一条 user 消息里，并且只追加。
    // 两者构成一个尽量长的稳定前缀。当前问题和本次回答放在最后，它们是每轮都变的。
    const sys = SYSTEM_PROMPT
      .replace('{MATERIALS}', this.materials || '（本次面试没有提供材料）')
      .replace('{CURRENT_QUESTION}', this.currentQuestion || '（面试官还没提问，候选人在自由陈述）');

    const askedBlock = this.asked.length
      ? `## 已经问过的问题（按时间顺序，不要重复）\n\n${this.asked.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
      : '## 已经问过的问题\n\n（还没有问过任何问题，这是第一个问题）';

    // ⚠️ 「你刚给过的建议」必须放在【最后一条】user 消息里，不能放进上面的稳定前缀。
    // 这个列表每轮都在长，放进前缀等于每轮都把缓存打掉一次。
    // 只保留最近若干条：模型要躲开的是"刚刚说过的话"，
    // 太早的建议既占 token 又和当前的回答上下文无关。
    const recent = this.suggested.slice(-SUGGEST_KEEP);
    const suggestedBlock = recent.length
      ? `## 你刚才已经给过的建议（不要再给一遍，换个角度）\n\n` +
        `${recent.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n`
      : '';

    // 历史场次问过的问题。措辞上刻意和上面的「已经问过的问题」区分开：
    // 那个是【本场】，这个是【以前几场】。如果不区分，模型会以为本次面试
    // 已经进行到了很后面，出题节奏会乱。
    const priorBlock = this.priorAsked.length
      ? `## 以前几场面试问过的问题（尽量避免重复；如果这场的回答确实暴露出新的信息缺口，可以换个角度重问）\n\n` +
        `${this.priorAsked.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n`
      : '';

    return [
      { role: 'system', content: sys },
      { role: 'user', content: askedBlock },
      {
        role: 'user',
        content:
          `## 候选人到目前为止的回答\n\n${this.answer || '（他还没开口）'}\n\n` +
          `## 刚听到的一块（第 ${item.seq} 块）\n\n${item.text}\n\n` +
          priorBlock +
          suggestedBlock +
          `现在给出面试官下一个该问的问题。只输出那四行。`,
      },
    ];
  }

  /**
   * 调用 LLM 出题。
   *
   * 这里是「尽早」的两个关键实现：
   *   1. 开 stream。一旦「问题：」这一行输出完整，立刻 emit('draft') 推给前端，
   *      不等后面那几行生成完。可见延迟因此只取决于首字延迟 + 一行字的时长。
   *   2. max_tokens 压得很低。输出越短，整轮占用的时间越短，
   *      在途请求更快结束，下一块的出题也就更早开始。
   */
  async _infer(item) {
    const ctl = new AbortController();
    this.abort = ctl;
    const timer = setTimeout(() => ctl.abort(), this.opt.timeoutMs);
    const t0 = Date.now();
    let acc = '';
    let draftSent = false;

    const emitDraft = () => {
      if (draftSent) return;
      const q = pickQuestion(acc);
      if (!q) return;
      draftSent = true;
      this.stats.draftLatency.push(Date.now() - t0);
      this.emit('draft', { seq: item.seq, question: q, ms: Date.now() - t0 });
    };

    try {
      const res = await fetch(`${this.opt.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.opt.apiKey}`,
        },
        body: JSON.stringify({
          model: this.opt.model,
          messages: this._buildMessages(item),
          temperature: this.opt.temperature,
          max_tokens: this.opt.maxTokens,
          stream: true,
          // 关掉思考模式，理由见 DEFAULT_ENGINE.disableThinking 的长注释。
          // 网关不认识这个字段时会直接忽略，不影响请求。
          ...(this.opt.disableThinking ? { enable_thinking: false } : {}),
        }),
        signal: ctl.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }

      const ctype = res.headers.get('content-type') || '';
      if (!/event-stream/i.test(ctype)) {
        // 有的网关不认 stream，会直接返回整包 JSON。退化成一次性解析：
        // 功能不受影响，只是失去「第一行先到」这个延迟优势。
        const data = await res.json();
        acc = data?.choices?.[0]?.message?.content ?? '';
        emitDraft();
      } else {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();          // 最后一段可能是半行，留到下一轮再拼
          for (const line of lines) {
            const s = line.trim();
            if (!s.startsWith('data:')) continue;
            const payload = s.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let j = null;
            try { j = JSON.parse(payload); } catch (_) { continue; }
            const delta = j?.choices?.[0]?.delta?.content;
            if (!delta) continue;
            acc += delta;
            emitDraft();
          }
        }
      }

      emitDraft();   // 收尾兜底：模型把四行挤成一行，或者网关没发 stream 头
      return parseNext(acc);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 面试结束：把这场的数据整理出来（复盘在页面上做，这里只交原始材料） */
  summary() {
    return {
      chunks: this.stats.chunks,
      applied: this.appliedSeq + 1,
      dropped: this.stats.dropped,
      merged: this.stats.merged,
      failed: this.stats.failed,
      repeated: this.stats.repeated,
      latencyMs: this.stats.latency,
      draftLatencyMs: this.stats.draftLatency,
      asked: this.asked,
      answer: this.answer,
      history: this.history,
      // 材料被砍掉多少字。界面上要显示出来——静默截断会让人以为
      // 「我明明粘了 20 万字它怎么没看到后面」，而它其实是故意砍的。
      materialsChars: this.materials.length,
      materialsDropped: this.materialsDropped,
    };
  }
}

/** 兼容旧名字：早期调用点还写着 IncrementalJudge */
export const IncrementalJudge = IncrementalQuestioner;

/**
 * 往提示词里喂多少条「以前几场问过的问题」。
 * 40 条大约 600~900 字，够覆盖两三次面试的提问轨迹，又不至于喧宾夺主。
 */
const PAST_ASKED_KEEP = 40;

/* ══════════════════════════════════════════════════════════════════════
 * 输出容错：LLM 经常不守规矩（多写一句、少一行、写成中文冒号）
 * ══════════════════════════════════════════════════════════════════════ */

const VALID_TYPES = { '追问': 'probe', '新方向': 'fresh', '收尾': 'wrap' };

/**
 * 把一道题归一化成可以比较的键，用来判断「这是不是同一句话」。
 *
 * 实测里重复的题几乎都不是逐字相同的，而是差一个开头：
 *   「那 LangChain 原生 Agent 和 LangGraph 差在哪？」
 *   「LangChain 原生 Agent 和 LangGraph 差在哪？」
 * 光比原串抓不住，所以要去掉标点、空白和句首那些没有信息量的词
 * （那 / 那么 / 所以 / 你刚说 …）之后再比。
 *
 * 只做「确定是同一句」的判定，不做模糊相似度：宁可漏掉一个变体，
 * 也不能把两道真的不同的题判成重复——那会让面试官少看到一道好题。
 */
const LEAD_FILLER = /^(那么|那|所以|然后|因此|另外|还有|嗯|你刚说|你刚才说|你刚提到|你提到|你说|你说到)+/;

/**
 * 「你刚给过的建议」保留最近多少条。
 * 取 12：一次面试里候选人说三五分钟大约会听到十几到二十几条建议，
 * 12 条足够盖住"刚刚重复"这个窗口，又不至于把 token 堆高。
 */
const SUGGEST_KEEP = 12;

export function normQuestion(q) {
  return cleanStr(q)
    .replace(/[\s，。、：；！？,.:;!?…—－\-—（）()【】\[\]「」『』“”"']/g, '')
    .replace(LEAD_FILLER, '')
    .trim();
}

// 模型很爱给问题套一层引号。中外文的引号都要剥，否则面试官会看到
// 「“消息没发出去呢？”」这种多余的一层壳。只剥【成对包裹】的，
// 中间出现的引号（比如提到某个字段名）不能动。
const WRAP_OPEN = /^[\s"'\u201c\u201d\u2018\u2019「『（(【\[《〈]+/;
const WRAP_CLOSE = /[\s"'\u201c\u201d\u2018\u2019」』）)】\]》〉]+$/;

export function cleanStr(v) {
  return String(v == null ? '' : v)
    .replace(/\*\*/g, '')
    .replace(WRAP_OPEN, '')
    .replace(WRAP_CLOSE, '')
    .trim();
}

/**
 * 从【流式中】的文本里抠出问题。
 *
 * ⚠️ 这里必须要求「问题：」这一行【已经结束】才返回，否则会把半句话当成完整
 * 问题推给面试官——他念到一半发现屏幕上的字还在长，比晚半秒更糟。
 * 行结束的标志有两个：换行，或者下一个字段（理由：）已经开始。
 */
export function pickQuestion(text) {
  const s = String(text || '');
  const m = s.match(/问\s*题\s*[：:]\s*([\s\S]*?)(?:\n|理\s*由\s*[：:])/);
  if (!m) return '';
  const q = cleanStr(m[1]);
  // 长度 <2 的多半是模型刚吐出一个标点，不是问题
  return q.length >= 2 ? q : '';
}

/** 完整解析四行输出。字段缺失或格式乱掉时尽量退化，不要抛异常。 */
export function parseNext(raw) {
  const s = String(raw || '');

  const grab = (label, tail = true) => {
    const re = new RegExp(label + '\\s*[：:]\\s*(' + (tail ? '[^\\n]*' : '[\\s\\S]*?') + ')');
    const m = s.match(re);
    return m ? cleanStr(m[1]) : '';
  };

  let question = grab('问\\s*题');
  const reason = grab('理\\s*由');
  const basis = grab('依\\s*据');
  const typeRaw = cleanStr(grab('类\\s*型'));

  // ⚠️ 太短的不是问题，别放行。
  //
  // 实测踩过的坑：模型被 max_tokens 截断时，正文只剩「问题：那」两个字。
  // 上面那行 grab 照样匹配成功，于是 question="那"、ok=true，
  // 一条只有一个字的"题目"就这么进了出题历史——面试官屏幕上真的出现过
  // 孤零零的一个「那」。pickQuestion() 有 <2 字的下限，这里却漏了。
  //
  // 阈值就取 2，和 pickQuestion() 保持一致。曾经写成 4，是错的：
  // 那会误杀「多久？」「谁定的？」这类真实存在的一两个字短问句，
  // 而且直接挂掉了 5 个用「A？」当样本的回归测试。
  // 真正防截断的是 disableThinking（见上面的长注释），这里只是兜底，
  // 兜住 1 个字的残渣就够了，不要顺手把短问句也杀了。
  const MIN_QUESTION = 2;
  if (question && question.length < MIN_QUESTION) question = '';

  // 模型完全不守格式时（只给了一句话），至少把第一行有内容的东西当问题用，
  // 别让面试官看到空面板。
  //
  // 但有个例外：如果文本里【出现了任何字段标签】，说明模型是想按格式写的，
  // 只是漏了「问题：」。这时绝不能拿第一行顶上去——否则「理由：他讲了异步落库」
  // 会被当成一道题念给候选人听。这种情况老实报 ok=false。
  if (!question) {
    const hasAnyLabel = /(问\s*题|理\s*由|类\s*型|依\s*据)\s*[：:]/.test(s);
    if (!hasAnyLabel) {
      const firstLine = s.split('\n')
        .map(x => cleanStr(x))
        .find(x => x && !/^[\[{<#`-]/.test(x));
      question = cleanStr(firstLine || '');
    }
  }

  // ⚠️ 这个字段叫 kind，不叫 type。
  // 服务端往 SSE 里发的是 { type: 'nextq', ...结果 }，而事件流的 type 是
  // **路由字段**——用前面那个 type 会被后面的展开覆盖掉，前端拿到
  // type:'probe' 就认不出来，整条结果被静默丢弃。
  // 实测踩过：draft 能上屏、整轮结果永远不出现，logs 一直是 0。
  let kind = '';
  for (const [zh, code] of Object.entries(VALID_TYPES)) {
    if (typeRaw === zh) { kind = code; break; }
  }
  if (!kind) {
    for (const [zh, code] of Object.entries(VALID_TYPES)) {
      if (typeRaw.includes(zh)) { kind = code; break; }
    }
  }
  if (!kind) kind = basis ? 'probe' : 'fresh';   // 有依据的多半是追问

  return {
    question,
    reason,
    kind,
    basis,
    ok: !!question,
    raw: question ? '' : s.slice(0, 300),
  };
}

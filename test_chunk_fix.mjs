// Before/after comparison of the chunker, using the user's REAL transcript.
//
// The "before" side re-implements the old rule exactly as it was
// (engine.mjs:188-189, pre-fix): flush the whole buffer the instant its length
// reaches minChars, with no regard for punctuation. The "after" side imports the
// real Chunker from engine.mjs.
//
// The corpus is the text the user actually ran, reconstructed by concatenating
// the 31 chunk texts in H:\edge_donwload\python\interview-2026-10-16-03-55-33.json.
import { Chunker } from './engine.mjs';

/* ── 用户的真实语料（由导出文件里 31 个块拼回原始文本） ── */
const CORPUS = [
  {
    q: '讲讲你的秒杀系统怎么做库存扣减的',
    text: '我用了 Redis 的 DECR 做预减库存，然后发消息到 RocketMQ，下游异步落库。这样能扛住三万 QPS。',
  },
  {
    q: '（同一题，候选人这次的回答和材料自相矛盾）',
    text: '我用了 Redis 的 DECR 做预减库存，然后发消息到 RocketMQ，下游异步落库。不过我们实际上没有做异步落库，是同步写库的，QPS 峰值大概 5000 左右。',
  },
  {
    q: '这个项目里你觉得最难的地方是什么',
    text: '我觉得最难的不是某一个技术点，而是**"证据不足"这个判断怎么定**。因为这是一个**没有标准答案的判断**——阈值设高了，明明有答案的问题被判定成没答案，用户会觉得这个助手很笨，转人工率很高；阈值设低了，知识库里没有的东西它硬答，用户拿着错的答案去操作，**后果比不回答严重得多**。我最后的处理不是找一个"最准"的阈值，而是**把这个问题拆开**：一方面把判断做成多信号的（分数、条数、模型判断），不要依赖单一指标；另一方面**把不同情况分开处理**——是用户没说清楚，还是知识库真没有，这两个的应对方式完全不同，前者追问，后者转人工。另外我加了**最大澄清轮次**，因为用户不会主动放弃，他会一直试，**这个必须由系统兜住**。\n\n到现在我也认为这个判断是**有误判率的**，我的态度是**宁可错转人工，不要错答**，然后靠持续分析误判的 case 去调',
  },
];

/* ── 旧规则：字数一到就整块冲出去（无标点感知） ── */
function oldChunker(text, { minChars = 18, step = 4 } = {}) {
  const out = [];
  let buf = '';
  for (let i = 0; i < text.length; i += step) {
    buf += text.slice(i, i + step);
    if (buf.length >= minChars) { const t = buf.trim(); buf = ''; if (t) out.push(t); }
  }
  const t = buf.trim(); if (t) out.push(t);
  return out;
}

/* ── 新规则：用真实 Chunker，按回放语速喂进去 ── */
async function newChunker(text, { cps = 4, tick = 0 } = {}) {
  const ch = new Chunker();
  const out = [];
  ch.on('chunk', c => out.push(c));
  const step = Math.max(1, Math.round(cps / 10));
  for (let i = 0; i < text.length; i += step) {
    ch.push(text.slice(i, i + step));
    if (tick) await new Promise(r => setTimeout(r, tick));
  }
  ch.flushNow('replayEnd');
  ch.close();
  return out;
}

const fmt = s => `${String(s.length).padStart(3)}字 │ ${s}`;

/* 统计：短块（<=10 字）占比，这是"切片太短了无意义"的量化指标 */
function stats(list) {
  const texts = list.map(x => typeof x === 'string' ? x : x.text);
  const lens = texts.map(t => t.length);
  const short = lens.filter(n => n <= 10).length;
  const mid = lens.filter(n => n > 10 && n < 24).length;
  const nums = [...lens].sort((a, b) => a - b);
  return {
    blocks: lens.length,
    avg: (lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(1),
    min: nums[0], p50: nums[Math.floor(nums.length / 2)], max: nums[nums.length - 1],
    shortBlocks: short, midShortBlocks: mid,
    shortRatio: ((short / lens.length) * 100).toFixed(0) + '%',
  };
}

for (const [i, c] of CORPUS.entries()) {
  console.log('═'.repeat(78));
  console.log(`语料 ${i + 1}（${c.text.length} 字）：${c.q}`);
  console.log('═'.repeat(78));

  const before = oldChunker(c.text);
  const after = await newChunker(c.text);

  console.log(`\n【修复前】切出 ${before.length} 块`);
  before.forEach(t => console.log('  ' + fmt(t)));
  console.log(`  统计: ${JSON.stringify(stats(before))}`);

  console.log(`\n【修复后】切出 ${after.length} 块`);
  for (const x of after) console.log(`  ${fmt(x.text)}  ← ${x.reason}`);
  console.log(`  统计: ${JSON.stringify(stats(after))}\n`);
}

/* ── 断言：修复后不允许出现"把英文词劈开"的块 ── */
console.log('═'.repeat(78));
console.log('回归断言');
console.log('═'.repeat(78));
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ✅ ${name}${detail ? ' · ' + detail : ''}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? ' · ' + detail : ''}`); fail++; }
};

const all = [];
for (const c of CORPUS) all.push(...(await newChunker(c.text)));

check('没有块会把 RocketMQ 劈成两半',
  !all.some(x => /Rocket$/.test(x.text)) && !all.some(x => /^MQ/.test(x.text)),
  all.filter(x => /Rocket|^MQ/.test(x.text)).map(x => x.text).join(' | ') || '无');

check('没有 10 字以下的碎片块', all.every(x => x.text.length > 10),
  all.filter(x => x.text.length <= 10).map(x => `"${x.text}"`).join(' ') || '无');

check('不再有倒下的孤块 "QPS。"',
  !all.some(x => /^QPS[。.]?$/.test(x.text)),
  all.filter(x => /^QPS/.test(x.text)).map(x => `"${x.text}"`).join(' ') || '无');

check('绝大多数块在标点处结束',
  all.filter(x => /[。！？；，、：!?;,]$/.test(x.text)).length >= all.length * 0.7,
  `${all.filter(x => /[。！？；，、：!?;,]$/.test(x.text)).length}/${all.length}`);

console.log(`\n  结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

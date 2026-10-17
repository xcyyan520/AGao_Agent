// 手动测试前的「铺料」脚本：把真实语料灌进服务端，并生成回放用的干净文本。
//
// 解决的痛点：手动测试要在浏览器里粘两坨东西——
//   1. 面试材料：云联-逐字稿.md 全文（16886 字）
//   2. 回放文本：逐字稿「模块四」正文，但必须先洗掉 markdown 记号和【】提示，
//      因为【】里写着"不用念出来"，真人不会念。手洗 2235 字不现实。
//
// 这个脚本做两件事：
//   - POST /api/materials + /api/question，把 ① 和首个问题灌好（不用你再粘）
//   - 把洗干净的 ② 写到 测试语料-回放用.txt，你打开它全选复制即可
//
// 用法：
//   node .run/prep_test.mjs              # 灌默认的第一题
//   node .run/prep_test.mjs 3            # 灌面试题.txt 的第 3 题
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8900';
const SESSION = process.env.SESSION || 'default';
const pick = Number(process.argv[2] || 1);

const transcript = readFileSync('云联-逐字稿.md', 'utf8');
const realQuestions = readFileSync('面试题.txt', 'utf8')
  .split('\n').map((s) => s.trim()).filter(Boolean);

if (!realQuestions.length) throw new Error('面试题.txt 是空的');
const QUESTION = realQuestions[Math.min(pick, realQuestions.length) - 1];

// 和 .run/e2e_real_corpus.mjs 用同一套清洗规则，保证手测和自动测是同一份输入
const m4start = transcript.indexOf('### 模块四：AI Agent 编排模块');
const m4end = transcript.indexOf('\n## 六、三个必答题');
if (m4start < 0 || m4end < 0) throw new Error('抽不到模块四，逐字稿结构变了');
const spoken = transcript.slice(m4start, m4end)
  .replace(/^###.*$/gm, '')
  .replace(/\*\*/g, '')
  .replace(/【[^】]*】/g, '')
  .replace(/★/g, '')
  .replace(/`/g, '')
  .replace(/^\s*[-–—]{3,}\s*$/gm, '')
  .replace(/^\s*[-*]\s+/gm, '')
  .replace(/^\s*\d+\.\s+/gm, '')
  .replace(/[ \t]+/g, '')
  .replace(/\n{2,}/g, '\n')
  .replace(/\n+/g, '')
  .trim();

const OUT = '测试语料-回放用.txt';
writeFileSync(OUT, spoken, 'utf8');

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status} ${t.slice(0, 200)}`);
  return JSON.parse(t);
}

const matRes = await post('/api/materials', { session: SESSION, materials: transcript });
const qRes = await post('/api/question', { session: SESSION, question: QUESTION });

console.log('════════ 测试语料已铺好 ════════\n');
console.log(`材料：云联-逐字稿.md 全文 → 服务端已收到 ${matRes.chars} 字 ✅`);
console.log(`首个问题：${QUESTION}`);
console.log(`         → 已记为「当前面试官的问题」✅ ${qRes.ok ? '' : '（返回异常，看看服务端日志）'}`);
console.log(`\n回放文本：洗干净的模块四 ${spoken.length} 字 → 已写到 ${OUT}`);
console.log(`         打开它，全选复制，粘到页面左侧「模拟候选人说话」框里。\n`);
console.log('接下来在浏览器里：');
console.log('  1. 打开 http://127.0.0.1:8900');
console.log('  2. 左侧「面试材料」框可以留空（服务端已经有了），但建议把全文粘上');
console.log('     让页面显示的字数对上，免得你以为没生效');
console.log(`  3. 「模拟候选人说话」粘 ${OUT} 的内容`);
console.log('  4. 点「▶ 开始回放」，然后就看着右上角「下一个问题」跟着变\n');

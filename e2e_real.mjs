// 端到端验证：把用户真实导出的面试回答，按真实语速喂进正在运行的服务，
// 看实际切出多少块、每块延迟多少、判断结果如何。
// 这条路径和浏览器里点『开始回放』完全一致（/events + /api/replay）。
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8900';
const S = 'e2e_' + Date.now();

const file = process.argv[2];
if (!file) { console.error('用法: node e2e_replay.mjs <interview-*.json>'); process.exit(2); }

const j = JSON.parse(fs.readFileSync(file, 'utf8'));
const oldTexts = (j.history || []).filter(h => h.text).map(h => h.text);
const ANSWER = oldTexts.join('');
console.log(`来源: ${file}`);
console.log(`原文 ${ANSWER.length} 字（旧版切成 ${oldTexts.length} 块）`);
console.log(`按 4 字/100ms 回放，约 ${Math.round(ANSWER.length / 4 * 0.1)}s\n`);

const t0 = Date.now();
const chunks = [];
const ac = new AbortController();

const dump = (async () => {
  const r = await fetch(`${BASE}/events?s=${S}`, { signal: ac.signal });
  const dec = new TextDecoder();
  let buf = '';
  for await (const part of r.body) {
    buf += dec.decode(part, { stream: true });
    const blocks = buf.split('\n\n');
    buf = blocks.pop();
    for (const b of blocks) {
      const m = b.match(/^data: (.*)$/m);
      if (!m) continue;
      let ev; try { ev = JSON.parse(m[1]); } catch { continue; }
      if (ev.type === 'chunk') chunks.push({ seq: ev.seq, text: ev.text, reason: ev.reason, at: Date.now() - t0 });
      if (ev.type === 'verdict') {
        const c = chunks.find(x => x.text === ev.text);
        if (c) { c.verdict = ev.verdict; c.ms = ev.ms; c.comment = ev.comment; }
      }
      if (ev.type === 'replay_end') return;
    }
  }
})().catch(() => {});

await new Promise(r => setTimeout(r, 300));
await fetch(`${BASE}/api/materials`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ session: S, materials: '候选人简历：负责秒杀系统，声称 QPS 峰值 3 万。\n（以上为候选人自己提供的项目资料）' }),
});

await fetch(`${BASE}/api/replay`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ session: S, text: ANSWER, charsPer100ms: 4 }),
});

await Promise.race([dump, new Promise(r => setTimeout(r, 120000))]);
ac.abort();
await new Promise(r => setTimeout(r, 4000));

const st = await (await fetch(`${BASE}/api/state?s=${S}`)).json();
const hist = st.history || [];

console.log('─'.repeat(78));
console.log(`新切块 ${hist.length} 块：\n`);
hist.forEach((h, i) => {
  const c = chunks.find(x => x.text === h.text);
  const when = c ? `+${(c.at / 1000).toFixed(1)}s` : '  -  ';
  console.log(`  ${String(i + 1).padStart(2)}. [${String(h.text.length).padStart(3)}字] ${when.padStart(7)} 判定${String(h.ms).padStart(5)}ms  ${h.verdict}`);
  console.log(`      ${h.text.replace(/\n/g, ' ⏎ ')}`);
});

const lens = hist.map(h => h.text.length);
const tiny = lens.filter(n => n < 12).length;
const midWord = hist.filter(h => /[A-Za-z0-9]$/.test(h.text)).length;
const oldLens = oldTexts.map(t => t.length);
const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;

console.log('─'.repeat(78));
console.log(`                       旧      新`);
console.log(`  块数              ${String(oldTexts.length).padStart(4)}   ${String(hist.length).padStart(4)}`);
console.log(`  平均块长(字)      ${String(avg(oldLens)).padStart(4)}   ${String(avg(lens)).padStart(4)}`);
console.log(`  最短块(字)        ${String(Math.min(...oldLens)).padStart(4)}   ${String(Math.min(...lens)).padStart(4)}`);
console.log(`  碎块 <12字        ${String(oldLens.filter(n => n < 12).length).padStart(4)}   ${String(tiny).padStart(4)}`);
console.log(`  疑似劈词          ${String(oldTexts.filter(t => /[A-Za-z0-9]$/.test(t)).length).padStart(4)}   ${String(midWord).padStart(4)}`);
console.log(`  RocketMQ 被劈开   ${oldTexts.some(t => /Rocket$/.test(t)) ? '是' : '否'}     ${hist.some(h => /Rocket$/.test(h.text)) ? '是' : '否'}`);
console.log(`  首块延迟          ${'? 旧版按18字硬切'.padEnd(6)} +${((chunks[0]?.at || 0) / 1000).toFixed(1)}s`);
console.log(`\n  stats: ${JSON.stringify(st.stats)}`);

// 量一下库里到底有多少数据。用户问「历史加载是不是数据量大到要换 MySQL」，
// 这个问题必须有数字，不能靠感觉答。
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/app.db');

const rows = (sql) => {
  try { return db.prepare(sql).get(); } catch { return null; }
};

console.log('=== 行数 ===');
for (const t of ['materials', 'sessions', 'suggestions', 'turns']) {
  const r = rows(`SELECT COUNT(*) AS n FROM ${t}`);
  console.log(`  ${t.padEnd(12)} ${r?.n ?? '?'}`);
}

console.log('\n=== 文本量（字节） ===');
const m = rows('SELECT SUM(LENGTH(text)) AS b FROM materials');
console.log(`  materials.text      ${m?.b ?? 0}`);
const s = rows('SELECT SUM(LENGTH(question)+LENGTH(reason)+LENGTH(basis)) AS b FROM suggestions');
console.log(`  suggestions 四字段  ${s?.b ?? 0}`);
const tu = rows('SELECT SUM(LENGTH(question)) AS b FROM turns');
console.log(`  turns 问句          ${tu?.b ?? 0}`);

console.log('\n=== 平均每条建议的字节数 ===');
const avg = rows('SELECT AVG(LENGTH(question)+LENGTH(COALESCE(reason,\'\'))+LENGTH(COALESCE(basis,\'\'))) AS a FROM suggestions');
console.log(`  ${Math.round(avg?.a ?? 0)} 字节/条`);

console.log('\n=== 一场面试的量级推算 ===');
const perSugg = Math.round(avg?.a ?? 60);
const perSession = perSugg * 80 + 240; // 80 条建议 + 一场的元数据
console.log(`  80 条建议 ≈ ${(perSession / 1024).toFixed(1)} KB / 场`);
console.log(`  100 场     ≈ ${(perSession * 100 / 1024 / 1024).toFixed(2)} MB`);
console.log(`  1000 场    ≈ ${(perSession * 1000 / 1024 / 1024).toFixed(2)} MB`);

const pc = rows('PRAGMA page_count');
const ps = rows('PRAGMA page_size');
if (pc && ps) console.log(`\n实际页数 ${pc.page_count} × ${ps.page_size} = ${((pc.page_count * ps.page_size) / 1024).toFixed(0)} KB`);

db.close();

/* 多音轨探针：1 个候选人 + 2 个面试官，同时开着，互不干扰。
 *
 * 验的是这次改造的**核心承诺**：
 *   - 两个面试官各开一条，不会互相顶掉
 *   - 候选人那条不被面试官的开工影响
 *   - 同一条音轨重复「开始」是幂等的，不重连、不丢音频
 *   - 换角色不重连（这一条只能在浏览器里验，这里验服务端语义）
 *   - 音轨表能列出全部，附带 label
 *
 * 用假音频（静音 PCM）：不指望识别出字，只看音轨生命周期对不对。
 * 真识别链路已经由 probe_asr_e2e.mjs 单独验过了。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8900';
const SID = 'tracks_' + Date.now();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' · ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' · ' + extra : ''}`); }
};

const postJSON = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
};
const getJSON = async (p) => (await fetch(BASE + p)).json();

// 250ms 的 16k 单声道静音
const SILENCE = Buffer.alloc(16000 * 2 / 4);

async function feed(track, bytes = SILENCE) {
  const r = await fetch(`${BASE}/api/asr/feed?s=${SID}&track=${encodeURIComponent(track)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
  });
  return r.json();
}

const tracks = async () => (await getJSON(`/api/asr/tracks?s=${SID}`)).tracks;

console.log(`\n=== 多音轨 · 场次 ${SID} ===\n`);

/* ── 1. 开三条轨 ── */
console.log('【1】三个人各开一条');
const r1 = await postJSON('/api/asr/start', { session: SID, track: 'candidate', role: 'candidate', label: '候选人' });
ok('候选人那条开起来', r1.ok === true, r1.error || '');
const r2 = await postJSON('/api/asr/start', { session: SID, track: 'iv_a', role: 'interviewer', label: '张工' });
ok('面试官 A 那条开起来', r2.ok === true, r2.error || '');
const r3 = await postJSON('/api/asr/start', { session: SID, track: 'iv_b', role: 'interviewer', label: '李工' });
ok('面试官 B 那条开起来', r3.ok === true, r3.error || '');

let t = await tracks();
ok('音轨表里有三条', t.length === 3, `实际 ${t.length}`);
ok('两条是面试官', t.filter(x => x.role === 'interviewer').length === 2);
ok('一条是候选人', t.filter(x => x.role === 'candidate').length === 1);
ok('label 带出来了', t.some(x => x.label === '张工') && t.some(x => x.label === '李工'),
  t.map(x => x.label).join('/'));
ok('三条都在 listening', t.every(x => x.listening === true));

/* ── 2. 两个面试官并行喂音频：A 的开工不该影响 B ── */
console.log('\n【2】两个面试官同时说话，互不干扰');
const fa = await feed('iv_a');
const fb = await feed('iv_b');
ok('A 的音频被接收', fa.accepted > 0, `${fa.accepted} 字节`);
ok('B 的音频被接收', fb.accepted > 0, `${fb.accepted} 字节`);
t = await tracks();
ok('喂完两条都还在', t.length === 3);
ok('两条面试官都还 listening', t.filter(x => x.role === 'interviewer').every(x => x.listening));

/* ── 3. 幂等：同一条重复「开始」不重连 ── */
console.log('\n【3】重复点「开始」不该把连接拆了重建');
const before = (await tracks()).find(x => x.track === 'iv_a');
const r4 = await postJSON('/api/asr/start', { session: SID, track: 'iv_a', role: 'interviewer', label: '张工' });
ok('重复开始返回 ok', r4.ok === true);
ok('返回里标了 reused（复用了现有连接）', r4.reused === true, JSON.stringify(r4));
const after = (await tracks()).find(x => x.track === 'iv_a');
ok('startedAt 没变（没重建）', before.startedAt === after.startedAt,
  `${before.startedAt} -> ${after.startedAt}`);
const fa2 = await feed('iv_a');
ok('复用之后还能继续喂音频', fa2.accepted > 0, `${fa2.accepted} 字节`);

/* ── 4. 换角色不重连 ── */
console.log('\n【4】换角色只改标签，不碰连接');
const r5 = await postJSON('/api/asr/start', { session: SID, track: 'iv_a', role: 'candidate', label: '张工' });
ok('同一条轨换成候选人角色：成功', r5.ok === true);
ok('仍然是 reused（音频流没断）', r5.reused === true);
t = await tracks();
const a = t.find(x => x.track === 'iv_a');
ok('角色确实改成了 candidate', a && a.role === 'candidate', a && a.role);
ok('label 保留原样', a && a.label === '张工', a && a.label);
ok('还在 listening（没重连）', a && a.listening === true);

/* ── 5. 停其中一条，其余不受影响 ── */
console.log('\n【5】关掉一条，别人不受影响');
await postJSON('/api/asr/stop', { session: SID, track: 'iv_b' });
t = await tracks();
ok('只剩两条', t.length === 2, `实际 ${t.length}`);
ok('被关的那条不在了', !t.some(x => x.track === 'iv_b'));
ok('另外两条还 listening', t.every(x => x.listening));
const fc = await feed('candidate');
ok('候选人那条还能喂', fc.accepted > 0, `${fc.accepted} 字节`);
const dead = await feed('iv_b');
ok('往已关的轨喂音频：静默丢弃不报错', dead.ok === true && dead.accepted === 0);

/* ── 6. 状态接口也带上了音轨表 ── */
console.log('\n【6】/api/state 里也有音轨表');
const st = await getJSON(`/api/state?s=${SID}`);
ok('state.tracks 是数组', Array.isArray(st.tracks), typeof st.tracks);
ok('数量对得上', st.tracks.length === 2, `state ${st.tracks.length} / tracks ${t.length}`);
ok('每项都带 role 与 listening', st.tracks.every(x => x.role && 'listening' in x));

/* ── 7. 清场 ── */
console.log('\n【7】清场');
for (const x of (await tracks())) {
  await postJSON('/api/asr/stop', { session: SID, track: x.track });
}
t = await tracks();
ok('全部关掉后音轨表空了', t.length === 0, `实际 ${t.length}`);
await postJSON('/api/sessions/delete', { session: SID });
await postJSON('/api/reset', { session: SID });

console.log(`\n───────────────────────────────`);
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
console.log(`───────────────────────────────\n`);
process.exit(fail ? 1 : 0);

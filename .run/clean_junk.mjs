/* 清掉自动化测试在库里留下的场次与材料。
   判据：id 以这些前缀开头 —— uimic_（麦克风检查）、asr（ASR 探针）、
   ui_（界面检查）、tunnel_（隧道检查）、corpus_（真实语料压测）、
   probe_（各探针脚本）。
   这些都是脚本造的，不是人真面过的。
   注意前缀要**带下划线**，写 'test_' 会连 'test_...' 的自动场次一起清掉，
   但写 'test'（不带下划线）就会误伤任何以 test 开头的东西——宁可窄不要宽。 */
import { openStore } from '../store.mjs';

const PREFIXES = ['uimic_', 'uihist_', 'asr_', 'asr', 'ui_', 'uib_', 'tunnel_', 'corpus_', 'p_', 'test_', 'probe_', 'twodev_', 'captest', 'uifix'];

const st = openStore();
const sessions = st.listSessions(1000);
const junk = sessions.filter(s => PREFIXES.some(p => String(s.id).startsWith(p)));

console.log(`库里有 ${sessions.length} 场，其中测试造的 ${junk.length} 场：`);
for (const s of junk) console.log(`  - ${s.id}  (${s.suggestions} 题 / ${s.turns} 轮)`);

for (const s of junk) st.deleteSession(s.id);

// 材料：名字是「会话 xxx 的材料」这种自动生成的，也一并清掉
const mats = st.listMaterials();
const junkMats = mats.filter(m => /^会话 \S+ 的材料$/.test(String(m.name || '')));
console.log(`\n材料 ${mats.length} 份，其中自动生成的 ${junkMats.length} 份：`);
for (const m of junkMats) console.log(`  - #${m.id} ${m.name} (${m.chars} 字)`);
for (const m of junkMats) st.deleteMaterial(m.id);

const after = st.listSessions(1000);
const afterMats = st.listMaterials();
console.log(`\n清完：${after.length} 场 / ${afterMats.length} 份材料`);
for (const s of after) console.log(`  留：${s.id}  (${s.suggestions} 题)`);
st.close();

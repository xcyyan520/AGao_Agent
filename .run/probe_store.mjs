import { openStore, resetStore } from '../store.mjs';
const db = openStore('.run/_t.db');
const m = db.saveMaterial('云联逐字稿', '这是一份很长的材料。'.repeat(100));
console.log('saveMaterial:', JSON.stringify(m));
const m2 = db.saveMaterial('云联逐字稿', '更新后的材料');
console.log('再次同名保存 ->', JSON.stringify(m2));
console.log('列表:', JSON.stringify(db.listMaterials()));
db.ensureSession('s1', m.id, '第一场');
db.addSuggestion('s1', { seq: 1, question: 'Redis 预减失败怎么办？', reason: '他跳过了', kind: 'probe', ms: 900, at: Date.now() });
db.addSuggestion('s1', { seq: 2, question: '', reason: '空题不该入库' });
db.addTurn('s1', '讲一下你的项目');
db.addTurn('s1', '那 Redis 怎么用的');
db.ensureSession('s2');
db.addTurn('s2', '上一场问过的问题');
console.log('sessions:', JSON.stringify(db.listSessions()));
console.log('sessionData:', JSON.stringify(db.getSessionData('s1')));
console.log('跨场记忆（排除 s2）:', JSON.stringify(db.getAskedFromOtherSessions('s2')));
resetStore();



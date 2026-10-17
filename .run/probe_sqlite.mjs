import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
db.prepare('INSERT INTO t (v) VALUES (?)').run('helloworld');
console.log('sqlite OK:', JSON.stringify(db.prepare('SELECT * FROM t').all()));


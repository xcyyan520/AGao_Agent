/* ══════════════════════════════════════════════════════════════════════
 * store.mjs —— 落盘存储（材料库 / 面试历史 / 出过的题）
 *
 * 为什么需要这个文件
 * ─────────────────────────────────────────────────────────────────────
 * 在这个文件出现之前，整个服务是纯内存的：`server.mjs` 里一个
 * `const sessions = new Map()` 装下所有东西。后果有三个，全部是真实的
 * 使用痛点，不是理论问题：
 *
 *   1. 「面试材料」每次都要重新粘一遍。候选人的逐字稿动辄上万字，刷新
 *      一次页面就得重粘，服务重启更是全丢。
 *   2. 面试过程一点记录都不留。关掉窗口，这一场问了什么、AI 建议过什么、
 *      候选人答了什么，全都没了，没法复盘。
 *   3. AI 完全不记得上一场。每场面试都是从零开始，同一个候选人隔一周
 *      再来，问的还是那几道题。
 *
 * 为什么用 node:sqlite 而不是 npm 装个什么
 * ─────────────────────────────────────────────────────────────────────
 * 这个项目的卖点之一是**零依赖**（`package.json` 都没有，clone 下来
 * `node server.mjs` 就能跑）。Node 22 起内置了 `node:sqlite`，Node 24
 * 已经是稳定可用的状态（会打一条 ExperimentalWarning，仅此而已）。
 * 用它就不用引入 better-sqlite3（那个还要编译原生模块，在 Windows 上
 * 装起来能让人放弃）。
 *
 * 代价：需要 Node >= 22.5。低于这个版本启动会直接报错，所以
 * `openStore()` 里做了显式检查并给出人能看懂的提示，而不是抛一个
 * "Cannot find module 'node:sqlite'"。
 *
 * 数据在哪
 * ─────────────────────────────────────────────────────────────────────
 *   data/app.db      —— SQLite 单文件，用任何 sqlite 工具都能打开
 *   data/app.db-wal  —— WAL 日志，别删
 * 整个 data/ 目录在 .gitignore 里，不进仓库（里面有真实候选人资料）。
 * ══════════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/* 只用来 require 内置模块（node:sqlite），不会去加载任何第三方包，
   "零依赖" 的承诺不变。 */
const require0 = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* 数据库文件的位置可以用 APP_DB 环境变量改。
   测试时指向临时文件或者 :memory:，免得把真实资料搅进来。 */
const DB_PATH = process.env.APP_DB || path.join(__dirname, 'data', 'app.db');

/**
 * 打开数据库并建表。幂等：重复调用返回同一个实例。
 * @returns {ReturnType<typeof openRaw>}
 */
let _db = null;

function openRaw() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require0('node:sqlite'));
  } catch (e) {
    throw new Error(
      '这个版本的 Node 没有内置 node:sqlite（需要 Node >= 22.5，推荐 24）。\n' +
      `当前版本：${process.version}\n` +
      '升级 Node 即可，不需要装任何 npm 包。'
    );
  }
  return DatabaseSync;
}

export function openStore(dbPath = DB_PATH) {
  if (_db) return _db;

  const DatabaseSync = openRaw();

  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);

  /* WAL：读写不互相阻塞。这个场景是「页面每 2 秒轮询读一次 + 出题时写
     一次」，量很小，但 WAL 顺带让「面试进行中导出复盘」不会卡住写入。
     NORMAL 同步级别意味着断电可能丢最后几条，对面试记录可以接受，
     比 FULL 快得多。 */
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');

  /* ── 表结构 ────────────────────────────────────────────────────────
     materials    材料库。一份逐字稿存一行，反复使用。
     sessions     一场面试。id 就是页面 URL 上的 ?s=xxx。
     suggestions  AI 出过的题（含理由/类型/依据/耗时），复盘用。
     turns        面试官真正问出口的问题 + 候选人的回答。这才是「历史
                  消息」，也是跨场记忆的依据。
     ──────────────────────────────────────────────────────────────── */
  db.exec(`
    CREATE TABLE IF NOT EXISTS materials (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      text       TEXT    NOT NULL,
      chars      INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT    PRIMARY KEY,
      material_id  INTEGER,
      title        TEXT,
      started_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS suggestions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT    NOT NULL,
      seq        INTEGER,
      question   TEXT    NOT NULL,
      reason     TEXT,
      kind       TEXT,
      basis      TEXT,
      ms         INTEGER,
      at         INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS turns (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT    NOT NULL,
      question   TEXT    NOT NULL,
      answer     TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sugg_session ON suggestions(session_id, id);
    CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, id);
    CREATE INDEX IF NOT EXISTS idx_sessions_time ON sessions(updated_at DESC);
  `);

  const now = () => Date.now();

  const api = {
    raw: db,
    path: dbPath,

    /* ══ 材料库 ═══════════════════════════════════════════════════════ */

    /**
     * 存一份材料。同名视为更新（免得材料库里堆出十个「云联逐字稿」）。
     * @returns {{id:number, name:string, chars:number, updated:boolean}}
     */
    saveMaterial(name, text) {
      const t = String(text ?? '');
      const n = String(name || '').trim() || '未命名材料';
      const existing = db.prepare('SELECT id FROM materials WHERE name = ?').get(n);
      if (existing) {
        db.prepare('UPDATE materials SET text = ?, chars = ?, updated_at = ? WHERE id = ?')
          .run(t, t.length, now(), existing.id);
        return { id: existing.id, name: n, chars: t.length, updated: true };
      }
      const r = db.prepare('INSERT INTO materials (name, text, chars, created_at, updated_at) VALUES (?,?,?,?,?)')
        .run(n, t, t.length, now(), now());
      return { id: Number(r.lastInsertRowid), name: n, chars: t.length, updated: false };
    },

    /** 材料列表，**不带正文**（正文可能上万字，列表页不需要）。 */
    listMaterials() {
      return db.prepare('SELECT id, name, chars, created_at, updated_at FROM materials ORDER BY updated_at DESC').all();
    },

    getMaterial(id) {
      return db.prepare('SELECT * FROM materials WHERE id = ?').get(Number(id)) || null;
    },

    deleteMaterial(id) {
      return db.prepare('DELETE FROM materials WHERE id = ?').run(Number(id)).changes > 0;
    },

    /* ══ 会话 ═════════════════════════════════════════════════════════ */

    /** 确保这个 session id 在库里有一行。存在就不动，返回 {created}。 */
    ensureSession(id, materialId = null, title = null) {
      const sid = String(id);
      const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
      if (row) {
        db.prepare('UPDATE sessions SET updated_at = ?' +
          (materialId !== null ? ', material_id = ?' : '') +
          (title ? ', title = ?' : '') +
          ' WHERE id = ?')
          .run(...[now(), ...(materialId !== null ? [materialId] : []), ...(title ? [title] : []), sid]);
        return { created: false, session: db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid) };
      }
      db.prepare('INSERT INTO sessions (id, material_id, title, started_at, updated_at) VALUES (?,?,?,?,?)')
        .run(sid, materialId, title, now(), now());
      return { created: true, session: db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid) };
    },

    touchSession(id) {
      db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now(), String(id));
    },

    /** 历史场次列表，带建议数和提问数，供页面「历史面试」面板用。 */
    listSessions(limit = 50) {
      return db.prepare(`
        SELECT s.id, s.title, s.started_at, s.updated_at, s.material_id,
               (SELECT COUNT(*) FROM suggestions g WHERE g.session_id = s.id) AS suggestions,
               (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id)       AS turns,
               m.name AS material_name
        FROM sessions s
        LEFT JOIN materials m ON m.id = s.material_id
        ORDER BY s.updated_at DESC
        LIMIT ?
      `).all(Number(limit) || 50);
    },

    /**
     * 恢复一场面试时要的数据：这场问过什么、AI 建议过什么。
     * @returns {{turns:Array, suggestions:Array}|null}
     */
    getSessionData(id) {
      const sid = String(id);
      const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
      if (!row) return null;
      const turns = db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY id').all(sid);
      const suggestions = db.prepare('SELECT * FROM suggestions WHERE session_id = ? ORDER BY id').all(sid);
      return { session: row, turns, suggestions };
    },

    deleteSession(id) {
      return db.prepare('DELETE FROM sessions WHERE id = ?').run(String(id)).changes > 0;
    },

    /* ══ 出过的题 ═════════════════════════════════════════════════════ */

    addSuggestion(sessionId, rec) {
      const sid = String(sessionId);
      api.ensureSession(sid);
      const q = String(rec.question || '').trim();
      if (!q) return null;   // 格式崩了、没取出题的那种，不往库里写
      const r = db.prepare(
        'INSERT INTO suggestions (session_id, seq, question, reason, kind, basis, ms, at) VALUES (?,?,?,?,?,?,?,?)'
      ).run(sid, rec.seq ?? null, q, rec.reason || '', rec.kind || '', rec.basis || '', rec.ms ?? null, rec.at || now());
      api.touchSession(sid);
      return Number(r.lastInsertRowid);
    },

    /* ══ 面试官真问出口的问题（历史消息） ═════════════════════════════ */

    addTurn(sessionId, question, answer = null) {
      const sid = String(sessionId);
      api.ensureSession(sid);
      const q = String(question || '').trim();
      if (!q) return null;
      const r = db.prepare('INSERT INTO turns (session_id, question, answer, created_at) VALUES (?,?,?,?)')
        .run(sid, q, answer, now());
      api.touchSession(sid);
      return Number(r.lastInsertRowid);
    },

    /* ══ 跨场记忆 ═════════════════════════════════════════════════════
       这是用户问的「AI 是不是不记得之前面试过的内容」的直接答案。

       以前：每场面试的 `asked` 列表都从空数组开始，模型完全不知道
       上一场问过什么，同一个候选人再面一次还是那几道题。

       现在：把**其他场次**里面试官真问过的问题捞出来，喂回提示词，
       让模型知道「这些已经问过了，别再问」。
       只取 `turns`（面试官真问出口的），不取 `suggestions`（AI 建议但
       可能没采用的）——后者噪声大，把建议也塞进去会让模型误以为
       那些问题「已经问过了」而不敢再出，反而变窄。
       ──────────────────────────────────────────────────────────────── */
    getAskedFromOtherSessions(excludeSessionId, limit = 40) {
      return db.prepare(`
        SELECT question, MAX(created_at) AS last_at
        FROM turns
        WHERE session_id != ?
        GROUP BY question
        ORDER BY last_at DESC
        LIMIT ?
      `).all(String(excludeSessionId), Number(limit) || 40).map(r => r.question);
    },

    /** 关库。测试里用得上。 */
    close() {
      try { db.close(); } catch (_) {}
      _db = null;
    },
  };

  _db = api;
  return api;
}

/** 测试用：强制关掉并重开（换 dbPath 时必需）。 */
export function resetStore() {
  if (_db) { try { _db.close(); } catch (_) {} }
  _db = null;
}

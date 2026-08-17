import Database from 'better-sqlite3';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
function parseAttachmentPaths(value) {
    if (typeof value !== 'string')
        return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
    }
    catch {
        return [];
    }
}
export const TEAM_SCHEMA_VERSION = 3;
const parseChallenge = (row) => ({
    challengeId: String(row.challengeId),
    title: String(row.title),
    category: row.category,
    description: String(row.description),
    attachmentPaths: parseAttachmentPaths(row.attachmentPaths),
    status: row.status,
    ...(row.flag === null || row.flag === undefined ? {} : { flag: String(row.flag) }),
    createdAt: Number(row.createdAt),
});
/** Open the durable team store and initialize its tables and query indexes. */
export function createDb(dbPath) {
    const fullPath = resolve(dbPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    const db = new Database(fullPath);
    let closed = false;
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    db.exec(`
    CREATE TABLE IF NOT EXISTS team_schema (
      version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS challenges (
      challengeId TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      attachmentPaths TEXT NOT NULL,
      status TEXT NOT NULL,
      flag TEXT,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shared_notes (
      challengeId TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updatedBy TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_notes (
      id TEXT PRIMARY KEY,
      challengeId TEXT NOT NULL,
      authorUserId TEXT NOT NULL,
      content TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_thoughts (
      id TEXT PRIMARY KEY,
      challengeId TEXT NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      challengeId TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subtasks (
      taskId TEXT PRIMARY KEY,
      challengeId TEXT NOT NULL,
      ownerUserId TEXT NOT NULL,
      prompt TEXT NOT NULL,
      done INTEGER NOT NULL,
      result TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS team_notes_challenge_created ON team_notes (challengeId, createdAt);
    CREATE INDEX IF NOT EXISTS agent_thoughts_challenge_created ON agent_thoughts (challengeId, createdAt);
    CREATE INDEX IF NOT EXISTS evidence_challenge_created ON evidence (challengeId, createdAt);
    CREATE INDEX IF NOT EXISTS subtasks_challenge_created ON subtasks (challengeId, createdAt);
    CREATE TABLE IF NOT EXISTS team_operations (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      opId TEXT NOT NULL UNIQUE,
      peerId TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS team_operations_created ON team_operations (createdAt, sequence);
    CREATE TABLE IF NOT EXISTS team_versions (
      scope TEXT NOT NULL,
      entityId TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      opId TEXT NOT NULL,
      PRIMARY KEY (scope, entityId)
    );
  `);
    const schemaRow = db.prepare('SELECT version FROM team_schema LIMIT 1').get();
    if (!schemaRow) {
        db.prepare('INSERT INTO team_schema (version) VALUES (?)').run(TEAM_SCHEMA_VERSION);
    }
    else if (Number(schemaRow.version) === 1 || Number(schemaRow.version) === 2) {
        // Version 2 added the operation log; version 3 adds one editable shared note per challenge.
        db.prepare('UPDATE team_schema SET version=?').run(TEAM_SCHEMA_VERSION);
    }
    else if (Number(schemaRow.version) !== TEAM_SCHEMA_VERSION) {
        throw new Error(`Unsupported team database schema version: ${String(schemaRow.version)}`);
    }
    const all = (sql, ...params) => db.prepare(sql).all(...params);
    const named = (value) => value;
    const ensureOpen = () => { if (closed)
        throw new Error('Team database is closed'); };
    return {
        schemaVersion: TEAM_SCHEMA_VERSION,
        close: () => { if (!closed) {
            closed = true;
            db.close();
        } },
        insertChallenge: (c) => {
            ensureOpen();
            db.prepare('INSERT INTO challenges (challengeId,title,category,description,attachmentPaths,status,flag,createdAt) VALUES (:challengeId,:title,:category,:description,:attachmentPaths,:status,:flag,:createdAt)').run(named({ ...c, flag: c.flag ?? null, attachmentPaths: JSON.stringify(c.attachmentPaths) }));
        },
        updateChallenge: (c) => {
            ensureOpen();
            db.prepare('UPDATE challenges SET title=:title,category=:category,description=:description,attachmentPaths=:attachmentPaths,status=:status,flag=:flag WHERE challengeId=:challengeId').run(named({ challengeId: c.challengeId, title: c.title, category: c.category, description: c.description, attachmentPaths: JSON.stringify(c.attachmentPaths), status: c.status, flag: c.flag ?? null }));
        },
        deleteChallenge: (id) => {
            ensureOpen();
            db.exec('BEGIN');
            try {
                for (const table of ['shared_notes', 'team_notes', 'agent_thoughts', 'evidence', 'subtasks']) {
                    db.prepare(`DELETE FROM ${table} WHERE challengeId=?`).run(id);
                }
                const result = db.prepare('DELETE FROM challenges WHERE challengeId=?').run(id);
                db.exec('COMMIT');
                return Number(result.changes ?? 0) > 0;
            }
            catch (error) {
                try {
                    db.exec('ROLLBACK');
                }
                catch { /* preserve the original database error */ }
                throw error;
            }
        },
        listChallenges: () => { ensureOpen(); return all('SELECT * FROM challenges ORDER BY createdAt DESC, challengeId DESC').map(parseChallenge); },
        getChallenge: (id) => { ensureOpen(); const row = db.prepare('SELECT * FROM challenges WHERE challengeId=?').get(id); return row ? parseChallenge(row) : null; },
        getSharedNote: (challengeId) => { ensureOpen(); const row = db.prepare('SELECT * FROM shared_notes WHERE challengeId=?').get(challengeId); return row ? { challengeId: String(row.challengeId), content: String(row.content), updatedBy: String(row.updatedBy), updatedAt: Number(row.updatedAt) } : null; },
        upsertSharedNote: (note) => { ensureOpen(); db.prepare('INSERT INTO shared_notes (challengeId,content,updatedBy,updatedAt) VALUES (:challengeId,:content,:updatedBy,:updatedAt) ON CONFLICT(challengeId) DO UPDATE SET content=excluded.content,updatedBy=excluded.updatedBy,updatedAt=excluded.updatedAt').run(named(note)); },
        insertNote: (n) => { ensureOpen(); db.prepare('INSERT INTO team_notes VALUES (:id,:challengeId,:authorUserId,:content,:createdAt)').run(named(n)); },
        listNotes: (id) => { ensureOpen(); return all('SELECT * FROM team_notes WHERE challengeId=? ORDER BY createdAt, id', id); },
        insertThought: (t) => { ensureOpen(); db.prepare('INSERT INTO agent_thoughts VALUES (:id,:challengeId,:source,:content,:createdAt)').run(named(t)); },
        listThoughts: (id) => { ensureOpen(); return all('SELECT * FROM agent_thoughts WHERE challengeId=? ORDER BY createdAt, id', id); },
        insertEvidence: (e) => { ensureOpen(); db.prepare('INSERT INTO evidence VALUES (:id,:challengeId,:type,:content,:createdAt)').run(named(e)); },
        listEvidence: (id) => { ensureOpen(); return all('SELECT * FROM evidence WHERE challengeId=? ORDER BY createdAt, id', id); },
        insertTask: (s) => { ensureOpen(); db.prepare('INSERT OR REPLACE INTO subtasks VALUES (:taskId,:challengeId,:ownerUserId,:prompt,:done,:result,:createdAt)').run(named({ ...s, done: s.done ? 1 : 0 })); },
        listTasks: (id) => { ensureOpen(); return all('SELECT * FROM subtasks WHERE challengeId=? ORDER BY createdAt, taskId', id).map((row) => ({ ...row, done: Boolean(row.done) })); },
        appendOperation: (operation) => {
            ensureOpen();
            db.prepare('INSERT OR IGNORE INTO team_operations (opId,peerId,kind,payload,createdAt) VALUES (:opId,:peerId,:kind,:payload,:createdAt)').run({
                opId: operation.opId, peerId: operation.peerId, kind: operation.kind, payload: JSON.stringify(operation.payload), createdAt: operation.createdAt,
            });
            const row = db.prepare('SELECT sequence FROM team_operations WHERE opId=?').get(operation.opId);
            return Number(row?.sequence ?? 0);
        },
        hasOperation: (opId) => { ensureOpen(); return Boolean(db.prepare('SELECT 1 AS found FROM team_operations WHERE opId=? LIMIT 1').get(opId)); },
        listOperations: (afterSequence, limit) => {
            ensureOpen();
            const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit || 100)));
            const rows = all('SELECT sequence,opId,peerId,kind,payload,createdAt FROM team_operations WHERE sequence>? ORDER BY sequence LIMIT ?', afterSequence, safeLimit + 1);
            const visible = rows.slice(0, safeLimit);
            const operations = visible.flatMap((row) => {
                try {
                    return [{ sequence: Number(row.sequence), opId: String(row.opId), peerId: String(row.peerId), kind: row.kind, payload: JSON.parse(String(row.payload)), createdAt: Number(row.createdAt) }];
                }
                catch {
                    return [];
                }
            });
            return { nextCursor: operations.length ? operations[operations.length - 1].sequence : afterSequence, hasMore: rows.length > safeLimit, operations };
        },
        getVersion: (scope, entityId) => {
            ensureOpen();
            const row = db.prepare('SELECT createdAt,opId FROM team_versions WHERE scope=? AND entityId=?').get(scope, entityId);
            return row ? { createdAt: Number(row.createdAt), opId: String(row.opId) } : null;
        },
        setVersion: (scope, entityId, version) => {
            ensureOpen();
            db.prepare('INSERT INTO team_versions (scope,entityId,createdAt,opId) VALUES (?,?,?,?) ON CONFLICT(scope,entityId) DO UPDATE SET createdAt=excluded.createdAt,opId=excluded.opId').run(scope, entityId, version.createdAt, version.opId);
        },
    };
}

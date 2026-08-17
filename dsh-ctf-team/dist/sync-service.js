import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TeamInputError } from './types.js';
const OPERATION_KINDS = new Set([
    'challenge_upsert', 'challenge_delete', 'note_add', 'thought_add', 'evidence_add', 'task_upsert',
]);
/** Host-side operation log and materializer used by browser P2P peers. */
export class TeamSyncService {
    ctx;
    db;
    team;
    identity;
    recordLocal;
    constructor(ctx, db, team, teamId, identityPath) {
        this.ctx = ctx;
        this.db = db;
        this.team = team;
        this.identity = loadIdentity(teamId, identityPath ?? './ctf-team.identity.json');
        this.recordLocal = (operation) => {
            const normalized = { ...operation, peerId: this.identity.peerId };
            db.appendOperation(normalized);
            if (normalized.kind === 'challenge_upsert') {
                const payload = normalized.payload;
                if (typeof payload.challengeId === 'string')
                    db.setVersion('challenge', payload.challengeId, normalized);
            }
            else if (normalized.kind === 'challenge_delete') {
                const payload = normalized.payload;
                if (typeof payload.challengeId === 'string')
                    db.setVersion('challenge', payload.challengeId, normalized);
            }
        };
        this.seedExistingState();
    }
    getIdentity() { return { ...this.identity }; }
    /** Backfill pre-sync SQLite rows so an upgraded installation can bootstrap peers. */
    seedExistingState() {
        for (const challenge of this.team.listChallenges()) {
            this.seedOperation(`bootstrap-challenge-${challenge.challengeId}`, 'challenge_upsert', challenge, challenge.createdAt);
            const detail = this.team.getDetail(challenge.challengeId);
            for (const note of detail.notes)
                this.seedOperation(`bootstrap-note-${note.id}`, 'note_add', note, note.createdAt);
            for (const thought of detail.thoughts)
                this.seedOperation(`bootstrap-thought-${thought.id}`, 'thought_add', thought, thought.createdAt);
            for (const evidence of detail.evidence)
                this.seedOperation(`bootstrap-evidence-${evidence.id}`, 'evidence_add', evidence, evidence.createdAt);
            for (const task of detail.tasks)
                this.seedOperation(`bootstrap-task-${task.taskId}`, 'task_upsert', task, task.createdAt);
        }
    }
    seedOperation(opId, kind, payload, createdAt) {
        if (this.db.hasOperation(opId))
            return;
        this.recordLocal({ opId, peerId: this.identity.peerId, kind, payload, createdAt: Math.max(1, createdAt) });
    }
    recordMutation(kind, payload) {
        this.recordLocal({ opId: randomUUID(), peerId: this.identity.peerId, kind, payload, createdAt: Date.now() });
    }
    getChanges(afterSequence = 0, limit = 200) {
        if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
            throw new TeamInputError('afterSequence is invalid');
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
            throw new TeamInputError('limit is invalid');
        return this.db.listOperations(afterSequence, limit);
    }
    applyOperations(input) {
        if (!Array.isArray(input))
            throw new TeamInputError('operations must be an array');
        if (input.length > 1000)
            throw new TeamInputError('operations contains too many entries');
        const accepted = [];
        const ignored = [];
        const pending = [];
        const operations = input.map(parseOperation).sort((a, b) => a.createdAt - b.createdAt || a.opId.localeCompare(b.opId));
        // Challenge roots go first so a note/evidence arriving in the same batch can apply.
        operations.sort((a, b) => rootRank(a.kind) - rootRank(b.kind) || a.createdAt - b.createdAt || a.opId.localeCompare(b.opId));
        for (const operation of operations) {
            if (this.db.hasOperation(operation.opId)) {
                ignored.push(operation.opId);
                continue;
            }
            const result = this.team.applyRemoteOperation(operation);
            if (result === 'pending') {
                pending.push(operation);
                continue;
            }
            this.db.appendOperation(operation);
            if (operation.kind === 'challenge_upsert' || operation.kind === 'challenge_delete') {
                const payload = operation.payload;
                if (typeof payload.challengeId === 'string')
                    this.db.setVersion('challenge', payload.challengeId, operation);
            }
            ;
            (result === 'applied' ? accepted : ignored).push(operation.opId);
        }
        return { accepted, ignored, pending };
    }
    status() {
        const batch = this.db.listOperations(0, 1000);
        return { teamId: this.identity.teamId, peerId: this.identity.peerId, operationCursor: batch.nextCursor, operationCount: batch.operations.length + (batch.hasMore ? 1000 : 0) };
    }
    /** Used by TeamService construction so every local mutation enters the log. */
    operationSink() {
        return this.recordLocal;
    }
    logger(message) { this.ctx.logger?.debug?.(`dsh-ctf-team sync: ${message}`); }
}
function rootRank(kind) {
    return kind === 'challenge_upsert' || kind === 'challenge_delete' ? 0 : 1;
}
function parseOperation(value) {
    if (value === null || typeof value !== 'object')
        throw new TeamInputError('operation is invalid');
    const input = value;
    if (typeof input.opId !== 'string' || !input.opId || input.opId.length > 128)
        throw new TeamInputError('operation.opId is invalid');
    if (typeof input.peerId !== 'string' || !input.peerId || input.peerId.length > 256)
        throw new TeamInputError('operation.peerId is invalid');
    if (typeof input.kind !== 'string' || !OPERATION_KINDS.has(input.kind))
        throw new TeamInputError('operation.kind is invalid');
    if (typeof input.createdAt !== 'number' || !Number.isSafeInteger(input.createdAt) || input.createdAt <= 0)
        throw new TeamInputError('operation.createdAt is invalid');
    return { opId: input.opId, peerId: input.peerId, kind: input.kind, payload: input.payload, createdAt: input.createdAt };
}
function loadIdentity(teamId, identityPath) {
    const fullPath = resolve(identityPath);
    try {
        if (existsSync(fullPath)) {
            const parsed = JSON.parse(readFileSync(fullPath, 'utf8'));
            if (typeof parsed.peerId === 'string' && parsed.peerId && typeof parsed.createdAt === 'number') {
                const identity = { teamId, peerId: parsed.peerId, createdAt: parsed.createdAt };
                writeIdentity(fullPath, identity);
                return identity;
            }
        }
    }
    catch { /* regenerate a damaged identity file */ }
    const identity = { teamId, peerId: `peer-${randomUUID()}`, createdAt: Date.now() };
    writeIdentity(fullPath, identity);
    return identity;
}
function writeIdentity(path, identity) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
}

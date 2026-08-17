/** Static Typert Remote contribution for the CTF Team Host service. */
import { z } from 'zod';
const category = z.union([z.literal('pwn'), z.literal('crypto'), z.literal('web'), z.literal('rev'), z.literal('misc'), z.literal('forensic')]);
const status = z.union([z.literal('pending'), z.literal('solving'), z.literal('solved')]);
const challenge = z.object({
    challengeId: z.string(), title: z.string(), category, description: z.string(),
    attachmentPaths: z.array(z.string()), status, flag: z.string().optional(), createdAt: z.number(),
});
const note = z.object({ id: z.string(), challengeId: z.string(), authorUserId: z.string(), content: z.string(), createdAt: z.number() });
const thought = z.object({ id: z.string(), challengeId: z.string(), source: z.string(), content: z.string(), createdAt: z.number() });
const evidence = z.object({ id: z.string(), challengeId: z.string(), type: z.union([z.literal('tool_output'), z.literal('file_extract'), z.literal('log')]), content: z.string(), createdAt: z.number() });
const task = z.object({ taskId: z.string(), challengeId: z.string(), ownerUserId: z.string(), prompt: z.string(), done: z.boolean(), result: z.string(), createdAt: z.number() });
const detail = z.object({ challenge, notes: z.array(note), thoughts: z.array(thought), evidence: z.array(evidence), tasks: z.array(task) });
const createInput = z.object({ challengeId: z.string().optional(), title: z.string().optional(), category: category.optional(), description: z.string().optional(), attachmentPaths: z.array(z.string()).optional(), status: status.optional(), flag: z.string().optional() });
const updateInput = z.object({ title: z.string().optional(), category: category.optional(), description: z.string().optional(), attachmentPaths: z.array(z.string()).optional(), status: status.optional(), flag: z.string().optional() });
const noteInput = z.object({ challengeId: z.string(), authorUserId: z.string().optional(), content: z.string() });
const evidenceInput = z.object({ challengeId: z.string(), type: z.union([z.literal('tool_output'), z.literal('file_extract'), z.literal('log')]).optional(), content: z.string() });
const thoughtInput = z.object({ challengeId: z.string(), source: z.string().optional(), content: z.string() });
const spawnInput = z.object({ challengeId: z.string(), ownerUserId: z.string().optional(), prompt: z.string() });
const deleted = z.object({ challengeId: z.string(), deleted: z.literal(true) });
const agentResult = z.object({ taskId: z.string(), response: z.string() });
const identity = z.object({ teamId: z.string(), peerId: z.string(), createdAt: z.number() });
const operation = z.object({ sequence: z.number(), opId: z.string(), peerId: z.string(), kind: z.union([z.literal('challenge_upsert'), z.literal('challenge_delete'), z.literal('note_add'), z.literal('thought_add'), z.literal('evidence_add'), z.literal('task_upsert')]), payload: z.unknown(), createdAt: z.number() });
const changes = z.object({ nextCursor: z.number(), hasMore: z.boolean(), operations: z.array(operation) });
const syncOperation = z.object({ opId: z.string(), peerId: z.string(), kind: operation.shape.kind, payload: z.unknown(), createdAt: z.number() });
const applyResult = z.object({ accepted: z.array(z.string()), ignored: z.array(z.string()), pending: z.array(syncOperation) });
const syncStatus = z.object({ teamId: z.string(), peerId: z.string(), operationCursor: z.number(), operationCount: z.number() });
function strict(typeSymbol, schema) {
    return { mode: 'strict', typeSymbol, schema };
}
function descriptor(method, parameters, result) {
    return { id: `dsh-ctf-team#ctfTeam/${method}`, service: 'ctfTeam', namespace: 'ctfTeam', method, invocation: { kind: 'direct' }, parameters, result };
}
const TYPERT_REMOTE = {
    package: 'dsh-ctf-team',
    descriptors: [
        descriptor('list', [], strict('dsh-ctf-team/client#Challenge[]', z.array(challenge))),
        descriptor('detail', [{ name: 'challengeId', wire: 'challengeId', source: 'json', codec: strict('string', z.string()) }], strict('dsh-ctf-team/client#ChallengeDetail', detail)),
        descriptor('create', [{ name: 'input', wire: 'input', source: 'json', codec: strict('dsh-ctf-team/client#CreateChallengeInput', createInput) }], strict('dsh-ctf-team/client#Challenge', challenge)),
        descriptor('update', [
            { name: 'challengeId', wire: 'challengeId', source: 'json', codec: strict('string', z.string()) },
            { name: 'input', wire: 'input', source: 'json', codec: strict('dsh-ctf-team/client#UpdateChallengeInput', updateInput) },
        ], strict('dsh-ctf-team/client#Challenge', challenge)),
        descriptor('delete', [{ name: 'challengeId', wire: 'challengeId', source: 'json', codec: strict('string', z.string()) }], strict('dsh-ctf-team/client#DeletedChallenge', deleted)),
        descriptor('addNote', [{ name: 'input', wire: 'input', source: 'json', codec: strict('dsh-ctf-team/client#AddNoteInput', noteInput) }], strict('dsh-ctf-team/client#TeamNote', note)),
        descriptor('addEvidence', [{ name: 'input', wire: 'input', source: 'json', codec: strict('dsh-ctf-team/client#AddEvidenceInput', evidenceInput) }], strict('dsh-ctf-team/client#EvidenceItem', evidence)),
        descriptor('addThought', [{ name: 'input', wire: 'input', source: 'json', codec: strict('dsh-ctf-team/client#AddThoughtInput', thoughtInput) }], strict('dsh-ctf-team/client#AgentThought', thought)),
        descriptor('spawnAgent', [{ name: 'input', wire: 'input', source: 'json', codec: strict('dsh-ctf-team/client#SpawnAgentInput', spawnInput) }], strict('dsh-ctf-team/client#SpawnAgentResult', agentResult)),
        descriptor('identity', [], strict('dsh-ctf-team/client#TeamIdentity', identity)),
        descriptor('changes', [{ name: 'input', wire: 'input', source: 'json', codec: strict('dsh-ctf-team/client#ChangesInput', z.object({ afterSequence: z.number().optional(), limit: z.number().optional() }).optional()), acceptsUndefined: true }], strict('dsh-ctf-team/client#SyncBatch', changes)),
        descriptor('applyOperations', [{ name: 'input', wire: 'input', source: 'json', codec: strict('dsh-ctf-team/client#ApplyOperationsInput', z.object({ operations: z.array(syncOperation) })) }], strict('dsh-ctf-team/client#SyncApplyResult', applyResult)),
        descriptor('syncStatus', [], strict('dsh-ctf-team/client#SyncStatus', syncStatus)),
    ],
};
export { TYPERT_REMOTE };
export default TYPERT_REMOTE;

import { randomUUID } from 'node:crypto';
export function setupAgentRunner(db, broadcast, adapter, concurrentLimit, mutationSink) {
    let running = 0;
    return {
        available: adapter !== undefined,
        async spawn(challengeId, ownerUserId, prompt) {
            if (!adapter)
                throw new Error('This Harness profile has no ctfTeamSessionFork adapter. Configure a trusted session-fork adapter before enabling agent tasks.');
            if (running >= concurrentLimit)
                throw new Error(`Agent concurrency limit (${concurrentLimit}) reached`);
            running += 1;
            const taskId = randomUUID();
            const task = { taskId, challengeId, ownerUserId, prompt, done: false, result: '', createdAt: Date.now() };
            db.insertTask(task);
            mutationSink?.('task_upsert', task);
            broadcast.emit({ type: 'task_update', payload: { challengeId, taskId } });
            try {
                const child = await adapter.fork(prompt);
                const dispose = child.onMessage?.((content) => {
                    const thought = { id: randomUUID(), challengeId, source: `agent-${taskId}`, content, createdAt: Date.now() };
                    db.insertThought(thought);
                    mutationSink?.('thought_add', thought);
                    broadcast.emit({ type: 'thought_add', payload: { challengeId, taskId } });
                });
                const completed = { ...task, done: true, result: child.content };
                db.insertTask(completed);
                mutationSink?.('task_upsert', completed);
                broadcast.emit({ type: 'task_update', payload: { challengeId, taskId } });
                dispose?.();
                return { taskId, response: child.content };
            }
            catch (error) {
                const failed = { ...task, done: true, result: `Failed: ${error instanceof Error ? error.message : String(error)}` };
                db.insertTask(failed);
                mutationSink?.('task_upsert', failed);
                broadcast.emit({ type: 'task_update', payload: { challengeId, taskId } });
                throw error;
            }
            finally {
                running -= 1;
            }
        },
    };
}

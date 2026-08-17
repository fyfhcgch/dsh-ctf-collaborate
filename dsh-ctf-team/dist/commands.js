/** Optional compatibility hook for hosts exposing Koishi-style command registration. */
export function setupCommands(ctx, service) {
    // Access optional services through lookup; reading an undeclared Context property
    // makes Cordis treat it as a missing inject edge.
    const command = ctx.get?.('command');
    if (typeof command !== 'function')
        return;
    command('team.list', 'List CTF challenges').action(() => service.listChallenges().map((item) => `[${item.status}] ${item.challengeId} ${item.title}`).join('\n') || 'No challenges');
    command('team.note <challengeId:text> <content:text>', 'Add a team note').action((_argv, challengeId, content) => {
        try {
            service.addNote({ challengeId, content });
        }
        catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
        return 'Note added';
    });
}

import { createElement, useEffect } from 'react';
import TYPERT_REMOTE from '../remote.js';
import { TeamP2PController } from './p2p.js';
import { TeamBoard } from './board.js';
export const inject = ['remote', 'slots'];
function unwrap(operation, result) {
    if (result.ok)
        return result.value;
    throw new Error(`ctfTeam.${operation} failed: ${result.error.code}: ${result.error.message}`);
}
function adaptRemote(remote) {
    return {
        async identity() { return unwrap('identity', await remote.identity()); },
        async changes(input) { return unwrap('changes', await remote.changes(input)); },
        async applyOperations(input) { return unwrap('applyOperations', await remote.applyOperations(input)); },
        async syncStatus() { return unwrap('syncStatus', await remote.syncStatus()); },
    };
}
function adaptBoardRemote(remote) {
    return {
        async list() { return unwrap('list', await remote.list()); },
        async detail(challengeId) { return unwrap('detail', await remote.detail(challengeId)); },
        async create(input) { return unwrap('create', await remote.create(input)); },
        async update(challengeId, input) { return unwrap('update', await remote.update(challengeId, input)); },
        async delete(challengeId) { return unwrap('delete', await remote.delete(challengeId)); },
        async addNote(input) { return unwrap('addNote', await remote.addNote(input)); },
        async addEvidence(input) { return unwrap('addEvidence', await remote.addEvidence(input)); },
        async addThought(input) { return unwrap('addThought', await remote.addThought(input)); },
        async spawnAgent(input) { return unwrap('spawnAgent', await remote.spawnAgent(input)); },
        async identity() { return unwrap('identity', await remote.identity()); },
        async syncStatus() { return unwrap('syncStatus', await remote.syncStatus()); },
    };
}
export async function apply(ctx) {
    const remote = ctx.get('remote');
    const disposeRemote = await remote.$mount(TYPERT_REMOTE);
    // The namespace is created by the mount above. Access it only through a
    // nested injection fiber so Cordis can trace and unwind the dependency.
    ctx.inject(['remote.ctfTeam'], (teamCtx) => {
        const wire = teamCtx.remote.ctfTeam;
        const log = (message) => { teamCtx.logger?.warn?.(`dsh-ctf-team: ${message}`); };
        const controller = new TeamP2PController(adaptRemote(wire), log);
        const board = new TeamBoard(adaptBoardRemote(wire), controller, log);
        teamCtx.effect(async () => {
            await controller.ready();
            board.mount();
            const slots = teamCtx;
            const disposeSidebarAction = slots.slots.inject('sidebar.footer.action', () => {
                const SidebarBoardAction = ({ wide }) => {
                    useEffect(() => {
                        board.setSidebarIntegrated(true);
                        return () => { board.setSidebarIntegrated(false); };
                    }, []);
                    useEffect(() => {
                        board.setSidebarWide(wide);
                    }, [wide]);
                    return createElement('button', {
                        type: 'button',
                        className: 'dsh-ctf-team-sidebar-action',
                        title: 'CTF Board',
                        'aria-label': 'CTF Board',
                        onClick: () => { board.toggleOpen(); },
                    }, wide ? 'CTF Board' : '🏁');
                };
                return slots.slots.register({
                    name: 'sidebar.footer.action',
                    id: 'dsh-ctf-team-board',
                    order: 100,
                }, SidebarBoardAction);
            });
            const target = globalThis;
            target.__DSH_CTF_TEAM_P2P__ = controller;
            target.__DSH_CTF_TEAM_BOARD__ = board;
            return () => {
                disposeSidebarAction();
                board.dispose();
                controller.dispose();
                if (target.__DSH_CTF_TEAM_P2P__ === controller)
                    delete target.__DSH_CTF_TEAM_P2P__;
                if (target.__DSH_CTF_TEAM_BOARD__ === board)
                    delete target.__DSH_CTF_TEAM_BOARD__;
            };
        }, 'dsh-ctf-team client board and P2P controller');
    });
    return async () => { await disposeRemote(); };
}
export { TYPERT_REMOTE, TeamBoard, TeamP2PController };

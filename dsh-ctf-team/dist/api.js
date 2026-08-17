import { TeamInputError, TeamNotFoundError } from './types.js';
import { getHttpServer } from './host-adapter.js';
const bodyOf = (value) => value !== null && typeof value === 'object' ? value : {};
function sendError(res, error) {
    if (error instanceof TeamNotFoundError)
        return res.status(404).json({ error: error.message });
    if (error instanceof TeamInputError) {
        const status = error.kind === 'conflict' ? 409 : error.kind === 'unsupported' ? 501 : 400;
        return res.status(status).json({ error: error.message });
    }
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
}
/** Mount the optional legacy HTTP bridge over the shared TeamService. */
export function setupApi(ctx, mountPath, broadcast, service) {
    const server = getHttpServer(ctx);
    if (!server) {
        ctx.logger?.warn?.('dsh-ctf-team: no compatible HTTP server; HTTP bridge was not mounted');
        return false;
    }
    const api = `${mountPath.replace(/\/$/, '')}/api`;
    server.get(`${api}/events`, (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.write('retry: 3000\n\n');
        const detach = broadcast.connectClient({ write: (data) => res.write(data), close: () => res.end() });
        req.on?.('close', () => { detach(); });
    });
    server.get(`${api}/challenges`, (_req, res) => res.json(service.listChallenges()));
    server.get(`${api}/challenges/:cid`, (req, res) => {
        try {
            res.json(service.getDetail(req.params.cid));
        }
        catch (error) {
            sendError(res, error);
        }
    });
    server.post(`${api}/challenges`, (req, res) => {
        try {
            res.json({ ok: true, challenge: service.createChallenge(bodyOf(req.body)) });
        }
        catch (error) {
            sendError(res, error);
        }
    });
    server.post(`${api}/challenges/:cid/update`, (req, res) => {
        try {
            res.json({ ok: true, challenge: service.updateChallenge(req.params.cid, bodyOf(req.body)) });
        }
        catch (error) {
            sendError(res, error);
        }
    });
    server.post(`${api}/challenges/:cid/delete`, (req, res) => {
        try {
            service.deleteChallenge(req.params.cid);
            res.json({ ok: true });
        }
        catch (error) {
            sendError(res, error);
        }
    });
    server.post(`${api}/notes`, (req, res) => {
        try {
            res.json({ ok: true, note: service.addNote(bodyOf(req.body)) });
        }
        catch (error) {
            sendError(res, error);
        }
    });
    server.post(`${api}/evidence`, (req, res) => {
        try {
            res.json({ ok: true, evidence: service.addEvidence(bodyOf(req.body)) });
        }
        catch (error) {
            sendError(res, error);
        }
    });
    server.post(`${api}/thoughts`, (req, res) => {
        try {
            res.json({ ok: true, thought: service.addThought(bodyOf(req.body)) });
        }
        catch (error) {
            sendError(res, error);
        }
    });
    server.post(`${api}/agent/spawn`, async (req, res) => {
        try {
            const body = bodyOf(req.body);
            res.json({ ok: true, task: await service.spawnAgent(body.challengeId, body.ownerUserId, body.prompt) });
        }
        catch (error) {
            sendError(res, error);
        }
    });
    return true;
}

/** Browser face for the CTF Team plugin.
 *
 * The Host owns the SQLite store and operation log. This face mounts the
 * Typert contribution, then starts the WebRTC synchronizer only inside a
 * child fiber that explicitly injects the generated `remote.ctfTeam` service.
 */
import type { Context } from '@deepseek-ai/cordis';
import TYPERT_REMOTE from '../remote.js';
import { TeamP2PController } from './p2p.js';
import { TeamBoard } from './board.js';
export declare const inject: string[];
export declare function apply(ctx: Context): Promise<() => Promise<void>>;
export { TYPERT_REMOTE, TeamBoard, TeamP2PController };

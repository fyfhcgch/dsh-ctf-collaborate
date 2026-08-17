/** Browser face for the CTF Team plugin.
 *
 * The Host owns the SQLite store; this face only mounts the generated Remote
 * contribution. UI packages can consume `ctx.remote.ctfTeam` through the
 * normal Cordis client module table without reaching into the database or the
 * legacy HTTP bridge.
 */
import type { Context } from '@deepseek-ai/cordis';
import TYPERT_REMOTE from './remote.js';
/** The Remote service is the only browser capability required by this module. */
export declare const inject: string[];
/** Mount the CTF Team Host methods and own their disposer with this fiber. */
export declare function apply(ctx: Context): Promise<() => Promise<void>>;
export { TYPERT_REMOTE };

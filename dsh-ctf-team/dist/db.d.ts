import type { TeamDb } from './types.js';
export declare const TEAM_SCHEMA_VERSION = 3;
/** Open the durable team store and initialize its tables and query indexes. */
export declare function createDb(dbPath: string): TeamDb;

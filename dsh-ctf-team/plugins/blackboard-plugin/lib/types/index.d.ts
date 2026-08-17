//#region lib/types/index.d.ts
/**
 * Type declarations for @dsh-external/dsh-blackboard.
 *
 * The plugin registers the cordis service `blackboard` on the context; agent
 * plugins consume it through `ctx.blackboard` (declare
 * `static inject = ["blackboard"]` or await `ctx.blackboard.waitReady()`).
 */
import type { Service } from "@deepseek-ai/cordis";

/** One entry value: any JSON-serializable value. */
export type BlackboardValue = unknown;

/** One section: a map of keys to JSON values. */
export interface BlackboardSection {
	[key: string]: BlackboardValue;
}

/** The full on-disk document. */
export interface BlackboardDocument {
	schemaVersion: number;
	meta: {
		createdAt: string;
		updatedAt: string;
		lastWriteAt: string;
		recoveredFromCorruption?: boolean;
		corruptBackup?: string;
		[key: string]: unknown;
	};
	sections: Record<string, BlackboardSection>;
}

/** Result record returned by every mutation. */
export interface BlackboardWriteResult<Op extends string = string> {
	op?: never;
	section?: string;
	key?: string;
	value?: BlackboardValue;
	item?: BlackboardValue;
	previous?: BlackboardValue;
	changed: boolean;
	at: string;
	file: string;
}

/** Notification event payload (emitted after each durable write). */
export interface BlackboardEventPayload {
	section?: string;
	key?: string;
	value?: BlackboardValue;
	item?: BlackboardValue;
	previous?: BlackboardValue;
	changed?: boolean;
	at: string;
	file: string;
}

/** Command-channel payload: `ctx.emit("blackboard/command", payload)`. */
export interface BlackboardCommand {
	op: "set" | "update" | "append" | "delete" | "remove" | "clear-section" | "clear" | "touch";
	section?: string;
	key?: string;
	value?: BlackboardValue;
}

/** Options for {@link BlackboardService.search}. */
export interface BlackboardSearchOptions {
	caseInsensitive?: boolean;
	limit?: number;
}

/** One search hit. */
export interface BlackboardSearchHit {
	section: string;
	key: string;
	value: BlackboardValue;
}

/** The `ctx.blackboard` service surface. */
export interface BlackboardService extends Service {
	/** Wait for the initial disk load (idempotent). */
	waitReady(): Promise<void>;
	/** Whether the document has been loaded. */
	readonly ready: boolean;
	/** Absolute path of the persistence file. */
	getFile(): string;
	/** Deep clone of the whole document. */
	getDocument(): BlackboardDocument;
	/** Deep clone of one section (undefined when absent). */
	getSection(section: string): BlackboardSection | undefined;
	/** Section names currently present. */
	listSections(): string[];
	/** Deep clone of one entry (undefined when absent). */
	get(section: string, key: string): BlackboardValue | undefined;
	/** Whether the entry exists. */
	has(section: string, key: string): boolean;
	/** Keys of one section. */
	keys(section: string): string[];
	/** Number of entries in one section. */
	size(section: string): number;
	/** Total entries across all sections. */
	count(): number;
	/** Case-insensitive substring search over keys and values. */
	search(query: string, options?: BlackboardSearchOptions): Promise<BlackboardSearchHit[]>;
	/** Set one entry (no-op when JSON-deep-equal). */
	set(section: string, key: string, value: BlackboardValue): Promise<BlackboardWriteResult<"set">>;
	/** Merge an object patch into one entry. */
	update(section: string, key: string, patch: Record<string, BlackboardValue>): Promise<BlackboardWriteResult<"update">>;
	/** Append one item to an array entry. */
	append(section: string, key: string, item: BlackboardValue): Promise<BlackboardWriteResult<"append">>;
	/** Delete one entry. */
	delete(section: string, key: string): Promise<BlackboardWriteResult<"delete">>;
	/** Alias of {@link delete}. */
	remove(section: string, key: string): Promise<BlackboardWriteResult<"delete">>;
	/** Empty one section. */
	clearSection(section: string): Promise<BlackboardWriteResult<"clear-section">>;
	/** Empty every section. */
	clear(): Promise<BlackboardWriteResult<"clear">>;
	/** Force a durable rewrite of the current document. */
	touch(): Promise<{ at: string; file: string }>;
}

/** Notification event names emitted by the plugin. */
export const BLACKBOARD_EVENTS: readonly [
	"blackboard/ready",
	"blackboard/set",
	"blackboard/update",
	"blackboard/append",
	"blackboard/delete",
	"blackboard/clear-section",
	"blackboard/clear",
	"blackboard/persist",
	"blackboard/change",
	"blackboard/error",
] as const;

/** The plugin class (cordis entry export). */
export declare class BlackboardProvider extends Service {
	static provide: "blackboard";
	static Config: import("@deepseek-ai/schemastery").S<{ file: string }>;
}

export default BlackboardProvider;
//#endregion

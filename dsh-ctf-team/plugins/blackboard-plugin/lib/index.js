//#region lib/index.js
/**
 * dsh-blackboard — durable global blackboard (shared memory) for CTF agents.
 *
 * A cordis service (`ctx.blackboard`) backed by ONE JSON file. Every mutation
 * is serialized through a write queue and durably committed (temp file +
 * rename) BEFORE the in-memory document advances and before any notification
 * event fires, so the on-disk file is always the source of truth and a
 * harness restart or machine restart loses nothing.
 *
 * Data model (plain JSON, versioned):
 *   {
 *     "schemaVersion": 1,
 *     "meta": { "createdAt", "updatedAt", "lastWriteAt", ... },
 *     "sections": {
 *       "challenges":      { key: value },   // 题目信息
 *       "tool_outputs":    { key: value },   // 工具输出
 *       "clues":           { key: value },   // 中间线索
 *       "failures":        { key: value },   // 失败记录
 *       "candidate_flags": { key: value },   // 候选flag
 *       ... any extra section is allowed ...
 *     }
 *   }
 *
 * Read/write interface:
 *   - Service API:       ctx.blackboard.get/set/update/append/delete/search/...
 *   - Command events:    ctx.emit("blackboard/command", { op, section, key, value })
 *   - Notification events (after each durable write): blackboard/set,
 *     blackboard/update, blackboard/append, blackboard/delete,
 *     blackboard/clear-section, blackboard/clear, blackboard/ready,
 *     blackboard/persist, blackboard/change, blackboard/error.
 *
 * @module @dsh-external/dsh-blackboard
 */
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Default persistence target (overridable through the `file` config key). */
const DEFAULT_FILE = process.env.DSH_BLACKBOARD_FILE ?? "persistent_data/blackboard.json";
/** Document schema version; bumping it triggers an explicit migration point. */
const SCHEMA_VERSION = 1;
/** Sections seeded into every fresh document; agents may add more. */
const CANONICAL_SECTIONS = ["challenges", "tool_outputs", "clues", "failures", "candidate_flags"];
/** Section names must be safe JSON keys: alphanumeric start, [A-Za-z0-9_.-] body. */
const SECTION_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Retry budget for transient Windows file errors (AV locks, open handles). */
const WRITE_RETRY_LIMIT = 10;
const WRITE_RETRY_DELAY_MS = 50;

/** Current UTC time as an ISO-8601 string. */
function nowIso() {
	return new Date().toISOString();
}

/** True for non-array object values (map-like). */
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep clone via structuredClone (values are JSON-safe by contract). */
function deepClone(value) {
	return value === undefined ? undefined : structuredClone(value);
}

/** JSON-deep equality for change detection (values are JSON-safe by contract). */
function deepEqualJson(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

/** Whether a filesystem error is a transient Windows lock worth retrying. */
function retryableWriteError(error) {
	const code = error?.code;
	return code === "EACCES" || code === "EBUSY" || code === "EPERM";
}

/** Render one document as pretty JSON with a trailing newline. */
function serializeDocument(document) {
	return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Durable blackboard provider: one service instance per process, registered
 * as `ctx.blackboard`. Consumers either declare `static inject = ["blackboard"]`
 * (the fiber waits for availability) or await `ctx.blackboard.waitReady()`.
 */
class BlackboardProvider extends Service {
	/** Service name registered on the context. */
	static provide = "blackboard";
	/** Plugin config schema. `file` pins the persistence target. */
	static Config = z.object({
		file: z.string().default(DEFAULT_FILE)
	});

	/** Resolved plugin config (schema-validated). */
	config;
	/** Absolute path of the persistence file. */
	file;
	/** In-memory document; only advanced after a successful durable write. */
	document = null;
	/** Boot promise: resolves once the document is loaded (and initial write done). */
	bootstrap = null;
	/** Serialized mutation chain (settled tail, so failures never poison it). */
	writeQueue = Promise.resolve();
	/** Set at dispose: refuse further events, drain pending writes. */
	closed = false;

	constructor(ctx, config) {
		super(ctx, "blackboard");
		this.config = config;
		this.file = resolve(config.file);
	}

	/**
	 * Lifecycle: register the command channel and load the document before the
	 * service is fully active. The disposer drains the write queue so a
	 * shutdown never cuts a committed mutation short.
	 */
	async *[Service.init]() {
		yield async () => {
			this.closed = true;
			await this.writeQueue;
		};
		this.ctx.on("blackboard/command", (payload) => this._dispatchCommand(payload));
		this.bootstrap = this._bootstrap();
		await this.bootstrap;
	}

	/** Load (or recover) the document, write it back only when needed, emit ready. */
	async _bootstrap() {
		const { document, shouldWrite, recovered, backup } = await this._load();
		this.document = document;
		if (recovered) {
			this.ctx.logger.warn("blackboard: %s was corrupt; started fresh (old bytes kept at %s)", this.file, backup);
		}
		if (shouldWrite) {
			try {
				await this._writeDocument(document);
			} catch (error) {
				this.ctx.logger.error("blackboard: failed to initialize %s", this.file);
				this.ctx.logger.error(error);
				throw error;
			}
		}
		if (!this.closed) this.ctx.emit("blackboard/ready", { at: nowIso(), file: this.file });
		this.ctx.logger.info("blackboard: loaded %s (%d entries)", this.file, this.count());
	}

	/**
	 * Read the file into a validated document.
	 * - Absent file    → fresh canonical document, needs an initial write.
	 * - Parse failure  → the corrupt file is renamed aside (backup kept), a
	 *   fresh document is returned and written, so the harness never dies on
	 *   a bad file and the old bytes are never silently destroyed.
	 * - Other read errors (EACCES, ...) fail loud: an unreadable blackboard
	 *   is a misconfiguration, not something to paper over.
	 */
	async _load() {
		let text;
		try {
			text = await readFile(this.file, "utf8");
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			return { document: this._freshDocument(), shouldWrite: true, recovered: false };
		}
		try {
			return { document: this._parse(text), shouldWrite: false, recovered: false };
		} catch (error) {
			const backup = `${this.file}.corrupt-${Date.now()}`;
			try {
				await rename(this.file, backup);
			} catch {
				this.ctx.logger.warn("blackboard: could not back up corrupt file %s", this.file);
			}
			this.ctx.logger.warn("blackboard: %s failed to parse: %s", this.file, error?.message ?? String(error));
			return {
				document: this._freshDocument({ recoveredFromCorruption: true, corruptBackup: backup }),
				shouldWrite: true,
				recovered: true,
				backup
			};
		}
	}

	/** Parse and validate one document text (read-lenient: unknown sections survive). */
	_parse(text) {
		const raw = JSON.parse(text);
		if (!isPlainObject(raw)) throw new TypeError("blackboard document root must be an object");
		if (raw.schemaVersion !== SCHEMA_VERSION) {
			throw new TypeError(`unsupported blackboard schemaVersion ${JSON.stringify(raw.schemaVersion)} (expected ${SCHEMA_VERSION})`);
		}
		if (!isPlainObject(raw.meta)) throw new TypeError("blackboard document meta must be an object");
		if (!isPlainObject(raw.sections)) throw new TypeError("blackboard document sections must be an object");
		const sections = {};
		for (const [name, entries] of Object.entries(raw.sections)) {
			if (!isPlainObject(entries)) {
				this.ctx.logger.warn("blackboard: dropping malformed section %s (not an object)", name);
				continue;
			}
			sections[name] = deepClone(entries);
		}
		for (const name of CANONICAL_SECTIONS) sections[name] ??= {};
		return {
			schemaVersion: SCHEMA_VERSION,
			meta: deepClone(raw.meta),
			sections
		};
	}

	/** A brand-new canonical document. */
	_freshDocument(extraMeta = {}) {
		return {
			schemaVersion: SCHEMA_VERSION,
			meta: {
				createdAt: nowIso(),
				updatedAt: nowIso(),
				lastWriteAt: nowIso(),
				...extraMeta
			},
			sections: Object.fromEntries(CANONICAL_SECTIONS.map((name) => [name, {}]))
		};
	}

	/** Append one task to the serialized mutation chain. */
	_enqueue(task) {
		const run = this.writeQueue.then(task, task);
		this.writeQueue = run.then(() => void 0, () => void 0);
		return run;
	}

	/**
	 * Atomically write one document: temp file + rename, with a bounded retry
	 * on transient Windows errors. The in-memory document is NOT advanced by
	 * this call; callers swap it only after the write resolves.
	 */
	async _writeDocument(document) {
		const text = serializeDocument(document);
		await mkdir(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.tmp`;
		for (let attempt = 0; ; attempt++) {
			try {
				await writeFile(tmp, text, "utf8");
				await rename(tmp, this.file);
				return;
			} catch (error) {
				if (!retryableWriteError(error) || attempt >= WRITE_RETRY_LIMIT) throw error;
				await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * WRITE_RETRY_DELAY_MS));
			}
		}
	}

	/**
	 * Durable-commit tail shared by every mutation: stamp meta, write to disk,
	 * swap the in-memory document, then emit notification events. `detail`
	 * must carry `section`/`key` (+ op-specific fields); `previous` holds the
	 * pre-mutation value deep-cloned.
	 */
	async _finishCommit(eventName, op, next, detail) {
		const at = nowIso();
		next.meta.updatedAt = at;
		next.meta.lastWriteAt = at;
		await this._writeDocument(next);
		this.document = next;
		if (this.closed) return { ...detail, at, file: this.file };
		this.ctx.emit(eventName, { ...detail, at, file: this.file });
		this.ctx.emit("blackboard/change", { op, section: detail.section, key: detail.key, at, file: this.file });
		this.ctx.emit("blackboard/persist", { at, file: this.file });
		return { ...detail, at, file: this.file };
	}

	/** Wait for the initial load (idempotent). */
	waitReady() {
		return Promise.resolve(this.bootstrap);
	}

	/** Whether the document has been loaded. */
	get ready() {
		return this.document !== null;
	}

	/** Throw a clear error when a read races the boot load. */
	_ensureReady() {
		if (this.document === null) {
			throw new Error("blackboard: not ready yet — await ctx.blackboard.waitReady() first");
		}
	}

	_assertSection(section) {
		if (typeof section !== "string" || !SECTION_RE.test(section)) {
			throw new TypeError(`blackboard: invalid section ${JSON.stringify(section)}`);
		}
	}

	_assertKey(key) {
		if (typeof key !== "string" || key.length === 0 || key.length > 256) {
			throw new TypeError(`blackboard: invalid key ${JSON.stringify(key)}`);
		}
	}

	_assertJsonValue(value) {
		if (value === undefined) throw new TypeError("blackboard: value must not be undefined");
		try {
			JSON.stringify(value);
		} catch {
			throw new TypeError("blackboard: value must be JSON-serializable");
		}
	}

	//#region reads (synchronous once ready)

	/** Absolute path of the persistence file. */
	getFile() {
		return this.file;
	}

	/** Deep clone of the whole document. */
	getDocument() {
		this._ensureReady();
		return deepClone(this.document);
	}

	/** Deep clone of one section map (undefined when the section does not exist). */
	getSection(section) {
		this._ensureReady();
		const entries = this.document.sections[section];
		return entries === undefined ? undefined : deepClone(entries);
	}

	/** Section names currently present. */
	listSections() {
		this._ensureReady();
		return Object.keys(this.document.sections);
	}

	/** Deep clone of one entry (undefined when absent). */
	get(section, key) {
		this._ensureReady();
		return deepClone(this.document.sections[section]?.[key]);
	}

	/** Whether the entry exists. */
	has(section, key) {
		this._ensureReady();
		return Boolean(this.document.sections[section] && key in this.document.sections[section]);
	}

	/** Keys of one section (empty when the section does not exist). */
	keys(section) {
		this._ensureReady();
		return Object.keys(this.document.sections[section] ?? {});
	}

	/** Number of entries in one section. */
	size(section) {
		this._ensureReady();
		return Object.keys(this.document.sections[section] ?? {}).length;
	}

	/** Total number of entries across all sections. */
	count() {
		this._ensureReady();
		return Object.values(this.document.sections).reduce((total, entries) => total + Object.keys(entries).length, 0);
	}

	/**
	 * Case-insensitive substring search over keys and serialized values.
	 * @param query - the substring to look for.
	 * @param options - `{ caseInsensitive = true, limit = 100 }`.
	 * @returns matching `{ section, key, value }` records.
	 */
	async search(query, options = {}) {
		this._ensureReady();
		const { caseInsensitive = true, limit = 100 } = options;
		const needle = caseInsensitive ? String(query).toLowerCase() : String(query);
		const results = [];
		for (const [section, entries] of Object.entries(this.document.sections)) {
			for (const [key, value] of Object.entries(entries)) {
				const haystack = caseInsensitive
					? `${key}\n${JSON.stringify(value)}`.toLowerCase()
					: `${key}\n${JSON.stringify(value)}`;
				if (haystack.includes(needle)) {
					results.push({ section, key, value: deepClone(value) });
					if (results.length >= limit) return results;
				}
			}
		}
		return results;
	}

	//#endregion

	//#region writes (async, durable, evented)

	/**
	 * Set one entry (auto-creates the section). No-op when the stored value is
	 * JSON-deep-equal — no write, no event.
	 * @returns `{ section, key, value, previous, changed, at, file }`.
	 */
	async set(section, key, value) {
		this._assertSection(section);
		this._assertKey(key);
		this._assertJsonValue(value);
		await this.waitReady();
		return this._enqueue(async () => {
			const previous = deepClone(this.document.sections[section]?.[key]);
			if (deepEqualJson(previous, value)) {
				return { section, key, value, previous, changed: false, at: this.document.meta.lastWriteAt, file: this.file };
			}
			const next = deepClone(this.document);
			next.sections[section] ??= {};
			next.sections[section][key] = deepClone(value);
			return this._finishCommit("blackboard/set", "set", next, { section, key, value, previous, changed: true });
		});
	}

	/**
	 * Merge an object patch into one entry: plain-object entries merge
	 * shallowly, everything else is replaced by the patch.
	 * @returns `{ section, key, value, previous, changed, at, file }`.
	 */
	async update(section, key, patch) {
		this._assertSection(section);
		this._assertKey(key);
		this._assertJsonValue(patch);
		if (!isPlainObject(patch)) throw new TypeError("blackboard: update patch must be a plain object");
		await this.waitReady();
		return this._enqueue(async () => {
			const previous = deepClone(this.document.sections[section]?.[key]);
			const merged = isPlainObject(previous) ? { ...deepClone(previous), ...deepClone(patch) } : deepClone(patch);
			if (deepEqualJson(previous, merged)) {
				return { section, key, value: merged, previous, changed: false, at: this.document.meta.lastWriteAt, file: this.file };
			}
			const next = deepClone(this.document);
			next.sections[section] ??= {};
			next.sections[section][key] = merged;
			return this._finishCommit("blackboard/update", "update", next, { section, key, value: merged, previous, changed: true });
		});
	}

	/**
	 * Append one item to an array entry (logs, clue trails, tool output lines).
	 * Non-array entries are replaced by a single-item array.
	 * @returns `{ section, key, item, previous, changed, at, file }`.
	 */
	async append(section, key, item) {
		this._assertSection(section);
		this._assertKey(key);
		this._assertJsonValue(item);
		await this.waitReady();
		return this._enqueue(async () => {
			const previous = deepClone(this.document.sections[section]?.[key]);
			const list = Array.isArray(previous) ? deepClone(previous) : [];
			list.push(deepClone(item));
			const next = deepClone(this.document);
			next.sections[section] ??= {};
			next.sections[section][key] = list;
			return this._finishCommit("blackboard/append", "append", next, { section, key, item, previous, changed: true });
		});
	}

	/**
	 * Delete one entry (alias: `remove`).
	 * @returns `{ section, key, previous, changed, at, file }`.
	 */
	async delete(section, key) {
		this._assertSection(section);
		this._assertKey(key);
		await this.waitReady();
		return this._enqueue(async () => {
			const previous = deepClone(this.document.sections[section]?.[key]);
			if (!this.document.sections[section] || !(key in this.document.sections[section])) {
				return { section, key, previous, changed: false, at: this.document.meta.lastWriteAt, file: this.file };
			}
			const next = deepClone(this.document);
			delete next.sections[section][key];
			return this._finishCommit("blackboard/delete", "delete", next, { section, key, previous, changed: true });
		});
	}

	/** Alias of {@link delete}. */
	remove(section, key) {
		return this.delete(section, key);
	}

	/**
	 * Empty one section (the section itself stays).
	 * @returns `{ section, previous, changed, at, file }`.
	 */
	async clearSection(section) {
		this._assertSection(section);
		await this.waitReady();
		return this._enqueue(async () => {
			const previous = deepClone(this.document.sections[section] ?? {});
			if (Object.keys(previous).length === 0) {
				return { section, previous, changed: false, at: this.document.meta.lastWriteAt, file: this.file };
			}
			const next = deepClone(this.document);
			next.sections[section] = {};
			return this._finishCommit("blackboard/clear-section", "clear-section", next, { section, previous, changed: true });
		});
	}

	/**
	 * Empty every section (structure and meta are kept).
	 * @returns `{ previous, changed, at, file }`.
	 */
	async clear() {
		await this.waitReady();
		return this._enqueue(async () => {
			const previous = deepClone(this.document.sections);
			const empty = Object.fromEntries(Object.keys(previous).map((name) => [name, {}]));
			if (deepEqualJson(previous, empty)) {
				return { previous, changed: false, at: this.document.meta.lastWriteAt, file: this.file };
			}
			const next = deepClone(this.document);
			next.sections = empty;
			return this._finishCommit("blackboard/clear", "clear", next, { previous, changed: true });
		});
	}

	/**
	 * Force a durable rewrite of the current document (refreshes
	 * `meta.lastWriteAt`). Emits only `blackboard/persist`.
	 */
	async touch() {
		await this.waitReady();
		return this._enqueue(async () => {
			const next = deepClone(this.document);
			const at = nowIso();
			next.meta.lastWriteAt = at;
			await this._writeDocument(next);
			this.document = next;
			if (!this.closed) this.ctx.emit("blackboard/persist", { at, file: this.file });
			return { at, file: this.file };
		});
	}

	//#endregion

	//#region command channel

	/**
	 * Event-driven write channel for agent plugins that prefer the bus over
	 * the service API: `ctx.emit("blackboard/command", { op, section, key, value })`
	 * with `op` one of `set | update | append | delete | remove | clear-section |
	 * clear | touch`. Failures are logged and surfaced as `blackboard/error`.
	 */
	async _dispatchCommand(payload) {
		const { op, section, key, value } = payload ?? {};
		try {
			switch (op) {
				case "set": await this.set(section, key, value); break;
				case "update": await this.update(section, key, value); break;
				case "append": await this.append(section, key, value); break;
				case "delete":
				case "remove": await this.delete(section, key); break;
				case "clear-section": await this.clearSection(section); break;
				case "clear": await this.clear(); break;
				case "touch": await this.touch(); break;
				default: throw new TypeError(`blackboard: unknown command op ${JSON.stringify(op)}`);
			}
		} catch (error) {
			this.ctx.logger.warn("blackboard: command %o failed: %s", payload, error?.message ?? String(error));
			if (!this.closed) this.ctx.emit("blackboard/error", { error, at: nowIso() });
		}
	}

	//#endregion
}

export { BlackboardProvider, BlackboardProvider as default, CANONICAL_SECTIONS, DEFAULT_FILE, SCHEMA_VERSION, deepClone, deepEqualJson, serializeDocument };
//#endregion

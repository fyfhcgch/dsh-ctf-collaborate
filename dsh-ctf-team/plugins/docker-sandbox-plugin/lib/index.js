//#region lib/index.js
/**
 * dsh-docker-sandbox — 外部 Docker 沙箱执行服务 (external Docker sandbox
 * execution service for CTF agents).
 *
 * 职责：
 *   1. 通过 **Docker Engine API**（HTTP/TCP、Unix socket、Windows named
 *      pipe）在一次性容器里执行任意命令/脚本 —— 纯 HTTP 客户端，绝不调用
 *      本地 shell（不 spawn、不 exec、不 child_process）；
 *   2. 沙箱化执行：镜像白名单、内存/CPU 限制、超时强杀（SIGKILL）、
 *      输出截断、自动清理容器（force remove）、no-new-privileges；
 *   3. 文件注入：把 `files`/`script` 以 ustar tar 上传进容器工作目录；
 *   4. 每次执行记录经 ctx.blackboard 持久化（executions/<runId> 全量记录、
 *      status 守护状态、tool_outputs 联动），重启不丢失；
 *   5. 后台任务与定时器全部由 cordis 生命周期托管：ctx.effect() 注册
 *      健康检查定时器与运行超时定时器，fiber 销毁时自动清理；
 *      容器等待（/containers/{id}/wait 长轮询）支持 AbortSignal，
 *      插件卸载时中止所有在飞请求。
 *
 * 事件总线（cordis）：
 *   命令通道   sandbox/command { op: "ping"|"run"|"version"|"info"|"list-images"|"list-containers"|"prune"|"remove-container"|"status", ... }
 *   通知事件   sandbox/ready sandbox/ping sandbox/run-start sandbox/run-done
 *             sandbox/run-fail sandbox/error
 *
 * 运行约束：
 *   - 硬性依赖 inject: ["blackboard"]（与其它 CTF 插件一致，全部持久化
 *     复用 blackboard 服务）；
 *   - 守护进程不可达时插件以降级模式启动（available=false，健康检查持续
 *     重试），不会拖垮 profile。
 *
 * @module @dsh-external/dsh-docker-sandbox
 */
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/** 默认 blackboard 分区名。 */
const DEFAULT_SECTION = "sandbox";
/** blackboard 分区名规则（与其它插件一致）。 */
const SECTION_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** 容器标签前缀（用于溯源与清理）。 */
const LABEL_PREFIX = "dsh.sandbox";
/** Windows 默认 Docker Desktop named pipe。 */
const DEFAULT_NPIPE = "\\\\.\\pipe\\docker_engine";
/** Unix 默认 docker socket。 */
const DEFAULT_SOCKET = "/var/run/docker.sock";
/** 运行超时上限（防止误配置拖垮执行器）。 */
const MAX_RUN_TIMEOUT_MS = 600000;
/** 文件注入总大小上限（10MB，防滥用）。 */
const DEFAULT_TAR_UPLOAD_LIMIT = 10485760;

/** 当前 UTC 时间 ISO-8601。 */
function nowIso() {
	return new Date().toISOString();
}

/** 4-hex 随机后缀。 */
function randomSuffix() {
	return Math.random().toString(16).slice(2, 6);
}

/** 普通对象判断。 */
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 深拷贝（值按 JSON 契约）。 */
function deepClone(value) {
	return value === undefined ? undefined : structuredClone(value);
}

/** 构造一个带 code 的错误。 */
function codedError(code, message, extra = {}) {
	return Object.assign(new Error(message), { code, ...extra });
}

/** 镜像名规范化：无 tag 补 latest（`alpine` → `alpine:latest`）。 */
function normalizeImageName(image) {
	const name = String(image ?? "").trim();
	if (!name) throw codedError("EINVAL", "sandbox: image must be a non-empty string");
	if (name.includes(":")) return name;
	return `${name}:latest`;
}

/** 内存限制字符串 → 字节（支持 b/k/m/g，大小写不敏感）。 */
function parseMemory(value) {
	const text = String(value ?? "").trim().toLowerCase();
	const match = /^(\d+(?:\.\d+)?)\s*([bkmg]?)$/.exec(text);
	if (!match) throw codedError("EINVAL", `sandbox: invalid memory limit ${JSON.stringify(value)}`);
	const n = Number(match[1]);
	const unit = match[2] || "b";
	const mult = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[unit];
	return Math.round(n * mult);
}

/** 对象 → URL query 字符串（跳过 undefined）。 */
function buildQuery(params) {
	const parts = [];
	for (const [key, value] of Object.entries(params ?? {})) {
		if (value === undefined || value === null) continue;
		parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`); // prettier-ignore
	}
	return parts.length ? `?${parts.join("&")}` : "";
}

/** 连接类错误 → 统一 EUNREACHABLE（信息里带上目标，便于排障）。 */
function classifySocketError(error, target) {
	const code = error?.code;
	if (code === "EABORTED") return error;
	if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "EPIPE" || code === "ECONNRESET" || code === "ENOENT" || code === "ECONNABORTED") {
		return codedError("EUNREACHABLE", `sandbox: cannot reach docker daemon at ${target} (${code}) — 检查 Docker 是否运行、Docker Desktop 是否启动、端点配置是否正确`, { cause: error });
	}
	return error;
}

//#region Docker Engine API 客户端（纯 HTTP，无本地 shell）

/**
 * 极简 HTTP/1.1 响应解析器（用于 Unix socket / Windows named pipe 传输）。
 * 支持 Content-Length、chunked、until-close 三种响应体模式。
 */
class HttpResponseParser {
	constructor({ maxBodyBytes = 64 * 1024 * 1024 } = {}) {
		this.buffer = Buffer.alloc(0);
		this.headEnd = -1;
		this.status = 0;
		this.statusText = "";
		this.headers = {};
		this.bodyMode = null;
		this.contentLength = 0;
		this.bodyChunks = [];
		this.bodyBytes = 0;
		this.done = false;
		this.maxBodyBytes = maxBodyBytes;
	}

	/** 追加数据；返回 "pending" | "done" | "error"（error 时 this.error 已置位）。 */
	push(chunk) {
		if (this.done || this.error) return "done";
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		if (this.headEnd < 0) {
			const idx = this.buffer.indexOf("\r\n\r\n");
			if (idx < 0) {
				if (this.buffer.length > 65536) {
					this.error = new Error("sandbox: docker response head too large");
					return "error";
				}
				return "pending";
			}
			this.headEnd = idx + 4;
			const head = this.buffer.subarray(0, idx).toString("latin1");
			const lines = head.split("\r\n");
			const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0]);
			if (!match) {
				this.error = new Error(`sandbox: invalid HTTP status line ${JSON.stringify(lines[0])}`);
				return "error";
			}
			this.status = Number(match[1]);
			this.statusText = match[2] ?? "";
			for (const line of lines.slice(1)) {
				const colon = line.indexOf(":");
				if (colon < 0) continue;
				const key = line.slice(0, colon).trim().toLowerCase();
				const value = line.slice(colon + 1).trim();
				this.headers[key] = this.headers[key] ? `${this.headers[key]}, ${value}` : value;
			}
			const te = (this.headers["transfer-encoding"] ?? "").toLowerCase();
			if (te.includes("chunked")) this.bodyMode = "chunked";
			else if (this.headers["content-length"] !== undefined) {
				this.bodyMode = "length";
				this.contentLength = Number(this.headers["content-length"]) || 0;
			} else this.bodyMode = this.status === 204 || this.status === 304 ? "none" : "until-close";
		}
		return this._consume();
	}

	/** 完成解析（until-close 模式由 socket close 触发）。 */
	finish() {
		if (this.done || this.error) return;
		if (this.bodyMode === "until-close") {
			this.bodyBytes += this.buffer.length - this.headEnd;
			if (this.bodyBytes > this.maxBodyBytes) {
				this.error = new Error("sandbox: docker response body too large");
				return;
			}
			this.bodyChunks.push(this.buffer.subarray(this.headEnd));
			this._settle();
		} else if (this.bodyMode === "none") {
			this._settle();
		} else if (!this.done && !this.error) {
			this.error = new Error("sandbox: docker response ended before body completed");
		}
	}

	_consume() {
		if (this.done || this.error) return this.done ? "done" : "error";
		if (this.bodyMode === "none") {
			this._settle();
			return "done";
		}
		if (this.bodyMode === "length") {
			const need = this.headEnd + this.contentLength;
			if (this.buffer.length < need) {
				if (this.contentLength > this.maxBodyBytes) {
					this.error = new Error("sandbox: docker response body too large");
					return "error";
				}
				return "pending";
			}
			const body = this.buffer.subarray(this.headEnd, need);
			this.bodyChunks.push(body);
			this.bodyBytes = body.length;
			this._settle();
			return "done";
		}
		// chunked
		let pos = this.headEnd;
		const chunks = [];
		let total = 0;
		for (;;) {
			const lineEnd = this.buffer.indexOf("\r\n", pos);
			if (lineEnd < 0) return "pending";
			const sizeHex = this.buffer.subarray(pos, lineEnd).toString("latin1").split(";")[0].trim();
			const size = Number.parseInt(sizeHex, 16);
			if (!Number.isFinite(size)) {
				this.error = new Error(`sandbox: invalid chunk size ${JSON.stringify(sizeHex)}`);
				return "error";
			}
			pos = lineEnd + 2;
			if (size === 0) {
				const trailerEnd = this.buffer.indexOf("\r\n\r\n", pos);
				if (trailerEnd < 0) return "pending";
				pos = trailerEnd + 4;
				break;
			}
			if (total + size > this.maxBodyBytes) {
				this.error = new Error("sandbox: docker response body too large");
				return "error";
			}
			if (this.buffer.length < pos + size + 2) return "pending";
			chunks.push(this.buffer.subarray(pos, pos + size));
			total += size;
			pos += size + 2;
		}
		this.bodyChunks = chunks;
		this.bodyBytes = total;
		this._settle();
		return "done";
	}

	_settle() {
		this.done = true;
		this.body = Buffer.concat(this.bodyChunks);
		this.buffer = Buffer.alloc(0);
	}
}

/**
 * Docker Engine API 客户端。
 *
 * 传输选择（构造时解析，优先级从高到低）：
 *   1. `baseUrl`    — http(s)://host:port（如 http://127.0.0.1:2375）
 *   2. `socketPath` — Unix socket（如 /var/run/docker.sock）
 *   3. `npipe`      — Windows named pipe（如 \\.\pipe\docker_engine）
 *   4. 自动探测     — win32 走默认 named pipe，否则默认 unix socket
 *
 * 所有方法均为纯 HTTP 请求：node:http/https（TCP/TLS）或 net socket 上的
 * 手写 HTTP/1.1（socket/named pipe）。没有任何本地进程调用。
 */
class DockerEngineClient {
	constructor(options = {}) {
		this.logger = options.logger ?? (() => {});
		this.connectTimeoutMs = options.connectTimeoutMs ?? 3000;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
		this.target = this._resolveTarget(options);
	}

	_resolveTarget({ baseUrl, socketPath, npipe }) {
		if (baseUrl && String(baseUrl).trim()) {
			const url = new URL(baseUrl.trim());
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				throw codedError("EINVAL", `sandbox: baseUrl must be http(s), got ${JSON.stringify(baseUrl)}`);
			}
			return {
				type: url.protocol === "https:" ? "https" : "http",
				hostname: url.hostname,
				port: url.port || (url.protocol === "https:" ? 443 : 80),
				label: `${url.protocol}//${url.host}`
			};
		}
		if (socketPath && String(socketPath).trim()) {
			return { type: "socket", path: String(socketPath).trim(), label: `socket:${socketPath}` };
		}
		if (npipe && String(npipe).trim()) {
			return { type: "socket", path: String(npipe).trim(), label: `npipe:${npipe}` };
		}
		if (process.platform === "win32") {
			return { type: "socket", path: DEFAULT_NPIPE, label: `npipe:${DEFAULT_NPIPE}` };
		}
		return { type: "socket", path: DEFAULT_SOCKET, label: `socket:${DEFAULT_SOCKET}` };
	}

	/** 低层请求。`body` 为 string|Buffer；`signal` 支持中止；`maxBodyBytes` 限制响应体。 */
	_request(method, path, options = {}) {
		const { query, headers = {}, body, timeoutMs, signal, maxBodyBytes = 64 * 1024 * 1024 } = options;
		const pathWithQuery = `${path}${buildQuery(query)}`;
		const reqHeaders = {
			Host: "docker",
			...headers
		};
		if (body !== undefined) {
			const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
			reqHeaders["Content-Length"] = String(buf.length);
			reqHeaders["Content-Type"] = headers["Content-Type"] ?? "application/json";
		}
		this.logger(`docker ${method} ${pathWithQuery}`);
		if (this.target.type === "socket") return this._socketRequest(method, pathWithQuery, { headers: reqHeaders, body, timeoutMs, signal, maxBodyBytes });
		return this._networkRequest(method, pathWithQuery, { headers: reqHeaders, body, timeoutMs, signal, maxBodyBytes });
	}

	/** node:http/https 传输。 */
	_networkRequest(method, pathWithQuery, { headers, body, timeoutMs, signal, maxBodyBytes }) {
		return new Promise((resolve, reject) => {
			const lib = this.target.type === "https" ? https : http;
			// timeoutMs === 0 → 不设请求超时（长轮询 /wait 由运行超时 + AbortSignal 接管）
			const requestTimeout = timeoutMs === 0 ? 0 : (timeoutMs ?? this.requestTimeoutMs);
			const requestOptions = {
				hostname: this.target.hostname,
				port: this.target.port,
				path: pathWithQuery,
				method,
				headers,
				timeout: requestTimeout || undefined,
				...(!(signal?.aborted) ? { signal } : {})
			};
			let settled = false;
			const fail = (error) => {
				if (settled) return;
				settled = true;
				reject(error);
			};
			const req = lib.request(requestOptions, (res) => {
				const chunks = [];
				let size = 0;
				res.on("data", (chunk) => {
					size += chunk.length;
					if (size > maxBodyBytes) {
						req.destroy();
						fail(codedError("EBODY", `sandbox: docker response body exceeds ${maxBodyBytes} bytes`));
						return;
					}
					chunks.push(chunk);
				});
				res.on("end", () => {
					if (settled) return;
					settled = true;
					resolve({
						status: res.statusCode ?? 0,
						statusText: res.statusMessage ?? "",
						headers: res.headers,
						body: Buffer.concat(chunks)
					});
				});
			});
			if (requestTimeout) {
				req.setTimeout(requestTimeout, () => {
					req.destroy(codedError("EAPI_TIMEOUT", `sandbox: docker api request timed out after ${requestTimeout}ms`));
				});
			}
			req.on("error", (error) => {
				if (settled) return;
				if (error?.code === "EABORTED" || error?.name === "AbortError") {
					fail(codedError("EABORTED", "sandbox: docker request aborted"));
					return;
				}
				fail(classifySocketError(error, this.target.label));
			});
			if (body !== undefined) req.write(body);
			req.end();
		});
	}

	/** Unix socket / named pipe 传输：net 连接 + 手写 HTTP/1.1。 */
	_socketRequest(method, pathWithQuery, { headers, body, timeoutMs, signal, maxBodyBytes }) {
		return new Promise((resolve, reject) => {
			const parser = new HttpResponseParser({ maxBodyBytes });
			let settled = false;
			let socket = null;
			const fail = (error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			const cleanup = () => {
				if (socket) {
					socket.removeAllListeners();
					socket.destroy();
					socket = null;
				}
				if (onAbort) signal?.removeEventListener("abort", onAbort);
			};
			let onAbort = null;
			if (signal) {
				if (signal.aborted) {
					fail(codedError("EABORTED", "sandbox: docker request aborted"));
					return;
				}
				onAbort = () => fail(codedError("EABORTED", "sandbox: docker request aborted"));
				signal.addEventListener("abort", onAbort, { once: true });
			}
			socket = net.createConnection({ path: this.target.path });
			const socketTimeout = timeoutMs === 0 ? 0 : (timeoutMs ?? this.requestTimeoutMs);
			if (socketTimeout) {
				socket.setTimeout(socketTimeout, () => {
					socket.destroy(codedError("EAPI_TIMEOUT", `sandbox: docker api request timed out after ${socketTimeout}ms`));
				});
			}
			socket.on("error", (error) => {
				if (error?.code === "EABORTED") {
					fail(error);
					return;
				}
				fail(classifySocketError(error, this.target.label));
			});
			socket.on("connect", () => {
				let head = `${method} ${pathWithQuery} HTTP/1.1\r\n`;
				for (const [key, value] of Object.entries(headers)) head += `${key}: ${value}\r\n`;
				head += "Connection: close\r\n\r\n";
				socket.write(head);
				if (body !== undefined) socket.write(body);
			});
			socket.on("data", (chunk) => {
				const state = parser.push(chunk);
				if (state === "error") {
					fail(parser.error);
				} else if (state === "done") {
					settled = true;
					cleanup();
					resolve({
						status: parser.status,
						statusText: parser.statusText,
						headers: parser.headers,
						body: parser.body ?? Buffer.alloc(0)
					});
				}
			});
			socket.on("close", () => {
				if (settled) return;
				if (parser.bodyMode === "until-close") {
					parser.finish();
					if (parser.error) {
						fail(parser.error);
						return;
					}
					settled = true;
					cleanup();
					resolve({
						status: parser.status,
						statusText: parser.statusText,
						headers: parser.headers,
						body: parser.body ?? Buffer.alloc(0)
					});
					return;
				}
				fail(new Error("sandbox: docker connection closed before response completed"));
			});
		});
	}

	/** 统一响应处理：非 2xx 抛 DockerEngineError，JSON 响应自动解析。 */
	async _call(method, path, options = {}) {
		const { expectStatus, json = true } = options;
		const res = await this._request(method, path, options);
		if (expectStatus && !expectStatus.includes(res.status)) {
			const text = res.body.length ? res.body.toString("utf8").slice(0, 2000) : "";
			throw codedError(`EHTTP${res.status}`, `sandbox: docker api ${method} ${path} → ${res.status} ${res.statusText}${text ? `: ${text}` : ""}`, { status: res.status, body: text });
		}
		if (!json || res.status === 204 || res.status === 304 || res.body.length === 0) return { status: res.status, headers: res.headers, body: res.body, data: undefined };
		const first = res.body.subarray(0, 1).toString("latin1");
		if (first !== "{" && first !== "[") return { status: res.status, headers: res.headers, body: res.body, data: undefined };
		try {
			return { status: res.status, headers: res.headers, body: res.body, data: JSON.parse(res.body.toString("utf8")) };
		} catch {
			return { status: res.status, headers: res.headers, body: res.body, data: undefined };
		}
	}

	/** GET /_ping（文本 "OK"）。 */
	async ping() {
		const res = await this._call("GET", "/_ping", { expectStatus: [200], json: false });
		return res.body.toString("utf8").trim();
	}

	/** GET /version。 */
	async version() {
		const res = await this._call("GET", "/version", { expectStatus: [200] });
		return res.data ?? {};
	}

	/** GET /info。 */
	async info() {
		const res = await this._call("GET", "/info", { expectStatus: [200] });
		return res.data ?? {};
	}

	/** GET /images/json → [{ Id, RepoTags, ... }]。 */
	async listImages() {
		const res = await this._call("GET", "/images/json", { expectStatus: [200] });
		return res.data ?? [];
	}

	/** POST /images/create?fromImage=...（拉取镜像，读取整个进度流）。 */
	async pullImage(image) {
		const [name, tag = "latest"] = normalizeImageName(image).split(":", 2);
		await this._call("POST", "/images/create", {
			query: { fromImage: name, tag },
			expectStatus: [200],
			maxBodyBytes: 32 * 1024 * 1024
		});
	}

	/** POST /containers/create → { Id, Warnings }。 */
	async createContainer(spec, name) {
		const res = await this._call("POST", "/containers/create", {
			query: name ? { name } : undefined,
			body: JSON.stringify(spec),
			expectStatus: [201, 200]
		});
		return { id: res.data?.Id ?? res.data?.id, warnings: res.data?.Warnings ?? [] };
	}

	/** POST /containers/{id}/start。 */
	async startContainer(id) {
		await this._call("POST", `/containers/${id}/start`, { expectStatus: [204, 200, 304] });
	}

	/** POST /containers/{id}/wait（长轮询，容器退出后返回 { StatusCode }）。 */
	async waitContainer(id, options = {}) {
		const res = await this._call("POST", `/containers/${id}/wait`, {
			query: { condition: "not-running" },
			expectStatus: [200],
			timeoutMs: options.timeoutMs,
			signal: options.signal
		});
		return { statusCode: res.data?.StatusCode ?? null, error: res.data?.Error ?? null };
	}

	/** POST /containers/{id}/kill?signal=...。 */
	async killContainer(id, signal = "SIGKILL") {
		await this._call("POST", `/containers/${id}/kill`, { query: { signal }, expectStatus: [204, 200] });
	}

	/** GET /containers/{id}/json → { State: { ExitCode, ... } }。 */
	async inspectContainer(id) {
		const res = await this._call("GET", `/containers/${id}/json`, { expectStatus: [200] });
		return res.data ?? {};
	}

	/** GET /containers/{id}/logs?stdout=1&stderr=1&tail=all（raw-stream 帧）。 */
	async containerLogs(id, options = {}) {
		const res = await this._call("GET", `/containers/${id}/logs`, {
			query: { stdout: 1, stderr: 1, tail: "all" },
			expectStatus: [200],
			json: false,
			maxBodyBytes: options.maxBodyBytes,
			signal: options.signal
		});
		return res.body;
	}

	/** DELETE /containers/{id}?force=1&v=1。 */
	async removeContainer(id, options = {}) {
		await this._call("DELETE", `/containers/${id}`, { query: { force: options.force ? 1 : undefined, v: options.v ? 1 : undefined }, expectStatus: [204, 200, 404] });
	}

	/** PUT /containers/{id}/archive?path=/（tar 注入）。 */
	async uploadArchive(id, path, tarBuffer) {
		await this._call("PUT", `/containers/${id}/archive`, {
			query: { path },
			headers: { "Content-Type": "application/x-tar" },
			body: tarBuffer,
			expectStatus: [200, 201]
		});
	}

	/** GET /containers/json?all=1。 */
	async listContainers() {
		const res = await this._call("GET", "/containers/json", { query: { all: 1 }, expectStatus: [200] });
		return res.data ?? [];
	}

	/** POST /containers/prune?label=...（清理带标签的容器）。 */
	async pruneContainers(label) {
		const res = await this._call("POST", "/containers/prune", { query: { label }, expectStatus: [200] });
		return res.data ?? {};
	}
}

//#endregion

//#region ustar tar 写入器（零依赖）

/**
 * 构造 ustar tar 归档（无依赖实现，供 Docker archive API 使用）。
 * @param files - `[{ name, content?, mode?, mtime? }]`；name 为容器内相对
 *   路径（如 `work/main.py`），可含目录；自动补目录项。
 * @returns Buffer（含两个 512B 结尾块）。
 */
function buildTar(files) {
	const blocks = [];

	const pushHeader = (name, typeflag, size, mode, mtime) => {
		const header = Buffer.alloc(512);
		const nameBytes = Buffer.from(name, "utf8");
		let nameField = nameBytes;
		let prefixField = Buffer.alloc(0);
		if (nameBytes.length > 100) {
			// ustar 长名拆分：prefix(≤155) + "/" + name(≤100)，按字节找分割点
			const minSplit = Math.max(0, nameBytes.length - 101);
			const maxSplit = Math.min(155, nameBytes.length - 2);
			let split = -1;
			for (let i = minSplit; i <= maxSplit; i++) {
				if (nameBytes[i] === 0x2f) {
					split = i;
					break;
				}
			}
			if (split < 0) throw codedError("ETAR", `sandbox: tar path too long: ${name}`);
			prefixField = nameBytes.subarray(0, split);
			nameField = nameBytes.subarray(split + 1);
		}
		nameField.copy(header, 0, 0, Math.min(100, nameField.length));
		if (prefixField.length) prefixField.copy(header, 345, 0, Math.min(155, prefixField.length));
		header.write("0000000\0", 108, 8, "latin1"); // uid
		header.write("0000000\0", 116, 8, "latin1"); // gid
		header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "latin1");
		header.write(Math.floor(mtime).toString(8).padStart(11, "0") + "\0", 136, 12, "latin1");
		header.write("        ", 148, 8, "latin1"); // checksum 占位（8 空格）
		header.write(typeflag, 156, 1, "latin1");
		header.write("ustar\0", 257, 6, "latin1");
		header.write("00", 263, 2, "latin1");
		// mode（8 字节：6 位八进制 + NUL）
		header.write(mode.toString(8).padStart(6, "0") + "\0", 100, 8, "latin1");
		// checksum：整个 header 的字节和（checksum 域按空格计）
		let checksum = 0;
		for (let i = 0; i < 512; i++) checksum += header[i];
		header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "latin1");
		blocks.push(header);
	};

	const pushContent = (content) => {
		const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ""), "utf8");
		if (buf.length) blocks.push(buf);
		const pad = (512 - (buf.length % 512)) % 512;
		if (pad) blocks.push(Buffer.alloc(pad));
		return buf.length;
	};

	const dirs = new Set();
	const cleanName = (raw) => {
		let name = String(raw ?? "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
		if (!name) throw codedError("ETAR", "sandbox: tar entry name must be non-empty");
		const parts = name.split("/");
		if (parts.some((p) => p === ".." || p === ".")) throw codedError("ETAR", `sandbox: tar entry name must not contain "..": ${name}`);
		return name;
	};

	for (const file of files ?? []) {
		const isDir = file.type === "dir";
		const name = cleanName(file.name);
		const parts = name.split("/");
		// 目录项（从短到长，只补到父级）
		for (let i = 1; i < parts.length; i++) {
			const dir = parts.slice(0, i).join("/");
			if (dirs.has(dir)) continue;
			dirs.add(dir);
			pushHeader(dir, "5", 0, 0o755, file.mtime ?? Math.floor(Date.now() / 1000));
		}
		if (isDir) {
			dirs.add(name);
			pushHeader(name, "5", 0, file.mode ?? 0o755, file.mtime ?? Math.floor(Date.now() / 1000));
			continue;
		}
		const content = file.content === undefined || file.content === null ? Buffer.alloc(0) : (Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content), "utf8"));
		pushHeader(name, "0", content.length, file.mode ?? 0o644, file.mtime ?? Math.floor(Date.now() / 1000));
		pushContent(content);
	}

	blocks.push(Buffer.alloc(512), Buffer.alloc(512));
	return Buffer.concat(blocks);
}

//#endregion

//#region docker 日志帧解码

/**
 * 解码 Docker raw-stream 日志（非 TTY 容器）：
 * 每帧 = 1B stream(1=stdout,2=stderr) + 3B 填充 + 4B 大端长度 + payload。
 * 非帧数据（尾随字节）并入 stdout。按 maxOutputBytes 截断每个流。
 */
function decodeDockerLogFrames(buffer, maxOutputBytes = 262144) {
	const stdout = [];
	const stderr = [];
	let stdoutBytes = 0;
	let stderrBytes = 0;
	let offset = 0;
	const push = (list, counter, payload) => {
		const room = maxOutputBytes - counter;
		if (room <= 0) return;
		const slice = payload.length > room ? payload.subarray(0, room) : payload;
		list.push(slice);
		counter += slice.length;
		return counter;
	};
	while (offset + 8 <= buffer.length) {
		const streamType = buffer[offset];
		const size = buffer.readUInt32BE(offset + 4);
		offset += 8;
		if (offset + size > buffer.length) break; // 帧不完整，剩余按 stdout 处理
		const payload = buffer.subarray(offset, offset + size);
		offset += size;
		if (streamType === 2) stderrBytes = push(stderr, stderrBytes, payload);
		else stdoutBytes = push(stdout, stdoutBytes, payload);
	}
	if (offset < buffer.length) push(stdout, stdoutBytes, buffer.subarray(offset));
	return {
		stdout: Buffer.concat(stdout).toString("utf8"),
		stderr: Buffer.concat(stderr).toString("utf8")
	};
}

//#endregion

//#region 沙箱服务

/**
 * 沙箱执行服务。注册为 `ctx.dockerSandbox`（dsh-base 已内置 `ctx.sandbox`
 * 服务于 harness 自身工具沙箱，故本插件以独立服务名注册避免冲突）。
 * 硬性依赖 inject: ["blackboard"]。
 */
class SandboxService extends Service {
	/** 服务名（避免与内置 ctx.sandbox 冲突）。 */
	static provide = "dockerSandbox";
	/** 必需服务（硬依赖 blackboard，与其它 CTF 插件一致）。 */
	static inject = ["blackboard"];
	/** 插件配置 schema。 */
	static Config = z.object({
		section: z.string().default(DEFAULT_SECTION),
		baseUrl: z.string().default(""),
		socketPath: z.string().default(""),
		npipe: z.string().default(""),
		connectTimeoutMs: z.number().min(100).default(3000),
		requestTimeoutMs: z.number().min(100).default(30000),
		defaultImage: z.string().default("alpine:latest"),
		pullPolicy: z.string().default("missing"),
		defaultTimeoutMs: z.number().min(100).default(30000),
		maxRunTimeoutMs: z.number().min(100).default(MAX_RUN_TIMEOUT_MS),
		maxOutputBytes: z.number().min(1024).default(262144),
		maxConcurrentRuns: z.number().min(1).default(4),
		healthCheckMs: z.number().min(0).default(30000),
		healthCheckOnStart: z.boolean().default(true),
		recordToBlackboard: z.boolean().default(true),
		recordOutputMaxChars: z.number().min(0).default(4000),
		allowedImages: z.array(z.string()).default([]),
		autoRemove: z.boolean().default(true),
		keepFailedContainers: z.boolean().default(false),
		memoryLimit: z.string().default("256m"),
		cpus: z.number().min(0.1).default(1),
		networkDisabled: z.boolean().default(false),
		defaultUser: z.string().default(""),
		defaultWorkdir: z.string().default("/work"),
		allowPrivileged: z.boolean().default(false),
		tarUploadLimit: z.number().min(1024).default(DEFAULT_TAR_UPLOAD_LIMIT)
	});

	/** 已校验配置。 */
	config;
	/** blackboard 分区名。 */
	section;
	/** blackboard 服务（injected）。 */
	blackboard;
	/** Docker Engine API 客户端。 */
	client;
	/** 最近一次探测结果（{ ok, ... }）。 */
	lastPing = null;
	/** 信号量：当前占用槽位。 */
	activeSlots = 0;
	/** 信号量等待队列。 */
	waiters = [];
	/** 在飞运行（runId → AbortController）。 */
	inflight = new Map();
	/** 累计运行计数。 */
	totalRuns = 0;
	/** dispose 标记。 */
	closed = false;
	/** 上次持久化的 status（JSON 比较去重）。 */
	lastStatusJson = "";

	constructor(ctx, config) {
		super(ctx, "dockerSandbox");
		this.config = config;
		if (!SECTION_RE.test(config.section)) {
			throw new TypeError(`sandbox: invalid blackboard section ${JSON.stringify(config.section)}`);
		}
		if (!["missing", "always", "never"].includes(config.pullPolicy)) {
			throw new TypeError(`sandbox: pullPolicy must be missing|always|never, got ${JSON.stringify(config.pullPolicy)}`);
		}
		this.section = config.section;
		this.blackboard = ctx.blackboard;
		this.client = new DockerEngineClient({
			baseUrl: config.baseUrl,
			socketPath: config.socketPath,
			npipe: config.npipe,
			connectTimeoutMs: config.connectTimeoutMs,
			requestTimeoutMs: config.requestTimeoutMs,
			logger: (message) => this.ctx.logger.debug("sandbox: %s", message)
		});
	}

	/**
	 * 生命周期：注册命令通道、等待 blackboard、首次探测、启动健康检查
	 * （ctx.effect 托管定时器，fiber 销毁自动清理）。disposer 中止全部在飞
	 * 请求并排空信号量。
	 */
	async *[Service.init]() {
		// disposer 必须永不 reject：cordis 按注册序逆序链式执行 disposer，
		// 任一 reject 会中断后续清理链，导致其它插件的定时器/资源泄漏。
		yield async () => {
			this.closed = true;
			try {
				for (const controller of this.inflight.values()) controller.abort();
			} catch {
				/* 清理阶段绝不抛 */
			}
			this.inflight.clear();
			for (const waiter of this.waiters.splice(0)) {
				try {
					waiter.reject(codedError("EABORTED", "sandbox: plugin is shutting down"));
				} catch {
					/* 等待者可能已超时，忽略 */
				}
			}
		};
		this.ctx.on("sandbox/command", (payload) => {
			this.dispatch(payload).catch((error) => this._handleError("sandbox/command", error));
		});
		await this.blackboard.waitReady();
		const { totalRuns } = await this._loadCounters();
		this.totalRuns = totalRuns;
		if (this.config.healthCheckOnStart && !this.closed) {
			await this._probe().catch((error) => this._handleError("initial sandbox probe", error));
		}
		if (this.config.healthCheckMs > 0 && !this.closed) {
			this.ctx.effect(() => {
				const timer = setInterval(() => {
					// disposer 已运行/正在运行则立即短路：关闭后绝不产生新的
					// 后台活动（网络请求、事件、黑板上报）
					if (this.closed) return;
					this._probe().catch((error) => this._handleError("sandbox health check", error));
				}, this.config.healthCheckMs);
				return () => {
					try {
						clearInterval(timer);
					} catch {
						/* 幂等清理 */
					}
				};
			}, "sandbox:health-check");
		}
		if (!this.closed) {
			this.ctx.emit("sandbox/ready", {
				available: this.getAvailable(),
				daemon: this.lastPing?.ok ? this.lastPing.daemon : null,
				at: nowIso()
			});
		}
		this.ctx.logger.info("sandbox: ready (section=%s, target=%s, available=%s)", this.section, this.client.target.label, this.getAvailable());
	}

	/** 从 blackboard 恢复运行计数（重启断点）。 */
	async _loadCounters() {
		try {
			const status = await this.blackboard.get(this.section, "status");
			return { totalRuns: typeof status?.totalRuns === "number" ? status.totalRuns : 0 };
		} catch {
			return { totalRuns: 0 };
		}
	}

	//#region 服务 API

	/** 当前是否探测到可达的 docker daemon。 */
	getAvailable() {
		return this.lastPing?.ok === true;
	}

	/** 探测 daemon：/_ping + /version + /info。失败返回 { ok:false }，不抛。 */
	async ping() {
		try {
			const [pong, version, info] = await Promise.all([
				this.client.ping(),
				this.client.version(),
				this.client.info()
			]);
			const result = {
				ok: true,
				daemon: "Docker Engine API",
				pong,
				version: version.Version ?? "unknown",
				apiVersion: version.ApiVersion ?? "unknown",
				os: info.OSType ?? info.OperatingSystem ?? "unknown",
				arch: info.Architecture ?? "unknown",
				containerCount: info.Containers ?? 0,
				imageCount: info.Images ?? 0,
				target: this.client.target.label,
				at: nowIso()
			};
			this.lastPing = result;
			return result;
		} catch (error) {
			const result = {
				ok: false,
				daemon: "Docker Engine API",
				error: { code: error?.code ?? "ERR", message: error?.message ?? String(error) },
				target: this.client.target.label,
				at: nowIso()
			};
			this.lastPing = result;
			return result;
		}
	}

	/** GET /version。 */
	async version() {
		return this.client.version();
	}

	/** GET /info。 */
	async info() {
		return this.client.info();
	}

	/** GET /images/json。 */
	async listImages() {
		return this.client.listImages();
	}

	/** GET /containers/json?all=1。 */
	async listContainers() {
		return this.client.listContainers();
	}

	/** POST /containers/prune?label=dsh.sandbox（清理本插件遗留容器）。 */
	async prune() {
		return this.client.pruneContainers(LABEL_PREFIX);
	}

	/** 删除一个容器（清理遗留）。 */
	async removeContainer(id) {
		return this.client.removeContainer(id, { force: true, v: true });
	}

	/** 读取一次运行记录（blackboard）。 */
	async getRun(runId) {
		await this.blackboard.waitReady();
		return this.blackboard.get(this.section, `executions/${runId}`);
	}

	/** 列出全部运行记录（blackboard）。 */
	async listRuns() {
		await this.blackboard.waitReady();
		const keys = await this.blackboard.keys(this.section);
		const runs = [];
		for (const key of keys) {
			if (!key.startsWith("executions/")) continue;
			const run = await this.blackboard.get(this.section, key);
			if (run) runs.push(run);
		}
		return runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
	}

	/** 当前守护状态（含队列统计）。 */
	async status() {
		await this.blackboard.waitReady();
		const stored = await this.blackboard.get(this.section, "status");
		return {
			available: this.getAvailable(),
			target: this.client.target.label,
			activeSlots: this.activeSlots,
			maxConcurrentRuns: this.config.maxConcurrentRuns,
			queued: this.waiters.length,
			inflight: this.inflight.size,
			totalRuns: this.totalRuns,
			lastPing: this.lastPing,
			...stored
		};
	}

	/**
	 * 沙箱执行一次命令/脚本。
	 * @param input - `{ image?, cmd?, args?, entrypoint?, script?, files?,
	 *   env?, workdir?, user?, memory?, cpus?, networkDisabled?, timeoutMs?,
	 *   maxOutputBytes?, autoRemove?, name?, labels?, privileged?, planId?,
	 *   taskId? }`。
	 * @returns `{ runId, ok, exitCode, stdout, stderr, timedOut, durationMs,
	 *   containerId, image, startedAt, at }`。
	 *   - `ok: true` = 沙箱机制完整跑通（命令本身可能非零退出，exitCode 承载）；
	 *   - `timedOut: true` = 超时被 SIGKILL（exitCode 通常 137）；
	 *   - 基础设施错误（镜像不可用/创建失败/daemon 不可达…）reject，code 见
	 *     EUNREACHABLE / EIMAGE / EPULL / EHTTPxxx / EINVAL / ETAR。
	 */
	async run(input = {}) {
		await this.blackboard.waitReady();
		const normalized = this._normalizeRunInput(input);
		const runId = `sandbox-${Date.now()}-${randomSuffix()}`;
		const controller = new AbortController();
		this.inflight.set(runId, controller);
		const slot = await this._acquire();
		const startedAt = nowIso();
		const startedMs = Date.now();
		let containerId = null;
		let removed = false;
		let stage = "queue";
		let timedOut = false;
		let exitCode = null;
		let stdout = "";
		let stderr = "";
		try {
			if (this.closed) throw codedError("EABORTED", "sandbox: plugin is shutting down");
			this.ctx.emit("sandbox/run-start", { runId, image: normalized.image, cmd: normalized.cmd ?? null, script: normalized.script ?? null, at: startedAt });
			this.ctx.logger.info("sandbox: run %s start (image=%s, timeout=%dms)", runId, normalized.image, normalized.timeoutMs);

			// 1) 镜像
			stage = "image";
			await this._ensureImage(normalized.image, controller.signal);

			// 2) 创建容器
			stage = "create";
			const spec = this._buildContainerSpec(normalized, runId);
			const created = await this.client.createContainer(spec, normalized.name);
			containerId = created.id;
			if (!containerId) throw codedError("EHTTP201", "sandbox: docker create returned no container id");

			// 3) 文件/脚本注入
			stage = "files";
			await this._uploadFiles(containerId, normalized, runId, controller.signal);

			// 4) 启动
			stage = "start";
			await this.client.startContainer(containerId);

			// 5) 等待退出（超时强杀）
			stage = "wait";
			const wait = await this._waitWithTimeout(containerId, normalized.timeoutMs, runId);
			timedOut = wait.timedOut;
			exitCode = wait.exitCode;

			// 6) 日志
			stage = "logs";
			const logBuffer = await this.client.containerLogs(containerId, {
				maxBodyBytes: normalized.maxOutputBytes * 2 + 65536,
				signal: controller.signal
			});
			const decoded = decodeDockerLogFrames(logBuffer, normalized.maxOutputBytes);
			stdout = decoded.stdout;
			stderr = decoded.stderr;

			// 7) 退出码兜底（/wait 未给时用 inspect）
			stage = "inspect";
			if (exitCode === null || exitCode === undefined) {
				const inspect = await this.client.inspectContainer(containerId);
				exitCode = inspect?.State?.ExitCode ?? null;
			}

			// 8) 清理
			stage = "cleanup";
			const cleanupError = await this._cleanupContainer(containerId, runId, false);
			removed = !cleanupError;

			const durationMs = Date.now() - startedMs;
			const record = this._buildRecord({ runId, input: normalized, containerId, exitCode, timedOut, stdout, stderr, durationMs, startedAt, removed, cleanupError });
			await this._recordRun(record);
			if (!this.closed) this.ctx.emit("sandbox/run-done", {
				runId,
				ok: true,
				exitCode,
				stdout,
				stderr,
				timedOut,
				durationMs,
				containerId,
				image: normalized.image,
				at: nowIso()
			});
			this.ctx.logger.info("sandbox: run %s done (exit=%s, timeout=%s, %dms)", runId, exitCode, timedOut, durationMs);
			return {
				runId,
				ok: true,
				exitCode,
				stdout,
				stderr,
				timedOut,
				durationMs,
				containerId,
				image: normalized.image,
				startedAt,
				at: nowIso()
			};
		} catch (error) {
			if (error?.code === "ETIMEOUT") {
				// 理论上不会走到这里（_waitWithTimeout 内部已转 timedOut 结果），兜底。
				timedOut = true;
				exitCode = 137;
			}
			if (containerId) {
				stage = "cleanup";
				const cleanupError = await this._cleanupContainer(containerId, runId, true);
				removed = !cleanupError;
			}
			const durationMs = Date.now() - startedMs;
			const failure = { code: error?.code ?? "ERR", message: error?.message ?? String(error) };
			const record = this._buildRecord({ runId, input: normalized, containerId, exitCode, timedOut, stdout, stderr, durationMs, startedAt, removed, stage, error: failure });
			await this._recordRun(record);
			if (!this.closed) this.ctx.emit("sandbox/run-fail", { runId, stage, error: failure, at: nowIso() });
			this.ctx.logger.warn("sandbox: run %s failed at stage %s: %s", runId, stage, failure.message);
			throw error;
		} finally {
			this.inflight.delete(runId);
			this._release();
		}
	}

	/** 命令通道：`ctx.emit("sandbox/command", payload)`。 */
	async dispatch(payload) {
		const { op } = payload ?? {};
		switch (op) {
			case "ping": {
				const result = await this.ping();
				if (!this.closed) this.ctx.emit("sandbox/ping", result);
				return result;
			}
			case "run":
				return this.run(payload);
			case "version":
				return this.version();
			case "info":
				return this.info();
			case "list-images":
				return this.listImages();
			case "list-containers":
				return this.listContainers();
			case "prune":
				return this.prune();
			case "remove-container":
				return this.removeContainer(payload?.id);
			case "status":
				return this.status();
			default:
				throw codedError("EINVAL", `sandbox: unknown command op ${JSON.stringify(op)}`);
		}
	}

	//#endregion

	//#region 执行管线内部实现

	/** 校验并规范化一次 run 输入。 */
	_normalizeRunInput(input) {
		if (!isPlainObject(input)) throw codedError("EINVAL", "sandbox: run input must be an object");
		const image = normalizeImageName(input.image ?? this.config.defaultImage);
		if (this.config.allowedImages.length > 0 && !this.config.allowedImages.some((pattern) => new RegExp(pattern, "i").test(image))) {
			throw codedError("EIMAGE", `sandbox: image ${JSON.stringify(image)} 不在白名单（allowedImages=${JSON.stringify(this.config.allowedImages)}）`);
		}
		let cmd = null;
		if (input.cmd !== undefined && input.cmd !== null) {
			if (Array.isArray(input.cmd)) {
				cmd = input.cmd.map(String);
			} else {
				cmd = ["/bin/sh", "-c", String(input.cmd)];
			}
		}
		const script = input.script !== undefined && input.script !== null ? String(input.script) : null;
		let files = [];
		if (Array.isArray(input.files)) {
			let total = 0;
			for (const file of input.files) {
				if (!isPlainObject(file) || typeof file.name !== "string" || !file.name.trim()) {
					throw codedError("EINVAL", "sandbox: files entries must be { name, content } objects");
				}
				const content = file.content === undefined || file.content === null ? "" : file.content;
				const bytes = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content));
				total += bytes;
				if (total > this.config.tarUploadLimit) {
					throw codedError("ETAR", `sandbox: uploaded files exceed tarUploadLimit=${this.config.tarUploadLimit} bytes`);
				}
				files.push({ name: file.name.trim(), content, mode: file.mode, mtime: file.mtime });
			}
		}
		const timeoutMs = Math.max(100, Math.min(input.timeoutMs ?? this.config.defaultTimeoutMs, this.config.maxRunTimeoutMs));
		if (input.privileged && !this.config.allowPrivileged) {
			throw codedError("EINVAL", "sandbox: privileged containers are disabled (config allowPrivileged=false)");
		}
		const env = {};
		if (isPlainObject(input.env)) {
			for (const [key, value] of Object.entries(input.env)) {
				if (value === undefined || value === null) continue;
				env[key] = String(value);
			}
		}
		// mounts：显式的宿主目录/文件绑定（仅当调用方明确传入才生效，
		// 默认无任何 bind，维持沙箱边界）。格式 [{ hostPath, containerPath }]。
		let mounts = [];
		if (Array.isArray(input.mounts)) {
			for (const mount of input.mounts) {
				if (!isPlainObject(mount) || typeof mount.hostPath !== "string" || !mount.hostPath.trim() || typeof mount.containerPath !== "string" || !mount.containerPath.trim()) {
					throw codedError("EINVAL", "sandbox: mounts entries must be { hostPath, containerPath } objects");
				}
				mounts.push({ hostPath: mount.hostPath.trim(), containerPath: mount.containerPath.trim() });
			}
		}
		return {
			image,
			cmd,
			args: Array.isArray(input.args) ? input.args.map(String) : [],
			entrypoint: input.entrypoint !== undefined && input.entrypoint !== null ? (Array.isArray(input.entrypoint) ? input.entrypoint.map(String) : [String(input.entrypoint)]) : null,
			script,
			files,
			env,
			workdir: input.workdir ?? this.config.defaultWorkdir ?? "",
			user: input.user ?? this.config.defaultUser ?? "",
			memory: input.memory ?? this.config.memoryLimit,
			cpus: input.cpus ?? this.config.cpus,
			networkDisabled: input.networkDisabled ?? this.config.networkDisabled,
			timeoutMs,
			maxOutputBytes: Math.max(1024, input.maxOutputBytes ?? this.config.maxOutputBytes),
			autoRemove: input.autoRemove ?? this.config.autoRemove,
			name: input.name ? String(input.name) : undefined,
			labels: isPlainObject(input.labels) ? { ...input.labels } : {},
			privileged: Boolean(input.privileged) && this.config.allowPrivileged,
			mounts,
			planId: input.planId ? String(input.planId) : undefined,
			taskId: input.taskId ? String(input.taskId) : undefined
		};
	}

	/** 确保镜像存在（pullPolicy: missing|always|never）。 */
	async _ensureImage(image, signal) {
		const policy = this.config.pullPolicy;
		if (policy === "always") {
			await this.client.pullImage(image);
			return;
		}
		const present = (await this.client.listImages()).some((img) => (img.RepoTags ?? []).includes(image));
		if (present) return;
		if (policy === "never") {
			throw codedError("EIMAGE", `sandbox: image ${image} 不在本地且 pullPolicy=never`);
		}
		try {
			await this.client.pullImage(image);
		} catch (error) {
			throw codedError("EPULL", `sandbox: 拉取镜像 ${image} 失败: ${error?.message ?? String(error)}`, { cause: error });
		}
	}

	/** 组装容器创建 spec（沙箱化 HostConfig）。 */
	_buildContainerSpec(normalized, runId) {
		const env = [];
		for (const [key, value] of Object.entries(normalized.env)) env.push(`${key}=${value}`);
		const spec = {
			Image: normalized.image,
			Cmd: normalized.cmd,
			Entrypoint: normalized.entrypoint,
			Env: env.length ? env : undefined,
			WorkingDir: normalized.workdir || undefined,
			User: normalized.user || undefined,
			Labels: {
				[`${LABEL_PREFIX}.runId`]: runId,
				[`${LABEL_PREFIX}.plugin`]: "dsh-docker-sandbox",
				...normalized.labels
			},
			HostConfig: {
				Memory: parseMemory(normalized.memory),
				NanoCpus: Math.max(1, Math.round(normalized.cpus * 1e9)),
				NetworkMode: normalized.networkDisabled ? "none" : "default",
				PidsLimit: 512,
				ReadonlyRootfs: false,
				Privileged: normalized.privileged,
				SecurityOpt: normalized.privileged ? undefined : ["no-new-privileges"],
				...(normalized.mounts.length ? { Binds: normalized.mounts.map((m) => `${m.hostPath}:${m.containerPath}`) } : {})
			}
		};
		// script → 注入 work/script.sh 并以 /bin/sh 执行（未显式给 cmd 时）
		if (normalized.script && normalized.cmd === null) {
			spec.Entrypoint = ["/bin/sh"];
			spec.Cmd = ["/work/script.sh"];
		}
		return spec;
	}

	/** tar 注入：工作目录项 + script + files。 */
	async _uploadFiles(containerId, normalized, runId, signal) {
		const entries = [];
		if (normalized.workdir) {
			const dir = String(normalized.workdir).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
			if (dir) entries.push({ type: "dir", name: dir, mode: 0o755 });
		}
		if (normalized.script) {
			entries.push({ name: "work/script.sh", content: normalized.script, mode: 0o755 });
		}
		for (const file of normalized.files) entries.push(file);
		if (entries.length === 0) return;
		let tar;
		try {
			tar = buildTar(entries);
		} catch (error) {
			throw codedError("ETAR", `sandbox: 构造 tar 失败: ${error?.message ?? String(error)}`, { cause: error });
		}
		await this.client.uploadArchive(containerId, "/", tar);
		this.ctx.logger.debug("sandbox: run %s uploaded %d tar entries (%d bytes)", runId, entries.length, tar.length);
	}

	/**
	 * 等待容器退出，超时强杀。超时定时器由 ctx.effect 托管（fiber 销毁自动
	 * 清理）；插件卸载时 AbortSignal 中止 /wait 长轮询。
	 * @returns `{ timedOut, exitCode }`。
	 */
	async _waitWithTimeout(containerId, timeoutMs, runId) {
		const signal = this.inflight.get(runId)?.signal;
		// /wait 是长轮询：不设请求级超时（timeoutMs: 0），由运行超时 + AbortSignal 接管
		const waitPromise = this.client.waitContainer(containerId, { signal, timeoutMs: 0 }).then((result) => ({ timedOut: false, exitCode: result.statusCode }));
		const { promise, reject } = Promise.withResolvers();
		let dispose;
		if (!this.closed) {
			dispose = this.ctx.effect(() => {
				const timer = setTimeout(() => {
					// 已关闭则丢弃：卸载流程会 abort /wait，race 由 EABORTED 收尾，
					// 此处不再 reject，避免触发 catch 里的 kill/清理路径
					if (this.closed) return;
					reject(codedError("ETIMEOUT", `sandbox: run ${runId} timed out after ${timeoutMs}ms`));
				}, timeoutMs);
				return () => {
					try {
						clearTimeout(timer);
					} catch {
						/* 幂等清理 */
					}
				};
			}, "sandbox:run-timeout");
		}
		try {
			return await Promise.race([waitPromise, promise]);
		} catch (error) {
			if (error?.code === "ETIMEOUT") {
				try {
					await this.client.killContainer(containerId, "SIGKILL");
				} catch {
					/* 容器可能已自行退出 */
				}
				if (!this.closed) {
					try {
						const reap = this.client.waitContainer(containerId, { signal, timeoutMs: 0 });
						await Promise.race([reap, this.ctx.timeout(5000)]);
					} catch {
						/* 尽力而为 */
					}
				}
				return { timedOut: true, exitCode: 137 };
			}
			throw error;
		} finally {
			dispose?.();
		}
	}

	/** 清理容器（force remove）。失败仅记录，不抛（best effort）。 */
	async _cleanupContainer(containerId, runId, failed) {
		const keep = this.config.keepFailedContainers && failed;
		if (keep) {
			this.ctx.logger.warn("sandbox: run %s container %s 保留（keepFailedContainers）", runId, containerId);
			return null;
		}
		try {
			await this.client.removeContainer(containerId, { force: true, v: true });
			return null;
		} catch (error) {
			this.ctx.logger.warn("sandbox: run %s 清理容器 %s 失败: %s", runId, containerId, error?.message ?? String(error));
			return { code: error?.code ?? "ERR", message: error?.message ?? String(error) };
		}
	}

	/** 组装运行记录（stdout/stderr 按 recordOutputMaxChars 截断入库）。 */
	_buildRecord({ runId, input, containerId, exitCode, timedOut, stdout, stderr, durationMs, startedAt, removed, stage, error, cleanupError }) {
		const max = this.config.recordOutputMaxChars;
		const truncate = (text) => {
			if (!max || typeof text !== "string" || text.length <= max) return text ?? "";
			return `${text.slice(0, max)}\n…[截断，共 ${text.length} 字符]`;
		};
		return {
			runId,
			image: input.image,
			cmd: input.cmd ?? null,
			script: input.script ?? null,
			files: input.files.map((f) => ({ name: f.name, ...(f.mode !== undefined ? { mode: f.mode } : {}) })),
			env: input.env,
			workdir: input.workdir,
			user: input.user,
			memory: input.memory,
			cpus: input.cpus,
			networkDisabled: input.networkDisabled,
			timeoutMs: input.timeoutMs,
			planId: input.planId,
			taskId: input.taskId,
			containerId,
			exitCode,
			timedOut,
			stdout: truncate(stdout),
			stderr: truncate(stderr),
			durationMs,
			startedAt,
			removed,
			stage,
			error,
			cleanupError,
			at: nowIso()
		};
	}

	/** 持久化运行记录 + 状态 + tool_outputs 联动（blackboard）。 */
	async _recordRun(record) {
		this.totalRuns += 1;
		if (!this.config.recordToBlackboard) return;
		await this.blackboard.set(this.section, `executions/${record.runId}`, record);
		await this._persistStatus({ lastRunAt: record.at, lastRunId: record.runId, lastExitCode: record.exitCode, lastTimedOut: record.timedOut });
		if (record.planId && record.taskId) {
			const status = record.timedOut ? `timeout(${record.timeoutMs}ms, exit=${record.exitCode})` : `exit=${record.exitCode}`;
			await this.blackboard.append("tool_outputs", `${record.planId}:${record.taskId}`, {
				output: `[docker-sandbox] ${record.runId} image=${record.image} ${status} in ${record.durationMs}ms stdout=${record.stdout.length} chars`,
				source: "docker-sandbox",
				runId: record.runId,
				at: nowIso()
			});
		}
	}

	/** 持久化 sandbox/status（JSON 去重：无变化不写盘）。 */
	async _persistStatus(extra = {}) {
		if (!this.config.recordToBlackboard) return;
		const status = {
			available: this.getAvailable(),
			daemon: this.lastPing?.ok ? this.lastPing.daemon : null,
			apiVersion: this.lastPing?.ok ? this.lastPing.apiVersion : null,
			os: this.lastPing?.ok ? this.lastPing.os : null,
			arch: this.lastPing?.ok ? this.lastPing.arch : null,
			containerCount: this.lastPing?.ok ? this.lastPing.containerCount : null,
			imageCount: this.lastPing?.ok ? this.lastPing.imageCount : null,
			target: this.client.target.label,
			totalRuns: this.totalRuns,
			lastPingAt: this.lastPing?.at ?? null,
			lastPingOk: this.lastPing?.ok ?? false,
			...extra,
			at: nowIso()
		};
		const json = JSON.stringify(status);
		if (json === this.lastStatusJson) return;
		this.lastStatusJson = json;
		await this.blackboard.set(this.section, "status", status);
	}

	/** 健康检查：ping → 更新 lastPing → 事件 + 状态持久化。 */
	async _probe() {
		const result = await this.ping();
		if (!this.closed) this.ctx.emit("sandbox/ping", result);
		try {
			await this._persistStatus();
		} catch (error) {
			this._handleError("sandbox status persist", error);
		}
		if (result.ok) this.ctx.logger.debug("sandbox: daemon ok (version=%s, api=%s)", result.version, result.apiVersion);
		else this.ctx.logger.warn("sandbox: daemon 不可达（%s）— %s", result.target, result.error?.message ?? "unknown");
		return result;
	}

	//#region 信号量

	/** 获取一个执行槽位（FIFO 等待；关闭时 reject EABORTED）。 */
	_acquire() {
		if (this.activeSlots < this.config.maxConcurrentRuns) {
			this.activeSlots += 1;
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			this.waiters.push({ resolve, reject });
		});
	}

	/** 释放一个槽位并唤醒下一个等待者。 */
	_release() {
		const next = this.waiters.shift();
		if (next) {
			next.resolve();
			return;
		}
		this.activeSlots = Math.max(0, this.activeSlots - 1);
	}

	//#endregion

	_handleError(context, error) {
		try {
			this.ctx.logger.error("sandbox: %s failed: %s", context, error?.message ?? String(error));
			if (!this.closed) this.ctx.emit("sandbox/error", { context, error, at: nowIso() });
		} catch {
			/* 关闭阶段的错误只记录，绝不再冒泡 */
		}
	}

	//#endregion
}

//#endregion

export {
	DEFAULT_SECTION,
	DockerEngineClient,
	LABEL_PREFIX,
	SandboxService,
	SandboxService as default,
	buildTar,
	decodeDockerLogFrames,
	normalizeImageName,
	parseMemory
};
//#endregion

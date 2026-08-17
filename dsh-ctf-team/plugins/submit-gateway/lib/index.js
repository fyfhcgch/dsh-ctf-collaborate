//#region lib/index.js
/**
 * dsh-submit-gateway — HTTP 提交网关插件。
 *
 * 注册 `POST /api/ctf/submit`（node:http exact 路由），接收 plan.submit 格式
 * JSON，内部调用 `ctx.planner.start()` 发起计划 —— 等价于 harness 控制台的
 * `plan.submit` 命令，供外部 PowerShell / curl 直接提交 CTF 题目进入多 Agent
 * 工作流（planner 分解 → 对应类别专家认领 → verifier 校验 flag）。
 *
 * 请求体（JSON，全部字段可选，description 必填）：
 *   {
 *     "planId": "plan-xxx",         // 可选，缺省自动生成
 *     "category": "web|crypto|misc|...", // 可选，缺省按描述关键字检测
 *     "title": "…",
 *     "description": "…",           // 必填
 *     "ciphertext": "…",            // 题目上下文（透传到 challenges/<planId>）
 *     "url": "http://…",            // web 题目目标（透传）
 *     "attachments": [],
 *     "meta": {}
 *   }
 * 响应：200 {"ok":true,"planId":"…","category":"…","status":"running"}；
 *       400 参数非法；500 planner 启动失败。
 *
 * 硬性依赖：inject ["blackboard", "planner", "webServer"]。
 * 全部持久化复用 blackboard 服务（经 planner），本插件不直接读写文件。
 *
 * @module @dsh-external/dsh-submit-gateway
 */
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

/** 提交端点路径。 */
const SUBMIT_PATH = "/api/ctf/submit";
/** 请求体大小上限（64KB，防滥用）。 */
const MAX_BODY_BYTES = 65536;

/** 当前 UTC 时间 ISO-8601。 */
function nowIso() {
	return new Date().toISOString();
}

/** 收集请求体（大小受限）。 */
function readBody(req, limit = MAX_BODY_BYTES) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(Object.assign(new Error("request body too large"), { code: "ETOOBIG" }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** 写 JSON 响应。 */
function sendJson(res, status, body) {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

/**
 * 提交网关服务。注册为 `ctx.submitGateway`。
 * 硬性依赖 inject: ["blackboard", "planner", "webServer"]。
 */
class SubmitGatewayService extends Service {
	/** 服务名。 */
	static provide = "submitGateway";
	/** 必需服务。 */
	static inject = ["blackboard", "planner", "webServer"];
	/** 插件配置 schema。 */
	static Config = z.object({});

	/** blackboard 服务（injected）。 */
	blackboard;
	/** planner 服务（injected）。 */
	planner;

	constructor(ctx, config) {
		super(ctx, "submitGateway");
		this.blackboard = ctx.blackboard;
		this.planner = ctx.planner;
	}

	/** 生命周期：注册 HTTP 路由（dispose 时注销）。 */
	async *[Service.init]() {
		const unregister = this.ctx.webServer.register({
			kind: "exact",
			path: SUBMIT_PATH,
			handler: (req, res) => this._handleSubmit(req, res)
		});
		yield unregister;
		this.ctx.logger.info("submitGateway: ready，提交入口 POST %s", SUBMIT_PATH);
	}

	/** 公开提交入口（等价于 POST /api/ctf/submit）。 */
	async submit(payload) {
		await this.blackboard.waitReady();
		if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
			throw new TypeError("submitGateway: payload must be a JSON object");
		}
		const { planId } = await this.planner.start(payload);
		const plan = await this.planner.getPlan(planId);
		return {
			ok: true,
			planId,
			category: plan?.category,
			status: plan?.status ?? "running",
			message: "计划已送入 planner，专家将自动认领执行",
			at: nowIso()
		};
	}

	/** POST /api/ctf/submit：解析 payload → ctx.planner.start → 响应。 */
	async _handleSubmit(req, res) {
		try {
			if (req.method !== "POST") {
				sendJson(res, 405, { ok: false, error: "method not allowed (use POST)" });
				return;
			}
			const raw = await readBody(req);
			let payload;
			try {
				payload = JSON.parse(raw || "{}");
			} catch {
				sendJson(res, 400, { ok: false, error: "body is not valid JSON" });
				return;
			}
			const result = await this.submit(payload);
			sendJson(res, 200, result);
			this.ctx.logger.info("submitGateway: 计划 %s 提交成功（category=%s）", result.planId, result.category);
		} catch (error) {
			const code = error?.code ?? "ERR";
			const message = error?.message ?? String(error);
			const status = code === "ETOOBIG" ? 413 : 400;
			this.ctx.logger.warn("submitGateway: 提交失败: %s", message);
			sendJson(res, status, { ok: false, error: message, code });
		}
	}
}

export { SubmitGatewayService, SubmitGatewayService as default, SUBMIT_PATH };
//#endregion

//#region lib/types/index.d.ts
/**
 * Type declarations for @dsh-external/dsh-submit-gateway.
 *
 * 插件注册 cordis 服务 `submitGateway`（`ctx.submitGateway`）。硬性依赖
 * `["blackboard", "planner", "webServer"]`。对外暴露
 * `POST /api/ctf/submit`，内部调用 ctx.planner.start。
 */
import type { Service } from "@deepseek-ai/cordis";

/** plan.submit 请求体（planner.start 入参的超集）。 */
export interface PlanSubmitPayload {
	/** 计划 id（可选，缺省自动生成）。 */
	planId?: string;
	/** 题目类别（可选，缺省按描述关键字检测）。 */
	category?: "web" | "pwn" | "crypto" | "reverse" | "forensics" | "osint" | "misc" | string;
	title?: string;
	/** 题目描述（必填）。 */
	description: string;
	/** 密码类题目密文（透传到 challenges/<planId>）。 */
	ciphertext?: string;
	/** web 类题目目标 URL（透传）。 */
	url?: string;
	attachments?: Array<{ name?: string; path?: string; note?: string; [k: string]: unknown }>;
	meta?: Record<string, unknown>;
	[key: string]: unknown;
}

/** 提交响应。 */
export interface PlanSubmitResponse {
	ok: boolean;
	planId?: string;
	category?: string;
	status?: string;
	message?: string;
	error?: string;
	code?: string;
	at?: string;
}

/** `ctx.submitGateway` 服务面。 */
export interface SubmitGatewayService extends Service {
	/** 处理一次提交（等价于 POST /api/ctf/submit）。 */
	submit(payload: PlanSubmitPayload): Promise<PlanSubmitResponse>;
}

/** 插件类（cordis 入口导出）。 */
export declare class SubmitGatewayService extends Service {
	static provide: "submitGateway";
	static inject: ["blackboard", "planner", "webServer"];
	static Config: import("@deepseek-ai/schemastery").S<Record<string, never>>;
}

export default SubmitGatewayService;
//#endregion

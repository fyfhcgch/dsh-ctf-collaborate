//#region tests/stub-webserver-package/index.js
/**
 * 测试用 webServer stub 插件（零依赖）。
 *
 * 真实 profile 里 `webServer` 服务由 @deepseek-ai/dsh-web-app 提供；
 * 集成测试不装载 dsh-web-app（避免占用 13825 端口/启动 GUI），因此用这个
 * 微型插件补齐 submit-gateway 的硬依赖 `inject: ["webServer"]`。
 *
 * 暴露的注册接口与 dsh-web-app 一致的最小面：
 *   ctx.webServer.register({ kind, path, handler }) → () => 注销
 */
export default function apply(ctx) {
	const routes = new Map();
	ctx.provide("webServer", {
		register(entry) {
			routes.set(entry.path, entry.handler);
			return () => routes.delete(entry.path);
		},
		/** 测试断言用：已注册路由。 */
		routes
	});
}
//#endregion

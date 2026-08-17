//#region tests/mock-docker.mjs
/**
 * Mock Docker Engine API server for the sandbox plugin boot test.
 *
 * Speaks the same HTTP endpoints the plugin uses, driven by per-container Env:
 *   MOCK_STDOUT  - stdout text emitted at exit
 *   MOCK_STDERR  - stderr text emitted at exit
 *   MOCK_EXIT    - exit code reported by /wait and inspect (default 0)
 *   MOCK_DELAY   - simulated runtime in ms before /wait returns (default 0)
 *
 * Container lifecycle is simulated:
 *   create → start → (delay) → exit → logs available → remove.
 * /kill marks the container killed and sets exit code 137 (SIGKILL).
 * Every request is recorded in `state.requests` for assertions.
 */
import http from "node:http";

function sendJson(res, status, body) {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function buildLogFrames(stdout, stderr) {
	const frames = [];
	const push = (streamType, text) => {
		const payload = Buffer.from(text ?? "", "utf8");
		const header = Buffer.alloc(8);
		header[0] = streamType;
		header.writeUInt32BE(payload.length, 4);
		frames.push(header, payload);
	};
	if (stdout) push(1, stdout);
	if (stderr) push(2, stderr);
	return Buffer.concat(frames);
}

/** Start the mock daemon on an ephemeral port. */
export async function startMockDocker(options = {}) {
	const state = {
		containers: new Map(),
		images: new Set(options.images ?? ["alpine:latest", "node:20-alpine"]),
		requests: [],
		archives: [],
		autoId: 0,
		pullFail: new Set(options.pullFail ?? [])
	};

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url, "http://mock.local");
		const method = req.method;
		const path = url.pathname;
		state.requests.push({ method, path, query: Object.fromEntries(url.searchParams.entries()), at: Date.now() });

		const matchId = (prefix) => {
			const m = new RegExp(`^/${prefix}/([^/]+)(/.*)?$`).exec(path);
			return m ? m[1] : null;
		};

		// ---- engine info ----
		if (method === "GET" && path === "/_ping") {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("OK");
			return;
		}
		if (method === "GET" && path === "/version") {
			sendJson(res, 200, { Version: "mock-27.0.0", ApiVersion: "1.46", MinAPIVersion: "1.24", Os: "linux", Arch: "amd64" });
			return;
		}
		if (method === "GET" && path === "/info") {
			sendJson(res, 200, { Containers: state.containers.size, Images: state.images.size, OSType: "linux", Architecture: "x86_64", OperatingSystem: "MockOS" });
			return;
		}

		// ---- images ----
		if (method === "GET" && path === "/images/json") {
			sendJson(res, 200, [...state.images].map((repoTag, i) => ({ Id: `sha256:mock-image-${i}`, RepoTags: [repoTag] })));
			return;
		}
		if (method === "POST" && path === "/images/create") {
			const fromImage = url.searchParams.get("fromImage");
			const tag = url.searchParams.get("tag") ?? "latest";
			if (state.pullFail.has(`${fromImage}:${tag}`)) {
				sendJson(res, 404, { message: `pull access denied for ${fromImage}` });
				return;
			}
			state.images.add(`${fromImage}:${tag}`);
			sendJson(res, 200, [{ status: `Pulled ${fromImage}:${tag}` }]);
			return;
		}

		// ---- containers ----
		if (method === "POST" && path === "/containers/create") {
			const body = await readBody(req);
			let spec;
			try {
				spec = JSON.parse(body.toString("utf8"));
			} catch {
				sendJson(res, 400, { message: "invalid create body" });
				return;
			}
			const id = `mock-c-${String(++state.autoId).padStart(3, "0")}`;
			const env = Object.fromEntries((spec.Env ?? []).map((line) => {
				const i = line.indexOf("=");
				return i < 0 ? [line, ""] : [line.slice(0, i), line.slice(i + 1)];
			}));
			state.containers.set(id, {
				id,
				spec,
				env,
				status: "created",
				exitCode: Number(env.MOCK_EXIT ?? "0"),
				stdout: env.MOCK_STDOUT ?? "",
				stderr: env.MOCK_STDERR ?? "",
				delayMs: Number(env.MOCK_DELAY ?? "0"),
				killed: false,
				archives: [],
				startedAt: null,
				waiters: []
			});
			res.writeHead(201, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ Id: id, Warnings: [] }));
			return;
		}

		const containerId = matchId("containers");
		if (containerId && !state.containers.has(containerId) && path !== "/containers/create") {
			sendJson(res, 404, { message: `No such container: ${containerId}` });
			return;
		}
		const container = state.containers.get(containerId);

		if (method === "POST" && path === `/containers/${containerId}/start`) {
			container.status = "running";
			container.startedAt = Date.now();
			if (container.delayMs <= 0) settleContainer(container);
			else setTimeout(() => settleContainer(container), container.delayMs);
			res.writeHead(204);
			res.end();
			return;
		}
		if (method === "POST" && path === `/containers/${containerId}/wait`) {
			if (container.status === "exited" || container.status === "killed") {
				sendJson(res, 200, { StatusCode: container.exitCode });
				return;
			}
			container.waiters.push(res);
			return;
		}
		if (method === "POST" && path === `/containers/${containerId}/kill`) {
			container.killed = true;
			container.status = "killed";
			container.exitCode = 137;
			settleContainer(container);
			res.writeHead(204);
			res.end();
			return;
		}
		if (method === "GET" && path === `/containers/${containerId}/json`) {
			sendJson(res, 200, {
				Id: container.id,
				State: { Status: container.status, Running: container.status === "running", ExitCode: container.exitCode, StartedAt: container.startedAt ? new Date(container.startedAt).toISOString() : null },
				Config: container.spec,
				HostConfig: container.spec.HostConfig ?? {}
			});
			return;
		}
		if (method === "GET" && path === `/containers/${containerId}/logs`) {
			// 无 Content-Length → node 自动 chunked，顺带覆盖客户端 chunked 解码
			res.writeHead(200, { "Content-Type": "application/vnd.docker.raw-stream" });
			res.end(buildLogFrames(container.stdout, container.stderr));
			return;
		}
		if (method === "DELETE" && path === `/containers/${containerId}`) {
			if (container) state.archives.push(...container.archives); // 容器删除前保留 tar 供断言
			state.containers.delete(containerId);
			res.writeHead(204);
			res.end();
			return;
		}
		if (method === "PUT" && path === `/containers/${containerId}/archive`) {
			const body = await readBody(req);
			container.archives.push(body);
			res.writeHead(200);
			res.end();
			return;
		}
		if (method === "GET" && path === "/containers/json") {
			sendJson(res, 200, [...state.containers.values()].map((c) => ({ Id: c.id, State: c.status, Names: [`/${c.spec?.Labels?.["dsh.sandbox.runId"] ?? "unnamed"}`] })));
			return;
		}
		if (method === "POST" && path === "/containers/prune") {
			const label = url.searchParams.get("label") ?? "";
			const deleted = [];
			for (const [id, c] of [...state.containers]) {
				if (!label) {
					deleted.push(id);
					state.containers.delete(id);
				}
			}
			sendJson(res, 200, { ContainersDeleted: deleted, SpaceReclaimed: 0 });
			return;
		}

		sendJson(res, 404, { message: `mock: no route for ${method} ${path}` });
	});

	function settleContainer(container) {
		if (container.status !== "exited" && container.status !== "killed") container.status = "exited";
		for (const waiter of container.waiters.splice(0)) {
			sendJson(waiter, 200, { StatusCode: container.exitCode });
		}
	}

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	return {
		server,
		port,
		state,
		url: `http://127.0.0.1:${port}`,
		stop: () => new Promise((resolve) => server.close(resolve))
	};
}

/** 读取一个 tar 归档的条目（测试侧校验 buildTar 输出用）。 */
export function readTarEntries(buffer) {
	const entries = [];
	let offset = 0;
	while (offset + 512 <= buffer.length) {
		const header = buffer.subarray(offset, offset + 512);
		if (header.every((b) => b === 0)) break;
		const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
		const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
		const size = Number.parseInt(header.subarray(124, 136).toString("latin1").replace(/\0.*$/, "").trim(), 8) || 0;
		const typeflag = String.fromCharCode(header[156]);
		const content = buffer.subarray(offset + 512, offset + 512 + size);
		entries.push({ name: (prefix ? `${prefix}/` : "") + name, typeflag, size, content: Buffer.from(content).toString("utf8") });
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return entries;
}
//#endregion

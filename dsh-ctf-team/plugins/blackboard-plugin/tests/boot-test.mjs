//#region tests/boot-test.mjs
/**
 * Standalone boot test for @dsh-external/dsh-blackboard.
 *
 * Mounts the plugin exactly the way dsh profile boot does — a root Include
 * over a cordis.yml plus a patch insert row — using the REAL
 * @deepseek-ai/dsh-app-boot `boot()` from the installed harness, so module
 * resolution, cordis instance identity, and lifecycle are production-faithful.
 *
 * Coverage:
 *   1. plugin loads and the `ctx.blackboard` service is available
 *   2. writes are durable: the JSON file is rewritten BEFORE the API resolves
 *   3. events fire after each durable write (set/append/update/delete/...)
 *   4. restart persistence: dispose the tree, boot again, data survives
 *   5. command channel (`blackboard/command`) event-driven writes
 *   6. no-op change detection (deep-equal set does not rewrite the file)
 *   7. corrupt-file recovery (backup + fresh document, harness survives)
 *
 * Usage:  node plugins/blackboard-plugin/tests/boot-test.mjs
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { loadHarnessBoot } from "../../../tests/harness-scope.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, "..");
const TMP = join(HERE, ".tmp");
const PROFILE_DIR = join(TMP, "profile");
const DATA_FILE = join(TMP, "blackboard.test.json");
const CONFIG_FILE = join(PROFILE_DIR, "cordis.yml");

const { boot } = await loadHarnessBoot();

/** Ensure the temp profile dir resolves the plugin exactly like a real profile. */
async function ensureProfileLinks() {
	await mkdir(join(PROFILE_DIR, "node_modules", "@dsh-external"), { recursive: true });
	await mkdir(join(PLUGIN_DIR, "node_modules", "@deepseek-ai"), { recursive: true });
	const { symlink } = await import("node:fs");
	const link = join(PROFILE_DIR, "node_modules", "@dsh-external", "dsh-blackboard");
	try {
		await stat(link);
	} catch {
		await new Promise((resolve, reject) => symlink(PLUGIN_DIR, link, "junction", (error) => error ? reject(error) : resolve()));
	}
	await writeFile(CONFIG_FILE, "[]\n", "utf8");
}

/** The patch insert row (same shape the bundle's cordis.patch.yml produces). */
function blackboardPatch(file) {
	return [{
		insert: [{
			id: "blackboard",
			name: "@dsh-external/dsh-blackboard",
			config: { file }
		}]
	}];
}

/** Poll until a predicate holds (for event-driven command channel assertions). */
async function waitFor(predicate, timeoutMs = 5000, intervalMs = 25) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error("waitFor: condition not met within timeout");
}

/** Boot one throwaway tree and return its context. */
function bootTree() {
	return boot("blackboard-test", CONFIG_FILE, blackboardPatch(DATA_FILE));
}

let passed = 0;
function ok(name) {
	passed += 1;
	console.log(`  ok ${passed} - ${name}`);
}

await rm(TMP, { recursive: true, force: true });
await ensureProfileLinks();

console.log("== boot 1: fresh start ==");
let ctx = await bootTree();
const bb = ctx.blackboard;
assert.ok(bb, "ctx.blackboard must be provided");
await bb.waitReady();
assert.equal(bb.ready, true, "ready flag after waitReady");
assert.deepEqual(bb.listSections().sort(), ["candidate_flags", "challenges", "clues", "failures", "tool_outputs"]);
assert.equal(bb.count(), 0);
ok("service available, canonical sections seeded, empty document");

console.log("== durable writes + events ==");
const seen = [];
ctx.on("blackboard/set", (p) => seen.push(["set", p]));
ctx.on("blackboard/append", (p) => seen.push(["append", p]));
ctx.on("blackboard/update", (p) => seen.push(["update", p]));
ctx.on("blackboard/delete", (p) => seen.push(["delete", p]));

const r1 = await bb.set("challenges", "web-01", { name: "flag shop", port: 3000 });
assert.equal(r1.changed, true);
let disk = JSON.parse(await readFile(DATA_FILE, "utf8"));
assert.deepEqual(disk.sections.challenges["web-01"], { name: "flag shop", port: 3000 }, "file rewritten before API resolves");
assert.equal(seen.at(-1)[0], "set");
assert.equal(seen.at(-1)[1].section, "challenges");
assert.equal(seen.at(-1)[1].key, "web-01");
assert.equal(seen.at(-1)[1].previous, undefined);
ok("set() writes the file synchronously and emits blackboard/set");

await bb.append("tool_outputs", "nmap-web-01", "3000/tcp open http");
await bb.append("tool_outputs", "nmap-web-01", "22/tcp open ssh");
disk = JSON.parse(await readFile(DATA_FILE, "utf8"));
assert.deepEqual(disk.sections.tool_outputs["nmap-web-01"], ["3000/tcp open http", "22/tcp open ssh"]);
ok("append() builds arrays across calls");

await bb.update("challenges", "web-01", { service: "http://10.0.0.5:3000" });
disk = JSON.parse(await readFile(DATA_FILE, "utf8"));
assert.deepEqual(disk.sections.challenges["web-01"], { name: "flag shop", port: 3000, service: "http://10.0.0.5:3000" });
ok("update() merges plain-object entries");

const beforeDelete = await bb.delete("challenges", "web-01");
assert.equal(beforeDelete.previous.name, "flag shop");
assert.equal(bb.has("challenges", "web-01"), false);
ok("delete() removes the entry and reports the previous value");

assert.deepEqual(bb.get("tool_outputs", "nmap-web-01"), ["3000/tcp open http", "22/tcp open ssh"]);
assert.equal(bb.size("tool_outputs"), 1);
assert.equal(bb.count(), 1);
assert.deepEqual(bb.getSection("clues"), {}, "canonical sections are pre-seeded empty");
assert.equal(bb.getSection("no-such-section"), undefined);
ok("synchronous reads reflect committed state");

const hits = await bb.search("http");
assert.ok(hits.some((h) => h.section === "tool_outputs" && h.key === "nmap-web-01"));
ok("search() finds values across sections");

console.log("== no-op change detection ==");
const rNoop = await bb.set("tool_outputs", "nmap-web-01", ["3000/tcp open http", "22/tcp open ssh"]);
assert.equal(rNoop.changed, false);
const statBefore = await stat(DATA_FILE);
await new Promise((resolve) => setTimeout(resolve, 100));
const statAfter = await stat(DATA_FILE);
assert.equal(statBefore.mtimeMs, statAfter.mtimeMs, "no rewrite on deep-equal set");
ok("deep-equal set is a no-op (no write, no event)");

console.log("== command channel ==");
ctx.emit("blackboard/command", { op: "set", section: "clues", key: "login-bypass", value: "admin panel leaks token" });
await waitFor(() => bb.has("clues", "login-bypass"));
assert.equal(bb.get("clues", "login-bypass"), "admin panel leaks token");
ctx.emit("blackboard/command", { op: "append", section: "failures", key: "sql-01", value: { payload: "' OR 1=1 --", result: "filtered" } });
await waitFor(() => bb.size("failures") === 1);
assert.equal(bb.get("failures", "sql-01").length, 1);
ok("blackboard/command events drive writes");

console.log("== boot 2: restart persistence ==");
await ctx.fiber.dispose();
ctx = await bootTree();
const bb2 = ctx.blackboard;
await bb2.waitReady();
assert.deepEqual(bb2.get("tool_outputs", "nmap-web-01"), ["3000/tcp open http", "22/tcp open ssh"], "tool outputs survive restart");
assert.equal(bb2.get("clues", "login-bypass"), "admin panel leaks token", "clues survive restart");
assert.equal(bb2.get("failures", "sql-01").length, 1, "failures survive restart");
assert.equal(bb2.count(), 3);
ok("all data survives a full tree restart");

console.log("== corrupt-file recovery ==");
await ctx.fiber.dispose();
await writeFile(DATA_FILE, "{ this is not json !!\n", "utf8");
ctx = await bootTree();
const bb3 = ctx.blackboard;
await bb3.waitReady();
assert.equal(bb3.count(), 0, "fresh document after corruption");
assert.equal(bb3.getDocument().meta.recoveredFromCorruption, true, "recovery is recorded in meta");
const backups = (await import("node:fs/promises")).readdir(TMP);
assert.ok((await backups).some((name) => name.startsWith("blackboard.test.json.corrupt-")), "corrupt bytes are backed up");
await bb3.set("candidate_flags", "flag-1", "CTF{durable}");
disk = JSON.parse(await readFile(DATA_FILE, "utf8"));
assert.equal(disk.sections.candidate_flags["flag-1"], "CTF{durable}");
ok("harness survives corruption, keeps a backup, and writes again");

await ctx.fiber.dispose();
await rm(TMP, { recursive: true, force: true });
console.log(`\nALL ${passed} TESTS PASSED`);
//#endregion

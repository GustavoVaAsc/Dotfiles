// Run: node --test kosmos-pi/guards/researcher-fetch-guard.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installGuarded, refusal, resolveWebAccessEntry } from "./researcher-fetch-guard.ts";

const blocked = (input) => assert.ok(refusal(input), JSON.stringify(input));
const allowed = (input) => assert.equal(refusal(input), undefined, JSON.stringify(input));

test("refuses github.com repo, commit, issue, PR and blob URLs in every spelling", () => {
	for (const url of [
		"https://github.com/owner/repo",
		"https://github.com/owner/repo/issues/1",
		"https://github.com/owner/repo/pull/2#issuecomment-3",
		"https://github.com/owner/repo/commit/abc123",
		"https://github.com/owner/repo/blob/main/README.md",
		"http://github.com/owner/repo",
		"https://www.github.com/owner/repo",
		"https://GitHub.com/owner/repo",
		"https://github.com./owner/repo",
		"https://github.com:443/owner/repo",
		"https://user:pw@github.com/owner/repo",
		"https://api.github.com/repos/owner/repo/issues",
		"github.com/owner/repo",
		"  https://github.com/owner/repo  ",
		"HTTPS://github.com/owner/repo",
	]) {
		blocked({ url });
		blocked({ urls: ["https://example.com/", url] });
	}
});

test("refuses a github URL hidden in urls next to url", () => {
	blocked({ url: "https://example.com/", urls: ["https://github.com/a/b"] });
});

test("allows public documentation and raw GitHub content", () => {
	for (const url of [
		"https://react.dev/reference",
		"https://raw.githubusercontent.com/owner/repo/main/README.md",
		"https://docs.github.com/en/rest",
		"https://owner.github.io/project/",
		"https://example.com/github.com/owner/repo",
		"https://example.com/?u=https://github.com/a/b",
		"https://github.com.evil.example/owner/repo",
		"https://evilgithub.com/owner/repo",
		"https://user@example.com/",
		"example.com/docs",
	]) {
		allowed({ url });
		allowed({ urls: [url] });
	}
});

test("refuses local paths, file URLs and other schemes", () => {
	for (const url of ["/etc/passwd", "./video.mp4", "../x", "~/clip.mp4", "file:///etc/passwd", "ftp://example.com/x",
		"javascript:alert(1)", "data:text/plain,hi", "C:\\Users\\x\\v.mp4", "https://example.com\\@github.com"]) {
		blocked({ url });
	}
});

test("refuses the auth option and unparseable URLs", () => {
	blocked({ url: "https://example.com/", auth: true });
	blocked({ url: "https://example.com/", auth: "profile" });
	blocked({ url: "http://" });
	allowed({ url: "https://example.com/", auth: false });
});

test("ignores empty input and non-string values", () => {
	allowed(undefined);
	allowed({});
	allowed({ url: 42, urls: [null, {}] });
});

test("refuses any proxy except an empty one (the proxy address is never checked by pi-web-access)", () => {
	for (const proxy of ["http://127.0.0.1:8080", "http://proxy.example:3128", "socks5://10.0.0.1:1080", " ", "x", null, 0, false, {}]) {
		blocked({ url: "https://example.com/", proxy });
		blocked({ queries: ["react"], proxy });
		blocked({ claim: "x", proxy });
	}
	allowed({ url: "https://example.com/", proxy: "" });
	allowed({ url: "https://example.com/", proxy: undefined });
	allowed({ queries: ["react"], proxy: "" });
});

test("refuses content fetches that bypass the per-URL check: includeContent and fetchContent", () => {
	for (const value of [true, "true", 1, "yes", {}]) {
		blocked({ queries: ["react"], includeContent: value });
		blocked({ claim: "x", fetchContent: value });
	}
	allowed({ queries: ["react"], includeContent: false });
	allowed({ claim: "x", fetchContent: false });
	allowed({ queries: ["react"], numResults: 5, workflow: "none" });
});

function fakeApi() {
	const calls = [];
	const handlers = [];
	return {
		calls, handlers,
		pi: { on: (name, fn) => { calls.push(`on:${name}`); handlers.push([name, fn]); }, registerTool: (tool) => calls.push(`tool:${tool.name}`) },
	};
}

test("the guard installs its handler first, then hands the same API object to pi-web-access", async () => {
	const api = fakeApi();
	let received;
	await installGuarded(api.pi, async () => ({ default: (pi) => { received = pi; pi.registerTool({ name: "fetch_content" }); } }));
	assert.equal(received, api.pi);
	assert.deepEqual(api.calls, ["on:tool_call", "tool:fetch_content"]);
});

test("the guard awaits an async pi-web-access factory", async () => {
	const api = fakeApi();
	await installGuarded(api.pi, async () => ({ default: async (pi) => { await new Promise((r) => setTimeout(r, 5)); pi.registerTool({ name: "web_search" }); } }));
	assert.deepEqual(api.calls, ["on:tool_call", "tool:web_search"]);
});

test("fail closed: if pi-web-access cannot be loaded the guard throws and no tool is registered", async () => {
	for (const [load, message] of [
		[async () => { throw new Error("Cannot find module"); }, /cannot load pi-web-access.*Cannot find module/],
		[async () => ({}), /no default export/],
		[async () => ({ default: "not a function" }), /no default export/],
		[async () => undefined, /no default export/],
	]) {
		const api = fakeApi();
		await assert.rejects(installGuarded(api.pi, load), message);
		assert.ok(!api.calls.some((c) => c.startsWith("tool:")));
	}
});

test("fail closed: an error thrown by pi-web-access itself propagates", async () => {
	const api = fakeApi();
	await assert.rejects(installGuarded(api.pi, async () => ({ default: () => { throw new Error("bad config"); } })), /bad config/);
});

test("the handler blocks fetch_content, web_search and source_check, with a reason", async () => {
	const api = fakeApi();
	await installGuarded(api.pi, async () => ({ default: () => {} }));
	const [name, handler] = api.handlers[0];
	assert.equal(name, "tool_call");
	for (const [toolName, input] of [
		["fetch_content", { url: "https://github.com/a/b" }],
		["fetch_content", { url: "https://example.com/", proxy: "http://127.0.0.1:8080" }],
		["web_search", { queries: ["x"], includeContent: true }],
		["web_search", { queries: ["x"], proxy: "http://127.0.0.1:8080" }],
		["source_check", { claim: "x", fetchContent: true }],
		["source_check", { claim: "x", proxy: "http://10.0.0.1:1" }],
	]) {
		const hit = await handler({ toolName, input });
		assert.equal(hit?.block, true, `${toolName} ${JSON.stringify(input)}`);
		assert.match(hit.reason, /^researcher-fetch-guard: /);
	}
	for (const [toolName, input] of [
		["fetch_content", { url: "https://react.dev/" }],
		["web_search", { queries: ["github.com/a/b"], workflow: "none" }],
		["source_check", { claim: "x", queries: ["y"] }],
		["get_search_content", { responseId: "abc", findText: "x" }],
	]) {
		assert.equal(await handler({ toolName, input }), undefined, `${toolName}`);
	}
});

test("the entry of pi-web-access is read from its package.json (pi.extensions), never guessed", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfg-"));
	try {
		const pkg = path.join(dir, ".pi", "agent", "npm", "node_modules", "pi-web-access");
		fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
		fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ pi: { extensions: ["./dist"] } }));
		fs.writeFileSync(path.join(pkg, "dist", "index.js"), "export default () => {}");
		assert.equal(resolveWebAccessEntry(dir), path.join(pkg, "dist", "index.js"));
		fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ pi: { extensions: ["./dist/index.js"] } }));
		assert.equal(resolveWebAccessEntry(dir), path.join(pkg, "dist", "index.js"));
		fs.writeFileSync(path.join(dir, "outside.js"), "export default () => {}");
		for (const bad of [{ pi: { extensions: ["../../../../../outside.js"] } }, {}, { pi: {} }, { pi: { extensions: [] } }, { pi: { extensions: ["./nope"] } }, { pi: { extensions: ["../../etc"] } }]) {
			fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify(bad));
			assert.throws(() => resolveWebAccessEntry(dir), /researcher-fetch-guard: /);
		}
		fs.rmSync(pkg, { recursive: true });
		assert.throws(() => resolveWebAccessEntry(dir), /researcher-fetch-guard: .*pi-web-access/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("the installed pi-web-access (when present) resolves to a real entry file", { skip: !fs.existsSync(path.join(os.homedir(), ".pi/agent/npm/node_modules/pi-web-access/package.json")) }, () => {
	const entry = resolveWebAccessEntry(os.homedir());
	assert.ok(fs.statSync(entry).isFile(), entry);
});

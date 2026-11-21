/**
 * researcher-fetch-guard.ts
 *
 * Child-only extension for `kosmos.researcher`, and the ONLY extension that
 * registers its web tools: its default export installs a `tool_call` guard and
 * then loads pi-web-access and calls that package's default export with the
 * same `pi` object. The researcher lists only this file in `extensions:`, so
 * `web_search`, `fetch_content`, `get_search_content` and `source_check` exist
 * only if this guard loaded; pi-subagents fails the launch when a `tools:`
 * entry is missing. If pi-web-access cannot be loaded this throws, and the
 * guard never runs unguarded.
 *
 * What it refuses, before pi-web-access sees the call:
 * - github.com, www.github.com and api.github.com URLs: pi-web-access fetches
 *   repository, commit, issue and PR URLs through the user's logged-in `gh`, so
 *   a researcher steered by an injected page could read private GitHub data;
 * - anything that is not an http(s) URL (local paths and file:// URLs reach
 *   local-video handling);
 * - the `auth` option (authenticated fetches with browser cookies);
 * - any `proxy` except "": pi-web-access never checks the proxy's address, so a
 *   model-chosen proxy such as http://127.0.0.1:8080 bypasses its SSRF checks;
 * - `includeContent` (web_search) and `fetchContent` (source_check): they send
 *   result URLs to the content extractor without going through `fetch_content`,
 *   and so past the URL checks above. The researcher fetches pages one by one.
 *
 * It is NOT auto-loaded: it lives under guards/, not extensions/. Public GitHub
 * content stays reachable through raw.githubusercontent.com, docs.github.com,
 * release pages on the project's own site and package registries.
 *
 * Tool names are matched by their pi-web-access defaults; a `toolNames` override
 * in the user's web-search.json would escape the guard (user config, not model
 * input). `refusal`, `installGuarded` and `resolveWebAccessEntry` are exported
 * for tests (researcher-fetch-guard.test.mjs).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GUARDED_TOOLS = new Set(["fetch_content", "web_search", "source_check"]);
const GITHUB_HOSTS = new Set(["github.com", "www.github.com", "api.github.com"]);
const WEB_ACCESS_DIR = [".pi", "agent", "npm", "node_modules", "pi-web-access"];
const NAME = "researcher-fetch-guard";

function refuseUrl(raw: string): string | undefined {
	const value = raw.trim();
	if (!value) return undefined;
	if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) {
		return `only http and https URLs may be fetched, not ${JSON.stringify(value.slice(0, 80))}`;
	}
	if (/^[/.~]/.test(value) || value.includes("\\")) {
		return `only http and https URLs may be fetched, not a local path (${JSON.stringify(value.slice(0, 80))})`;
	}
	let parsed: URL;
	try {
		parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
	} catch {
		return `not a valid URL: ${JSON.stringify(value.slice(0, 80))}`;
	}
	const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
	if (GITHUB_HOSTS.has(host)) {
		return "github.com URLs are not fetched by the researcher: pi-web-access would use the user's logged-in gh. Use raw.githubusercontent.com for a file, or the project's own docs, changelog or registry page";
	}
	return undefined;
}

/** Why a web-tool call must not run, or undefined when it may. */
export function refusal(input: Record<string, unknown> | undefined): string | undefined {
	if (!input) return undefined;
	if (input.auth !== undefined && input.auth !== false) {
		return "authenticated fetches (auth) are not allowed for the researcher";
	}
	if (input.proxy !== undefined && input.proxy !== "") {
		return "a proxy is not allowed for the researcher: pi-web-access does not check the proxy's address. Omit proxy";
	}
	if (input.includeContent !== undefined && input.includeContent !== false) {
		return "includeContent is not allowed for the researcher: fetch pages one by one with fetch_content";
	}
	if (input.fetchContent !== undefined && input.fetchContent !== false) {
		return "fetchContent is not allowed for the researcher: fetch pages one by one with fetch_content";
	}
	const urls: unknown[] = [input.url, ...(Array.isArray(input.urls) ? input.urls : [])];
	for (const url of urls) {
		if (typeof url !== "string") continue;
		const reason = refuseUrl(url);
		if (reason) return reason;
	}
	return undefined;
}

/** The module file pi loads for pi-web-access, read from its package.json `pi.extensions`. Throws when it cannot be found. */
export function resolveWebAccessEntry(home: string = os.homedir()): string {
	const pkgDir = path.join(home, ...WEB_ACCESS_DIR);
	const fail = (why: string): never => {
		throw new Error(`${NAME}: cannot locate pi-web-access in ${pkgDir} (${why})`);
	};
	let manifest: { pi?: { extensions?: unknown } };
	try {
		manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
	const declared = Array.isArray(manifest?.pi?.extensions) ? manifest.pi.extensions[0] : undefined;
	if (typeof declared !== "string" || !declared) return fail("package.json has no pi.extensions entry");
	const target = path.resolve(pkgDir, declared);
	const inside = path.relative(pkgDir, target);
	if (inside.startsWith("..") || path.isAbsolute(inside)) return fail(`pi.extensions entry ${JSON.stringify(declared)} leaves the package`);
	const candidates = fs.existsSync(target) && fs.statSync(target).isDirectory()
		? [path.join(target, "index.js"), path.join(target, "index.ts")]
		: [target];
	const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
	return found ?? fail(`no module file at ${target}`);
}

/** Installs the guard, then registers pi-web-access's tools on the same `pi`. Throws, never continues unguarded. */
export async function installGuarded(pi: ExtensionAPI, load: () => Promise<unknown>): Promise<void> {
	pi.on("tool_call", async (event) => {
		if (!GUARDED_TOOLS.has(event.toolName)) return undefined;
		const reason = refusal(event.input as Record<string, unknown> | undefined);
		return reason ? { block: true, reason: `${NAME}: ${reason}` } : undefined;
	});
	let loaded: unknown;
	try {
		loaded = await load();
	} catch (error) {
		throw new Error(`${NAME}: cannot load pi-web-access, so the researcher has no web tools: ${error instanceof Error ? error.message : String(error)}`);
	}
	const factory = (loaded as { default?: unknown } | undefined)?.default;
	if (typeof factory !== "function") {
		throw new Error(`${NAME}: pi-web-access has no default export to register its tools, so the researcher has no web tools`);
	}
	await (factory as (api: ExtensionAPI) => void | Promise<void>)(pi);
}

export default async function (pi: ExtensionAPI): Promise<void> {
	await installGuarded(pi, () => import(pathToFileURL(resolveWebAccessEntry()).href));
}

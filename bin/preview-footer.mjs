#!/usr/bin/env node
/**
 * preview-footer.mjs — render the custom footer without launching Pi.
 *
 * The footer in pi/agent/extensions/footer.ts replaces Pi's built-in one, so
 * its layout is worth checking outside a TUI. This renders it with fake
 * session data at a few widths and prints the lines.
 *
 * Usage: node bin/preview-footer.mjs [width...]
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const agentDir = process.env.PI_AGENT_DIR || join(process.env.HOME || "/root", ".pi", "agent");
const npmDir = join(agentDir, "npm", "node_modules");

// jiti lives in Pi's npm directory, not in this repo, so import it by path.
const { createJiti } = await import(pathToFileURL(join(npmDir, "jiti", "lib", "jiti.mjs")).href);

const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-tui": join(npmDir, "@earendil-works", "pi-tui", "dist", "index.js"),
	},
});

const mod = await jiti.import(join(repo, "pi", "agent", "extensions", "footer.ts"));
const handlers = {};
mod.default({
	on: (name, fn) => {
		handlers[name] = fn;
	},
	getSettings: () => ({ compaction: { enabled: true } }),
});

const theme = { fg: (_style, text) => text };
const statuses = new Map([
	["agent-name", "● kosmos.orchestrator — lead mode · minimax/MiniMax-M3.1-Flash"],
	["mcp", "MCP: 1 server enabled (1 connected)"],
]);
const footerData = {
	getGitBranch: () => "main",
	getExtensionStatuses: () => statuses,
	getAvailableProviderCount: () => 1,
	onBranchChange: () => () => {},
};
const entries = [
	{
		type: "message",
		message: {
			role: "assistant",
			usage: { input: 1200, output: 800, cacheRead: 40000, cacheWrite: 0, cost: { total: 0.012 } },
		},
	},
];

const ctx = {
	mode: "tui",
	hasUI: true,
	cwd: process.cwd(),
	model: { id: "minimax/MiniMax-M3.1-Flash", provider: "minimax", reasoning: true, contextWindow: 1000000 },
	thinkingLevel: "high",
	sessionManager: {
		getCwd: () => process.cwd(),
		getSessionName: () => undefined,
		getLeafId: () => "leaf-1",
		getEntryCount: () => entries.length,
		getEntries: () => entries,
	},
	getContextUsage: () => ({ percent: 12.3, contextWindow: 1000000 }),
	ui: {
		setFooter: (factory) => {
			ctx.footerFactory = factory;
		},
	},
};

await handlers.session_start({}, ctx);
const component = ctx.footerFactory({}, theme, footerData);

for (const width of process.argv.slice(2).map(Number).filter((n) => n > 0)) {
	console.log(`--- width ${width} ---`);
	for (const line of component.render(width)) console.log(`|${line}|`);
}

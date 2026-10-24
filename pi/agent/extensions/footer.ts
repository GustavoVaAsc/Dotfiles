/**
 * footer.ts
 *
 * Replaces Pi's built-in footer so the MCP status hint sits on the bottom
 * right instead of trailing the other extension statuses on the left.
 *
 * Pi joins every extension status into one left-aligned line, so a single
 * status cannot be right-aligned without replacing the footer. This
 * replacement mirrors the built-in layout — pwd line, stats line with the
 * model on the right, status line — and changes only where the MCP hint
 * goes.
 *
 * Auto-loaded by Pi from ~/.pi/agent/extensions/footer.ts.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Status key pi-mcp-adapter uses for its persistent footer hint. */
const MCP_STATUS_KEY = "mcp";

/** Minimum gap between the left and the right half of a line. */
const MIN_PADDING = 2;

type FooterTheme = {
	fg(style: string, text: string): string;
};

type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

type SessionStats = {
	totals: UsageTotals;
	cacheHitRate?: number;
	contextWindow: number;
	contextPercent: number;
	contextKnown: boolean;
};

/** getEntryCount() exists on the session manager but is not in the read-only type. */
type CountableSessionManager = { getEntryCount?: () => number };

function emptyTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsage(totals: UsageTotals, usage: any): void {
	if (!usage) return;
	totals.input += usage.input ?? 0;
	totals.output += usage.output ?? 0;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;
	totals.cost += usage.cost?.total ?? 0;
}

/** Token formatting, same as Pi's footer. */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Cwd formatting, same as Pi's footer: home-relative with a leading ~. */
function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/** Single-line sanitising, same as Pi applies to status text. */
function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

class FooterComponent implements Component {
	private cache?: { key: string; stats: SessionStats };

	constructor(
		private readonly ctx: ExtensionContext,
		private readonly theme: FooterTheme,
		private readonly footerData: ReadonlyFooterDataProvider,
		private readonly autoCompactEnabled: () => boolean,
	) {}

	/**
	 * Usage totals and context usage scan the whole session, and the footer
	 * renders on every frame. Recompute only when the session grew or the
	 * model changed, the same way Pi's own footer does.
	 */
	private getSessionStats(): SessionStats {
		const sessionManager = this.ctx.sessionManager;
		const countable = sessionManager as unknown as CountableSessionManager;
		const entryCount =
			typeof countable.getEntryCount === "function"
				? countable.getEntryCount()
				: sessionManager.getEntries().length;
		const modelId = this.ctx.model?.id ?? "";
		const key = `${sessionManager.getLeafId()}:${entryCount}:${modelId}`;
		const cached = this.cache;
		if (cached && cached.key === key) return cached.stats;

		const totals = emptyTotals();
		let cacheHitRate: number | undefined;
		for (const entry of sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsage(totals, (entry as any).usage);
			} else if (entry.type === "message" && (entry as any).message.role === "assistant") {
				const usage = (entry as any).message.usage;
				addUsage(totals, usage);
				const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
				cacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
			} else if (entry.type === "message" && (entry as any).message.role === "toolResult" && (entry as any).message.usage) {
				addUsage(totals, (entry as any).message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && (entry as any).usage) {
				addUsage(totals, (entry as any).usage);
			}
		}

		const contextUsage = this.ctx.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? this.ctx.model?.contextWindow ?? 0;
		const contextPercent = contextUsage?.percent ?? 0;
		const stats: SessionStats = {
			totals,
			cacheHitRate,
			contextWindow,
			contextPercent,
			contextKnown: contextUsage?.percent !== null,
		};
		this.cache = { key, stats };
		return stats;
	}

	render(width: number): string[] {
		const theme = this.theme;
		const stats = this.getSessionStats();
		const model = this.ctx.model;

		let pwd = formatCwdForFooter(this.ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
		const branch = this.footerData.getGitBranch();
		if (branch) pwd = `${pwd} (${branch})`;
		const sessionName = this.ctx.sessionManager.getSessionName();
		if (sessionName) pwd = `${pwd} • ${sessionName}`;

		const parts: string[] = [];
		const totals = stats.totals;
		if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
		if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
		if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
		if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
		if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && stats.cacheHitRate !== undefined) {
			parts.push(`CH${stats.cacheHitRate.toFixed(1)}%`);
		}
		// Kimi Coding is subscription-backed despite using API-key authentication.
		const usingSubscription = model?.provider === "kimi-coding";
		if (totals.cost || usingSubscription) {
			parts.push(`$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
		}
		const autoIndicator = this.autoCompactEnabled() ? " (auto)" : "";
		const contextDisplay = stats.contextKnown
			? `${stats.contextPercent.toFixed(1)}%/${formatTokens(stats.contextWindow)}${autoIndicator}`
			: `?/${formatTokens(stats.contextWindow)}${autoIndicator}`;
		parts.push(
			stats.contextPercent > 90
				? theme.fg("error", contextDisplay)
				: stats.contextPercent > 70
					? theme.fg("warning", contextDisplay)
					: contextDisplay,
		);

		let statsLeft = parts.join(" ");
		let statsLeftWidth = visibleWidth(statsLeft);
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		const modelName = model?.id || "no-model";
		let rightSide = modelName;
		if (model?.reasoning) {
			const level = this.ctx.thinkingLevel || "off";
			rightSide = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
		}
		if (this.footerData.getAvailableProviderCount() > 1 && model) {
			const withProvider = `(${model.provider}) ${rightSide}`;
			if (statsLeftWidth + MIN_PADDING + visibleWidth(withProvider) <= width) {
				rightSide = withProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		let statsLine: string;
		if (statsLeftWidth + MIN_PADDING + rightSideWidth <= width) {
			statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide;
		} else {
			const available = width - statsLeftWidth - MIN_PADDING;
			if (available > 0) {
				const truncated = truncateToWidth(rightSide, available, "");
				statsLine = statsLeft + " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncated))) + truncated;
			} else {
				statsLine = statsLeft;
			}
		}

		// Dim each part separately: statsLeft may carry its own colour codes
		// that would clear an outer dim wrapper.
		const lines = [
			truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
			theme.fg("dim", statsLeft) + theme.fg("dim", statsLine.slice(statsLeft.length)),
		];

		const statusLine = this.renderStatusLine(width);
		if (statusLine) lines.push(statusLine);
		return lines;
	}

	/**
	 * The status line keeps every extension status on the left and puts the
	 * MCP hint on the right edge of the line.
	 */
	private renderStatusLine(width: number): string | undefined {
		const statuses = this.footerData.getExtensionStatuses();
		if (statuses.size === 0) return undefined;

		const sorted = Array.from(statuses.entries()).sort(([a], [b]) => a.localeCompare(b));
		const mcpEntry = sorted.find(([key]) => key === MCP_STATUS_KEY);
		const left = sorted
			.filter(([key]) => key !== MCP_STATUS_KEY)
			.map(([, text]) => sanitizeStatusText(text))
			.filter((text) => text.length > 0)
			.join(" ");
		const right = mcpEntry ? sanitizeStatusText(mcpEntry[1]) : "";

		if (!right) {
			return left ? truncateToWidth(left, width, this.theme.fg("dim", "...")) : undefined;
		}
		const rightWidth = visibleWidth(right);
		if (!left) {
			if (rightWidth >= width) return truncateToWidth(right, width, this.theme.fg("dim", "..."));
			return " ".repeat(width - rightWidth) + right;
		}
		const leftWidth = visibleWidth(left);
		if (leftWidth + MIN_PADDING + rightWidth <= width) {
			return left + " ".repeat(width - leftWidth - rightWidth) + right;
		}
		const available = width - rightWidth;
		if (available > 0) {
			const truncated = truncateToWidth(left, available, "");
			return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated) - rightWidth)) + right;
		}
		return truncateToWidth(right, width, this.theme.fg("dim", "..."));
	}

	invalidate(): void {
		// No cached rendering state to drop.
	}
}

export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;

	const install = (current: ExtensionContext) => {
		ctx = current;
		if (current.mode !== "tui" || !current.hasUI) return;
		const autoCompactEnabled = () => pi.getSettings().compaction?.enabled ?? true;
		current.ui.setFooter((_tui, theme, footerData) => new FooterComponent(ctx!, theme, footerData, autoCompactEnabled));
	};

	pi.on("session_start", async (_event, current) => {
		install(current);
	});

	pi.on("agent_start", async (_event, current) => {
		install(current);
	});

	pi.on("session_shutdown", async (_event, current) => {
		if (current.mode !== "tui") return;
		current.ui.setFooter(undefined);
	});
}
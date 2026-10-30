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

/** Context usage bar: cell characters, default width and the degradation ladder. */
const BAR_FILLED = "█";
const BAR_EMPTY = "░";
const BAR_WIDTHS = [12, 8, 6, 4];

/**
 * A percentage above 100 % is possible (the estimate can exceed the
 * window), so the ceiling is generous; beyond it the number is not a
 * percentage.
 */
const MAX_CONTEXT_PERCENT = 1000;

type FooterTheme = {
	fg(style: string, text: string): string;
};

/**
 * The session cost, which is the only usage figure the footer shows: the
 * token counters (input, output, cache reads and writes) and the cache hit
 * rate are not rendered.
 */
type UsageTotals = {
	cost: number;
};

type SessionStats = {
	totals: UsageTotals;
	contextWindow: number;
	/** The percentage the readout and the thresholds use; 0 when unknown. */
	contextPercent: number;
	/**
	 * The percentage as reported, but only when it is a usable number: a
	 * finite value within 0..MAX_CONTEXT_PERCENT. Null for every unusable
	 * value (no percentage at all, null, NaN, an infinity or an out-of-range
	 * magnitude). This is the field that gates the bar.
	 */
	contextPercentRaw: number | null;
	/**
	 * Whether the readout shows a percentage. False when the percentage is
	 * explicitly null or unusable, in which case the readout shows "?/". An
	 * absent percentage stays 0.0%, as it always has: a fresh session has
	 * genuinely used nothing.
	 */
	contextKnown: boolean;
};

/** getEntryCount() exists on the session manager but is not in the read-only type. */
type CountableSessionManager = { getEntryCount?: () => number };

function emptyTotals(): UsageTotals {
	return { cost: 0 };
}

function addUsage(totals: UsageTotals, usage: any): void {
	if (!usage) return;
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

/**
 * The context percentage, or null when it is not a usable percentage.
 *
 * A percentage has to be a finite number within 0..MAX_CONTEXT_PERCENT: an
 * over-100 % estimate is possible, but a magnitude such as 1e300 is not a
 * percentage at all. The readout and the bar both follow this one value, so
 * they can never disagree.
 */
function usablePercent(value: number | null | undefined): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	if (value < 0 || value > MAX_CONTEXT_PERCENT) return null;
	return value;
}

/**
 * The context usage bar: `width` cells, filled proportionally to the
 * percentage. A small but non-zero usage still shows one filled cell.
 *
 * Returns null for a percentage that is not a finite number: an unknown
 * percentage gets no bar at all, never an empty one.
 */
function contextBar(
	theme: FooterTheme,
	percent: number,
	width: number,
	color: string,
): { text: string; painted: string } | null {
	if (!Number.isFinite(percent)) return null;
	let filled = Math.round((percent / 100) * width);
	if (filled > width) filled = width;
	if (filled < 0) filled = 0;
	if (percent > 0 && filled === 0) filled = 1;
	const filledText = BAR_FILLED.repeat(filled);
	const emptyText = BAR_EMPTY.repeat(width - filled);
	// The empty cells are muted, not dim: the dim colour is the brightest
	// one of the theme and would make the unused part the loudest.
	let painted = "";
	if (filledText) painted += theme.fg(color, filledText);
	if (emptyText) painted += theme.fg("muted", emptyText);
	return { text: filledText + emptyText, painted };
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
		for (const entry of sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsage(totals, (entry as any).usage);
			} else if (entry.type === "message" && (entry as any).message.role === "assistant") {
				addUsage(totals, (entry as any).message.usage);
			} else if (entry.type === "message" && (entry as any).message.role === "toolResult" && (entry as any).message.usage) {
				addUsage(totals, (entry as any).message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && (entry as any).usage) {
				addUsage(totals, (entry as any).usage);
			}
		}

		const contextUsage = this.ctx.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? this.ctx.model?.contextWindow ?? 0;
		const reportedPercent = contextUsage?.percent;
		// One value decides whether the reported percentage is usable: it has
		// to be a finite number within 0..MAX_CONTEXT_PERCENT. A genuine
		// over-100 % estimate stays visible, but an implausible magnitude is
		// not a percentage at all. The readout and the bar both follow it.
		const usable = usablePercent(reportedPercent);
		const stats: SessionStats = {
			totals,
			contextWindow,
			contextPercent: usable ?? 0,
			// Null for every unusable value: this is the field that gates the
			// bar.
			contextPercentRaw: usable,
			// An absent percentage is a fresh session, not an unknown one: it
			// keeps its 0.0% readout, as the built-in footer does.
			contextKnown: usable !== null || reportedPercent === undefined,
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

		const totals = stats.totals;
		// Kimi Coding is subscription-backed despite using API-key authentication.
		const usingSubscription = model?.provider === "kimi-coding";
		// The cost is the only segment before the readout.
		const leadText =
			totals.cost || usingSubscription
				? `$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`
				: "";
		const autoIndicator = this.autoCompactEnabled() ? " (auto)" : "";
		const contextDisplay = stats.contextKnown
			? `${stats.contextPercent.toFixed(1)}%/${formatTokens(stats.contextWindow)}${autoIndicator}`
			: `?/${formatTokens(stats.contextWindow)}${autoIndicator}`;
		const contextColor =
			stats.contextPercent > 90 ? "error" : stats.contextPercent > 70 ? "warning" : "dim";
		// The bar's filled cells follow the same thresholds, but a healthy
		// usage is accent (purple) rather than the dim text colour.
		const barColor =
			stats.contextPercent > 90 ? "error" : stats.contextPercent > 70 ? "warning" : "accent";

		// The left half without a bar: the cost is plain text, the readout
		// carries its own colour when it is over a threshold, and the whole
		// half is dimmed in one wrapper.
		const readout = contextColor === "dim" ? contextDisplay : theme.fg(contextColor, contextDisplay);
		let statsLeft = leadText ? `${leadText} ${readout}` : readout;
		let statsLeftWidth = visibleWidth(statsLeft);
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		const modelName = model?.id || "no-model";
		// The model on the right. The provider prefix only fits when there is
		// room, and the room is measured on the left half *without* the bar:
		// the right half never changes because of the bar.
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

		// The bar is the only thing that shrinks: it tries the widest size
		// first and falls back to narrower ones, and it is dropped entirely
		// rather than pushing the numbers, the cost or the model out.
		let leftText = statsLeft;
		let leftPainted = statsLeft;
		const barPercent = stats.contextPercentRaw;
		if (barPercent !== null && stats.contextWindow > 0) {
			for (const barWidth of BAR_WIDTHS) {
				const bar = contextBar(theme, barPercent, barWidth, barColor);
				if (!bar) break;
				const candidateText = leadText
					? `${leadText} ${bar.text} ${contextDisplay}`
					: `${bar.text} ${contextDisplay}`;
				const candidateWidth = visibleWidth(candidateText);
				if (candidateWidth + MIN_PADDING + rightSideWidth <= width) {
					leftText = candidateText;
					leftPainted = leadText
						? `${leadText} ${bar.painted} ${theme.fg(contextColor, contextDisplay)}`
						: `${bar.painted} ${theme.fg(contextColor, contextDisplay)}`;
					break;
				}
			}
		}
		const leftWidth = visibleWidth(leftText);

		let rightText = "";
		if (leftWidth + MIN_PADDING + rightSideWidth <= width) {
			rightText = " ".repeat(width - leftWidth - rightSideWidth) + rightSide;
		} else {
			const available = width - leftWidth - MIN_PADDING;
			if (available > 0) {
				const truncated = truncateToWidth(rightSide, available, "");
				rightText = " ".repeat(Math.max(0, width - leftWidth - visibleWidth(truncated))) + truncated;
			}
		}

		// The left half is dimmed in one wrapper, the right half in another:
		// a single wrapper would be cancelled by the bar's own colour codes.
		const lines = [
			truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
			theme.fg("dim", leftPainted) + theme.fg("dim", rightText),
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
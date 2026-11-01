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
 * The cost on the stats line is split into two segments: the orchestrator's
 * own spend (accent colour) and the spend of the delegated subagents
 * (success colour). The split comes from pi-subagents' in-process RPC when
 * it answers, and is computed from the session entries otherwise.
 *
 * The cost follows the current branch rather than the whole session, and the
 * displayed total is the orchestrator plus its delegated children.
 *
 * Auto-loaded by Pi from ~/.pi/agent/extensions/footer.ts.
 */
import { randomUUID } from "node:crypto";
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

/** The in-process RPC pi-subagents exposes its cost report on. */
const RPC_READY_EVENT = "subagents:rpc:v1:ready";
const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";

/**
 * How long a cost request waits for its reply before its event-bus
 * listener is retired. A request that is never answered (pi-subagents is
 * not loaded, or its bridge throws) must not leave a listener behind for
 * every message of the session.
 */
const REPLY_TIMEOUT_MS = 30_000;

/** The tool results that carry a delegated child's usage. */
const DELEGATED_TOOLS = new Set(["subagent", "bg_wait"]);

type FooterTheme = {
	fg(style: string, text: string): string;
};

/**
 * The cost of a session, split into the orchestrator's own spend and the
 * spend of the subagents it delegated to.
 */
type CostSplit = {
	/** The orchestrator's cost, without any delegated child spend. */
	parent: number;
	/** The delegated child cost; null when it cannot be determined. */
	child: number | null;
};

/**
 * The cost report pi-subagents returns over its RPC: the same split, with
 * the children resolved from the run artifacts as well.
 */
type SubagentCostReport = {
	/** The orchestrator's cost, without any delegated child spend. */
	parent: number;
	/** The delegated child cost; null when it cannot be determined. */
	child: number | null;
};

/**
 * One piece of the left half of the stats line: the plain text for the
 * width maths and the painted text for the output. The two have to stay
 * in step, because only the painted text carries the colour codes.
 */
type Piece = {
	text: string;
	painted: string;
};

type SessionStats = {
	/** The cost split computed from the session entries. */
	cost: CostSplit;
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

/** The session branch, the entries pi-subagents walks for its own cost report. */
type BranchableSessionManager = { getBranch?: () => any[] };

/** The width of a list of pieces. */
function piecesWidth(pieces: Piece[]): number {
	let width = 0;
	for (const piece of pieces) width += visibleWidth(piece.text);
	return width;
}

/**
 * The cost of one usage record. A usage record either carries a cost
 * object (the parent's own usage) or a plain number (a child's usage).
 */
function usageCost(usage: any): number {
	if (!usage) return 0;
	const cost = usage.cost;
	const total = typeof cost === "object" && cost !== null ? cost.total : cost;
	return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

/**
 * The cost split of the session entries, mirroring the definition
 * pi-subagents uses: the parent is the assistant usage plus the compaction
 * entries, and the children are the usage attached to the delegated tool
 * results. The definition has to match pi-subagents' own report exactly, so
 * the number does not move when the RPC report takes over.
 *
 * The child cost is null when a delegated child ran whose usage cannot be
 * read from the session, so the caller can tell "no children" from "the
 * children's cost is unknown".
 */
function collectLocalCost(entries: any[]): CostSplit {
	let parent = 0;
	let child = 0;
	let childUnknown = false;
	const seenChildren = new Set<string>();

	const addChild = (result: any): boolean => {
		const cost = usageCost(result?.usage);
		if (!cost) return false;
		const identity =
			typeof result?.runId === "string"
				? `run:${result.runId}`
				: typeof result?.sessionFile === "string"
					? `session:${result.sessionFile}`
					: undefined;
		if (identity) {
			if (seenChildren.has(identity)) return true;
			seenChildren.add(identity);
		}
		child += cost;
		return true;
	};

	for (const entry of entries) {
		const message = entry?.type === "message" ? entry.message : undefined;
		if (message?.role === "assistant") {
			parent += usageCost(message.usage);
		} else if (message?.role === "toolResult" && DELEGATED_TOOLS.has(message.toolName)) {
			const details = message.details;
			let counted = 0;
			for (const result of details?.results ?? []) {
				if (addChild(result)) counted += 1;
			}
			for (const completion of details?.completions ?? []) {
				for (const result of completion?.results ?? []) {
					if (addChild(result)) counted += 1;
				}
			}
			if (counted === 0) {
				// No per-child usage: the tool result's own usage is the sum
				// of the children it ran.
				const toolCost = usageCost(message.usage);
				if (toolCost > 0) child += toolCost;
				else if (details?.asyncId || details?.mode === "workflow") {
					// An async run keeps its usage in the run artifacts, which
					// only pi-subagents can resolve.
					childUnknown = true;
				}
			}
		} else if (entry?.type === "compaction") {
			parent += usageCost(entry.usage);
		}
	}

	return { parent, child: childUnknown ? null : child };
}

/**
 * A cost amount, rounded to three decimals. A non-zero amount that would
 * round to zero is shown as "<$0.001" so a real cost never reads as free.
 */
function formatCostAmount(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "$0.000";
	const rounded = value.toFixed(3);
	if (rounded === "0.000") return "<$0.001";
	return `$${rounded}`;
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
		private readonly costReport: () => SubagentCostReport | undefined,
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

		// The cost split follows the session branch, the same entries
		// pi-subagents walks for its own cost report.
		const branchManager = sessionManager as unknown as BranchableSessionManager;
		const entries =
			typeof branchManager.getBranch === "function"
				? branchManager.getBranch()
				: sessionManager.getEntries();
		const cost = collectLocalCost(entries);

		const contextUsage = this.ctx.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? this.ctx.model?.contextWindow ?? 0;
		const reportedPercent = contextUsage?.percent;
		// One value decides whether the reported percentage is usable: it has
		// to be a finite number within 0..MAX_CONTEXT_PERCENT. A genuine
		// over-100 % estimate stays visible, but an implausible magnitude is
		// not a percentage at all. The readout and the bar both follow it.
		const usable = usablePercent(reportedPercent);
		const stats: SessionStats = {
			cost,
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

	/**
	 * The two cost segments of the stats line: the orchestrator's own cost
	 * in the accent colour and the delegated child cost in the success
	 * colour, separated by a plain "+".
	 *
	 * The report pi-subagents returns wins while it covers the message the
	 * session is in; until it arrives (or when pi-subagents is not loaded)
	 * the split is computed from the session entries. A child cost that is
	 * unknown is not shown at all rather than guessed.
	 */
	private getCostPieces(theme: FooterTheme, usingSubscription: boolean): Piece[] {
		const report = this.costReport();
		const split: CostSplit = report
			? { parent: report.parent, child: report.child }
			: this.getSessionStats().cost;
		const pieces: Piece[] = [];

		const parentText = formatCostAmount(split.parent);
		const parentLabel = `${parentText}${usingSubscription ? " (sub)" : ""}`;
		// The parent is shown whenever there is a cost to show at all: a
		// delegation without any parent spend still reads as two segments.
		if (split.parent > 0 || usingSubscription || (split.child !== null && split.child > 0)) {
			pieces.push({ text: parentLabel, painted: theme.fg("accent", parentLabel) });
		}

		if (split.child !== null && split.child > 0) {
			const childText = formatCostAmount(split.child);
			// The "+" and the space before it are plain: the amount it
			// introduces carries the success colour.
			pieces.push({
				text: ` +${childText}`,
				painted: ` +${theme.fg("success", childText)}`,
			});
		}

		return pieces;
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

		// Kimi Coding is subscription-backed despite using API-key authentication.
		const usingSubscription = model?.provider === "kimi-coding";
		// The cost is the only segment before the readout.
		const costPieces = this.getCostPieces(theme, usingSubscription);
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

		// The plain pieces are dimmed on their own: the coloured segments
		// close their colour with a reset, so one dim wrapper around the
		// whole half would leave everything after them unstyled.
		const space: Piece = { text: " ", painted: theme.fg("dim", " ") };
		const readout: Piece = { text: contextDisplay, painted: theme.fg(contextColor, contextDisplay) };

		const modelName = model?.id || "no-model";
		// The model on the right. The provider prefix only fits when there is
		// room, and the room is measured on the left half *without* the bar:
		// the right half never changes because of the bar.
		let rightSide = modelName;
		if (model?.reasoning) {
			const level = this.ctx.thinkingLevel || "off";
			rightSide = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
		}
		// The cost is followed by a space only when there is a cost: with
		// no cost the line starts with the readout, not with a space.
		const costPrefix: Piece[] = costPieces.length > 0 ? [...costPieces, space] : [];
		const leftWithoutBar: Piece[] = [...costPrefix, readout];
		if (this.footerData.getAvailableProviderCount() > 1 && model) {
			const withProvider = `(${model.provider}) ${rightSide}`;
			if (piecesWidth(leftWithoutBar) + MIN_PADDING + visibleWidth(withProvider) <= width) {
				rightSide = withProvider;
			}
		}
		const rightSideWidth = visibleWidth(rightSide);
		const fits = (pieces: Piece[]): boolean =>
			piecesWidth(pieces) + MIN_PADDING + rightSideWidth <= width;

		// The bar is the only thing that shrinks: it tries the widest size
		// first and falls back to narrower ones, and it is dropped entirely
		// rather than pushing the numbers, the cost or the model out.
		let leftPieces: Piece[] = leftWithoutBar;
		const barPercent = stats.contextPercentRaw;
		if (barPercent !== null && stats.contextWindow > 0) {
			for (const barWidth of BAR_WIDTHS) {
				const bar = contextBar(theme, barPercent, barWidth, barColor);
				if (!bar) break;
				const candidate: Piece[] = [
					...costPrefix,
					{ text: bar.text, painted: bar.painted },
					space,
					readout,
				];
				if (fits(candidate)) {
					leftPieces = candidate;
					break;
				}
			}
		}

		// What is left gives up its parts in a fixed order: the delegated
		// segment goes before the readout, and the readout goes before the
		// model name. The model is never shortened while a cost segment or
		// the readout is still on the line.
		if (!fits(leftPieces)) {
			// The delegated segment is the first to go.
			const parentCost = costPieces.length > 1 ? [costPieces[0]] : costPieces;
			const parentPrefix: Piece[] = parentCost.length > 0 ? [...parentCost, space] : [];
			const withParentOnly: Piece[] = [...parentPrefix, readout];
			if (fits(withParentOnly)) {
				leftPieces = withParentOnly;
			} else {
				// The readout gives up its room next: it is truncated to
				// what is left next to the cost, and dropped when even that
				// does not fit. The space that separated it from the cost
				// goes with it.
				const readoutRoom = width - MIN_PADDING - rightSideWidth - piecesWidth(parentPrefix);
				if (readoutRoom >= 4) {
					const shrunk = truncateToWidth(contextDisplay, readoutRoom, "...");
					const candidate: Piece[] = [
						...parentPrefix,
						{ text: shrunk, painted: theme.fg(contextColor, shrunk) },
					];
					leftPieces = fits(candidate) ? candidate : parentCost;
				} else {
					leftPieces = parentCost;
				}
			}
		}

		// A line narrower than the cost itself: the parent text is cut.
		if (piecesWidth(leftPieces) > width) {
			const parentOnly = costPieces.slice(0, 1);
			if (piecesWidth(parentOnly) <= width) {
				leftPieces = parentOnly;
			} else {
				const truncated = truncateToWidth(parentOnly[0]?.text ?? "", Math.max(0, width), "...");
				leftPieces = [{ text: truncated, painted: theme.fg("accent", truncated) }];
			}
		}

		const leftText = leftPieces.map((piece) => piece.text).join("");
		const leftPainted = leftPieces.map((piece) => piece.painted).join("");
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
	/** The last cost report pi-subagents returned, if any. */
	let costReport: SubagentCostReport | undefined;
	/**
	 * The user message the report covers. A report is taken at the end of a
	 * message, so it describes that message and nothing after it.
	 */
	let costReportMessageId: string | undefined;
	/**
	 * The reply listeners of the requests that are still in flight, with the
	 * timer that retires them. Every reply removes its own listener, and a
	 * request that is never answered is retired by its timer, so a session
	 * does not accumulate dead listeners. The rest are torn down when the
	 * session changes, so a reply can never be applied to a session it was
	 * not asked for.
	 */
	const pendingReplies = new Map<() => void, ReturnType<typeof setTimeout>>();
	/**
	 * The sequence number of the newest cost request. A reply that belongs
	 * to an older request is discarded by this check.
	 */
	let requestSeq = 0;
	/**
	 * The key of the newest cost request: what that request covers. The
	 * report of a message is keyed by its user message id, the report of
	 * the session start by the session id.
	 */
	let requestedKey: string | undefined;
	/** Redraws the footer after a cost report arrived. */
	let requestRender: (() => void) | undefined;
	/** Whether the footer is installed; only then is a report worth asking for. */
	let footerInstalled = false;

	/** The session the footer is showing right now. */
	const currentSessionId = (): string | undefined => {
		try {
			return ctx?.sessionManager.getSessionId();
		} catch {
			return undefined;
		}
	};

	/**
	 * The id of the last user message in the branch. It is the key that
	 * tells one user message from the next: every turn boundary of the
	 * same message shares it.
	 */
	const lastUserMessageId = (): string | undefined => {
		const entries = ctx?.sessionManager.getBranch() ?? [];
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index] as any;
			if (entry?.type === "message" && entry.message?.role === "user") return entry.id;
		}
		return undefined;
	};

	/** Drop every reply listener that is still waiting for an answer. */
	const dropPendingReplies = () => {
		for (const [unsubscribe, timer] of pendingReplies) {
			clearTimeout(timer);
			unsubscribe();
		}
		pendingReplies.clear();
	};

	/**
	 * The cost report to show, when it covers the message the session is
	 * in.
	 *
	 * A report is taken at the end of a user message, so it describes that
	 * message only. While the next message is running the live local
	 * computation is used instead, which grows with the branch.
	 */
	const currentCostReport = (): SubagentCostReport | undefined => {
		if (!costReport) return undefined;
		if (costReportMessageId !== lastUserMessageId()) return undefined;
		return costReport;
	};

	/**
	 * Ask pi-subagents for the cost report. The answer arrives on the event
	 * bus, so the report is cached and the footer reads the cache while it
	 * renders.
	 *
	 * One request per user message: the request is made when the agent
	 * settles, at the end of the message, so the report pi-subagents
	 * computes (it walks the session branch when it answers) covers every
	 * turn of that message. The key of the request is the user message id,
	 * so the turns of one message cannot ask twice.
	 *
	 * The request carries the session it was made for. A reply that arrives
	 * for a session that is gone is ignored, and a reply that belongs to an
	 * older request is discarded by the sequence check, so no answer is
	 * applied to the wrong session or out of order.
	 */
	const requestCostReport = (key: string, coversMessageId: string | undefined) => {
		if (!footerInstalled) return;
		if (requestedKey === key) return;
		requestedKey = key;

		const seq = ++requestSeq;
		const sessionId = currentSessionId();
		const requestId = randomUUID();
		const unsubscribe = pi.events.on(`${RPC_REPLY_PREFIX}${requestId}`, (raw) => {
			const timer = pendingReplies.get(unsubscribe);
			if (timer !== undefined) clearTimeout(timer);
			pendingReplies.delete(unsubscribe);
			unsubscribe();
			// An older reply is discarded: the newest request wins.
			if (seq !== requestSeq) return;
			// A reply for a session that is gone belongs to the old
			// session and is not applied to the new one.
			if (sessionId !== currentSessionId()) return;
			const reply = raw as
				| {
						success?: boolean;
						data?: {
							parent?: { cost?: number };
							childTotal?: { cost?: number };
							unresolvedAsyncChildren?: number;
						};
				  }
				| undefined;
			if (!reply || reply.success !== true) return;
			const parent = reply.data?.parent?.cost;
			const child = reply.data?.childTotal?.cost;
			const unresolved = reply.data?.unresolvedAsyncChildren;
			if (typeof parent !== "number" || !Number.isFinite(parent)) return;
			// The child total is a lower bound while an async child is
			// unresolved, so the child cost is unknown rather than exact.
			const childUnknown = typeof unresolved === "number" && unresolved > 0;
			costReport = {
				parent,
				child: childUnknown
					? null
					: typeof child === "number" && Number.isFinite(child)
						? child
						: 0,
			};
			costReportMessageId = coversMessageId;
			requestRender?.();
		});
		// A request that is never answered must not keep its listener on the
		// event bus for the rest of the session: the timer retires it.
		const timer = setTimeout(() => {
			unsubscribe();
			pendingReplies.delete(unsubscribe);
		}, REPLY_TIMEOUT_MS);
		// The timer must not keep the process alive on its own.
		const unref = (timer as { unref?: () => void }).unref;
		if (typeof unref === "function") unref.call(timer);
		pendingReplies.set(unsubscribe, timer);
		pi.events.emit(RPC_REQUEST_EVENT, { version: 1, requestId, method: "cost", params: {} });
	};

	// pi-subagents announces its RPC bridge when the session starts: ask for
	// the report right away, so the footer has one before the first turn
	// ends. That report covers no user message, so it never takes the place
	// of the report taken at the end of a message.
	pi.events.on(RPC_READY_EVENT, () => {
		requestCostReport(`session:${currentSessionId() ?? ""}`, undefined);
	});

	const install = (current: ExtensionContext) => {
		ctx = current;
		if (current.mode !== "tui" || !current.hasUI) return;
		footerInstalled = true;
		const autoCompactEnabled = () => pi.getSettings().compaction?.enabled ?? true;
		current.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			return new FooterComponent(ctx!, theme, footerData, autoCompactEnabled, currentCostReport);
		});
	};

	pi.on("session_start", async (_event, current) => {
		// A new session starts without a cost report, and the request that
		// is still in flight belongs to the old session: its listener is
		// torn down and its sequence number is retired, so a late reply
		// can never be applied to the new session.
		costReport = undefined;
		costReportMessageId = undefined;
		requestSeq++;
		dropPendingReplies();
		requestedKey = undefined;
		install(current);
	});

	pi.on("agent_start", async (_event, current) => {
		install(current);
	});

	// The cost report is read at the end of a run, never on a timer: the
	// agent settles once per user message, and pi-subagents walks the
	// session branch when it answers, so the report then covers every turn
	// of that message. While the message is still running the footer shows
	// the live local computation, which grows with the branch.
	pi.on("agent_settled", async () => {
		const messageId = lastUserMessageId();
		if (messageId === undefined) return;
		requestCostReport(`message:${messageId}`, messageId);
	});

	pi.on("session_shutdown", async (_event, current) => {
		requestSeq++;
		dropPendingReplies();
		costReport = undefined;
		costReportMessageId = undefined;
		requestedKey = undefined;
		requestRender = undefined;
		footerInstalled = false;
		if (current.mode !== "tui") return;
		current.ui.setFooter(undefined);
	});
}

/**
 * usage.ts
 *
 * Adds the `/usage` command: the token-plan quota of the two subscription
 * providers this machine is set up for, shown the way Claude Code shows its
 * `/usage`.
 *
 * - MiniMax Token Plan: the 5-hour rolling window and the weekly window,
 *   read from the `token_plan/remains` endpoint with the provider API key.
 * - Xiaomi MiMo Token Plan: the plan's usage and allowance, read from the
 *   Xiaomi dashboard API with the browser session cookie.
 *
 * In the TUI the report is an overlay panel, not a chat message. The panel
 * opens at once with a loading state and fills in when the fetch settles;
 * Esc or q closes it, `r` fetches again past the cache. Nothing is written
 * to the transcript and no model turn is started. Every quota window is a
 * row of its own: a label, a fill bar of the fraction used (same glyphs,
 * colours and thresholds as the context bar of footer.ts, sized to the
 * panel width), the used and remaining amounts, and the reset time. A
 * percentage the API did not give is shown as `?` with an empty bar.
 *
 * Without a TUI (print, json and RPC modes) the same report is sent as a
 * custom message, so those modes still get it.
 *
 * No secret is ever printed. The MiniMax key and the Xiaomi cookie are
 * only ever used as request credentials; the report carries percentages,
 * counts and reset times.
 *
 * Auto-loaded by Pi from ~/.pi/agent/extensions/usage.ts.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** The custom message type the report is delivered as. */
const REPORT_TYPE = "usage-report";

/** Fill bar glyphs, the same as the context bar of footer.ts. */
const BAR_FILLED = "█";
const BAR_EMPTY = "░";

/** The bar never grows past this many cells, however wide the panel is. */
const BAR_MAX_WIDTH = 40;

/** The bar never shrinks below this many cells. */
const BAR_MIN_WIDTH = 4;

/** The MiniMax token-plan endpoint. */
const MINIMAX_REMAINS_URL = "https://api.minimax.io/v1/token_plan/remains";

/** The Xiaomi dashboard endpoint that carries the plan usage. */
const MIMO_USAGE_URL = "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage";

/** The Xiaomi dashboard endpoint that carries the per-model breakdown. */
const MIMO_DETAIL_URL = "https://platform.xiaomimimo.com/api/v1/tokenPlan/detail";

/** The sign-in page the Xiaomi cookie is copied from. */
const MIMO_LOGIN_URL = "https://platform.xiaomimimo.com";

/** Every request gives up after this many milliseconds. */
const REQUEST_TIMEOUT_MS = 10_000;

/** How long a rendered report is reused before it is fetched again. */
const CACHE_TTL_MS = 60_000;

/**
 * The Xiaomi API reports its amounts in units of 1e8 credits, so a raw
 * value is a fixed-point credit count and the credits are the raw value
 * divided by this factor.
 */
const MIMO_CREDIT_SCALE = 1e8;

/** The auth file Pi keeps the provider credentials in. */
function authPath(): string {
	return join(homedir(), ".pi", "agent", "auth.json");
}

/** The file the Xiaomi dashboard cookie can be kept in. */
function cookiePath(): string {
	return join(homedir(), ".config", "mimo", "token-plan-cookie");
}

/** One entry of the auth file: a provider name and its credential. */
type AuthEntry = {
	type?: string;
	key?: string;
};

/** The auth file: provider name to credential. */
type AuthFile = Record<string, AuthEntry>;

/**
 * Read the auth file.
 *
 * The file is read at command time, so a key that was added or rotated
 * since the session started is picked up. A missing or malformed file is
 * not an error: the report then says that the provider has no key.
 */
async function readAuth(): Promise<AuthFile> {
	try {
		const raw = await readFile(authPath(), "utf8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as AuthFile;
	} catch {
		return {};
	}
}

/** The API key of a provider, or undefined when the provider has none. */
function apiKey(auth: AuthFile, provider: string): string | undefined {
	const entry = auth[provider];
	const key = entry?.key;
	return typeof key === "string" && key.trim().length > 0 ? key.trim() : undefined;
}

/** One row of the MiniMax remains response. */
type MinimaxRow = {
	model_name?: string;
	current_interval_remaining_percent?: number;
	current_weekly_remaining_percent?: number;
	current_interval_total_count?: number;
	current_interval_usage_count?: number;
	current_weekly_total_count?: number;
	current_weekly_usage_count?: number;
	end_time?: number;
	weekly_end_time?: number;
};

/** The MiniMax remains response. */
type MinimaxResponse = {
	model_remains?: MinimaxRow[];
};

/**
 * A finite number within the range of a percentage, or undefined.
 *
 * The API has been seen to answer with a missing or a non-numeric
 * percentage; such a value is not shown as "0 % remaining", which would
 * read as "nothing left".
 */
function usablePercent(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	if (value < 0 || value > 1000) return undefined;
	return value;
}

/** A count that is worth showing; a zero count is not shown at all. */
function usableCount(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return value > 0 ? value : undefined;
}

/**
 * The reset time as a local time.
 *
 * A reset later today is shown as the time of day ("19:20"), a reset on
 * another day as the date and the time ("2026-11-03 03:20"): the weekly
 * window reaches days ahead, so the date is what tells two resets apart.
 */
function formatReset(epochMs: unknown): string | undefined {
	if (typeof epochMs !== "number" || !Number.isFinite(epochMs) || epochMs <= 0) return undefined;
	const when = new Date(epochMs);
	if (Number.isNaN(when.getTime())) return undefined;
	const now = new Date();
	const sameDay =
		when.getFullYear() === now.getFullYear() &&
		when.getMonth() === now.getMonth() &&
		when.getDate() === now.getDate();
	const time = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
	if (sameDay) return time;
	const date = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(
		when.getDate(),
	).padStart(2, "0")}`;
	return `${date} ${time}`;
}

/** A count as a plain integer. */
function formatCount(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

/**
 * The absolute amounts of a MiniMax window, or undefined when there are none.
 *
 * The counts are only shown when they are non-zero: with this account the
 * endpoint answers with zero counts and meaningful percentages, and a
 * "0 used" line would state as fact something the API does not know. The
 * remaining count is only derived when both the used and the total count
 * are known.
 */
function formatCounts(used: number | undefined, total: number | undefined): string | undefined {
	if (used !== undefined && total !== undefined) {
		const left = Math.max(0, total - used);
		return `${formatCount(used)} of ${formatCount(total)} used · ${formatCount(left)} left`;
	}
	if (total !== undefined) return `limit ${formatCount(total)}`;
	if (used !== undefined) return `${formatCount(used)} used`;
	return undefined;
}

/**
 * One quota window of the report.
 *
 * `used` is the fraction used in percent, or undefined when the API gave
 * none: the bar is then empty and the numbers read `?`.
 */
type QuotaRow = {
	label: string;
	used?: number;
	/** The used and remaining amounts in absolute terms, when known. */
	amounts?: string;
	reset?: string;
};

/** A provider block of the report: a title and its rows or a note. */
type Section = {
	title: string;
	rows: QuotaRow[];
	/** A line that stands in for the rows: an error or a setup hint. */
	note?: string[];
};

/** The whole report: one section per provider. */
type Report = Section[];

/** A provider-supplied name without control characters, so it cannot move the cursor or colour the panel. */
function cleanName(name: string): string {
	return name.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/** The used percentage of a remaining percentage, clamped to 0..100. */
function usedFromRemaining(remaining: number | undefined): number | undefined {
	if (remaining === undefined) return undefined;
	return Math.max(0, Math.min(100, 100 - remaining));
}

/**
 * The MiniMax block of the report.
 *
 * The `general` row is the plan of the account; a response without it
 * falls back to the first row, which is the only one there is.
 */
async function fetchMiniMax(auth: AuthFile): Promise<Section> {
	const title = "MiniMax Token Plan";
	const key = apiKey(auth, "minimax");
	if (!key) {
		return { title, rows: [], note: ["no API key for minimax in ~/.pi/agent/auth.json"] };
	}

	let response: Response;
	try {
		response = await fetch(MINIMAX_REMAINS_URL, {
			headers: { Authorization: `Bearer ${key}`, accept: "application/json" },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "request failed";
		return { title, rows: [], note: [`unavailable (${reason})`] };
	}

	if (!response.ok) {
		return { title, rows: [], note: [`unavailable (HTTP ${response.status})`] };
	}

	let body: MinimaxResponse;
	try {
		body = (await response.json()) as MinimaxResponse;
	} catch {
		return { title, rows: [], note: ["unavailable (unreadable response)"] };
	}

	return minimaxSection(body);
}

/** The MiniMax section of a parsed remains response. */
export function minimaxSection(body: MinimaxResponse): Section {
	const rows = Array.isArray(body?.model_remains) ? body.model_remains : [];
	if (rows.length === 0) return { title: "MiniMax Token Plan", rows: [], note: ["no plan information in the response"] };

	const row = rows.find((entry) => entry?.model_name === "general") ?? rows[0];
	const model = (typeof row.model_name === "string" && cleanName(row.model_name)) || "general";

	const windows: QuotaRow[] = [];
	const pairs = [
		{
			label: "5h window",
			remaining: row.current_interval_remaining_percent,
			reset: row.end_time,
			used: row.current_interval_usage_count,
			total: row.current_interval_total_count,
		},
		{
			label: "Weekly",
			remaining: row.current_weekly_remaining_percent,
			reset: row.weekly_end_time,
			used: row.current_weekly_usage_count,
			total: row.current_weekly_total_count,
		},
	];
	for (const pair of pairs) {
		const remaining = usablePercent(pair.remaining);
		const reset = formatReset(pair.reset);
		if (remaining === undefined && reset === undefined) {
			windows.push({ label: pair.label });
			continue;
		}
		windows.push({
			label: pair.label,
			used: usedFromRemaining(remaining),
			amounts: formatCounts(usableCount(pair.used), usableCount(pair.total)),
			reset,
		});
	}

	return { title: `MiniMax Token Plan (${model})`, rows: windows };
}

/**
 * The Xiaomi dashboard cookie.
 *
 * The cookie is the browser session token of the dashboard, not the API
 * key: the token-plan hosts do not expose the usage of a plan to the API
 * key, so the dashboard is the only place the usage lives.
 *
 * The environment variable wins over the file, and the file is read for
 * its first non-empty line. The value is never printed or logged.
 */
async function readMimoCookie(): Promise<string | undefined> {
	const fromEnv = process.env.MIMO_TOKEN_PLAN_COOKIE?.trim();
	if (fromEnv) return normalizeCookie(fromEnv);
	try {
		const raw = await readFile(cookiePath(), "utf8");
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (trimmed) return normalizeCookie(trimmed);
		}
	} catch {
		// No cookie file: the report says how to configure one.
	}
	return undefined;
}

/**
 * The cookie value, whether it was copied as a bare value or as a whole
 * `api-platform_serviceToken="..."` cookie pair.
 */
function normalizeCookie(value: string): string {
	const match = value.match(/api-platform_serviceToken\s*=\s*"?([^";]*)"?/);
	if (match) return match[1].trim();
	return value.replace(/^"|"$/g, "").trim();
}

/** One usage item of the Xiaomi payload: a limit and what is used of it. */
type UsageItem = {
	limit: number;
	used: number;
	/** The name of the item, when the payload carries one. */
	name?: string;
	/** The window the item covers, when the payload carries one. */
	window?: string;
};

/**
 * A number the API sends as a number or as a string.
 *
 * The Xiaomi payload is not consistent about it, so both are read.
 */
function toNumber(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

/**
 * Every item of the payload that carries a limit and a used count.
 *
 * The items may sit at the top level, inside a `monthUsage` list or
 * nested deeper, so the whole payload is walked. The name and the window
 * are picked up from the item itself and from its parent object.
 */
export function collectUsageItems(node: unknown, parent?: UsageItem, out: UsageItem[] = []): UsageItem[] {
	if (Array.isArray(node)) {
		for (const entry of node) collectUsageItems(entry, parent, out);
		return out;
	}
	if (!node || typeof node !== "object") return out;

	const record = node as Record<string, unknown>;
	const limit = toNumber(record.limit);
	const used = toNumber(record.used);
	let item = parent;
	if (limit !== undefined && used !== undefined) {
		const name =
			typeof record.name === "string"
				? record.name
				: typeof record.model_name === "string"
					? record.model_name
					: typeof record.model === "string"
						? record.model
						: parent?.name;
		const window =
			typeof record.type === "string"
				? record.type
				: typeof record.window === "string"
					? record.window
					: typeof record.window_type === "string"
						? record.window_type
						: parent?.window;
		item = { limit, used, name, window };
		out.push(item);
	}

	for (const value of Object.values(record)) {
		if (value && typeof value === "object") collectUsageItems(value, item, out);
	}
	return out;
}

/**
 * The item that describes the whole month, which is the plan's headline
 * number. A payload without such an item falls back to the first one.
 */
function pickHeadlineItem(items: UsageItem[]): UsageItem | undefined {
	const monthly = items.find((item) => item.window?.includes("month"));
	return monthly ?? items[0];
}

/** The percentage of an item that is used, when the limit allows it. */
function usedPercent(item: UsageItem): number | undefined {
	if (!Number.isFinite(item.used) || item.used < 0) return undefined;
	if (!Number.isFinite(item.limit) || item.limit <= 0) return undefined;
	const percent = (item.used / item.limit) * 100;
	if (!Number.isFinite(percent)) return undefined;
	return Math.max(0, Math.min(100, percent));
}

/**
 * An amount of the Xiaomi payload as a readable number.
 *
 * The payload counts credits in units of 1e8, so an amount that is at
 * least that large is shown in credits and a smaller one is shown as it
 * was received. The scale is decided by the allowance of the item, so the
 * used and the limit of one item are always on the same scale.
 */
export function formatCredits(value: number, useCredits: boolean): string {
	if (!useCredits) return `${formatCount(value)} units`;
	const credits = Number((value / MIMO_CREDIT_SCALE).toFixed(4));
	return `${credits} credits`;
}

/** The top-level keys of a payload, for the "unexpected shape" line. */
function topLevelKeys(body: unknown): string {
	if (!body || typeof body !== "object" || Array.isArray(body)) return "none";
	const keys = Object.keys(body as Record<string, unknown>);
	return keys.length > 0 ? keys.join(", ") : "none";
}

/**
 * The answer of a Xiaomi dashboard endpoint.
 *
 * A status of 0 marks a request that never reached the dashboard, and
 * `error` then says why.
 */
type MimoResponse = {
	status: number;
	body?: unknown;
	error?: string;
};

/**
 * A fetch of a Xiaomi dashboard endpoint.
 *
 * The status is returned instead of an exception: a rejected request and
 * an expired cookie are both a line in the report, not a failure of the
 * command.
 */
async function fetchMimo(url: string, cookie: string): Promise<MimoResponse> {
	try {
		const response = await fetch(url, {
			headers: {
				Cookie: `api-platform_serviceToken="${cookie}"`,
				accept: "application/json",
				"X-Timezone": "Asia/Shanghai",
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) return { status: response.status };
		try {
			return { status: response.status, body: await response.json() };
		} catch {
			return { status: response.status };
		}
	} catch (error) {
		const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "request failed";
		return { status: 0, error: reason };
	}
}

/**
 * The used and remaining amounts of a Xiaomi item, or undefined when there
 * is nothing worth showing. A negative or non-finite `used` is unknown, and
 * a limit that is not positive is no allowance: only the used amount shows.
 */
function mimoAmounts(item: UsageItem): string | undefined {
	if (!Number.isFinite(item.used) || item.used < 0) return undefined;
	const hasLimit = Number.isFinite(item.limit) && item.limit > 0;
	if (!hasLimit) {
		return item.used > 0 ? `${formatCredits(item.used, item.used >= MIMO_CREDIT_SCALE)} used` : undefined;
	}
	const scaled = item.limit >= MIMO_CREDIT_SCALE;
	const left = Math.max(0, item.limit - item.used);
	return `${formatCredits(item.used, scaled)} of ${formatCredits(item.limit, scaled)} used · ${formatCredits(left, scaled)} left`;
}

/** A quota row of a Xiaomi item. */
export function mimoRow(label: string, item: UsageItem): QuotaRow {
	return { label: cleanName(label) || "model", used: usedPercent(item), amounts: mimoAmounts(item) };
}

/**
 * The Xiaomi block of the report.
 *
 * Without a cookie the block explains how to configure one; with a cookie
 * it reports the usage of the plan, and the per-model breakdown when the
 * dashboard has one to add.
 */
async function fetchMimoSection(): Promise<Section> {
	const title = "Xiaomi MiMo Token Plan";
	const cookie = await readMimoCookie();
	if (!cookie) {
		return {
			title,
			rows: [],
			note: [
				`cookie not configured — sign in at ${MIMO_LOGIN_URL} and save`,
				"the api-platform_serviceToken cookie in ~/.config/mimo/token-plan-cookie",
			],
		};
	}

	const usage = await fetchMimo(MIMO_USAGE_URL, cookie);
	if (usage.status === 401) {
		return { title, rows: [], note: ["the cookie expired, refresh it from the dashboard"] };
	}
	if (usage.status !== 200) {
		return { title, rows: [], note: [`unavailable (${usage.error ?? `HTTP ${usage.status}`})`] };
	}

	const items = collectUsageItems(usage.body);
	const headline = pickHeadlineItem(items);
	if (!headline) {
		return { title, rows: [], note: [`unexpected response (keys: ${topLevelKeys(usage.body)})`] };
	}

	const rows = [mimoRow("Month total", headline)];

	// The detail endpoint is only worth a call when the usage call worked
	// and its answer was understood; it adds the per-model breakdown. An
	// item that repeats the headline adds nothing and is left out.
	const detail = await fetchMimo(MIMO_DETAIL_URL, cookie);
	if (detail.status === 200 && detail.body !== undefined) {
		const detailItems = collectUsageItems(detail.body).filter(
			(item) => item.name && !(item.limit === headline.limit && item.used === headline.used),
		);
		for (const item of detailItems.slice(0, 2)) rows.push(mimoRow(item.name as string, item));
	}

	return { title, rows };
}

/** The colours of the panel; Pi's Theme satisfies it, and so does a plain stub. */
export type PanelTheme = {
	fg(style: string, text: string): string;
	bold(text: string): string;
};

/** The colour of the filled cells: the thresholds of the context bar in footer.ts. */
function barColor(percent: number): string {
	return percent > 90 ? "error" : percent > 70 ? "warning" : "accent";
}

/**
 * The whole-number percentage used that is displayed. It is only 0 when
 * nothing is used and only 100 when the quota is exhausted, so "0% left"
 * and "0% used" never round their way into the readout.
 */
function displayUsed(percent: number): number {
	if (percent <= 0) return 0;
	if (percent >= 100) return 100;
	return Math.min(99, Math.max(1, Math.round(percent)));
}

/**
 * The fill bar: `width` cells, filled proportionally to the fraction used.
 * A small but non-zero usage still shows one filled cell and a bar is only
 * full when the quota is exhausted. An unknown fraction gives an all-empty
 * bar, never a full or a zero-filled one.
 */
function fillBar(theme: PanelTheme, percent: number | undefined, width: number): string {
	if (percent === undefined || !Number.isFinite(percent)) return theme.fg("muted", BAR_EMPTY.repeat(width));
	const shown = displayUsed(percent);
	let filled = Math.round((shown / 100) * width);
	if (shown < 100) filled = Math.min(filled, width - 1);
	if (shown > 0) filled = Math.max(filled, 1);
	let painted = "";
	if (filled > 0) painted += theme.fg(barColor(percent), BAR_FILLED.repeat(filled));
	if (filled < width) painted += theme.fg("muted", BAR_EMPTY.repeat(width - filled));
	return painted;
}

/** The "N% used · M% left" readout of a row; `?` when the percentage is unknown. */
function percentText(percent: number | undefined): string {
	if (percent === undefined || !Number.isFinite(percent)) return "? used · ? left";
	const used = displayUsed(percent);
	return `${used}% used · ${100 - used}% left`;
}

/**
 * How the body is laid out:
 * - `full`: label, bar and readout, amounts and reset on lines of their own.
 * - `compact`: for short terminals, no blank separators, one line per row
 *   (label, bar, readout, reset) and the amounts as a dim second line, kept
 *   only when they fit whole. When the reset does not fit beside a bar of at least 8 cells it moves
 *   to the second line, so it is never clipped.
 * - `tight`: like `compact` without the amounts line, and the bar may
 *   shrink to 4 cells. The amounts are the only thing ever dropped.
 */
export type BodyMode = "full" | "compact" | "tight";

/** A unit of the body that is kept or dropped as a whole when the body is clipped. */
type Block = { lines: string[]; title?: boolean };

/** Month abbreviations for the short reset form. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-08 18:00" as "Nov 08 18:00"; a time of day stays as it is. */
function shortReset(reset: string): string {
	const match = reset.match(/^\d{4}-(\d{2})-(\d{2}) (.+)$/);
	if (!match) return reset;
	return `${MONTHS[Number(match[1]) - 1] ?? match[1]} ${match[2]} ${match[3]}`;
}

/** The body as blocks; the blank before a section belongs to its title block, the blank before a row to the row. */
function bodyBlocks(report: Report, theme: PanelTheme, width: number, mode: BodyMode): Block[] {
	const full = mode === "full";
	const blocks: Block[] = [];
	const fit = (line: string) => truncateToWidth(line, width, theme.fg("dim", "…"));

	// One bar width for every row, so the bars line up.
	const rows = report.flatMap((section) => section.rows);
	const readout = Math.max(0, ...rows.map((row) => visibleWidth(percentText(row.used))));
	let barWidth = Math.max(BAR_MIN_WIDTH, Math.min(BAR_MAX_WIDTH, width - 2 - readout - 2));
	let resetInline = false;
	let labelWidth = 0;
	if (!full) {
		labelWidth = Math.max(0, ...rows.map((row) => visibleWidth(row.label)));
		const resetWidth = Math.max(0, ...rows.map((row) => (row.reset ? 3 + visibleWidth(shortReset(row.reset)) : 0)));
		const space = width - 2 - labelWidth - 2 - 2 - readout - resetWidth;
		const minBar = mode === "compact" ? 8 : BAR_MIN_WIDTH;
		resetInline = space >= minBar;
		const room = resetInline ? space : width - 2 - labelWidth - 2 - 2 - readout;
		barWidth = Math.max(BAR_MIN_WIDTH, Math.min(20, room));
	}

	report.forEach((section, index) => {
		const head: string[] = [];
		if (index > 0 && full) head.push("");
		head.push(fit(theme.bold(theme.fg("accent", section.title))));
		for (const note of section.note ?? []) head.push(fit(`  ${theme.fg("warning", note)}`));
		blocks.push({ lines: head, title: section.rows.length > 0 });
		for (const row of section.rows) {
			const lines: string[] = [];
			if (full) lines.push("");
			const empty = row.used === undefined && row.amounts === undefined && row.reset === undefined;
			if (!full) {
				const label = row.label + " ".repeat(Math.max(0, labelWidth - visibleWidth(row.label)));
				if (empty) {
					lines.push(fit(`  ${label}  ${theme.fg("dim", "no information")}`));
				} else {
					const reset = row.reset && resetInline ? theme.fg("dim", ` · ${shortReset(row.reset)}`) : "";
					lines.push(fit(`  ${label}  ${fillBar(theme, row.used, barWidth)}  ${percentText(row.used)}${reset}`));
					const second: string[] = [];
					if (row.reset && !resetInline) second.push(`resets ${shortReset(row.reset)}`);
					// The amounts are dropped when they do not fit whole beside the reset.
					const indent = 2 + labelWidth + 2;
					if (row.amounts && mode === "compact") {
						const joined = [...second, row.amounts].join(" · ");
						if (indent + visibleWidth(joined) <= width) second.push(row.amounts);
					}
					if (second.length > 0) lines.push(fit(`  ${" ".repeat(labelWidth + 2)}${theme.fg("dim", second.join(" · "))}`));
				}
			} else {
				lines.push(fit(`  ${row.label}`));
				if (empty) {
					lines.push(fit(`  ${theme.fg("dim", "no information")}`));
				} else {
					lines.push(fit(`  ${fillBar(theme, row.used, barWidth)}  ${percentText(row.used)}`));
					if (row.amounts) lines.push(fit(`  ${theme.fg("dim", row.amounts)}`));
					if (row.reset) lines.push(fit(`  ${theme.fg("dim", `Resets ${row.reset}`)}`));
				}
			}
			blocks.push({ lines });
		}
	});
	return blocks;
}

/** The body of the report as lines of at most `width` columns. */
export function renderReportBody(report: Report, theme: PanelTheme, width: number, mode: BodyMode = "full"): string[] {
	return bodyBlocks(report, theme, width, mode).flatMap((block) => block.lines);
}

/**
 * The body clipped to `room` lines. Whole blocks are kept, so a row is never
 * cut in half and a provider title never ends the body without a row under
 * it. The hidden remainder is counted in a dim `… N more lines`.
 */
export function clipReportBody(report: Report, theme: PanelTheme, width: number, room: number): string[] {
	const blocks = bodyBlocks(report, theme, width, "tight");
	const total = blocks.reduce((sum, block) => sum + block.lines.length, 0);
	if (total <= room) return blocks.flatMap((block) => block.lines);

	// Leave one line for the "more lines" marker.
	const budget = Math.max(0, room - 1);
	let used = 0;
	let kept = 0;
	for (const block of blocks) {
		if (used + block.lines.length > budget) break;
		used += block.lines.length;
		kept++;
	}
	while (kept > 0 && blocks[kept - 1].title) {
		kept--;
		used -= blocks[kept].lines.length;
	}
	const hidden = total - used;
	const lines = blocks.slice(0, kept).flatMap((block) => block.lines);
	if (room > 0) lines.push(theme.fg("dim", `… ${hidden} more line${hidden === 1 ? "" : "s"}`));
	return lines;
}

const HINT_LINE = "This session's split: /subagent-cost";

/** The report as plain text, for the modes that have no panel. */
export function reportToText(report: Report): string {
	const plain: PanelTheme = { fg: (_style, text) => text, bold: (text) => text };
	return ["Token plan usage", "", ...renderReportBody(report, plain, 64), "", HINT_LINE].join("\n");
}

/**
 * The whole report.
 *
 * The two providers are fetched in parallel and each one is settled on
 * its own, so a provider that is down or misconfigured never keeps the
 * other one from being reported.
 */
export async function buildReport(): Promise<Report> {
	const [minimaxResult, mimoResult] = await Promise.allSettled([
		readAuth().then((auth) => fetchMiniMax(auth)),
		fetchMimoSection(),
	]);
	const minimax: Section =
		minimaxResult.status === "fulfilled"
			? minimaxResult.value
			: { title: "MiniMax Token Plan", rows: [], note: ["unavailable"] };
	const mimo: Section =
		mimoResult.status === "fulfilled"
			? mimoResult.value
			: { title: "Xiaomi MiMo Token Plan", rows: [], note: ["unavailable"] };
	return [minimax, mimo];
}

/** The cached report and the moment it was fetched. */
let cached: { at: number; report: Report } | undefined;

/** The cached report when it is still fresh. */
function freshCache(): Report | undefined {
	return cached && Date.now() - cached.at < CACHE_TTL_MS ? cached.report : undefined;
}

/**
 * The report, from the cache when it is still fresh.
 *
 * `refresh` forces a new fetch; without it a second `/usage` inside the
 * same minute is answered from the cache and costs no request.
 */
export async function usageReport(refresh: boolean): Promise<Report> {
	const hit = refresh ? undefined : freshCache();
	if (hit) return hit;
	const report = await buildReport();
	cached = { at: Date.now(), report };
	return report;
}

/** What the panel needs from the TUI: a render hook and the terminal height. */
type PanelHost = { requestRender(): void; terminal?: { rows: number } };

/** The report shown when a load fails: both providers, unavailable. */
function unavailableReport(): Report {
	return [
		{ title: "MiniMax Token Plan", rows: [], note: ["unavailable"] },
		{ title: "Xiaomi MiMo Token Plan", rows: [], note: ["unavailable"] },
	];
}

/** The overlay geometry; the panel's room math and `overlayOptions` use the same values. */
const OVERLAY_WIDTH = 76;
const OVERLAY_HEIGHT_SHARE = 0.9;
const OVERLAY_MARGIN = 1;

/**
 * The overlay panel: a loading state first, the report once it settles.
 * Esc or q closes it, `r` fetches again past the cache. While a fetch is
 * running the current report stays on screen and `r` is ignored.
 */
export class UsagePanel implements Component {
	private report: Report | undefined;
	private closed = false;
	private pending = false;

	constructor(
		private readonly host: PanelHost,
		private readonly theme: PanelTheme,
		private readonly close: () => void,
		private readonly load: (refresh: boolean) => Promise<Report>,
		initial?: Report,
	) {
		this.report = initial;
		if (!initial) this.start(false);
	}

	/** Start a fetch; a result that arrives after the panel closed is dropped. */
	private start(refresh: boolean): void {
		this.pending = true;
		const settle = (report: Report) => {
			if (this.closed) return;
			this.pending = false;
			this.report = report;
			this.host.requestRender();
		};
		this.load(refresh).then(settle, () => settle(unavailableReport()));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.close();
		} else if (matchesKey(data, "r") && !this.pending) {
			this.start(true);
			this.host.requestRender();
		}
	}

	dispose(): void {
		this.closed = true;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const theme = this.theme;
		const inner = Math.max(1, width - 4);
		// The close hint lives in the header, so a clipped bottom never hides
		// it. At narrow widths the title goes first, then the refresh hint;
		// a hint is shown whole or not at all.
		const refreshing = this.pending && this.report ? "refreshing… · " : "";
		const keysFull = this.pending ? `${refreshing}Esc/q close` : "Esc/q close · r refresh";
		const headers = [
			`${theme.bold("Token plan usage")}  ${theme.fg("dim", keysFull)}`,
			theme.fg("dim", keysFull),
			theme.fg("dim", `${refreshing}Esc/q close`),
			theme.fg("dim", "Esc/q close"),
		];
		const header = headers.find((candidate) => visibleWidth(candidate) <= inner) ?? headers[headers.length - 1];
		const hint = theme.fg("dim", HINT_LINE);

		// Lines the overlay can show: Pi clamps its height to the share of the
		// terminal and to the rows left by the margins; the borders are ours.
		const rows = this.host.terminal?.rows;
		const room =
			rows === undefined
				? Infinity
				: Math.min(Math.floor(rows * OVERLAY_HEIGHT_SHARE), rows - 2 * OVERLAY_MARGIN) - 2;

		let lines: string[];
		if (!this.report) {
			lines = [header, "", theme.fg("dim", "Loading token plan usage…"), "", hint];
		} else {
			lines = [header, "", ...renderReportBody(this.report, theme, inner), "", hint];
			for (const mode of ["compact", "tight"] as const) {
				if (lines.length <= room) break;
				lines = [header, ...renderReportBody(this.report, theme, inner, mode), hint];
			}
			if (lines.length > room) {
				lines = [header, ...clipReportBody(this.report, theme, inner, Math.max(0, room - 2)), hint];
			}
		}

		const border = (text: string) => theme.fg("borderMuted", text);
		const top = border(`╭${"─".repeat(Math.max(0, width - 2))}╮`);
		const bottom = border(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
		const framed = lines.map((line) => {
			const fitted = truncateToWidth(line, inner, "…", true);
			return `${border("│")} ${fitted} ${border("│")}`;
		});
		return [top, ...framed, bottom];
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Show the token plan quota of MiniMax and Xiaomi MiMo",
		handler: async (args, ctx) => {
			const refresh = args.trim().toLowerCase() === "refresh";

			if (ctx.mode !== "tui") {
				// No panel without a TUI: a custom message, not a user message,
				// so the report reaches print and RPC modes and no model turn
				// is started.
				const text = reportToText(await usageReport(refresh));
				pi.sendMessage({ customType: REPORT_TYPE, content: text, display: true, details: { viewOnly: true } });
				return;
			}

			const initial = refresh ? undefined : freshCache();
			let first = refresh;
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new UsagePanel(
						tui,
						theme,
						() => done(),
						(force) => {
							// `/usage refresh` bypasses the cache on the first load too.
							const bypass = force || first;
							first = false;
							return usageReport(bypass);
						},
						initial,
					),
				{ overlay: true, overlayOptions: {
						width: OVERLAY_WIDTH,
						minWidth: 36,
						maxHeight: `${OVERLAY_HEIGHT_SHARE * 100}%`,
						anchor: "center",
						margin: OVERLAY_MARGIN,
					} },
			);
		},
	});
}

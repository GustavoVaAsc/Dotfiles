/**
 * usage.ts
 *
 * Adds the `/usage` command: a compact report of the token-plan quota of
 * the two subscription providers this machine is set up for.
 *
 * - MiniMax Token Plan: the 5-hour rolling window and the weekly window,
 *   with the remaining percentage and the reset time, read from the
 *   `token_plan/remains` endpoint with the provider API key.
 * - Xiaomi MiMo Token Plan: the plan's usage and allowance, read from the
 *   Xiaomi dashboard API with the browser session cookie.
 *
 * The report is a custom message, not a user message, so it never starts a
 * model turn: the numbers are rendered into the transcript and the session
 * stays idle.
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

/** The custom message type the report is delivered as. */
const REPORT_TYPE = "usage-report";

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

/** A percentage as a whole number, or undefined when there is none. */
function formatPercent(value: number | undefined): string | undefined {
	if (value === undefined) return undefined;
	return `${Math.round(value)}%`;
}

/** A count as a plain integer. */
function formatCount(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

/**
 * The "used of total" part of a MiniMax line.
 *
 * The counts are only shown when they are non-zero: with this account the
 * endpoint answers with zero counts and meaningful percentages, and a
 * "0 used" line would state as fact something the API does not know.
 */
function formatCounts(used: number | undefined, total: number | undefined): string {
	if (used !== undefined && total !== undefined) return ` · ${formatCount(used)}/${formatCount(total)} used`;
	if (total !== undefined) return ` · limit ${formatCount(total)}`;
	if (used !== undefined) return ` · ${formatCount(used)} used`;
	return "";
}

/**
 * The MiniMax block of the report.
 *
 * The `general` row is the plan of the account; a response without it
 * falls back to the first row, which is the only one there is.
 */
async function renderMiniMax(auth: AuthFile): Promise<string[]> {
	const key = apiKey(auth, "minimax");
	if (!key) {
		return ["MiniMax Token Plan", "  no API key for minimax in ~/.pi/agent/auth.json"];
	}

	let response: Response;
	try {
		response = await fetch(MINIMAX_REMAINS_URL, {
			headers: { Authorization: `Bearer ${key}`, accept: "application/json" },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "request failed";
		return ["MiniMax Token Plan", `  unavailable (${reason})`];
	}

	if (!response.ok) {
		return ["MiniMax Token Plan", `  unavailable (HTTP ${response.status})`];
	}

	let body: MinimaxResponse;
	try {
		body = (await response.json()) as MinimaxResponse;
	} catch {
		return ["MiniMax Token Plan", "  unavailable (unreadable response)"];
	}

	const rows = Array.isArray(body?.model_remains) ? body.model_remains : [];
	if (rows.length === 0) return ["MiniMax Token Plan", "  no plan information in the response"];

	const row = rows.find((entry) => entry?.model_name === "general") ?? rows[0];
	const model = typeof row.model_name === "string" && row.model_name ? row.model_name : "general";

	const lines = [`MiniMax Token Plan (${model})`];

	const interval = formatPercent(usablePercent(row.current_interval_remaining_percent));
	const intervalReset = formatReset(row.end_time);
	if (interval === undefined && intervalReset === undefined) {
		lines.push("  5h window   no information");
	} else {
		lines.push(
			`  5h window   ${interval ?? "?"} remaining${intervalReset ? ` · resets ${intervalReset}` : ""}` +
				formatCounts(
					usableCount(row.current_interval_usage_count),
					usableCount(row.current_interval_total_count),
				),
		);
	}

	const weekly = formatPercent(usablePercent(row.current_weekly_remaining_percent));
	const weeklyReset = formatReset(row.weekly_end_time);
	if (weekly === undefined && weeklyReset === undefined) {
		lines.push("  weekly      no information");
	} else {
		lines.push(
			`  weekly      ${weekly ?? "?"} remaining${weeklyReset ? ` · resets ${weeklyReset}` : ""}` +
				formatCounts(
					usableCount(row.current_weekly_usage_count),
					usableCount(row.current_weekly_total_count),
				),
		);
	}

	return lines;
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
 * The Xiaomi block of the report.
 *
 * Without a cookie the block explains how to configure one; with a cookie
 * it reports the usage of the plan, and the per-model breakdown when the
 * dashboard has one to add.
 */
async function renderMimo(): Promise<string[]> {
	const lines = ["Xiaomi MiMo Token Plan"];
	const cookie = await readMimoCookie();
	if (!cookie) {
		lines.push(
			`  cookie not configured — sign in at ${MIMO_LOGIN_URL} and save`,
			"  the api-platform_serviceToken cookie in ~/.config/mimo/token-plan-cookie",
		);
		return lines;
	}

	const usage = await fetchMimo(MIMO_USAGE_URL, cookie);
	if (usage.status === 401) {
		lines.push("  the cookie expired, refresh it from the dashboard");
		return lines;
	}
	if (usage.status !== 200) {
		const reason = usage.error ?? `HTTP ${usage.status}`;
		lines.push(`  unavailable (${reason})`);
		return lines;
	}

	const items = collectUsageItems(usage.body);
	const headline = pickHeadlineItem(items);
	if (!headline) {
		lines.push(`  unexpected response (keys: ${topLevelKeys(usage.body)})`);
		return lines;
	}

	const percent = usedPercent(headline);
	const scaled = headline.limit >= MIMO_CREDIT_SCALE;
	lines.push(
		`  month total   ${percent === undefined ? "?" : `${Math.round(percent)}% used`} · ` +
			`${formatCredits(headline.used, scaled)} of ${formatCredits(headline.limit, scaled)}`,
	);

	// The detail endpoint is only worth a call when the usage call worked
	// and its answer was understood; it adds the per-model breakdown. An
	// item that repeats the headline adds nothing and is left out.
	const detail = await fetchMimo(MIMO_DETAIL_URL, cookie);
	if (detail.status === 200 && detail.body !== undefined) {
		const detailItems = collectUsageItems(detail.body).filter(
			(item) => item.name && !(item.limit === headline.limit && item.used === headline.used),
		);
		for (const item of detailItems.slice(0, 2)) {
			const itemPercent = usedPercent(item);
			const itemScaled = item.limit >= MIMO_CREDIT_SCALE;
			lines.push(
				`  ${item.name}   ${itemPercent === undefined ? "?" : `${Math.round(itemPercent)}% used`} · ` +
					`${formatCredits(item.used, itemScaled)} of ${formatCredits(item.limit, itemScaled)}`,
			);
		}
	}

	return lines;
}

/**
 * The whole report.
 *
 * The two providers are fetched in parallel and each one is settled on
 * its own, so a provider that is down or misconfigured never keeps the
 * other one from being reported.
 */
export async function buildUsageReport(): Promise<string> {
	// The two providers are fetched in parallel and each one settles on its
	// own: a provider that is down or misconfigured never keeps the other
	// one from being reported.
	const [minimaxResult, mimoResult] = await Promise.allSettled([
		readAuth().then((auth) => renderMiniMax(auth)),
		renderMimo(),
	]);
	const minimax = minimaxResult.status === "fulfilled" ? minimaxResult.value : ["MiniMax Token Plan", "  unavailable"];
	const mimo = mimoResult.status === "fulfilled" ? mimoResult.value : ["Xiaomi MiMo Token Plan", "  unavailable"];
	const lines = ["Token plan usage", "", ...minimax, "", ...mimo, "", "This session's split: /subagent-cost"];
	return lines.join("\n");
}

/** The cached report and the moment it was fetched. */
let cached: { at: number; text: string } | undefined;

/**
 * The report, from the cache when it is still fresh.
 *
 * `refresh` forces a new fetch; without it a second `/usage` inside the
 * same minute is answered from the cache and costs no request.
 */
export async function usageReport(refresh: boolean): Promise<string> {
	if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.text;
	const text = await buildUsageReport();
	cached = { at: Date.now(), text };
	return text;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Show the token plan quota of MiniMax and Xiaomi MiMo",
		handler: async (args, ctx) => {
			const refresh = args.trim().toLowerCase() === "refresh";
			const text = await usageReport(refresh);
			// A custom message, not a user message: the report lands in the
			// transcript and no model turn is started.
			pi.sendMessage({ customType: REPORT_TYPE, content: text, display: true, details: { viewOnly: true } });
		},
	});
}

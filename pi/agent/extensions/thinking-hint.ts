/**
 * thinking-hint.ts
 *
 * With `hideThinkingBlock: true` Pi collapses reasoning into a one-line label
 * ("Thinking..." by default). While the model reasons, this extension turns that
 * label into a live hint: `Thinking · 12s · <tail of the latest reasoning line>`.
 *
 * Pi's label is global: it is applied to every assistant message in the chat, not
 * only the one streaming. So nothing per-message may outlive the thinking run.
 * When the run ends (thinking_end, message_end, agent_end, shutdown) the label is
 * restored to Pi's default with `setHiddenThinkingLabel()`. A static "Thought for
 * 12s" was rejected: it would be stamped on every old message with the wrong time.
 * While a run is live, older collapsed blocks in the chat show the live hint too;
 * that is inherent to the global label and disappears when the run ends.
 *
 * Updates are throttled: a single 250 ms ticker refreshes the label only when its
 * text changed, so token deltas never trigger a re-render themselves.
 *
 * Model text is untrusted: ANSI/OSC escapes, control characters and newlines are
 * stripped before it reaches the terminal. No-op without an interactive TUI.
 *
 * Auto-loaded by Pi from ~/.pi/agent/extensions/thinking-hint.ts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TICK_MS = 250;
export const TAIL_CHARS = 60;
// Only the end of the reasoning is ever shown; cap what we keep.
const BUFFER_CHARS = 2000;

// OSC (BEL or ST terminated), CSI, DCS/SOS/PM/APC strings, then any other ESC pair.
const ANSI =
	/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[P^_X][^\x1b]*(?:\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]?|\x1b[\s\S]?|[\x90\x98\x9e\x9f][^\x9c]*\x9c?|\x9b[0-?]*[ -/]*[@-~]?|\x9d[^\x07\x9c]*[\x07\x9c]?/g;
// Also the bidi and invisible format characters that can reorder or hide text in a terminal label.
const CONTROL = new RegExp("[\\x00-\\x1f\\x7f-\\x9f\\u2028\\u2029\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]", "g");

/** Strip escape sequences and control characters; collapse whitespace to single spaces. */
export function sanitize(text: string): string {
	return text.replace(ANSI, "").replace(CONTROL, " ").replace(/ {2,}/g, " ").trim();
}

/** Last non-empty (after sanitizing) line of the reasoning text. */
export function lastLine(text: string): string {
	const lines = text.split(/\r\n|\r|\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const clean = sanitize(lines[i]);
		if (clean) return clean;
	}
	return "";
}

/** Keep the last `max` characters, prefixing an ellipsis when truncated. */
export function tail(text: string, max = TAIL_CHARS): string {
	const chars = Array.from(text);
	if (chars.length <= max) return text;
	return `…${chars.slice(chars.length - (max - 1)).join("").trimStart()}`;
}

export function formatLabel(elapsedMs: number, reasoning: string): string {
	const secs = Math.max(0, Math.floor(elapsedMs / 1000));
	const hint = tail(lastLine(reasoning));
	return hint ? `Thinking · ${secs}s · ${hint}` : `Thinking · ${secs}s`;
}

export default function (pi: ExtensionAPI) {
	let ticker: ReturnType<typeof setInterval> | undefined;
	let startedAt = 0;
	let buffer = "";
	let shown: string | undefined;
	let ui: { setHiddenThinkingLabel(label?: string): void } | undefined;

	const stop = () => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		buffer = "";
		if (shown !== undefined) ui?.setHiddenThinkingLabel();
		shown = undefined;
	};

	const refresh = () => {
		const label = formatLabel(Date.now() - startedAt, buffer);
		if (label === shown) return;
		shown = label;
		ui?.setHiddenThinkingLabel(label);
	};

	const start = () => {
		stop();
		startedAt = Date.now();
		refresh();
		ticker = setInterval(refresh, TICK_MS);
		ticker.unref?.();
	};

	pi.on("message_update", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		const e = event.assistantMessageEvent;
		if (e.type === "thinking_start") {
			ui = ctx.ui;
			start();
		} else if (e.type === "thinking_delta" && ticker) {
			buffer = (buffer + e.delta).slice(-BUFFER_CHARS);
		} else if (e.type === "thinking_end") {
			stop();
		}
	});

	pi.on("message_end", async () => stop());
	pi.on("agent_end", async () => stop());
	pi.on("session_shutdown", async () => stop());
}

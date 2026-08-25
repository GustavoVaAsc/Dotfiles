/**
 * agent-name-hint.ts
 *
 * Shows the active persona (derived from the first heading of the system prompt)
 * together with the active model in the TUI footer, and updates the terminal tab
 * title to match.
 *
 * Auto-loaded by Pi from ~/.pi/agent/extensions/agent-name-hint.ts.
 *
 * Heuristic for the persona label:
 *   1. Skip YAML frontmatter.
 *   2. Take the first markdown `# ` or `## ` heading.
 *   3. If none exists, take the first non-empty sentence (≤ 48 chars).
 *   4. Otherwise fall back to "Pi Coding Agent".
 *
 * For a stable label, give your SYSTEM.md / APPEND_SYSTEM.md a first heading like:
 *   `# kosmos.orchestrator — lead mode`
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "agent-name";
const FALLBACK_PERSONA = "Pi Coding Agent";

function derivePersona(prompt: string): string {
	let inFrontmatter = false;
	let sawHeading = false;
	let firstSentence: string | undefined;

	for (const raw of prompt.split("\n")) {
		const line = raw.trim();
		if (line === "---") {
			inFrontmatter = !inFrontmatter;
			continue;
		}
		if (inFrontmatter) continue;
		if (!line) continue;

		const heading = /^(#{1,2})\s+(.+?)\s*$/.exec(line);
		if (heading) {
			sawHeading = true;
			const cleaned = heading[2].replace(/[`*_]/g, "").trim();
			if (cleaned) return cleaned.slice(0, 48);
		}

		if (!firstSentence) {
			const candidate = line.split(/[.!\n]/)[0]?.trim();
			if (candidate && candidate.length >= 6) firstSentence = candidate;
		}

		// If we already saw one heading and the first sentence, we can stop.
		if (sawHeading && firstSentence) break;
	}

	if (firstSentence) return firstSentence.slice(0, 48);
	return FALLBACK_PERSONA;
}

function tint(theme: { fg?: (style: string, text: string) => string } | undefined, style: string, text: string): string {
	if (theme?.fg) {
		try {
			return theme.fg(style, text);
		} catch {
			// Theme may reject unknown style names; fall back to plain text.
		}
	}
	return text;
}

export default function (pi: ExtensionAPI) {
	const apply = (prompt: string, modelId: string | undefined, ui: any) => {
		const persona = derivePersona(prompt);
		const theme = ui.theme;
		const dot = tint(theme, "accent", "●");
		const sep = tint(theme, "dim", " · ");
		const modelText = modelId ? `${sep}${modelId}` : "";
		ui.setStatus(STATUS_KEY, `${dot} ${persona}${modelText}`);
		ui.setTitle(`pi · ${persona}${modelId ? ` (${modelId})` : ""}`);
	};

	pi.on("session_start", async (_event, ctx) => {
		apply(ctx.getSystemPrompt(), undefined, ctx.ui);
	});

	pi.on("agent_start", async (_event, ctx) => {
		apply(ctx.getSystemPrompt(), undefined, ctx.ui);
	});

	pi.on("model_select", async (event, ctx) => {
		apply(ctx.getSystemPrompt(), event.model.id, ctx.ui);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setTitle(undefined);
	});
}

/**
 * preset.ts
 *
 * Adds the `/preset` command: switch the model and thinking level of the main
 * session and of every subagent with one name.
 *
 *   /preset                 list the presets and show the active one
 *   /preset <name>          apply it (Tab completes names)
 *   /preset save <name>     save the current state as a preset
 *   /preset new <name>      build a preset with pickers (model and thinking for main, then each agent)
 *   /preset delete <name>   delete a preset (asks first; the active preset is refused)
 *
 * A preset is a JSON file in ~/.pi/agent/presets/<name>.json (synced from
 * pi/agent/presets/ by bin/install-kosmos-pi.sh):
 *
 *   {
 *     "description": "optional, one line",
 *     "main":   { "model": "provider/id", "thinking": "medium" },
 *     "agents": { "kosmos.coder": { "model": "provider/id", "thinking": "low" } }
 *   }
 *
 * Applying a preset:
 *   - sets the main session model and thinking level at once (Pi's extension
 *     `setModel` / `setThinkingLevel` change the session only, so this
 *     extension persists them itself);
 *   - writes `defaultProvider`, `defaultModel`, `defaultThinkingLevel` and
 *     `kosmosActivePreset` to ~/.pi/agent/settings.json, so new sessions start
 *     on the preset;
 *   - MERGES `model` and `thinking` into `subagents.agentOverrides.<agent>`.
 *     Every other field and every other entry is kept, notably the
 *     `{"disabled": true}` entries that block unguarded builtin agents. This is
 *     why pi-subagents' own `/subagents-load-profile` is not used: it replaces
 *     `agentOverrides` wholesale.
 *
 * Agent keys are pi-subagents runtime names (`<package>.<name>`, e.g.
 * `kosmos.coder`). pi-subagents re-reads settings.json when the file changes,
 * so the next subagent launch uses the new models; a subagent already running
 * is not affected. A project `.pi/settings.json` override still wins over the
 * user settings this command writes.
 *
 * All-or-nothing: the name is checked against a strict charset before any path
 * is built, the preset shape is validated, every model must be in Pi's model
 * registry, and the settings merge is computed first. On any failure neither
 * the session nor settings.json is changed. The settings write holds both lock
 * protocols that other writers use (Pi's `settings.json.lock`, pi-subagents'
 * `settings.json.write-lock`) and is an atomic temp-file rename.
 *
 * Creating and deleting presets (save, new, delete are reserved words, never preset names):
 *   - `save` snapshots the session's model and thinking level, and for each agent of kosmos-pi/agents/*.md the
 *     `subagents.agentOverrides` model/thinking if set, else the agent's frontmatter (thinking: else
 *     `subagents.defaultThinking`). The agent list comes from that frontmatter, found through the absolute
 *     `file:<repo>/kosmos-pi` entry of settings `packages` (else Pi's installed copy under npm/node_modules):
 *     it is the only source that names every agent and also holds the fallback values, whereas the keys of an
 *     existing preset can be stale or incomplete. An agent whose model or thinking cannot be determined is an
 *     error, so a saved preset is always complete.
 *   - `new` asks for the same values with selectors (only models with credentials; the current value first).
 *   - A preset is written to BOTH `<repo>/pi/agent/presets/` (the repo the `file:` entry points into; it survives
 *     installs, which rsync --delete the other store, and is versioned) and `~/.pi/agent/presets/` (works now).
 *     The repo store is used only when it is a real directory of a repo that looks like the Dotfiles one; else
 *     only the local copy is written and the next install-kosmos-pi.sh run deletes it, which the notice says.
 *     Files are staged as temp files and renamed; a symlink at a target is never followed or replaced.
 *   - Existing presets are only overwritten or deleted after a confirmation; any cancelled prompt writes nothing.
 *   Afterwards the preset can be applied at once.
 *
 * Agent keys must match the runtime names of the agents in kosmos-pi/agents/*.md. A key that matches no
 * agent is silently ignored by pi-subagents, so test/preset.test.js ("the checked-in presets ...") checks
 * that each shipped preset names exactly those agents; it is the guard when an agent is added or renamed.
 *
 * A preset covers the agents it names. Switching to a preset that omits an
 * agent leaves that agent's previous override in place, so presets should list
 * every agent they are meant to control.
 *
 * Auto-loaded by Pi from ~/.pi/agent/extensions/preset.ts.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** pi-subagents runtime names: `<package>.<name>` or a bare builtin name. */
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MODEL_ID_RE = /^[^\s\x00-\x1f\x7f-\x9f]+$/;
const CONTROL_RE = new RegExp("[\\x00-\\x1f\\x7f-\\x9f\\u2028\\u2029]");

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const MAX_PRESET_BYTES = 64 * 1024;
const MAX_DESCRIPTION = 200;
/** How long to wait for another process that holds a settings lock. */
const LOCK_WAIT_MS = 2000;
/** proper-lockfile's default: a lock directory untouched for this long is stale. */
const LOCK_STALE_MS = 10_000;

export const ACTIVE_KEY = "kosmosActivePreset";

export interface AgentSetting {
	model?: string;
	thinking?: ThinkingLevel;
}
export interface Preset {
	description?: string;
	main: { model: string; thinking: ThinkingLevel };
	agents: Record<string, AgentSetting>;
}
type Json = Record<string, unknown>;

/** A failure with a message meant for the user. */
export class PresetError extends Error {}
/** A failure after the session was already changed and could not be put back. */
export class PartialApplyError extends PresetError {}

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinking(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Why a preset description is not acceptable, or undefined. One rule for validatePreset and the prompt. */
function descriptionProblem(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > MAX_DESCRIPTION || CONTROL_RE.test(value)) {
		return `description must be one line of at most ${MAX_DESCRIPTION} characters, without control characters`;
	}
	return undefined;
}

/** The `subagents.maxThinking` of the settings, when it is a valid level. pi-subagents refuses to launch a child above it. */
function thinkingCeiling(settings: Json): ThinkingLevel | undefined {
	const ceiling = isObject(settings.subagents) ? settings.subagents.maxThinking : undefined;
	return isThinking(ceiling) ? ceiling : undefined;
}

/** The levels an agent may use under the ceiling (all of them without one). */
function levelsUpTo(ceiling: ThinkingLevel | undefined): ThinkingLevel[] {
	return THINKING_LEVELS.filter((level) => ceiling === undefined || THINKING_LEVELS.indexOf(level) <= THINKING_LEVELS.indexOf(ceiling));
}

/** The one check that an agent's thinking level fits the ceiling; used when applying, saving and picking. */
function thinkingCeilingProblem(agent: string, level: ThinkingLevel, ceiling: ThinkingLevel | undefined): string | undefined {
	if (levelsUpTo(ceiling).includes(level)) return undefined;
	return `${agent}: thinking ${level} is above subagents.maxThinking (${ceiling}); pi-subagents would refuse to launch it`;
}

/** A name for messages: quoted and escaped, so control characters cannot reach the terminal. */
function show(value: unknown): string {
	return JSON.stringify(String(value).slice(0, 80));
}

/** Words after `/preset` that are subcommands; they cannot name a preset, so `/preset <word>` is never ambiguous. */
export const RESERVED_NAMES = ["save", "new", "delete"] as const;

/** Why a string cannot be a preset name, or undefined when it can. */
function nameProblem(name: unknown): string | undefined {
	if (typeof name !== "string" || !NAME_RE.test(name)) {
		return `invalid preset name ${show(name)}: use lowercase letters, digits, "-" and "_" (at most 64)`;
	}
	if ((RESERVED_NAMES as readonly string[]).includes(name)) {
		return `${show(name)} is reserved for a /preset subcommand (${RESERVED_NAMES.join(", ")}); pick another name`;
	}
	return undefined;
}

export function isValidPresetName(name: unknown): name is string {
	return nameProblem(name) === undefined;
}

export function parseModelRef(ref: unknown): { provider: string; id: string } {
	const text = typeof ref === "string" ? ref : "";
	const slash = text.indexOf("/");
	const provider = text.slice(0, slash);
	const id = text.slice(slash + 1);
	if (slash < 1 || !PROVIDER_RE.test(provider) || !MODEL_ID_RE.test(id)) {
		throw new PresetError(`invalid model ${show(ref)}: expected "provider/model-id"`);
	}
	return { provider, id };
}

function checkKeys(label: string, value: Json, allowed: string[]): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new PresetError(`${label}: unknown field ${show(key)}`);
	}
}

function checkThinking(label: string, value: unknown): ThinkingLevel {
	if (!isThinking(value)) throw new PresetError(`${label}: thinking must be one of ${THINKING_LEVELS.join(", ")}`);
	return value;
}

/** Validate the parsed JSON of a preset file and return a clean copy. Throws PresetError. */
export function validatePreset(raw: unknown): Preset {
	if (!isObject(raw)) throw new PresetError("a preset must be a JSON object");
	checkKeys("preset", raw, ["description", "main", "agents"]);

	const preset: Preset = { main: { model: "", thinking: "medium" }, agents: {} };
	if (raw.description !== undefined) {
		const d = raw.description;
		const problem = descriptionProblem(d);
		if (problem) throw new PresetError(`preset: ${problem}`);
		preset.description = d;
	}

	const main = raw.main;
	if (!isObject(main)) throw new PresetError('preset: "main" must be an object with model and thinking');
	checkKeys("main", main, ["model", "thinking"]);
	if (typeof main.model !== "string") throw new PresetError("main: model is required");
	parseModelRef(main.model);
	preset.main = { model: main.model, thinking: checkThinking("main", main.thinking) };

	if (raw.agents !== undefined) {
		if (!isObject(raw.agents)) throw new PresetError('preset: "agents" must be an object keyed by agent name');
		for (const [name, entry] of Object.entries(raw.agents)) {
			if (!AGENT_RE.test(name)) throw new PresetError(`agents: invalid agent name ${show(name)}`);
			if (!isObject(entry)) throw new PresetError(`agents.${name}: must be an object`);
			checkKeys(`agents.${name}`, entry, ["model", "thinking"]);
			if (entry.model === undefined && entry.thinking === undefined) {
				throw new PresetError(`agents.${name}: set model, thinking or both`);
			}
			const setting: AgentSetting = {};
			if (entry.model !== undefined) {
				parseModelRef(entry.model);
				setting.model = entry.model as string;
			}
			if (entry.thinking !== undefined) setting.thinking = checkThinking(`agents.${name}`, entry.thinking);
			preset.agents[name] = setting;
		}
	}
	return preset;
}

/**
 * Look every model of the preset up with `find` (Pi's model registry) and return the main one.
 * Every unknown model is named in one error, so a partly-valid preset is never half applied.
 */
export function resolveModels<M>(preset: Preset, find: (provider: string, id: string) => M | undefined): M {
	const missing: string[] = [];
	const lookup = (ref: string, where: string): M | undefined => {
		const { provider, id } = parseModelRef(ref);
		const model = find(provider, id);
		if (model === undefined) missing.push(`${ref} (${where})`);
		return model;
	};
	const main = lookup(preset.main.model, "main");
	for (const [agent, setting] of Object.entries(preset.agents)) {
		if (setting.model !== undefined) lookup(setting.model, agent);
	}
	if (missing.length > 0 || main === undefined) throw new PresetError(`not in Pi's model registry: ${missing.join(", ")}`);
	return main;
}

/** Builtin agents without a guard; `{"disabled": true}` entries keep them off and must stay in force. */
const BLOCKED_BUILTINS = ["researcher", "evidence-auditor"];

/**
 * pi-subagents layers `agentOverridesByProvider.<provider>.<agent>` over `agentOverrides.<agent>`, so a
 * provider entry that sets `disabled` to anything but true would switch a blocked builtin back on.
 * Applying a preset on top of that would hide a security problem, so refuse and let the user fix it.
 */
function refuseReenabledBuiltins(settings: Json): void {
	const subagents = settings.subagents;
	const byProvider = isObject(subagents) ? subagents.agentOverridesByProvider : undefined;
	if (!isObject(byProvider)) return;
	for (const [provider, agents] of Object.entries(byProvider)) {
		if (!isObject(agents)) continue;
		for (const builtin of BLOCKED_BUILTINS) {
			const entry = Object.prototype.hasOwnProperty.call(agents, builtin) ? agents[builtin] : undefined;
			if (isObject(entry) && Object.prototype.hasOwnProperty.call(entry, "disabled") && entry.disabled !== true) {
				throw new PresetError(`settings: subagents.agentOverridesByProvider.${provider}.${builtin}.disabled is not true, which would enable the blocked builtin agent ${builtin}; fix it first`);
			}
		}
	}
}

/**
 * The settings object with the preset applied. Pure: the input is not changed.
 * Only `model` and `thinking` are merged into each agent's override.
 */
export function applyPresetToSettings(settings: Json, name: string, preset: Preset): Json {
	const next = structuredClone(settings);
	const { provider, id } = parseModelRef(preset.main.model);
	next.defaultProvider = provider;
	next.defaultModel = id;
	next.defaultThinkingLevel = preset.main.thinking;
	next[ACTIVE_KEY] = name;
	refuseReenabledBuiltins(next);

	const names = Object.keys(preset.agents);
	if (names.length === 0) return next;
	if (next.subagents !== undefined && !isObject(next.subagents)) throw new PresetError("settings: subagents must be an object");
	const subagents: Json = isObject(next.subagents) ? next.subagents : {};
	if (subagents.agentOverrides !== undefined && !isObject(subagents.agentOverrides)) {
		throw new PresetError("settings: subagents.agentOverrides must be an object");
	}
	const overrides: Json = isObject(subagents.agentOverrides) ? subagents.agentOverrides : {};
	const ceiling = thinkingCeiling(next);

	for (const agent of names) {
		const setting = preset.agents[agent];
		const existing = Object.prototype.hasOwnProperty.call(overrides, agent) ? overrides[agent] : undefined;
		if (existing !== undefined && !isObject(existing)) {
			throw new PresetError(`settings: subagents.agentOverrides.${agent} must be an object`);
		}
		const tooHigh = setting.thinking === undefined ? undefined : thinkingCeilingProblem(agent, setting.thinking, ceiling);
		if (tooHigh) throw new PresetError(tooHigh);
		overrides[agent] = { ...(existing ?? {}), ...setting };
	}
	subagents.agentOverrides = overrides;
	next.subagents = subagents;
	return next;
}

/** The lines of the confirmation shown after a preset is applied. */
export function presetSummary(name: string, preset: Preset): string[] {
	const lines = [`Preset ${name} applied`, `  main: ${preset.main.model} (${preset.main.thinking})`];
	for (const [agent, setting] of Object.entries(preset.agents)) {
		lines.push(`  ${agent}: ${setting.model ?? "model unchanged"} (${setting.thinking ?? "thinking unchanged"})`);
	}
	return lines;
}

/** Pi's agent directory: PI_CODING_AGENT_DIR when set, else ~/.pi/agent. */
export function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return env === "~" ? os.homedir() : env.startsWith("~/") ? path.join(os.homedir(), env.slice(2)) : env;
	return path.join(os.homedir(), ".pi", "agent");
}

/** "line L column C" (or "position N") of a JSON.parse failure. The message also quotes the source text, which is never shown. */
function jsonPosition(error: unknown): string {
	const m = /position (\d+)(?: \(line (\d+) column (\d+)\))?\s*$/.exec(error instanceof Error ? error.message : "");
	if (!m) return "unknown position";
	return m[2] ? `line ${m[2]} column ${m[3]}` : `position ${m[1]}`;
}

/**
 * Read a small regular file as text. It is opened without following a symlink or blocking on a FIFO, checked
 * on the open descriptor and read with a hard size bound. A missing file throws the raw ENOENT error.
 */
function readRegularFile(file: string, label: string, maxBytes: number): string {
	let fd: number;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
	} catch (error) {
		if (isErrno(error, "ENOENT")) throw error;
		if (isErrno(error, "ELOOP")) throw new PresetError(`${label} is not a regular file (symbolic links are refused)`);
		throw new PresetError(`cannot read ${label}: ${(error as Error).message}`);
	}
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) throw new PresetError(`${label} is not a regular file`);
		const tooLarge = new PresetError(`${label} is too large (over ${maxBytes} bytes)`);
		if (stat.size > maxBytes) throw tooLarge;
		// One byte more than the limit: a file that grew after the fstat is still caught.
		const buffer = Buffer.alloc(maxBytes + 1);
		let length = 0;
		while (length < buffer.length) {
			const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
			if (read === 0) break;
			length += read;
		}
		if (length > maxBytes) throw tooLarge;
		return buffer.toString("utf8", 0, length);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Read and validate one preset. The name is checked before any path is built; the file is opened without
 * following a symlink or blocking on a FIFO, checked on the open descriptor and read with a hard size bound.
 */
export function loadPreset(dir: string, name: string): Preset {
	const problem = nameProblem(name);
	if (problem) throw new PresetError(problem);
	const file = path.join(dir, `${name}.json`);
	let text: string;
	try {
		text = readRegularFile(file, `preset ${name}`, MAX_PRESET_BYTES);
	} catch (error) {
		if (!isErrno(error, "ENOENT")) throw error;
		const known = listPresets(dir).map((p) => p.name);
		throw new PresetError(`unknown preset ${show(name)}${known.length > 0 ? `; available: ${known.join(", ")}` : ""}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new PresetError(`preset ${name} (${file}) is not valid JSON at ${jsonPosition(error)}`);
	}
	try {
		return validatePreset(parsed);
	} catch (error) {
		throw new PresetError(`preset ${name}: ${(error as Error).message}`);
	}
}

export interface PresetListing {
	name: string;
	description?: string;
	error?: string;
}

/** Every `<name>.json` regular file of the dir with a safe name, sorted; invalid ones carry their error. */
export function listPresets(dir: string): PresetListing[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const listing: PresetListing[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const name = entry.name.slice(0, -".json".length);
		if (!isValidPresetName(name)) continue;
		try {
			listing.push({ name, description: loadPreset(dir, name).description });
		} catch (error) {
			listing.push({ name, error: (error as Error).message });
		}
	}
	return listing.sort((a, b) => a.name.localeCompare(b.name));
}

// --- preset files: serialising, the agents, the stores ---------------------------------------------

/** The preset as the JSON text of a preset file: the shipped format (2 spaces, fixed key order, final newline). */
export function presetToJson(preset: Preset): string {
	const out: Json = {};
	if (preset.description !== undefined) out.description = preset.description;
	out.main = { model: preset.main.model, thinking: preset.main.thinking };
	const names = Object.keys(preset.agents);
	if (names.length > 0) {
		const agents: Record<string, AgentSetting> = {};
		for (const agent of names) {
			const setting = preset.agents[agent];
			agents[agent] = {
				...(setting.model !== undefined ? { model: setting.model } : {}),
				...(setting.thinking !== undefined ? { thinking: setting.thinking } : {}),
			};
		}
		out.agents = agents;
	}
	return `${JSON.stringify(out, null, 2)}\n`;
}

export interface AgentInfo {
	/** pi-subagents runtime name, `<package>.<name>`. */
	name: string;
	/** `model` and `thinking` of the agent's frontmatter, as written. */
	model?: string;
	thinking?: string;
}

const MAX_AGENT_FILE_BYTES = 256 * 1024;

/** The `name`, `package`, `model` and `thinking` keys of a Markdown file's YAML frontmatter (top-level `key: value` lines only). */
export function parseAgentFrontmatter(text: string): { name?: string; package?: string; model?: string; thinking?: string } {
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return {};
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end < 0) return {};
	const found: Record<string, string> = {};
	for (const line of lines.slice(1, end)) {
		const match = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
		if (!match || !["name", "package", "model", "thinking"].includes(match[1])) continue;
		const value = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
		if (value) found[match[1]] = value;
	}
	return found;
}

/** The agents of the kosmos-pi package (`*.md` in its agents dir), by runtime name. A file without a `name` is not an agent. */
export function readKosmosAgents(agentsDir: string): AgentInfo[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(agentsDir, { withFileTypes: true });
	} catch (error) {
		throw new PresetError(`cannot read the kosmos-pi agents directory ${agentsDir}: ${(error as Error).message}`);
	}
	const agents: AgentInfo[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const fm = parseAgentFrontmatter(readRegularFile(path.join(agentsDir, entry.name), `agent file ${entry.name}`, MAX_AGENT_FILE_BYTES));
		if (!fm.name) continue;
		const name = fm.package ? `${fm.package}.${fm.name}` : fm.name;
		if (!AGENT_RE.test(name)) throw new PresetError(`agent file ${entry.name}: invalid agent name ${show(name)}`);
		agents.push({ name, ...(fm.model ? { model: fm.model } : {}), ...(fm.thinking ? { thinking: fm.thinking } : {}) });
	}
	return agents.sort((a, b) => a.name.localeCompare(b.name));
}

/** The kosmos-pi package dir named by the absolute `file:<path>/kosmos-pi` entry of settings `packages` (the installer writes it). */
export function findKosmosPackageDir(settings: Json): string | undefined {
	const packages = settings.packages;
	if (!Array.isArray(packages)) return undefined;
	for (const entry of packages) {
		if (typeof entry !== "string" || !entry.startsWith("file:")) continue;
		const dir = entry.slice("file:".length).replace(/\/+$/, "");
		if (path.isAbsolute(dir) && path.basename(dir) === "kosmos-pi") return dir;
	}
	return undefined;
}

export interface PresetStores {
	/** ~/.pi/agent/presets: what Pi reads now. */
	local: string;
	/** <repo>/pi/agent/presets: what survives an install. Only set when it was derived and checked. */
	repo?: string;
	/** Why `repo` is not set. */
	repoProblem?: string;
	/** Where the kosmos-pi agent files are: the package dir of the settings entry, else Pi's installed copy. */
	agentsDir?: string;
}

function isDirectory(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Where presets live. The repo store is `<repo>/pi/agent/presets`, with `<repo>` the parent of the kosmos-pi
 * package of the settings entry. It is only used when `<repo>/pi/agent/settings.json` exists (it looks like the
 * Dotfiles repo) and the presets dir is a real directory, never a symlink: writes through a link could land anywhere.
 */
export function locatePresetStores(settings: Json, agentDirPath: string): PresetStores {
	const stores: PresetStores = { local: path.join(agentDirPath, "presets") };
	const pkg = findKosmosPackageDir(settings);
	if (!pkg) {
		stores.repoProblem = "settings.json has no absolute file:<path>/kosmos-pi entry in packages, so the Dotfiles repo is unknown";
	} else {
		if (isDirectory(path.join(pkg, "agents"))) stores.agentsDir = path.join(pkg, "agents");
		const root = path.dirname(pkg);
		const presets = path.join(root, "pi", "agent", "presets");
		try {
			if (!fs.statSync(path.join(root, "pi", "agent", "settings.json")).isFile()) throw new Error("not a file");
		} catch {
			stores.repoProblem = `${root} does not look like the Dotfiles repo (no pi/agent/settings.json)`;
			return withInstalledAgents(stores, agentDirPath);
		}
		try {
			const stat = fs.lstatSync(presets);
			if (stat.isSymbolicLink()) stores.repoProblem = `${presets} is a symbolic link`;
			else if (!stat.isDirectory()) stores.repoProblem = `${presets} is not a directory`;
			else stores.repo = presets;
		} catch {
			stores.repoProblem = `${presets} does not exist`;
		}
	}
	return withInstalledAgents(stores, agentDirPath);
}

function withInstalledAgents(stores: PresetStores, agentDirPath: string): PresetStores {
	if (stores.agentsDir) return stores;
	const installed = path.join(agentDirPath, "npm", "node_modules", "kosmos-pi", "agents");
	if (isDirectory(installed)) stores.agentsDir = installed;
	return stores;
}

/** The model and thinking an agent runs with now: its override in settings, else its frontmatter (thinking: else `subagents.defaultThinking`). */
function effectiveAgentSetting(agent: AgentInfo, settings: Json): { model?: unknown; thinking?: unknown } {
	const subagents = isObject(settings.subagents) ? settings.subagents : {};
	const overrides = isObject(subagents.agentOverrides) ? subagents.agentOverrides : {};
	const own = Object.prototype.hasOwnProperty.call(overrides, agent.name) ? overrides[agent.name] : undefined;
	const override: Json = isObject(own) ? own : {};
	return {
		model: override.model !== undefined ? override.model : agent.model,
		thinking: override.thinking !== undefined ? override.thinking : (agent.thinking ?? subagents.defaultThinking),
	};
}

/**
 * A complete preset of the current state: `main` as given, and for every agent its effective model and thinking.
 * An agent whose model or thinking cannot be determined is an error naming it: a saved preset is never partial.
 */
export function snapshotPreset(options: { main: { model: string; thinking: string }; agents: AgentInfo[]; settings: Json; description?: string }): Preset {
	const { main, agents, settings, description } = options;
	if (agents.length === 0) throw new PresetError("no agents found to save (the kosmos-pi agents directory is empty)");
	const entries: Record<string, AgentSetting> = {};
	for (const agent of agents) {
		const { model, thinking } = effectiveAgentSetting(agent, settings);
		if (model === undefined) throw new PresetError(`agent ${agent.name} has no model in subagents.agentOverrides or its frontmatter`);
		try {
			parseModelRef(model);
		} catch {
			throw new PresetError(`agent ${agent.name}: model ${show(model)} is not "provider/model-id"; set one in subagents.agentOverrides first`);
		}
		if (thinking === undefined) throw new PresetError(`agent ${agent.name} has no thinking level in subagents.agentOverrides, its frontmatter or subagents.defaultThinking`);
		if (!isThinking(thinking)) throw new PresetError(`agent ${agent.name}: thinking ${show(thinking)} is not one of ${THINKING_LEVELS.join(", ")}`);
		const tooHigh = thinkingCeilingProblem(agent.name, thinking, thinkingCeiling(settings));
		if (tooHigh) throw new PresetError(`${tooHigh}; lower it in subagents.agentOverrides first`);
		entries[agent.name] = { model: model as string, thinking };
	}
	return validatePreset({ ...(description !== undefined ? { description } : {}), main, agents: entries });
}

/** Options for a selector: the current value first and marked; a current value that is not on offer is added with the reason. */
export function choiceList(values: readonly string[], current?: string, notOffered = "not offered"): Array<{ label: string; value: string }> {
	const unique = [...new Set(values)];
	const choices: Array<{ label: string; value: string }> = [];
	if (current !== undefined) {
		choices.push({ label: `${current} (current${unique.includes(current) ? "" : `, ${notOffered}`})`, value: current });
	}
	for (const value of unique) if (value !== current) choices.push({ label: value, value });
	return choices;
}

function checkName(name: unknown): string {
	const problem = nameProblem(name);
	if (problem) throw new PresetError(problem);
	return name as string;
}

/** The directories without repeats: two spellings or links of one directory count once (first kept). */
export function uniqueDirs(dirs: string[]): string[] {
	const seen = new Set<string>();
	return dirs.filter((dir) => {
		let key = path.resolve(dir);
		try {
			key = fs.realpathSync(dir);
		} catch {
			// A store that does not exist yet is compared by its path.
		}
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** The preset file paths that exist (as anything, a link included) in the stores. */
export function existingCopies(dirs: string[], name: string): string[] {
	checkName(name);
	return uniqueDirs(dirs).map((dir) => path.join(dir, `${name}.json`)).filter((file) => {
		try {
			fs.lstatSync(file);
			return true;
		} catch {
			return false;
		}
	});
}

function checkStoreDir(dir: string): void {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(dir);
	} catch {
		throw new PresetError(`preset store ${dir} does not exist`);
	}
	if (stat.isSymbolicLink()) throw new PresetError(`preset store ${dir} is a symbolic link; refusing to write through it`);
	if (!stat.isDirectory()) throw new PresetError(`preset store ${dir} is not a directory`);
}

/** Refuse a target that exists and is not a regular file (a symlink is neither followed nor replaced). */
function checkTargetFile(file: string): void {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(file);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return;
		throw new PresetError(`cannot check ${file}: ${(error as Error).message}`);
	}
	if (stat.isSymbolicLink()) throw new PresetError(`${file} is a symbolic link; refusing to replace it`);
	if (!stat.isFile()) throw new PresetError(`${file} is not a regular file`);
}

/**
 * Write `<name>.json` into every store: all targets and stores are checked first, every file is staged as a
 * temp file (`wx`) next to its target, and only then are they renamed into place. A refusal or a failed
 * staging changes no store. A rename is atomic per file; the (unlikely) failure of a later rename after an
 * earlier one succeeded is reported with what was already written.
 */
export function writePresetFiles(storeDirs: string[], name: string, text: string): string[] {
	checkName(name);
	// Files are renamed in the order given. The callers list the repo store first: the installer rsyncs repo to
	// local with --delete, so a failure after the repo write heals on the next install, while a local-first
	// order would have its only copy wiped by that same install.
	const dirs = uniqueDirs(storeDirs);
	const targets = dirs.map((dir) => path.join(dir, `${name}.json`));
	for (const dir of dirs) checkStoreDir(dir);
	for (const target of targets) checkTargetFile(target);
	const staged: string[] = [];
	try {
		for (const target of targets) {
			const temp = path.join(path.dirname(target), `.${name}.json.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
			fs.writeFileSync(temp, text, { flag: "wx", mode: 0o644 });
			staged.push(temp);
			fs.chmodSync(temp, 0o644);
		}
	} catch (error) {
		for (const temp of staged) fs.rmSync(temp, { force: true });
		throw error;
	}
	const written: string[] = [];
	try {
		for (let i = 0; i < targets.length; i += 1) {
			fs.renameSync(staged[i], targets[i]);
			written.push(targets[i]);
		}
	} catch (error) {
		for (const temp of staged.slice(written.length)) fs.rmSync(temp, { force: true });
		const done = written.length > 0 ? ` (already written: ${written.join(", ")})` : "";
		const failure = `could not write ${targets[written.length]}: ${(error as Error).message}${done}`;
		throw written.length > 0 ? new PartialApplyError(failure) : new PresetError(failure);
	}
	return written;
}

/** Delete `<name>.json` from the stores that have it. Only regular files are deleted; everything is checked before the first delete. */
export function removePresetFiles(dirs: string[], name: string): string[] {
	checkName(name);
	const targets = existingCopies(dirs, name); // already without repeated stores
	for (const target of targets) checkTargetFile(target);
	const removed: string[] = [];
	try {
		for (const target of targets) {
			fs.unlinkSync(target);
			removed.push(target);
		}
	} catch (error) {
		const done = removed.length > 0 ? ` (already deleted: ${removed.join(", ")})` : "";
		throw new PartialApplyError(`could not delete ${targets[removed.length]}: ${(error as Error).message}${done}`);
	}
	return removed;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isErrno(error: unknown, code: string): boolean {
	return (error as NodeJS.ErrnoException)?.code === code;
}

// The two lock protocols below are copies of what the other writers of settings.json do. They cannot be
// imported: Pi's lock is the `proper-lockfile` package, which an extension in ~/.pi/agent/extensions cannot
// resolve (Pi's loader aliases only its own packages and nothing above that folder has a node_modules),
// and pi-subagents' lease is an internal file of a pinned third-party package. test/preset.test.js runs
// the real pi-subagents lease against ours, so drift in either shows up as a failing test.

interface Owner {
	token: string;
	pid: number;
	hostname: string;
	processStart?: string;
}

/** The start time of a process (field 22 of /proc/<pid>/stat), which tells a reused PID from the original. Linux only. */
function startIdentity(pid: number): string | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		return raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
	} catch {
		return undefined;
	}
}

/** The owner recorded in a pi-subagents lease, or undefined when it is missing or malformed. */
function ownerOf(lockPath: string): Owner | undefined {
	try {
		const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
		if (typeof owner.token !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(owner.token)) return undefined;
		if (typeof owner.hostname !== "string" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return undefined;
		return owner;
	} catch {
		return undefined;
	}
}

/** Whether the process that owns a lease is provably gone: not running, or its PID now belongs to another process. */
function isDeadOwner(owner: Owner): boolean {
	if (owner.hostname !== os.hostname()) return false;
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		return isErrno(error, "ESRCH");
	}
	const current = startIdentity(owner.pid);
	return owner.processStart !== undefined && current !== undefined && owner.processStart !== current;
}

/**
 * Take a lock directory the way another writer of settings.json does, so both exclude each other.
 *   plain: Pi's proper-lockfile (`settings.json.lock`, `realpath: false`), a bare directory that its holder
 *          touches while it lives; stale once untouched for 10 s.
 *   owned: pi-subagents' lease (`settings.json.write-lock`, `tryLease` of its file-lease.js), an `owner.json`
 *          inside. A dead owner's lease is renamed to `<lock>.retired-<token>`, which stays as a fence.
 *          A lease whose owner cannot be read, or lives on another host, is never evicted.
 * Returns the release function. Throws PresetError when the lock stays held past the deadline.
 */
async function acquireLock(lockPath: string, kind: "plain" | "owned", deadline: number): Promise<() => void> {
	const owner: Owner = { token: randomUUID(), pid: process.pid, hostname: os.hostname() };
	const processStart = startIdentity(process.pid);
	if (processStart !== undefined) owner.processStart = processStart;
	for (;;) {
		try {
			fs.mkdirSync(lockPath, { mode: 0o700 });
			if (kind === "owned") {
				try {
					fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
				} catch (error) {
					fs.rmSync(lockPath, { recursive: true, force: true });
					throw error;
				}
			}
			return () => releaseLock(lockPath, kind, owner.token);
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
		}
		if (kind === "plain" ? reclaimStalePlain(lockPath) : reclaimDeadLease(lockPath)) continue;
		if (Date.now() >= deadline) throw new PresetError(`settings file is locked by another process (${path.basename(lockPath)}); try again in a moment`);
		await sleep(20);
	}
}

/**
 * Remove a proper-lockfile directory nobody has touched for LOCK_STALE_MS. The directory is first renamed
 * away and its mtime looked at again: if a live holder replaced the stale lock between our check and the
 * rename, what we moved is that holder's fresh lock. It is then "put back" by creating a new lock directory
 * with an atomic mkdir (same default mode as proper-lockfile), never by renaming the old one back: rename(2)
 * silently replaces an empty directory, so it could overwrite a newer lock. On EEXIST someone else already
 * holds the name and that lock is left alone. The renamed-away directory is removed in every case.
 *
 * Pi takes this lock synchronously for a few milliseconds and never refreshes it, so a holder displaced this
 * way is not told anything; it simply finishes and removes the lock. Two bounded effects remain, both only
 * when a holder takes the free name in the instant between our check and our rename: the holder is unprotected
 * for that moment, and if it releases before our mkdir the re-created lock has no holder (a phantom) and
 * blocks writers until it goes stale, at most LOCK_STALE_MS (10 s). The alternative, a plain `rmdir` after the
 * stat, would delete the live holder's lock outright in the same race.
 */
function reclaimStalePlain(lockPath: string): boolean {
	const isFresh = (target: string) => Date.now() - fs.statSync(target).mtimeMs <= LOCK_STALE_MS;
	const retired = `${lockPath}.stale-${randomUUID()}`;
	try {
		if (isFresh(lockPath)) return false;
		fs.renameSync(lockPath, retired);
		const displacedLiveLock = isFresh(retired);
		fs.rmdirSync(retired);
		if (!displacedLiveLock) return true;
		try {
			fs.mkdirSync(lockPath);
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
		}
		return false;
	} catch (error) {
		// Released or reclaimed by someone else meanwhile: the next mkdir decides.
		return isErrno(error, "ENOENT");
	}
}

/**
 * Mirror of pi-subagents' `tryLease` recovery: a lease whose owner is dead is renamed to
 * `<lock>.retired-<token>` and that directory is kept as a fence, so a delayed reclaimer of the same
 * token cannot rename a replacement lease over it. Returns whether the lease was moved (retry the mkdir).
 */
function reclaimDeadLease(lockPath: string): boolean {
	const previous = ownerOf(lockPath);
	if (!previous || !isDeadOwner(previous)) return false;
	const retired = `${lockPath}.retired-${previous.token}`;
	try {
		fs.renameSync(lockPath, retired);
	} catch (error) {
		// Already moved, or this very lease was retired before: treat the lock as still held.
		if (isErrno(error, "ENOENT") || ownerOf(retired)?.token === previous.token) return false;
		throw error;
	}
	if (ownerOf(retired)?.token !== previous.token) {
		throw new PresetError(`lock owner changed while recovering ${path.basename(lockPath)}; nothing was changed`);
	}
	return true;
}

function releaseLock(lockPath: string, kind: "plain" | "owned", token: string): void {
	if (kind === "owned") {
		if (ownerOf(lockPath)?.token === token) fs.rmSync(lockPath, { recursive: true });
		return;
	}
	try {
		fs.rmdirSync(lockPath);
	} catch (error) {
		if (!isErrno(error, "ENOENT")) throw error;
	}
}

/** Parse a settings file; it must hold one JSON object. A parse failure reports the position, never the content. */
export function readSettingsFile(file: string): Json {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		throw new PresetError(`cannot read settings file ${file}: ${(error as Error).message}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch (error) {
		throw new PresetError(`cannot parse settings file ${file}: not valid JSON at ${jsonPosition(error)}`);
	}
	if (!isObject(parsed)) throw new PresetError(`settings file ${file} must contain a JSON object`);
	return parsed;
}

/**
 * Read-modify-write the settings file under the other writers' locks, replacing it atomically.
 * `update` gets a copy of the parsed settings and returns the new object; if it throws, or the
 * file cannot be parsed, or a lock stays held, the file is not touched. Never creates the file.
 * Resolves with warnings (a lock that could not be released after a successful write); on failure the
 * original error is thrown and a release problem is only appended to its message, never replacing it.
 */
export async function updateSettingsFile(file: string, update: (settings: Json) => Json, options: { timeoutMs?: number } = {}): Promise<string[]> {
	const deadline = Date.now() + (options.timeoutMs ?? LOCK_WAIT_MS);
	let real: string;
	try {
		real = fs.realpathSync(file);
	} catch (error) {
		throw new PresetError(`settings file not found: ${file} (${(error as Error).message})`);
	}
	const releases: Array<{ name: string; release: () => void }> = [];
	let failure: unknown;
	let failed = false;
	try {
		releases.push({ name: `${path.basename(file)}.lock`, release: await acquireLock(`${file}.lock`, "plain", deadline) });
		releases.push({ name: `${path.basename(real)}.write-lock`, release: await acquireLock(`${real}.write-lock`, "owned", deadline) });

		const original = fs.readFileSync(real, "utf8");
		const next = update(structuredClone(readSettingsFile(real)));
		if (!isObject(next)) throw new PresetError("the updated settings must be a JSON object");
		const text = `${JSON.stringify(next, null, 2)}${original.endsWith("\n") ? "\n" : ""}`;

		const mode = fs.statSync(real).mode & 0o7777;
		const temp = `${real}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
		try {
			fs.writeFileSync(temp, text, { flag: "wx", mode });
			fs.chmodSync(temp, mode);
			fs.renameSync(temp, real);
		} catch (error) {
			fs.rmSync(temp, { force: true });
			throw error;
		}
	} catch (error) {
		failed = true;
		failure = error;
	}
	// Every lock gets its own release attempt; one failing must not leave the others held.
	const problems: string[] = [];
	while (releases.length > 0) {
		const { name, release } = releases.pop()!;
		try {
			release();
		} catch (error) {
			problems.push(`could not release ${name}: ${(error as Error).message}`);
		}
	}
	if (failed) {
		if (problems.length > 0 && failure instanceof Error) failure.message += ` (also ${problems.join("; ")})`;
		throw failure;
	}
	return problems;
}

/** A prompt was cancelled (or a "no" given to an overwrite or delete question): stop, change nothing. */
class Cancelled extends Error {}

const SUBCOMMAND_HELP: Record<(typeof RESERVED_NAMES)[number], string> = {
	save: "save the current model, thinking level and agent settings as a preset: /preset save <name>",
	new: "build a preset step by step: /preset new <name>",
	delete: "delete a preset from both stores: /preset delete <name>",
};

export default function (pi: ExtensionAPI) {
	const presetsDir = () => path.join(agentDir(), "presets");
	const settingsFile = () => path.join(agentDir(), "settings.json");

	const activePreset = (): string | undefined => {
		try {
			const active = readSettingsFile(settingsFile())[ACTIVE_KEY];
			return isValidPresetName(active) ? active : undefined;
		} catch {
			return undefined;
		}
	};

	const listLines = (): string[] => {
		const presets = listPresets(presetsDir());
		if (presets.length === 0) return [`No presets found in ${presetsDir()}`];
		const active = activePreset();
		const lines = [`Presets (active: ${active ?? "none"}). Apply one with /preset <name>; also /preset save | new | delete <name>`];
		for (const p of presets) {
			const detail = p.error ? `invalid: ${p.error}` : p.description;
			lines.push(`${p.name === active ? "*" : " "} ${p.name}${detail ? ` — ${detail}` : ""}`);
		}
		return lines;
	};

	/** The whole apply path: resolve, check, switch the session, persist, and put the session back if persisting fails. */
	const applyNamed = async (name: string, ctx: ExtensionCommandContext): Promise<void> => {
		const preset = loadPreset(presetsDir(), name);
		const model = resolveModels(preset, (provider, id) => ctx.modelRegistry.find(provider, id));
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
			throw new PresetError(`no credentials (API key or login) configured for ${preset.main.model}`);
		}
		// Dry run: a settings problem must be found before the session is touched.
		applyPresetToSettings(readSettingsFile(settingsFile()), name, preset);

		const previousModel = ctx.model;
		const previousThinking = pi.getThinkingLevel();
		if (!(await pi.setModel(model))) throw new PresetError(`Pi could not switch to ${preset.main.model} (no credentials)`);
		// setModel resets the thinking level for the new model, so set ours after it.
		pi.setThinkingLevel(preset.main.thinking);
		let warnings: string[];
		try {
			warnings = await updateSettingsFile(settingsFile(), (settings) => applyPresetToSettings(settings, name, preset));
		} catch (error) {
			// Put the session back. If that is not certain, say so: the settings were not written but the session was changed.
			let problem: string | undefined;
			try {
				if (!previousModel) problem = "there was no previous model to go back to";
				else if (!(await pi.setModel(previousModel))) problem = "Pi refused to switch back";
				else pi.setThinkingLevel(previousThinking);
			} catch (restoreError) {
				problem = (restoreError as Error).message;
			}
			if (problem) {
				throw new PartialApplyError(`${(error as Error).message}. The session is on ${preset.main.model} and could not be switched back (${problem}); use /model`);
			}
			throw error;
		}
		const lines = presetSummary(name, preset);
		const effective = pi.getThinkingLevel();
		if (effective !== preset.main.thinking) lines.push(`  main thinking is ${effective}: ${preset.main.model} does not support ${preset.main.thinking}`);
		lines.push("  New sessions start on this preset; subagents use it from their next launch.");
		for (const warning of warnings) lines.push(`  warning: ${warning}`);
		ctx.ui.notify(lines.join("\n"), warnings.length > 0 ? "warning" : "info");
	};

	// --- save, new, delete -------------------------------------------------------------------

	const requireUI = (ctx: ExtensionCommandContext, what: string): void => {
		if (ctx.hasUI === false) throw new PresetError(`/preset ${what} needs an interactive UI to ask questions`);
	};

	/** The one preset name a subcommand takes. */
	const nameArg = (words: string[], what: string): string => {
		if (words.length !== 1) throw new PresetError(`usage: /preset ${what} <name> (one name, lowercase letters, digits, "-" and "_")`);
		return checkName(words[0]);
	};

	/** The stores, the settings they were derived from and the kosmos agents. Throws when they cannot be found. */
	const context = (needAgents: boolean) => {
		const settings = readSettingsFile(settingsFile());
		const stores = locatePresetStores(settings, agentDir());
		let agents: AgentInfo[] = [];
		if (needAgents) {
			if (!stores.agentsDir) {
				throw new PresetError("cannot find the kosmos-pi agents (no file:<path>/kosmos-pi entry in settings.json packages and no installed copy); run bin/install-kosmos-pi.sh");
			}
			agents = readKosmosAgents(stores.agentsDir);
		}
		// Repo first, then local: see writePresetFiles.
		const dirs = uniqueDirs(stores.repo ? [stores.repo, stores.local] : [stores.local]);
		return { settings, stores, agents, dirs };
	};

	/** A dialog answer; undefined means the user cancelled. */
	const answer = async <T>(dialog: Promise<T | undefined>): Promise<T> => {
		const value = await dialog;
		if (value === undefined) throw new Cancelled();
		return value;
	};

	const confirmOverwrite = async (ctx: ExtensionCommandContext, name: string, dirs: string[]): Promise<void> => {
		const copies = existingCopies(dirs, name);
		if (copies.length === 0) return;
		const yes = await ctx.ui.confirm("Overwrite preset?", `Preset "${name}" already exists:\n${copies.map((c) => `  ${c}`).join("\n")}\nOverwrite it?`);
		if (!yes) throw new Cancelled();
	};

	/** Ask for the optional description; an unusable one is asked again with the reason, a cancel aborts. */
	const askDescription = async (ctx: ExtensionCommandContext): Promise<string | undefined> => {
		let title = "Description (optional, one line; empty for none)";
		for (;;) {
			const text = (await answer(ctx.ui.input(title, "what this preset is for"))).trim();
			if (text === "") return undefined;
			const problem = descriptionProblem(text);
			if (!problem) return text;
			title = `Not accepted: ${problem}. Description (optional; empty for none)`;
		}
	};

	/** Validate, write to every store, report where, and offer to apply it. */
	const persist = async (ctx: ExtensionCommandContext, name: string, draft: Preset, description: string | undefined, c: ReturnType<typeof context>): Promise<void> => {
		const preset = validatePreset({ ...(description !== undefined ? { description } : {}), main: draft.main, agents: draft.agents });
		if (!c.stores.repo) {
			// The local store is the only one; make sure it exists (the installer normally creates it).
			try {
				fs.mkdirSync(c.stores.local);
			} catch (error) {
				if (!isErrno(error, "EEXIST")) throw error;
			}
		}
		const written = writePresetFiles(c.dirs, name, presetToJson(preset));
		const lines = [`Preset ${name} saved:`, ...written.map((file) => `  ${file}`)];
		if (c.stores.repo) {
			ctx.ui.notify(lines.join("\n"), "info");
		} else {
			lines.push(`  Only this copy was written: ${c.stores.repoProblem}.`);
			lines.push("  The next bin/install-kosmos-pi.sh run deletes it (rsync --delete); copy the file into pi/agent/presets/ of the Dotfiles repo to keep it.");
			ctx.ui.notify(lines.join("\n"), "warning");
		}
		if (!(await ctx.ui.confirm("Apply preset now?", `Apply "${name}" to this session and the subagents?`))) return;
		try {
			await applyNamed(name, ctx);
		} catch (error) {
			// The files are written: say so, instead of the generic "nothing was changed" of the handler.
			// A PartialApplyError means the session IS on the new model and could not be switched back.
			if (error instanceof PartialApplyError) {
				ctx.ui.notify(`Preset ${name} was saved. ${error.message}.`, "error");
				return;
			}
			const message = error instanceof PresetError ? error.message : `unexpected error: ${(error as Error).message}`;
			ctx.ui.notify(`Preset ${name} was saved but not applied: ${message}.`, "error");
		}
	};

	const currentMain = (ctx: ExtensionCommandContext): { model: string; thinking: string } | undefined => {
		const model = ctx.model;
		return model ? { model: `${model.provider}/${model.id}`, thinking: pi.getThinkingLevel() } : undefined;
	};

	const savePreset = async (words: string[], ctx: ExtensionCommandContext): Promise<void> => {
		requireUI(ctx, "save");
		const name = nameArg(words, "save");
		const c = context(true);
		const main = currentMain(ctx);
		if (!main) throw new PresetError("there is no current model to save; pick one with /model first");
		const draft = snapshotPreset({ main, agents: c.agents, settings: c.settings });
		await confirmOverwrite(ctx, name, c.dirs);
		await persist(ctx, name, draft, await askDescription(ctx), c);
	};

	const newPreset = async (words: string[], ctx: ExtensionCommandContext): Promise<void> => {
		requireUI(ctx, "new");
		const name = nameArg(words, "new");
		const c = context(true);
		const available = [...new Set(ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`))]
			.filter((ref) => {
				try {
					parseModelRef(ref);
					return true;
				} catch {
					return false;
				}
			})
			.sort();
		if (available.length === 0) throw new PresetError("no models with credentials are available; log in or set an API key first (/login)");
		await confirmOverwrite(ctx, name, c.dirs);
		const description = await askDescription(ctx);

		const pick = async (title: string, choices: Array<{ label: string; value: string }>): Promise<string> => {
			const label = await answer(ctx.ui.select(title, choices.map((choice) => choice.label)));
			const hit = choices.find((choice) => choice.label === label);
			if (!hit) throw new PresetError(`unexpected selection for "${title}"`);
			return hit.value;
		};
		const agentLevels = levelsUpTo(thinkingCeiling(c.settings));
		const validRef = (value: unknown): string | undefined => {
			try {
				parseModelRef(value);
				return value as string;
			} catch {
				return undefined;
			}
		};

		const current = currentMain(ctx);
		const mainModel = await pick("Preset: main session model", choiceList(available, current?.model, "not available"));
		const mainThinking = await pick("Preset: main session thinking level", choiceList(THINKING_LEVELS, current?.thinking));
		const agents: Record<string, AgentSetting> = {};
		for (const [index, agent] of c.agents.entries()) {
			const now = effectiveAgentSetting(agent, c.settings);
			const position = `${index + 1}/${c.agents.length}`;
			const model = await pick(`Preset: ${agent.name} model (${position})`, choiceList(available, validRef(now.model), "not available"));
			const levels = choiceList(agentLevels, isThinking(now.thinking) && agentLevels.includes(now.thinking) ? now.thinking : undefined);
			const thinking = await pick(`Preset: ${agent.name} thinking level (${position})`, levels);
			agents[agent.name] = { model, thinking: thinking as ThinkingLevel };
		}
		await persist(ctx, name, validatePreset({ main: { model: mainModel, thinking: mainThinking }, agents }), description, c);
	};

	const deletePreset = async (words: string[], ctx: ExtensionCommandContext): Promise<void> => {
		requireUI(ctx, "delete");
		const name = nameArg(words, "delete");
		const c = context(false);
		if (c.settings[ACTIVE_KEY] === name) throw new PresetError(`preset ${name} is the active preset; apply another preset first`);
		const copies = existingCopies(c.dirs, name);
		if (copies.length === 0) throw new PresetError(`unknown preset ${show(name)}`);
		const repoCopy = c.stores.repo ? path.join(c.stores.repo, `${name}.json`) : undefined;
		const gitNote = repoCopy && copies.includes(repoCopy)
			? `\nThe repo copy is tracked by git: if it is committed, restore it with \`git checkout -- ${repoCopy}\`; an uncommitted copy cannot be recovered.`
			: "";
		const yes = await ctx.ui.confirm("Delete preset?", `Delete preset "${name}"?\n${copies.map((file) => `  ${file}`).join("\n")}${gitNote}`);
		if (!yes) throw new Cancelled();
		const removed = removePresetFiles(c.dirs, name);
		const lines = [`Preset ${name} deleted:`, ...removed.map((file) => `  ${file}`)];
		if (c.stores.repo) {
			ctx.ui.notify(lines.join("\n"), "info");
		} else {
			lines.push(`  The Dotfiles repo copy was not touched: ${c.stores.repoProblem}.`);
			lines.push("  If pi/agent/presets/ of the repo has this preset, the next bin/install-kosmos-pi.sh run brings it back.");
			ctx.ui.notify(lines.join("\n"), "warning");
		}
	};

	const subcommands = { save: savePreset, new: newPreset, delete: deletePreset };

	pi.registerCommand("preset", {
		description: "List presets, switch the model and thinking level of the session and every subagent, or save, build and delete presets: /preset [name | save|new|delete <name>]",
		getArgumentCompletions: (prefix) => {
			const after = /^(\S+)\s+(\S*)$/.exec(prefix);
			if (after) {
				if (after[1] !== "delete") return null;
				const items = listPresets(presetsDir())
					.filter((p) => !p.error && p.name.startsWith(after[2]))
					.map((p) => ({ value: `delete ${p.name}`, label: p.name, ...(p.description ? { description: p.description } : {}) }));
				return items.length > 0 ? items : null;
			}
			if (/\s/.test(prefix)) return null;
			const items = [
				...listPresets(presetsDir())
					.filter((p) => !p.error && p.name.startsWith(prefix))
					.map((p) => ({ value: p.name, label: p.name, ...(p.description ? { description: p.description } : {}) })),
				...RESERVED_NAMES.filter((word) => word.startsWith(prefix)).map((word) => ({ value: word, label: word, description: SUBCOMMAND_HELP[word] })),
			];
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify(listLines().join("\n"), "info");
				return;
			}
			const [first, ...rest] = text.split(/\s+/);
			const subcommand = (RESERVED_NAMES as readonly string[]).includes(first) ? (first as keyof typeof subcommands) : undefined;
			try {
				if (subcommand) await subcommands[subcommand](rest, ctx);
				else await applyNamed(text, ctx);
			} catch (error) {
				const label = subcommand ? subcommand : show(text);
				if (error instanceof Cancelled) {
					ctx.ui.notify(`/preset ${label}: cancelled. Nothing was ${subcommand === "delete" ? "deleted" : "written"}.`, "info");
					return;
				}
				const message = error instanceof PresetError ? error.message : `unexpected error: ${(error as Error).message}`;
				ctx.ui.notify(`/preset ${label}: ${message}.${error instanceof PartialApplyError ? "" : " Nothing was changed."}`, "error");
			}
		},
	});
}

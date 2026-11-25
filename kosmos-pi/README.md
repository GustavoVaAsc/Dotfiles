# kosmos-pi

A portable [Pi](https://github.com/badlogic/pi-mono) package that ships a senior engineering agent team and supporting skills. Install once on any machine, get the same specialists every time.

Originally converted from OpenCode agents into Pi's frontmatter format; see [Conversion notes](#conversion-notes) below for the mapping applied.

## What's inside

### Agents (6)

| Agent | Model | Mode | Purpose |
|---|---|---|---|
| `kosmos.coder` | MiniMax-M3.1-Flash | read/write, medium thinking | Implementation of any size: features, fixes, refactors, new modules, new public APIs |
| `kosmos.code-reviewer` | MiniMax-M3.1-Flash | read-only, medium thinking | 12-category audit (correctness, security, perf, reliability, concurrency, …) with severity-ranked findings |
| `kosmos.security-auditor` | MiniMax-M3.1-Flash | read-only, medium thinking | 15-layer threat model + OWASP-focused security audit, with an OSV lockfile scan and advisory lookup |
| `kosmos.docs-writer` | MiniMax-M2.7 | read/write, low thinking | READMEs, API refs, guides, tutorials, ADRs, changelogs |
| `kosmos.researcher` | MiniMax-M3.1-Flash | web-only, read-only, medium thinking | Web research on libraries, APIs, standards, prior art and advisories. Searches and fetches only, never reads the repo; returns one cited report saved to the path the task sets |
| `kosmos.orchestrator` | MiniMax-M3.1-Flash | read/write, medium thinking | Senior tech-lead: challenges the plan, delegates implementation, fans out specialists in parallel via `subagent(...)`; edits plans, docs and config inline when the change is small |

The Model column shows the frontmatter defaults, which match the `minimax` preset. Switch the models with `/preset` (see [Model presets](#model-presets-preset)).

Runtime agent names are formed from the `package:` + `name:` frontmatter fields (`kosmos` + `coder` → `kosmos.coder`). Each agent file lives under `agents/` without a `kosmos-` prefix.

### Security auditor: network access

The auditor reaches the network in two ways, and both are narrow:

- **Lockfile scan.** The only scanner it may run without approval is `~/Dotfiles/bin/kosmos-osv-scan <lockfile>`, a wrapper from this Dotfiles repo. It takes exactly one lockfile inside the repo (a fixed list of file names), runs osv-scanner with call analysis off and a pinned empty config, and ignores the repo's own `osv-scanner.toml`. It sends the lockfile's package names and versions to OSV. Package-manager scanners (`npm audit`, `pip-audit`, `cargo audit`, ...) and other manifests go under `[approval]` for you to run. Outside this checkout the wrapper does not exist, so the scan is reported under `[approval]` too.
- **Advisory pages.** It may fetch only advisory hosts (NVD, GitHub advisories, OSV, RustSec, PyPI, npmjs.com, and the vendor page a CVE or GHSA names).

On Pi nothing enforces these rules: they are in the agent's prompt. Claude Code prompts for each fetch, and opencode enforces both with deny rules (and has no web search for this agent). A fetch is checked on its first URL only, so an allowed host can redirect it elsewhere; the prompt tells the agent to note the final host and treat an off-list page as untrusted.

### Researcher: web only

`kosmos.researcher` answers questions whose answer lives outside the repo. It has no tool that reads, searches or writes the repo, so the task must carry the non-secret codebase context it needs. Codebase questions go to `scout` or the Explore agent. The runtime saves the report to the output path the task sets (by convention `docs/research/<slug>.md`).

Its web tools load only through `guards/researcher-fetch-guard.ts`, which wraps pi-web-access. The guard refuses these calls before pi-web-access runs them:

| Refused | Why |
|---|---|
| `github.com`, `www.github.com` and `api.github.com` URLs | pi-web-access would fetch them through the user's logged-in `gh`, which can read private data |
| URLs that are not `http` or `https`, including local paths and `file://` | a local file could be sent to a model provider |
| the `auth` option, any non-empty `proxy`, `includeContent` and `fetchContent` | they skip the per-URL check, or the proxy address is never checked |

If the guard does not load, the launch fails. context7 is not available to the Pi researcher yet.

The kosmos settings in `pi/agent/settings.json` disable pi-subagents' built-in `researcher` and `evidence-auditor` (`subagents.agentOverrides`). The built-in agents loaded pi-web-access without the guard, and the built-in researcher could read the repo. Use `kosmos.researcher` instead. If you copy the settings file elsewhere, copy these overrides too.

### Skills (2 published, 1 local)

| Skill | Purpose |
|---|---|
| `pr-workflow` | Full PR protocol: pre-flight → commit hygiene → PR description → self-review via specialist fan-out |
| `the-cock-of-justice` | Dual-lens verdict (spec + quality reviewers in parallel) → ACCEPTED / WARNING / FAIL. Opt-in: fires only on an explicit request |
| `artifact-review` | **Local Dotfiles installs only; not in the published npm package** (`files` excludes it, because it needs the `kosmos-review/` tool from this repo). Review loop for a long Markdown document: write it with embedded questions, serve it in a local browser page, read the submitted `round-N.json`, revise, repeat |

## Model presets (`/preset`)

`/preset` switches the model and thinking level of the main session and of every kosmos subagent with one name. The `minimax` preset is the default and matches the agent frontmatter.

| Command | Effect |
|---|---|
| `/preset` | Lists the presets and marks the active one with `*` |
| `/preset <name>` | Applies the preset. Tab completes names |
| `/preset save <name>` | Saves the current setup as a preset. Prompts for an optional description before writing |
| `/preset new <name>` | Builds a preset with pickers. Asks for the description, then a model and thinking level for the main session and for each agent |
| `/preset delete <name>` | Deletes a preset after confirmation. Refuses the active preset |

`save` records the main session's model and thinking level, plus each kosmos agent's model and thinking. An agent without an override is saved with its frontmatter value, so a saved preset always covers every agent. `new` offers only models that have credentials, and caps each thinking level at `subagents.maxThinking`. `save` and `new` check the thinking levels against that cap as well. Cancelling a prompt at any step saves nothing. Overwriting an existing name asks for confirmation first. After `save` or `new`, `/preset` offers to switch to the new preset.

Applying a preset changes three things:

| Where | What changes |
|---|---|
| Main session | `main.model` and `main.thinking` apply live |
| `~/.pi/agent/settings.json` | `defaultProvider`, `defaultModel`, `defaultThinkingLevel` and `kosmosActivePreset` are written, so new sessions start on the preset |
| `subagents.agentOverrides.<agent>` | `model` and `thinking` are merged into each agent the preset names. Other fields and entries are kept, including the `{"disabled": true}` overrides on `researcher` and `evidence-auditor` ([Researcher: web only](#researcher-web-only)) |

Subagents use the new models from their next launch. A subagent that is already running keeps its old model. A project `.pi/settings.json` with `agentOverrides` still takes precedence over the user settings that `/preset` writes (see `pi/agent/extensions/preset.ts`, header comment).

### Shipped presets

The `minimax` preset (`pi/agent/presets/minimax.json`) uses the MiniMax provider:

| Agent | Model | Thinking |
|---|---|---|
| main session | `minimax/MiniMax-M3.1-Flash` | medium |
| `kosmos.orchestrator` | `minimax/MiniMax-M3.1-Flash` | medium |
| `kosmos.coder` | `minimax/MiniMax-M3.1-Flash` | medium |
| `kosmos.code-reviewer` | `minimax/MiniMax-M3.1-Flash` | medium |
| `kosmos.security-auditor` | `minimax/MiniMax-M3.1-Flash` | medium |
| `kosmos.researcher` | `minimax/MiniMax-M3.1-Flash` | medium |
| `kosmos.docs-writer` | `minimax/MiniMax-M2.7` | low |

The `mimo` preset (`pi/agent/presets/mimo.json`) uses the `xiaomi-token-plan-sgp` provider. It runs the pro model for orchestration, review and audit, and the flash model for the rest:

| Agent | Model | Thinking |
|---|---|---|
| main session | `xiaomi-token-plan-sgp/mimo-v2.6-flash` | medium |
| `kosmos.orchestrator` | `xiaomi-token-plan-sgp/mimo-v2.6-pro` | medium |
| `kosmos.code-reviewer` | `xiaomi-token-plan-sgp/mimo-v2.6-pro` | medium |
| `kosmos.security-auditor` | `xiaomi-token-plan-sgp/mimo-v2.6-pro` | high |
| `kosmos.coder` | `xiaomi-token-plan-sgp/mimo-v2.6-flash` | medium |
| `kosmos.researcher` | `xiaomi-token-plan-sgp/mimo-v2.6-flash` | medium |
| `kosmos.docs-writer` | `xiaomi-token-plan-sgp/mimo-v2.6-flash` | low |

### Preset file format

A preset is a JSON file named `<name>.json`. The name must match `^[a-z0-9][a-z0-9_-]{0,63}$`: lowercase letters, digits, `-` and `_`, at most 64 characters. The names `save`, `new` and `delete` are reserved for the subcommands and cannot be used. Files are limited to 64 KiB.

```json
{
  "description": "Cheaper models for the review agents",
  "main": { "model": "minimax/MiniMax-M3.1-Flash", "thinking": "medium" },
  "agents": {
    "kosmos.code-reviewer": { "model": "minimax/MiniMax-M2.7", "thinking": "low" }
  }
}
```

| Field | Required | Value |
|---|---|---|
| `description` | No | One line, at most 200 characters. Shown by `/preset` and Tab completion |
| `main` | Yes | Object with `model` and `thinking` |
| `main.model` | Yes | `provider/model-id` |
| `main.thinking` | Yes | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` |
| `agents` | No | Object keyed by agent runtime name (`kosmos.coder`, not `coder`) |
| `agents.<name>.model` | One of `model` or `thinking` | `provider/model-id` |
| `agents.<name>.thinking` | One of `model` or `thinking` | Same values as `main.thinking` |

Unknown fields are rejected. A preset covers only the agents it names. An agent that the preset omits keeps the override from the previously applied preset, so list every agent a preset should control.

### Where presets live

Shipped presets live in the repo at `pi/agent/presets/`. `bin/install-kosmos-pi.sh` syncs them to `~/.pi/agent/presets/` with `rsync --delete`. The installer refuses to run when `~/.pi/agent/presets` is a symlink.

`save` and `new` write the preset to two places:

| Location | Survives an install | Notes |
|---|---|---|
| `<Dotfiles>/pi/agent/presets/<name>.json` | Yes | Versioned. It shows in `git status`, so commit it |
| `~/.pi/agent/presets/<name>.json` | No | Works immediately |

`<Dotfiles>` is the parent of the `file:<path>/kosmos-pi` entry in `packages` of `~/.pi/agent/settings.json`, which the installer writes. The repo copy is written only when that directory is a real directory that contains `pi/agent/settings.json`. Otherwise only the local copy is written, and `/preset` warns that the next install will delete it. A preset that exists only in `~/.pi/agent/presets/` is deleted on the next install, so add it to the repo.

`delete` removes the preset from both locations. It refuses the active preset. If the repo copy was committed, `git checkout -- pi/agent/presets/<name>.json` restores it. An uncommitted repo copy cannot be restored this way.

If a preset is invalid, names a model that is not in Pi's model registry, or names a model without credentials, `/preset` reports the error and changes nothing. The same applies when the settings write fails. A thinking level above `subagents.maxThinking` in `settings.json` is also refused.

Re-running the installer copies the repo's `settings.json` over the live one. That removes `kosmosActivePreset` and the per-agent overrides, so run `/preset <name>` again after each install. `/preset` then shows `active: none` until you apply a preset.

If a project's `agentOverridesByProvider` entry sets `disabled` to anything other than `true` for `researcher` or `evidence-auditor`, `/preset` refuses to apply, because the preset would otherwise hide that problem. Fix the setting first.

The extension and presets ship from `pi/agent/` in this Dotfiles repo, not in the npm package. The `files` list in `kosmos-pi/package.json` covers `agents/`, `guards/`, `skills/`, `README.md` and `LICENSE` only.

## Install

Run the install script once on each machine:

```bash
~/Dotfiles/bin/install-kosmos-pi.sh
```

The script (see [`bin/install-kosmos-pi.sh`](./bin/install-kosmos-pi.sh) for the full source):

1. Installs the `kosmos-pi` npm package into `~/.pi/agent/npm/`.
2. Adds `"file:<this repo>/kosmos-pi"` to `~/.pi/agent/settings.json` if not already present. The path is written by the installer, not stored in the repo, so the checked-in `settings.json` stays machine-independent.
3. Syncs `~/Dotfiles/pi/agent/` → `~/.pi/agent/` (per-file/per-subtree rsync of `SYSTEM.md`, `settings.json`, `themes/`, `presets/`, `mcp-adapter.json` — leaves `npm/`, `agents/`, `sessions/`, etc. untouched).
4. Removes `~/.pi/agent/mcp.json` if present. Pi's own MCP config is a second input to the MCP adapter on Pi 0.99+, so a stale copy there keeps deleted servers alive. The server list lives in `~/Dotfiles/mcp/mcp.json`, which the top-level `ai-harness-install.sh` symlinks to `~/.config/mcp/`.
5. Reports what changed. Safe to re-run.

After running it, restart Pi. The 6 agents appear under `kosmos.*` and the skills under `/skill:pr-workflow` and `/skill:the-cock-of-justice`, plus `/skill:artifact-review` when installed from this repo (see above).

### From npm (after publishing)

If you prefer to install from npm rather than a local checkout, add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:kosmos-pi"]
}
```

Then restart Pi.

### From a local checkout (for development)

```json
{
  "packages": ["file:/absolute/path/to/Dotfiles/kosmos-pi"]
}
```

Relative paths work too if the package is inside your Pi project or dotfiles repo:

```json
{
  "packages": ["file:./kosmos-pi"]
}
```

## Portable config tree

Two subtrees in the Dotfiles repo are kept in sync with the live Pi config:

- `pi/agent/` — Pi agent-level settings:
  - `SYSTEM.md` — parent system prompt injected into all Pi sessions
  - `settings.json` — user preferences, theme, default model, packages list
  - `themes/kosmos.json` — custom theme
  - `mcp-adapter.json` — MCP adapter settings (footer icon, tool rendering); the server list lives in the shared config below
  - `extensions/agent-name-hint.ts` — derives the active persona label from the system prompt's first heading and displays it in the TUI footer status line and, with the active model, in the terminal title
  - `extensions/footer.ts` — replaces Pi's built-in footer with the same layout, but puts the MCP status hint on the bottom right instead of trailing the other extension statuses on the left, shows a context usage bar before the context readout, and leaves the token counters (input, output, cache reads and writes) and the cache hit rate out. The bar is 12 cells wide and shrinks (12, 8, 6, 4) when the line does not fit. It is omitted when the percentage is unusable (not a finite number, or outside 0–1000 %; the readout then shows `?/<size>`) and when the context window size is zero or unknown. A session that has not reported a percentage yet — a fresh session — renders `0.0%/<size>` and no bar until the first response reports one, because nothing has been used at that point
- `mcp/` — global MCP config, symlinked to `~/.config/mcp/`:
  - `mcp.json` — globally available MCP servers, the single source of truth for the server list

Re-capture after editing live Pi config (e.g., after changing theme or adding an MCP server). The install script's per-file/per-subtree rsync is intentional: syncing `pi/agent/SYSTEM.md` alone does not wipe `~/.pi/agent/sessions/`, `npm/`, or other Pi state that lives alongside it.

## Usage

### Spawning a specialist directly

From the parent Pi session, use the `subagent(...)` tool (from the `pi-subagents` package):

```typescript
subagent({
  agent: "kosmos.code-reviewer",
  task: "Review the diff in src/auth/login.ts for the last 3 commits."
})
```

Pi resolves the `agent` name through its discovery chain (built-in → user → project → package). The `package: kosmos` frontmatter field tells Pi which package to look in when the name is not globally unique.

### Orchestrating multi-agent work

The `kosmos.orchestrator` agent is meant to be invoked by the parent session. It will:

1. Challenge your proposed plan and surface alternatives.
2. Ask clarifying questions if scope or approach is ambiguous.
3. Delegate implementation to one coder that handles work of any size, with a brief that states the goal.
4. Fan out independent specialists in parallel via `subagent({ workflow: "parallel", args: { tasks: [...] } })`.
5. Synthesize their findings into one consolidated report with a ship verdict.

A typical invocation:

```typescript
subagent({
  agent: "kosmos.orchestrator",
  task: "Plan and review the change in src/billing/. Branch: feat/usage-based-pricing. Goal: tier-based pricing with metered overages."
})
```

Parallel fan-out:

```typescript
subagent({
  workflow: "parallel",
  args: {
    tasks: [
      { agent: "kosmos.code-reviewer", task: "Review the diff in src/auth/login.ts for the last 3 commits." }
      // Add { agent: "kosmos.security-auditor", task: "Audit the same diff for security issues." }
      // when the diff touches auth, input handling, secrets, crypto, network, eval,
      // path traversal, deserialization, XSS or CSRF, log injection, rate limits,
      // abuse controls, or session and token lifetimes.
    ]
  }
})
```

### Using the PR workflow skill

When the user says "open a PR", "prepare a PR", or "review my PR before I open it", fire `/skill:pr-workflow`. The skill walks through four phases (pre-flight → commit hygiene → PR description → self-review) and produces a complete PR package without ever pushing or merging.

### Using the verdict skill

When the user asks for "the cock of justice" or a "verdict", fire `/skill:the-cock-of-justice`. The skill spawns exactly two reviewers in parallel (spec lens + quality lens) and returns ACCEPTED / WARNING / FAIL with a deduplicated concern list. It is opt-in: it is not part of the default ship gate, which is `kosmos.code-reviewer` with `kosmos.security-auditor` added on security triggers.

## Project layout

```
Dotfiles/
├── bin/
│   ├── install-kosmos-pi.sh   # Idempotent installer
│   └── preview-footer.mjs     # Renders the custom footer without launching Pi
├── config/
│   └── mcp/
│       └── mcp.json           # Global MCP server config
├── pi/
│   └── agent/
│       ├── SYSTEM.md          # Parent system prompt
│       ├── settings.json       # User preferences, theme, packages
│       ├── mcp-adapter.json   # MCP adapter settings (server list lives in mcp/mcp.json)
│       └── themes/
│           └── kosmos.json    # Custom theme
└── kosmos-pi/                 # The Pi package
    ├── package.json           # pi + pi-subagents manifest
    ├── README.md
    ├── LICENSE
    ├── agents/                # Declared under pi-subagents.agents
    │   ├── orchestrator.md
    │   ├── coder.md
    │   ├── code-reviewer.md
    │   ├── security-auditor.md
    │   ├── researcher.md
    │   └── docs-writer.md
    ├── guards/                # Extensions the researcher loads (shipped in the npm package)
    │   └── researcher-fetch-guard.ts
    └── skills/               # Declared under pi.skills
        ├── pr-workflow/
        │   └── SKILL.md
        ├── the-cock-of-justice/
        │   └── SKILL.md
        └── artifact-review/     # local installs only; excluded from the npm package by package.json "files"
            └── SKILL.md
```

Agent files use YAML frontmatter (`name`, `package`, `description`, `model`, `thinking`, `tools`, `acceptanceRole`, etc.) with the body as the system prompt. Skills follow the [Agent Skills standard](https://agentskills.io/specification): a directory containing `SKILL.md` with `name` + `description` frontmatter and instructions.

### Naming convention

Agent files live under `agents/` without a `kosmos-` prefix. The runtime name is formed from `package:` + `name:` in frontmatter:

- `package: kosmos`, `name: coder` → `kosmos.coder`
- `package: kosmos`, `name: orchestrator` → `kosmos.orchestrator`

This keeps the filenames short while avoiding namespace collisions with other packages.

### Why two manifest keys?

Pi core reads the `pi` manifest in `package.json` for shared resources (skills, extensions, prompts, themes). The `pi-subagents` package extends Pi with its own agent-discovery machinery and reads from a separate `pi-subagents` key (or a nested `pi.subagents` key). Skills are core, so they go under `pi.skills`; agents are an extension point, so they go under `pi-subagents.agents`. The package declares `pi-subagents` as a peer dependency to make the dependency explicit.

## Conversion notes

These agents were ported from OpenCode (`.config/opencode/agents/*.md`) to Pi's frontmatter format. Mapping applied:

| OpenCode | Pi |
|---|---|
| `mode: subagent` + `permission.{edit,bash}: deny` | `acceptanceRole: read-only` + `tools` allowlist omits edit/write/bash |
| `mode: primary` (orchestrator) | Remains a subagent; only Pi parents can spawn. Orchestrator doc explains the parent-spawns-children model |
| `temperature: 0.1` | `thinking: high` |
| `temperature: 0.2-0.3` | `thinking: medium` |
| `steps: N` | Removed — pi-subagents has no per-agent turn limit (0.89.1 frontmatter has no such field) |
| `permission.task: "agent": allow` | Removed for the coder — it has no `subagent` tool. `kosmos.orchestrator` keeps it and dispatches the specialists itself. |
| `permission.question: allow` | Removed — no Pi equivalent for subagents |
| `model: provider/X` | `model: X` (Pi uses `defaultProvider` from settings) |
| `color`, `webfetch` | Removed (cosmetic / non-equivalent) |

Skills were ported from `~/.config/opencode/skills/*/SKILL.md` to the package's `skills/` directory. The bodies are largely the same; the only meaningful changes replace OpenCode's `task` tool with Pi's `subagent(...)` tool and note the parent-spawns-children model.

## Publishing

To publish to npm so others can `npm:kosmos-pi`:

```bash
cd ~/Dotfiles/kosmos-pi
npm login
npm publish --access public
```

After publishing, the install snippet at the top of this README works for anyone.

Bump the version in `package.json` and re-publish when adding new agents, skills, or changing existing ones. Pi caches package metadata at startup, so users will need to restart Pi after a version bump.

## Development

Edit any agent or skill file directly in `agents/` or `skills/`. Restart Pi to pick up the changes (or run `/reload` if your version supports it).

To verify frontmatter parses cleanly without launching Pi, use the `pi-subagents` parser directly:

```bash
node --no-warnings -e "
  import(process.env.HOME + '/.pi/agent/npm/node_modules/pi-subagents/src/agents/frontmatter.js').then(({ parseFrontmatter }) => {
    import('node:fs').then((fs) => {
      for (const f of fs.readdirSync('./agents')) {
        const { frontmatter } = parseFrontmatter(fs.readFileSync('./agents/' + f, 'utf8'));
        console.log(f, '→', frontmatter.name, '(' + (frontmatter.description || '').length + 'ch)');
      }
    });
  });
"
```

All agents must have a `name` and a `description` under 1024 chars. All skills follow the same constraints.

## License

MIT — see [LICENSE](./LICENSE).

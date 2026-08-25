# kosmos-pi

A portable [Pi](https://github.com/badlogic/pi-mono) package that ships a senior engineering agent team and supporting skills. Install once on any machine, get the same specialists every time.

Originally converted from OpenCode agents into Pi's frontmatter format; see [Conversion notes](#conversion-notes) below for the mapping applied.

## What's inside

### Agents (6)

| Agent | Tier | Mode | Purpose |
|---|---|---|---|
| `kosmos.coder` | MiniMax-M2.7 | read/write, medium thinking | Routine implementation: small diffs, clear existing patterns, single file or small file set |
| `kosmos.pro-coder` | MiniMax-M3 | read/write, high thinking | Complex work: new modules, public APIs, cross-cutting refactors, perf/security-sensitive changes |
| `kosmos.code-reviewer` | MiniMax-M3 | read-only, high thinking | 12-category audit (correctness, security, perf, reliability, concurrency, …) with severity-ranked findings |
| `kosmos.security-auditor` | MiniMax-M3 | read-only, medium thinking | 15-layer threat model + OWASP-focused security audit |
| `kosmos.docs-writer` | MiniMax-M2.5 | read-only, low thinking | READMEs, API refs, guides, tutorials, ADRs, changelogs |
| `kosmos.orchestrator` | MiniMax-M3 | read-only, high thinking | Senior tech-lead: challenges the plan, picks the right coder tier, fans out specialists in parallel via `subagent(...)` |

Runtime agent names are formed from the `package:` + `name:` frontmatter fields (`kosmos` + `coder` → `kosmos.coder`). Each agent file lives under `agents/` without a `kosmos-` prefix.

### Skills (2)

| Skill | Purpose |
|---|---|
| `pr-workflow` | Full PR protocol: pre-flight → commit hygiene → PR description → self-review via specialist fan-out |
| `the-cock-of-justice` | Dual-lens verdict (spec + quality reviewers in parallel) → ACCEPTED / WARNING / FAIL |

## Install

Run the install script once on each machine:

```bash
~/Dotfiles/bin/install-kosmos-pi.sh
```

The script (see [`bin/install-kosmos-pi.sh`](./bin/install-kosmos-pi.sh) for the full source):

1. Installs the `kosmos-pi` npm package into `~/.pi/agent/npm/`.
2. Adds `"npm:kosmos-pi"` to `~/.pi/agent/settings.json` if not already present.
3. Syncs `~/Dotfiles/pi/agent/` → `~/.pi/agent/` (per-file/per-subtree rsync of `SYSTEM.md`, `settings.json`, `themes/`, `mcp.json` — leaves `npm/`, `agents/`, `sessions/`, etc. untouched).
4. Syncs `~/Dotfiles/config/mcp/` → `~/.config/mcp/` (`mcp.json` only).
5. Reports what changed. Safe to re-run.

After running it, restart Pi. The 6 agents appear under `kosmos.*` and the 2 skills under `/skill:pr-workflow` and `/skill:the-cock-of-justice`.

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
  "packages": ["npm:/absolute/path/to/Dotfiles/kosmos-pi"]
}
```

Relative paths work too if the package is inside your Pi project or dotfiles repo:

```json
{
  "packages": ["npm:./kosmos-pi"]
}
```

## Portable config tree

Two subtrees in the Dotfiles repo are kept in sync with the live Pi config:

- `pi/agent/` — Pi agent-level settings:
  - `SYSTEM.md` — parent system prompt injected into all Pi sessions
  - `settings.json` — user preferences, theme, default model, packages list
  - `themes/kosmos.json` — custom theme
  - `mcp.json` — per-agent MCP server definitions
- `config/mcp/` — global MCP config:
  - `mcp.json` — globally available MCP servers

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
3. Pick the right coder tier (`kosmos.coder` vs `kosmos.pro-coder`) based on signals, not safety.
4. Fan out specialists in parallel via `subagent(tasks: [...])`.
5. Synthesize their findings into one consolidated report with a ship verdict.

A typical invocation:

```typescript
subagent({
  agent: "kosmos.orchestrator",
  task: "Plan and review the change in src/billing/. Branch: feat/usage-based-pricing. Goal: tier-based pricing with metered overages."
})
```

### Using the PR workflow skill

When the user says "open a PR", "prepare a PR", or "review my PR before I open it", fire `/skill:pr-workflow`. The skill walks through four phases (pre-flight → commit hygiene → PR description → self-review) and produces a complete PR package without ever pushing or merging.

### Using the verdict skill

When the user asks for "the cock of justice", a "verdict", or wants a hard go / no-go on a plan or diff, fire `/skill:the-cock-of-justice`. The skill spawns exactly two reviewers in parallel (spec lens + quality lens) and returns ACCEPTED / WARNING / FAIL with a deduplicated concern list.

## Project layout

```
Dotfiles/
├── bin/
│   └── install-kosmos-pi.sh   # Idempotent installer
├── config/
│   └── mcp/
│       └── mcp.json           # Global MCP server config
├── pi/
│   └── agent/
│       ├── SYSTEM.md          # Parent system prompt
│       ├── settings.json       # User preferences, theme, packages
│       ├── mcp.json           # Per-agent MCP servers
│       └── themes/
│           └── kosmos.json    # Custom theme
└── kosmos-pi/                 # The Pi package
    ├── package.json           # pi + pi-subagents manifest
    ├── README.md
    ├── LICENSE
    ├── agents/                # Declared under pi-subagents.agents
    │   ├── orchestrator.md
    │   ├── coder.md
    │   ├── pro-coder.md
    │   ├── code-reviewer.md
    │   ├── security-auditor.md
    │   └── docs-writer.md
    └── skills/               # Declared under pi.skills
        ├── pr-workflow/
        │   └── SKILL.md
        └── the-cock-of-justice/
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
| `steps: N` | `turnBudget: { maxTurns: N, graceTurns: N/4 }` |
| `permission.task: "agent": allow` | Removed — children don't spawn in Pi; orchestrator doc explains parent uses `subagent(...)` |
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
node --experimental-strip-types --no-warnings -e "
  import('/path/to/pi-subagents/src/agents/frontmatter.ts').then(({ parseFrontmatter }) => {
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

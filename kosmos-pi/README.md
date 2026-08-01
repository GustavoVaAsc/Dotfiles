# kosmos-pi

A portable [Pi](https://github.com/badlogic/pi-mono) package that ships a senior engineering agent team and supporting skills. Install once on any machine, get the same specialists every time.

Originally converted from OpenCode agents into Pi's frontmatter format; see [Conversion notes](#conversion-notes) below for the mapping applied.

## What's inside

### Agents (6)

| Agent | Tier | Mode | Purpose |
|---|---|---|---|
| `kosmos-coder` | MiniMax-M2.7 | read/write, medium thinking | Routine implementation: small diffs, clear existing patterns, single file or small file set |
| `kosmos-pro-coder` | MiniMax-M3 | read/write, high thinking | Complex work: new modules, public APIs, cross-cutting refactors, perf/security-sensitive changes |
| `kosmos-code-reviewer` | MiniMax-M3 | read-only, high thinking | 12-category audit (correctness, security, perf, reliability, concurrency, …) with severity-ranked findings |
| `kosmos-security-auditor` | MiniMax-M3 | read-only, high thinking | 15-layer threat model + OWASP-focused security audit |
| `kosmos-docs-writer` | MiniMax-M2.5 | read-only, medium thinking | READMEs, API refs, guides, tutorials, ADRs, changelogs |
| `kosmos-orchestrator` | MiniMax-M3 | read-only, high thinking | Senior tech-lead: challenges the plan, picks the right coder tier, fans out specialists in parallel via `subagent(...)` |

### Skills (2)

| Skill | Purpose |
|---|---|
| `pr-workflow` | Full PR protocol: pre-flight → commit hygiene → PR description → self-review via specialist fan-out |
| `the-cock-of-justice` | Dual-lens verdict (spec + quality reviewers in parallel) → ACCEPTED / WARNING / FAIL |

## Install

### From npm (after publishing)

Add to your `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:kosmos-pi"]
}
```

Then restart Pi. The 6 agents and 2 skills appear automatically.

### From a local checkout (for development)

```json
{
  "packages": ["npm:/absolute/path/to/Dotfiles/kosmos-pi"]
}
```

Relative paths work too if you keep the package inside your Pi project or dotfiles repo:

```json
{
  "packages": ["npm:./kosmos-pi"]
}
```

After restarting Pi, run `/agents` to confirm the kosmos-* agents are loaded, and `/skill:pr-workflow` (or `/skill:the-cock-of-justice`) to invoke a skill.

## Usage

### Spawning a specialist directly

From the parent Pi session, use the `subagent(...)` tool (from the `pi-subagents` package):

```typescript
subagent({
  agent: "kosmos-code-reviewer",
  task: "Review the diff in src/auth/login.ts for the last 3 commits."
})
```

The `agent` name is the unprefixed local name. Pi resolves it through its discovery chain (built-in → user → project → package).

### Orchestrating multi-agent work

The `kosmos-orchestrator` agent is meant to be invoked by the parent session. It will:

1. Challenge your proposed plan and surface alternatives.
2. Ask clarifying questions if scope or approach is ambiguous.
3. Pick the right coder tier (`kosmos-coder` vs `kosmos-pro-coder`) based on signals, not safety.
4. Fan out specialists in parallel via `subagent(tasks: [...])`.
5. Synthesize their findings into one consolidated report with a ship verdict.

A typical invocation:

```typescript
subagent({
  agent: "kosmos-orchestrator",
  task: "Plan and review the change in src/billing/. Branch: feat/usage-based-pricing. Goal: tier-based pricing with metered overages."
})
```

### Using the PR workflow skill

When the user says "open a PR", "prepare a PR", or "review my PR before I open it", fire `/skill:pr-workflow`. The skill walks through four phases (pre-flight → commit hygiene → PR description → self-review) and produces a complete PR package without ever pushing or merging.

### Using the verdict skill

When the user asks for "the cock of justice", a "verdict", or wants a hard go / no-go on a plan or diff, fire `/skill:the-cock-of-justice`. The skill spawns exactly two reviewers in parallel (spec lens + quality lens) and returns ACCEPTED / WARNING / FAIL with a deduplicated concern list.

## Project layout

```
kosmos-pi/
├── package.json              # pi + pi-subagents manifest
├── README.md
├── LICENSE
├── .npmignore
├── agents/                   # Declared under pi-subagents.agents
│   ├── kosmos-code-reviewer.md
│   ├── kosmos-coder.md
│   ├── kosmos-docs-writer.md
│   ├── kosmos-orchestrator.md
│   ├── kosmos-pro-coder.md
│   └── kosmos-security-auditor.md
└── skills/                   # Declared under pi.skills
    ├── pr-workflow/
    │   └── SKILL.md
    └── the-cock-of-justice/
        └── SKILL.md
```

Each agent is a single Markdown file with YAML frontmatter (`name`, `description`, `model`, `thinking`, `tools`, `acceptanceRole`, etc.) and a system prompt body. Each skill follows the [Agent Skills standard](https://agentskills.io/specification): a directory containing `SKILL.md` with `name` + `description` frontmatter and instructions.

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

Skills were ported from `~/.config/opencode/skills/*/SKILL.md` to Pi's `~/.pi/agent/skills/` global skill directory. The bodies are largely the same; the only meaningful changes replace OpenCode's `task` tool with Pi's `subagent(...)` tool and note the parent-spawns-children model.

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

All agents must have a `name` matching `^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$` and a `description` under 1024 chars. All skills follow the same constraints.

## License

MIT — see [LICENSE](./LICENSE).

# AI Harness Backlog

Ideas for the kosmos agent system (Claude Code, Pi and OpenCode). Nothing here is planned yet.

## Open questions

- **Where the harness lives.** Decide whether to keep the harness in the dotfiles or move it to a self-contained project.

## Ideas

### 1. Memory system

Keep memory separately for each repository and workstream, and load it efficiently. The main goal is to limit context poisoning. The memory systems used so far bring in unrelated things, so recall should stay scoped to the current repo and workstream.

### 2. Own antislop

Build an in-house antislop based on the one currently installed. Its skills and tools should be managed here, not taken from upstream.

### 3. Coder command safety

Stop the coder agents from running commands that wait for a long time, and mitigate infinite loops in the commands they run.

### 4. Learning mode (`kosmos-mentor`)

Add a learning mode to the harness. It swaps the orchestrator for an agent named `kosmos-mentor`.

### 5. One source for the prompts

Write each agent prompt and skill once, then generate the Claude Code, Pi and OpenCode versions from it. Today the same rule is kept in sync by hand in several files.

### 6. Parity check

A script that compares what each harness actually installed and flags any drift between Claude Code, Pi and OpenCode.

### 7. `kosmos doctor`

One command that checks the setup:

- the symlinks and installers;
- the provider keys and the MiMo cookie (present, not expired);
- that the MCP servers are reachable;
- that the agent files load.

### 8. Test setup for extensions

A committed tsconfig and a small test runner for `pi/agent/extensions/`. Right now type checks borrow a TypeScript binary from another project, and the extensions have no tests.

### 9. Findings ledger

Record code-review findings per repository. Findings that keep coming back get fed into future coder briefs.

> **Needs more thought:** this could be invasive. Assess it properly before committing to it.

### 10. Budget guardrails

A spend cap per task or per session, with a warning in the footer and a hard stop for runaway subagents.

> **Needs more thought:** assess this properly before committing to it.

### 11. Parallel coders in isolated worktrees

Give each coder its own git worktree, so independent changes can run in parallel without stepping on each other.

### 12. Workstream handoff notes

At the end of a session, write a short summary of decisions, open questions and next steps. This could feed the memory system (item 1).

### 13. Completion notifications

A desktop or kitty notification when a long delegation or review loop finishes, or needs input.

### 14. Secret scrubbing

Catch API keys, cookies and tokens before they are written to transcripts or logs.

### 15. Tools called from code instead of loaded into context

Based on Anthropic's engineering posts on code execution with MCP. Don't load every tool definition into context up front. The agent discovers tools when it needs them and writes a small script that calls them. Large results are filtered in that script, so only a summary comes back into context. This lowers the hidden token cost of tool definitions and large tool results, which grows with every MCP server registered. Skills already load only when needed; this applies the same idea to tools.

### 16. Artifact reviewer

A browser page for reviewing a Markdown document the agent wrote, then sending structured feedback back to the agent. It doubles as a way to produce documentation and designs that live in the repo.

- **Rendering:** a purple theme; headers, lists, tables, code; Mermaid diagrams (flowcharts and similar); images and videos the agent generated (JavaScript rendering, manim or any other tool), referenced from the document.
- **Questions:** the agent embeds questions in the document in a standard format. The page renders them as single choice, multiple choice or free text, so the reviewer clicks an option or writes their own answer.
- **Comments:** comments anchored to a line (or range) of the Markdown source, saying what should change and how.
- **Review loop:** comments and answers are saved as the review goes, then submitted together when the review is done. The agent receives them with line references, addresses them, and the next round starts.
- **Storage:** documents, their assets and the reviews are saved in the repo.

> **Scope first:** pick the toolchain (vanilla JavaScript or a framework), the question format and how the feedback gets back to the agent before handing it to the coder.

## Considered, not now

- **Prompt regression evals.** The workflow is still being evaluated through daily use. Writing evals now would lock in behaviours that may be removed later.
- **Quota-aware model routing.** Cost efficiency should be designed in from the start, not added as a routing layer on top. Look at other mechanisms instead.
- **Delegation trace.** The current footer cost split is enough.

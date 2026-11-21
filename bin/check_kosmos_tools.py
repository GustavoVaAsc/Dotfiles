#!/usr/bin/env python3
"""Check that every tool a kosmos-pi agent names can be loaded by its child.

`subagents.defaultExtensions: []` stops pi-subagents children from loading
ambient extensions, so an agent that names an extension-provided tool
(web_search, ...) fails at launch unless its `extensions` list loads the
provider. For every kosmos-pi agent, each tool must be a Pi builtin, a
pi-subagents runtime tool, or a tool of a provider the agent lists. Builtin
agents that use provider tools (researcher, evidence-auditor) need an
`agentOverrides.<name>.extensions` entry in settings.json.

Usage: check_kosmos_tools.py SETTINGS AGENTS_DIR [--installed PI_SUBAGENTS_DIR]

Without --installed only the agent files and the hardcoded builtin table are
checked (run it before the pinned npm install). With --installed it also scans
the builtin agents of the installed pi-subagents package and warns when a
listed extension path does not exist (run it after the install).

Exits 1 with one `error:` line per problem, naming the agent, the tool and the
missing provider.
"""
import json
import os
import pathlib
import re
import sys

# Tools Pi itself provides in every session.
PI_BUILTIN_TOOLS = {"read", "bash", "powershell", "edit", "write", "grep", "find", "ls"}

# Tools the pi-subagents child runtime registers in every child, whatever
# `extensions` says (subagent-prompt-runtime and fanout-child; see
# docs/agents.md "Extension loading"). `intercom` is NOT here: it comes from a
# separate extension.
SUBAGENTS_RUNTIME_TOOLS = {
    "subagent", "subagent_supervisor", "contact_supervisor", "structured_output",
    "watchdog_diff", "subagent_command", "bg_wait",
}

# Extension-provided tools: package name -> the tools it registers. A child
# loads none of these unless the agent's `extensions` lists the provider.
# Add a row here when an agent starts using a tool from another package.
PROVIDER_TOOLS = {
    "pi-web-access": {"web_search", "fetch_content", "get_search_content", "source_check"},
}
PROVIDER_EXAMPLE = {
    "pi-web-access": "~/.pi/agent/npm/node_modules/pi-web-access",
}
TOOL_PROVIDER = {tool: pkg for pkg, tools in PROVIDER_TOOLS.items() for tool in tools}

# pi-subagents builtins that name provider tools (their own `tools:` lists in
# pi-subagents 0.89.1). They are covered by `defaultExtensions: []` too, so each
# needs an `agentOverrides.<name>.extensions` entry for the providers of ITS OWN
# tools. Review this table when the pinned pi-subagents version changes; the
# --installed scan catches builtins that were added.
BUILTIN_TOOLS = {
    "researcher": ["read", "write", "web_search", "fetch_content", "get_search_content", "source_check"],
    "evidence-auditor": ["read", "web_search", "fetch_content", "get_search_content", "source_check"],
}

# Wrapper extensions that register a provider's tools themselves: a guard that installs its
# `tool_call` checks and then calls the provider package's default export with the same API object.
# An `extensions` entry ending in one of these paths provides every tool of that package, so the
# agent need not (and for fail-closed guards must not) list the package itself.
PROVIDER_WRAPPERS = {
    "pi-web-access": ("/kosmos-pi/guards/researcher-fetch-guard.ts",),
}

_UNSAFE = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def clean(value):
    """Names come from agent files; strip control characters before printing them."""
    return _UNSAFE.sub("", str(value))


def parse_list(value, block):
    items = []
    for raw in ([value] if value else []) + block:
        raw = raw.strip()
        if raw.startswith("- "):
            raw = raw[2:]
        for part in raw.split(","):
            part = part.strip().strip("'\"").strip()
            if part:
                items.append(part)
    return items


def parse_frontmatter(text):
    """The subset of pi-subagents' frontmatter parser this check needs."""
    text = text.replace("\r\n", "\n")
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end == -1:
        return {}
    fm, key, block = {}, None, []

    def flush():
        if key is not None:
            fm[key] = (fm[key][0], block[:])

    for line in text[4:end].split("\n"):
        if key is not None and line[:1] in (" ", "\t") and line.strip():
            block.append(line.strip())
            continue
        flush()
        key, block = None, []
        if ":" in line and not line.startswith(("#", " ", "\t")):
            k, _, v = line.partition(":")
            key = k.strip()
            fm[key] = (v.strip(), [])
    flush()
    return {k: parse_list(v, b) if k in ("tools", "extensions") else v for k, (v, b) in fm.items()}


def provider_listed(entries, pkg):
    """True when an `extensions` entry points at the provider package."""
    for entry in entries:
        entry = entry.rstrip("/")
        if any(entry.endswith(wrapper) for wrapper in PROVIDER_WRAPPERS.get(pkg, ())):
            return True
        if entry == f"npm:{pkg}" or entry.split("/")[-1] == pkg or f"/node_modules/{pkg}/" in entry + "/":
            return True
    return False


def is_path_like(tool):
    return "/" in tool or tool.endswith((".ts", ".js"))


def check_tools(label, tools, extensions, errors, notes):
    for tool in tools:
        if tool in PI_BUILTIN_TOOLS or tool in SUBAGENTS_RUNTIME_TOOLS or is_path_like(tool):
            continue  # a path-like tools entry loads that extension itself
        if tool.startswith("mcp:"):
            notes.append(f"{label}: tool '{clean(tool)}' is an MCP selection; not checked (needs pi-mcp-adapter loaded in the child)")
            continue
        pkg = TOOL_PROVIDER.get(tool)
        if pkg is None:
            errors.append(
                f"{label}: tool '{clean(tool)}' is neither a Pi builtin, a pi-subagents runtime tool nor in "
                f"the provider map; add it to PROVIDER_TOOLS in bin/check_kosmos_tools.py (or fix the name)"
            )
        elif not provider_listed(extensions, pkg):
            errors.append(
                f"{label}: tool '{clean(tool)}' needs extension provider '{pkg}' but its extensions do not "
                f"list it (add 'extensions: {PROVIDER_EXAMPLE[pkg]}')"
            )


def expand(entry):
    return pathlib.Path(os.path.expanduser(entry))


def check(settings_path, agents_dir, installed_dir=None):
    """Return (errors, warnings, notes, summary)."""
    settings = json.loads(pathlib.Path(settings_path).read_text(encoding="utf-8"))
    subagents = settings.get("subagents", {})
    overrides = subagents.get("agentOverrides", {})
    default_extensions = subagents.get("defaultExtensions")
    errors, warnings, notes = [], [], []
    seen_paths = set()
    checked = 0

    def note_paths(label, entries):
        if installed_dir is None:
            return
        for entry in entries:
            if entry in seen_paths or entry.startswith("npm:") or not ("/" in entry or entry.startswith("~")):
                continue
            seen_paths.add(entry)
            if not expand(entry).exists():
                warnings.append(f"{label}: extension path '{clean(entry)}' does not exist")

    for path in sorted(pathlib.Path(agents_dir).glob("*.md")):
        fm = parse_frontmatter(path.read_text(encoding="utf-8"))
        name = fm.get("name")
        if not name or "tools" not in fm or fm["tools"] == ["inherit"]:
            continue
        runtime_name = f"{fm['package']}.{name}" if fm.get("package") else name
        # pi-subagents applies `agentOverrides` to builtin agents only, so a packaged agent never
        # inherits the override of a builtin with the same bare name (kosmos.researcher vs researcher).
        override = overrides.get(runtime_name, {})
        if "extensions" in override and override["extensions"] is not False:
            extensions = override["extensions"]
        elif "extensions" in fm:
            extensions = fm["extensions"]
        else:
            extensions = default_extensions or []
        checked += 1
        label = f"agent {clean(runtime_name)} ({clean(path.name)})"
        check_tools(label, fm["tools"], extensions, errors, notes)
        note_paths(label, extensions)

    builtins = {name: list(tools) for name, tools in BUILTIN_TOOLS.items()}
    if installed_dir is not None and (pathlib.Path(installed_dir) / "agents").is_dir():
        for path in sorted((pathlib.Path(installed_dir) / "agents").glob("*.md")):
            fm = parse_frontmatter(path.read_text(encoding="utf-8"))
            if fm.get("name") and any(t in TOOL_PROVIDER for t in fm.get("tools", [])):
                builtins[fm["name"]] = fm["tools"]
    # An override with `"disabled": true` (a boolean, exactly) hides the builtin from discovery, so it
    # cannot run and needs no extensions. Overrides apply to builtins only: the packaged-agent loop
    # above never looks at `disabled`.
    builtins = {name: tools for name, tools in builtins.items() if overrides.get(name, {}).get("disabled") is not True}
    for name, tools in sorted(builtins.items()):
        override = overrides.get(name, {})
        extensions = override.get("extensions") or []
        for pkg in sorted({TOOL_PROVIDER[t] for t in tools if t in TOOL_PROVIDER}):
            if not provider_listed(extensions, pkg):
                errors.append(
                    f"builtin agent {clean(name)}: uses {pkg} tools but "
                    f"subagents.agentOverrides.{clean(name)}.extensions in settings.json does not list "
                    f"'{pkg}' (add \"{PROVIDER_EXAMPLE[pkg]}\")"
                )
        note_paths(f"builtin agent {clean(name)}", extensions)

    summary = f"tool guard: {checked} kosmos-pi agents and {len(builtins)} builtin overrides load every extension tool they name"
    return errors, warnings, notes, summary


def main(argv):
    args = argv[1:]
    installed = None
    if "--installed" in args:
        i = args.index("--installed")
        if i + 1 >= len(args):
            print(__doc__, file=sys.stderr)
            return 2
        installed = args[i + 1]
        del args[i:i + 2]
    if len(args) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    errors, warnings, notes, summary = check(args[0], args[1], installed)
    for message in notes:
        print(f"  note: {message}")
    for message in warnings:
        print(f"warning: {message}", file=sys.stderr)
    if errors:
        for message in errors:
            print(f"error: {message}", file=sys.stderr)
        return 1
    print(f"  ✓ {summary}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

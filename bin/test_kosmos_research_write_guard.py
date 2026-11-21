"""Tests for bin/kosmos-research-write-guard, the PreToolUse hook that fences the researcher's Write. Run: python3 -I -m unittest discover -s bin -p 'test_*.py'"""
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest

BIN = pathlib.Path(__file__).resolve().parent
GUARD = BIN / "kosmos-research-write-guard"
AGENT = BIN.parent / "claude" / "agents" / "kosmos-researcher.md"
ALLOW = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow",
                                "permissionDecisionReason": "kosmos-research-write-guard: a report inside docs/research/"}}


def frontmatter():
    """The agent file's frontmatter: the text between the opening '---' line and the first '\\n---\\n'."""
    text = AGENT.read_text()
    assert text.startswith("---\n")
    return text[4:].split("\n---\n")[0]


def hook_commands():
    """matcher (as written) -> hook command, for every PreToolUse hook in the frontmatter."""
    found = {}
    for block in frontmatter().split("- matcher: ")[1:]:
        matcher = block.splitlines()[0].strip()
        command = re.search(r"^\s+command: (.+)$", block, re.M).group(1).strip()
        found[matcher] = json.loads(command) if command[0] == '"' else command.strip("'")
    return found


WRITE_MATCHER = '"Write"'
WEB_MATCHER = '"WebSearch|WebFetch|mcp__context7__resolve-library-id|mcp__context7__query-docs"'
WRITE_COMMAND = 'python3 -I "$HOME/Dotfiles/bin/kosmos-research-write-guard" || exit 2'
WEB_COMMAND = 'python3 -I "$HOME/Dotfiles/bin/kosmos-research-web-guard" || exit 2'


class GuardTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = pathlib.Path(os.path.realpath(tmp.name))
        self.root = self.base / "project"
        (self.root / "docs" / "research").mkdir(parents=True)
        (self.root / ".claude").mkdir()
        self.outside = self.base / "outside"
        self.outside.mkdir()

    def payload(self, file_path, tool_name="Write", **extra):
        return {"session_id": "s", "cwd": str(self.root), "hook_event_name": "PreToolUse",
                "tool_name": tool_name, "tool_input": {"file_path": file_path, "content": "# report\n"}, **extra}

    def run_guard(self, stdin, project_dir="default", env_extra=None):
        env = {k: v for k, v in os.environ.items() if k != "CLAUDE_PROJECT_DIR"}
        if project_dir == "default":
            env["CLAUDE_PROJECT_DIR"] = str(self.root)
        elif project_dir is not None:
            env["CLAUDE_PROJECT_DIR"] = project_dir
        env.update(env_extra or {})
        data = stdin if isinstance(stdin, bytes) else (stdin if isinstance(stdin, str) else json.dumps(stdin)).encode()
        return subprocess.run([sys.executable, "-I", str(GUARD)], input=data, env=env, capture_output=True, cwd=self.base)

    def assert_allowed(self, stdin, **kw):
        result = self.run_guard(stdin, **kw)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(result.stdout), ALLOW)
        self.assertEqual(result.stdout.count(b"\n"), 1)
        return result

    def assert_blocked(self, stdin, reason=None, **kw):
        result = self.run_guard(stdin, **kw)
        self.assertEqual(result.returncode, 2, (stdin, result.stderr.decode()))
        self.assertEqual(result.stdout, b"")
        stderr = result.stderr.decode()
        self.assertIn("kosmos-research-write-guard", stderr)
        if reason:
            self.assertIn(reason, stderr)
        return result

    def target(self, name="topic.md"):
        return str(self.root / "docs" / "research" / name)

    # --- allowed -------------------------------------------------------------

    def test_allows_a_report_in_the_research_folder(self):
        self.assert_allowed(self.payload(self.target()))

    def test_allow_is_exactly_the_pretooluse_allow_decision(self):
        result = self.run_guard(self.payload(self.target()))
        self.assertEqual(result.stdout, (json.dumps(ALLOW) + "\n").encode())
        self.assertEqual(result.stderr, b"")

    def test_a_blocked_write_never_emits_an_allow(self):
        for path in [str(self.root / ".claude" / "settings.md"), "docs/research/x.md", self.target("x.txt")]:
            self.assertEqual(self.assert_blocked(self.payload(path)).stdout, b"")
        for stdin in [b"", b"{", self.payload(self.target(), tool_name="Edit")]:
            self.assertEqual(self.run_guard(stdin).stdout, b"")

    def test_allows_realistic_slugs(self):
        for name in ["a.md", "a-react-19-hooks.md", "b_2.md", "v1-2-notes.md", "0day.md", "claude-notes.md", "agents-md-survey.md", ("x" * 64) + ".md"]:
            self.assert_allowed(self.payload(self.target(name)))

    def test_allows_rewriting_an_existing_report(self):
        pathlib.Path(self.target()).write_text("old")
        self.assert_allowed(self.payload(self.target()))

    def test_allows_when_the_research_folder_does_not_exist_yet(self):
        (self.root / "docs" / "research").rmdir()
        self.assert_allowed(self.payload(self.target()))
        (self.root / "docs").rmdir()
        self.assert_allowed(self.payload(self.target()))

    def test_allows_a_large_payload(self):
        payload = self.payload(self.target())
        payload["tool_input"]["content"] = "x" * 2_000_000
        self.assert_allowed(payload)

    def test_project_root_may_sit_behind_a_symlink_but_a_foreign_symlink_prefix_is_blocked(self):
        link = self.base / "link"
        link.symlink_to(self.root, target_is_directory=True)
        via_link = str(link / "docs" / "research" / "topic.md")
        via_real = self.target()
        self.assert_allowed(self.payload(via_link), project_dir=str(link))
        self.assert_allowed(self.payload(via_real), project_dir=str(link))
        self.assert_allowed(self.payload(via_real), project_dir=str(self.root))
        self.assert_blocked(self.payload(via_link), "outside the project root", project_dir=str(self.root))

    # --- blocked: location ---------------------------------------------------

    def test_blocks_everything_outside_the_research_folder(self):
        for path in [
            "/etc/passwd.md",
            str(self.outside / "docs" / "research" / "x.md"),
            str(self.root) + "-evil/docs/research/x.md",
            str(self.root / "x.md"),
            str(self.root / "docs" / "x.md"),
            str(self.root / "docs" / "research.md"),
            str(self.root / "docs" / "reviews" / "r" / "doc.md"),
            str(self.root / "docs" / "research-old" / "x.md"),
            str(self.root / ".claude" / "settings.md"),
            str(self.root / ".claude" / "agents" / "evil.md"),
            str(self.root / "CLAUDE.md"),
            str(self.root / "docs" / "research"),
            str(self.root / "docs" / "research") + "/",
            self.target("sub/x.md"),
            self.target("sub.md/x.md"),
            self.target("a.md/b.md/c.md"),
            str(self.root) + "Xdocs/research/x.md",
            str(self.root) + "-docs/research/x.md",
            str(self.root / "sub" / "docs" / "research" / "x.md"),
        ]:
            self.assert_blocked(self.payload(path))

    def test_blocks_dot_dot_traversal(self):
        for path in [
            str(self.root / "docs" / "research" / ".." / ".." / ".claude" / "x.md"),
            str(self.root / "docs" / "research" / ".." / "research" / "x.md"),
            str(self.root / "docs" / "research" / ".." / "x.md"),
            str(self.root / "docs" / "research" / "x.." / "y.md"),
            "../../etc/x.md",
            str(self.root / "docs" / "research") + "/..",
        ]:
            self.assert_blocked(self.payload(path))
        self.assert_blocked(self.payload(str(self.root / "docs" / "research" / ".." / "x.md")), "..")

    def test_blocks_names_that_are_not_a_lowercase_slug(self):
        for name in ["a..b.md", "..md", ".md", ".hidden.md", "-x.md", "_x.md", "v1.2-notes.md", "A-react.md", "Topic.md",
                     "aB.md", "x.y.md"]:
            self.assert_blocked(self.payload(self.target(name)))

    def test_blocks_instruction_file_names_in_any_case(self):
        # Claude Code and OpenCode load these from a nested folder as trusted instructions.
        for name in ["claude.md", "CLAUDE.md", "Claude.md", "claude.local.md", "CLAUDE.local.md", "agents.md", "AGENTS.md",
                     "Agents.md", "gemini.md", "GEMINI.md", "context.md", "CONTEXT.md"]:
            self.assert_blocked(self.payload(self.target(name)))
        self.assert_blocked(self.payload(self.target("claude.md")), "reserved")

    def test_blocks_non_canonical_spellings(self):
        root = str(self.root)
        for path in [
            root + "/docs//research/x.md",
            root + "//docs/research/x.md",
            root + "/docs/./research/x.md",
            root + "/docs/research/./x.md",
        ]:
            self.assert_blocked(self.payload(path), "canonical")

    def test_blocks_relative_paths(self):
        for path in ["docs/research/x.md", "./docs/research/x.md", "x.md", "~/docs/research/x.md"]:
            self.assert_blocked(self.payload(path), "absolute")

    # --- blocked: names ------------------------------------------------------

    def test_blocks_anything_that_is_not_a_plain_md_name(self):
        for name in ["x.txt", "x", "x.md.sh", "x.sh", "x.MD", "x.markdown", "x.md ", "x md.md", "x\\y.md",
                     "x.json", "settings.json", "x.md~", "x;y.md", "x$y.md", ("x" * 65) + ".md", "é.md"]:
            self.assert_blocked(self.payload(self.target(name)))

    def test_blocks_control_characters_in_the_path(self):
        for char in ["\x00", "\n", "\r", "\t", "\x1b", "\x7f"]:
            self.assert_blocked(self.payload(self.target("x" + char + ".md")), "control")
        self.assert_blocked(self.payload(self.target("x.md") + "\x00.txt"), "control")

    # --- blocked: symlinks ---------------------------------------------------

    def test_blocks_a_symlinked_target_inside_and_outside(self):
        (self.outside / "victim.md").write_text("keep")
        (self.root / "docs" / "research" / "out.md").symlink_to(self.outside / "victim.md")
        self.assert_blocked(self.payload(self.target("out.md")), "symlink")
        (self.root / ".claude" / "settings.md").write_text("keep")
        (self.root / "docs" / "research" / "in.md").symlink_to(self.root / ".claude" / "settings.md")
        self.assert_blocked(self.payload(self.target("in.md")), "symlink")
        (self.root / "docs" / "research" / "dangling.md").symlink_to(self.outside / "nope.md")
        self.assert_blocked(self.payload(self.target("dangling.md")), "symlink")

    def test_blocks_a_symlinked_research_folder(self):
        (self.root / "docs" / "research").rmdir()
        (self.root / "docs" / "research").symlink_to(self.outside, target_is_directory=True)
        self.assert_blocked(self.payload(self.target()), "symlink")
        (self.root / "docs" / "research").unlink()
        (self.root / "docs" / "research").symlink_to(self.root / ".claude", target_is_directory=True)
        self.assert_blocked(self.payload(self.target()), "symlink")

    def test_blocks_a_symlinked_docs_folder(self):
        (self.root / "docs" / "research").rmdir()
        (self.root / "docs").rmdir()
        (self.outside / "research").mkdir()
        (self.root / "docs").symlink_to(self.outside, target_is_directory=True)
        self.assert_blocked(self.payload(self.target()), "symlink")

    def test_blocks_a_dangling_symlinked_docs_folder(self):
        (self.root / "docs" / "research").rmdir()
        (self.root / "docs").rmdir()
        (self.root / "docs").symlink_to(self.outside / "missing", target_is_directory=True)
        self.assert_blocked(self.payload(self.target()), "symlink")

    def test_an_os_error_is_a_normal_block_not_an_internal_error(self):
        # docs/research is a regular file, so lstat of the target raises ENOTDIR.
        (self.root / "docs" / "research").rmdir()
        (self.root / "docs" / "research").write_text("a file")
        result = self.assert_blocked(self.payload(self.target()))
        self.assertNotIn(b"Internal error", result.stderr)
        self.assertIn(b"cannot inspect", result.stderr)
        (self.root / "docs" / "research").unlink()
        (self.root / "docs").rmdir()
        (self.root / "docs").write_text("a file")
        result = self.assert_blocked(self.payload(self.target()))
        self.assertNotIn(b"Internal error", result.stderr)

    def test_blocks_a_target_that_is_not_a_regular_file(self):
        (self.root / "docs" / "research" / "dir.md").mkdir()
        self.assert_blocked(self.payload(self.target("dir.md")), "regular file")
        os.mkfifo(self.target("fifo.md"))
        self.assert_blocked(self.payload(self.target("fifo.md")), "regular file")

    def test_blocks_a_hard_linked_target(self):
        (self.outside / "victim.md").write_text("keep")
        os.link(self.outside / "victim.md", self.target("hard.md"))
        self.assert_blocked(self.payload(self.target("hard.md")), "hard link")

    # --- blocked: the project root -------------------------------------------

    def test_blocks_when_the_project_root_is_unusable(self):
        for project_dir in [None, "", "relative/dir", "/", "//", str(self.root) + "/../project", str(self.root) + "\n"]:
            self.assert_blocked(self.payload(self.target()), project_dir=project_dir)
        self.assert_blocked(self.payload(self.target()), "CLAUDE_PROJECT_DIR", project_dir=None)

    def test_a_trailing_slash_on_the_project_root_is_fine(self):
        self.assert_allowed(self.payload(self.target()), project_dir=str(self.root) + "/")

    def test_does_not_fall_back_to_the_payload_cwd(self):
        self.assert_blocked(self.payload(self.target(), cwd=str(self.root)), "CLAUDE_PROJECT_DIR", project_dir=None)

    def test_the_project_root_is_the_env_not_the_payload(self):
        other = self.base / "other"
        (other / "docs" / "research").mkdir(parents=True)
        self.assert_blocked(self.payload(str(other / "docs" / "research" / "x.md"), cwd=str(other)))

    # --- blocked: malformed input, fail closed -------------------------------

    def test_blocks_malformed_input(self):
        for stdin in [b"", b"   ", b"{", b"not json", b"null", b"[]", b'"Write"', b"42", b"true", b"{}",
                      b"\xff\xfe\x00", b'{"tool_name": "Write"', json.dumps(self.payload(self.target())).encode()[:-5]]:
            self.assert_blocked(stdin)

    def test_blocks_deeply_nested_json_instead_of_crashing_open(self):
        self.assert_blocked(b"[" * 200_000 + b"]" * 200_000)
        self.assert_blocked(b'{"a":' * 200_000)

    def test_blocks_missing_or_mistyped_fields(self):
        good = self.payload(self.target())
        for mutate in [
            lambda p: p.pop("tool_name"),
            lambda p: p.pop("tool_input"),
            lambda p: p["tool_input"].pop("file_path"),
            lambda p: p.update(tool_name=None),
            lambda p: p.update(tool_name=["Write"]),
            lambda p: p.update(tool_input=None),
            lambda p: p.update(tool_input=[self.target()]),
            lambda p: p.update(tool_input=self.target()),
            lambda p: p["tool_input"].update(file_path=None),
            lambda p: p["tool_input"].update(file_path=""),
            lambda p: p["tool_input"].update(file_path=42),
            lambda p: p["tool_input"].update(file_path=[self.target()]),
            lambda p: p["tool_input"].update(file_path={"path": self.target()}),
            lambda p: (p["tool_input"].pop("file_path"), p["tool_input"].update(path=self.target())),
            lambda p: (p["tool_input"].pop("file_path"), p["tool_input"].update(filePath=self.target())),
        ]:
            payload = json.loads(json.dumps(good))
            mutate(payload)
            self.assert_blocked(payload)

    def test_blocks_other_tools_even_with_a_valid_path(self):
        for tool in ["Edit", "MultiEdit", "NotebookEdit", "Bash", "Read", "write", "WRITE", "Write ", "", "mcp__fs__write_file"]:
            self.assert_blocked(self.payload(self.target(), tool_name=tool), "tool")

    def test_ignores_extra_fields(self):
        self.assert_allowed(self.payload(self.target(), agent_id="a1", agent_type="kosmos-researcher", permission_mode="default"))

    def test_the_last_duplicate_key_cannot_swap_the_target(self):
        evil = '{"tool_name":"Write","tool_input":{"file_path":"%s","file_path":"%s"}}' % (self.target(), self.root / ".claude" / "x.md")
        self.assert_blocked(evil)
        evil = '{"tool_name":"Write","tool_input":{"file_path":"%s","file_path":"%s"}}' % (self.root / ".claude" / "x.md", self.target())
        self.assert_blocked(evil)

    def test_stderr_escapes_hostile_paths(self):
        result = self.assert_blocked(self.payload("/x/\x1b[31mred\x1b[0m\n.md"))
        self.assertNotIn(b"\x1b", result.stderr)
        self.assertEqual(result.stderr.count(b"\n"), 1)

    def test_a_blocked_write_leaves_no_file_behind(self):
        self.assert_blocked(self.payload(str(self.root / ".claude" / "settings.json")))
        self.assertEqual(list((self.root / ".claude").iterdir()), [])
        self.assertEqual(list((self.root / "docs" / "research").iterdir()), [])


class AgentFrontmatterTest(unittest.TestCase):
    """The Claude researcher's tool set is exactly the web tools, Write (fenced by the hook) and the two context7 tools."""

    def fields(self):
        out = {}
        for line in frontmatter().splitlines():
            match = re.match(r"^([A-Za-z]+): ?(.*)$", line)
            if match:
                out[match.group(1)] = match.group(2)
        return out

    def test_tools_are_exactly_the_web_tools_write_and_context7(self):
        tools = [t.strip() for t in self.fields()["tools"].split(",")]
        self.assertEqual(sorted(tools), sorted(["WebSearch", "WebFetch", "Write",
                                                "mcp__context7__resolve-library-id", "mcp__context7__query-docs"]))
        self.assertNotIn("disallowedTools", self.fields())

    def test_budget_model_and_context_settings(self):
        fields = self.fields()
        self.assertEqual(fields["maxTurns"], "40")
        self.assertEqual(fields["omitClaudeMd"], "true")
        self.assertEqual(fields["model"], "sonnet")
        self.assertEqual(fields["effort"], "medium")
        self.assertNotIn("permissionMode", fields)

    def test_exactly_two_pretooluse_hooks_with_exact_matchers_and_fail_closed_commands(self):
        front = frontmatter()
        self.assertRegex(front, r"(?m)^hooks:\n  PreToolUse:\n    - matcher: ")
        self.assertEqual(len(re.findall(r"^\s+- type: command$", front, re.M)), 2)
        self.assertEqual(re.findall(r"^\s+- matcher: (.+)$", front, re.M), [WRITE_MATCHER, WEB_MATCHER])
        self.assertEqual(hook_commands(), {WRITE_MATCHER: WRITE_COMMAND, WEB_MATCHER: WEB_COMMAND})
        self.assertEqual(list(re.findall(r"^[A-Za-z]+:", front, re.M)).count("hooks:"), 1)
        self.assertNotIn("PostToolUse", front)

    def test_the_web_matcher_covers_every_non_write_tool_and_nothing_else(self):
        tools = {t.strip() for t in self.fields()["tools"].split(",")}
        self.assertEqual(set(WEB_MATCHER.strip('"').split("|")), tools - {"Write"})


class HookWiringTest(unittest.TestCase):
    """The hook command in the agent frontmatter fails closed when the guard cannot run."""

    @classmethod
    def command(cls):
        return hook_commands()[WRITE_MATCHER]

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = pathlib.Path(os.path.realpath(tmp.name))
        self.project = self.home / "project"
        (self.project / "docs" / "research").mkdir(parents=True)

    def run_hook(self, payload):
        env = {"HOME": str(self.home), "PATH": os.environ["PATH"], "CLAUDE_PROJECT_DIR": str(self.project)}
        return subprocess.run(["sh", "-c", self.command()], input=json.dumps(payload).encode(), env=env, capture_output=True)

    def install_guard(self):
        (self.home / "Dotfiles").mkdir()
        (self.home / "Dotfiles" / "bin").symlink_to(BIN, target_is_directory=True)

    def good(self, name="x.md"):
        return {"tool_name": "Write", "tool_input": {"file_path": str(self.project / "docs" / "research" / name)}}

    def test_allows_and_blocks_through_the_real_command(self):
        self.install_guard()
        allowed = self.run_hook(self.good())
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        self.assertEqual(json.loads(allowed.stdout)["hookSpecificOutput"]["permissionDecision"], "allow")
        blocked = self.run_hook(self.good("../x.md"))
        self.assertEqual(blocked.returncode, 2, blocked.stderr)
        self.assertEqual(blocked.stdout, b"")
        self.assertIn("kosmos-research-write-guard", blocked.stderr.decode())

    def test_a_missing_guard_blocks_instead_of_failing_open(self):
        result = self.run_hook(self.good())
        self.assertEqual(result.returncode, 2, result.stderr)

    def test_a_guard_that_crashes_blocks(self):
        self.install_guard()
        broken = self.home / "Dotfiles"
        (broken / "bin").unlink()
        (broken / "bin").mkdir()
        (broken / "bin" / "kosmos-research-write-guard").write_text("raise SystemExit(1)\n")
        self.assertEqual(self.run_hook(self.good()).returncode, 2)

    def test_a_missing_interpreter_blocks(self):
        self.install_guard()
        env = {"HOME": str(self.home), "PATH": str(self.home), "CLAUDE_PROJECT_DIR": str(self.project)}
        result = subprocess.run(["/bin/sh", "-c", self.command()], input=json.dumps(self.good()).encode(), env=env, capture_output=True)
        self.assertEqual(result.returncode, 2, result.stderr)


class WebHookWiringTest(unittest.TestCase):
    """The web-tool hook command fails closed when its guard cannot run, and approves only what the guard approves."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = pathlib.Path(os.path.realpath(tmp.name))

    def run_hook(self, payload, path=None):
        env = {"HOME": str(self.home), "PATH": path if path is not None else os.environ["PATH"]}
        return subprocess.run(["/bin/sh", "-c", hook_commands()[WEB_MATCHER]], input=json.dumps(payload).encode(), env=env, capture_output=True)

    def install_guard(self):
        (self.home / "Dotfiles").mkdir()
        (self.home / "Dotfiles" / "bin").symlink_to(BIN, target_is_directory=True)

    def test_allows_and_blocks_through_the_real_command(self):
        self.install_guard()
        allowed = self.run_hook({"tool_name": "WebFetch", "tool_input": {"url": "https://react.dev/reference", "prompt": "x"}})
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        self.assertEqual(json.loads(allowed.stdout)["hookSpecificOutput"]["permissionDecision"], "allow")
        for url in ["http://react.dev/", "https://127.0.0.1/", "https://localhost/", "https://x@react.dev/"]:
            blocked = self.run_hook({"tool_name": "WebFetch", "tool_input": {"url": url}})
            self.assertEqual(blocked.returncode, 2, url)
            self.assertEqual(blocked.stdout, b"")
            self.assertIn("kosmos-research-web-guard", blocked.stderr.decode())

    def test_a_missing_guard_blocks_instead_of_failing_open(self):
        result = self.run_hook({"tool_name": "WebSearch", "tool_input": {"query": "react"}})
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(result.stdout, b"")

    def test_a_guard_that_crashes_blocks(self):
        (self.home / "Dotfiles" / "bin").mkdir(parents=True)
        (self.home / "Dotfiles" / "bin" / "kosmos-research-web-guard").write_text("raise SystemExit(1)\n")
        self.assertEqual(self.run_hook({"tool_name": "WebSearch", "tool_input": {"query": "react"}}).returncode, 2)

    def test_a_missing_interpreter_blocks(self):
        self.install_guard()
        result = self.run_hook({"tool_name": "WebSearch", "tool_input": {"query": "react"}}, path=str(self.home))
        self.assertEqual(result.returncode, 2, result.stderr)


if __name__ == "__main__":
    unittest.main()

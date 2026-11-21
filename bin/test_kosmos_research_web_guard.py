"""Tests for bin/kosmos-research-web-guard, the PreToolUse hook that approves the researcher's own web tools. Run: python3 -I -m unittest discover -s bin -p 'test_*.py'"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

BIN = pathlib.Path(__file__).resolve().parent
GUARD = BIN / "kosmos-research-web-guard"
WRITE_GUARD = BIN / "kosmos-research-write-guard"
ALLOW = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow",
                                "permissionDecisionReason": "kosmos-research-web-guard: a researcher web tool call"}}
C7_RESOLVE = "mcp__context7__resolve-library-id"
C7_QUERY = "mcp__context7__query-docs"


def call(tool, **tool_input):
    return {"session_id": "s", "cwd": "/p", "hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": tool_input}


def fetch(url):
    return call("WebFetch", url=url, prompt="summarise")


class WebGuardTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = pathlib.Path(os.path.realpath(tmp.name)) / "home"
        self.home.mkdir()
        self.xdg = pathlib.Path(os.path.realpath(tmp.name)) / "xdg"

    def deny_file(self, location="home"):
        """The user deny-suffix file under the temporary HOME (or XDG_CONFIG_HOME), as a path."""
        base = self.home / ".config" if location == "home" else self.xdg
        return base / "kosmos" / "research-deny-suffixes"

    def write_deny(self, content, location="home"):
        path = self.deny_file(location)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content if isinstance(content, bytes) else content.encode())
        return path

    def run_guard(self, stdin, env=None):
        data = stdin if isinstance(stdin, bytes) else (stdin if isinstance(stdin, str) else json.dumps(stdin)).encode()
        env = {"HOME": str(self.home)} if env is None else env
        return subprocess.run([sys.executable, "-I", str(GUARD)], input=data, env=env, capture_output=True)

    def assert_allowed(self, stdin):
        result = self.run_guard(stdin)
        self.assertEqual(result.returncode, 0, (stdin, result.stderr.decode()))
        self.assertEqual(json.loads(result.stdout), ALLOW)
        self.assertEqual(result.stdout.count(b"\n"), 1)
        self.assertEqual(result.stderr, b"")

    def assert_blocked(self, stdin, reason=None):
        result = self.run_guard(stdin)
        self.assertEqual(result.returncode, 2, (stdin, result.stderr.decode()))
        self.assertEqual(result.stdout, b"", stdin)
        stderr = result.stderr.decode()
        self.assertIn("kosmos-research-web-guard", stderr)
        self.assertEqual(stderr.count("\n"), 1)
        if reason:
            self.assertIn(reason, stderr)

    # --- WebSearch and context7 -----------------------------------------------

    def test_allows_a_well_formed_websearch(self):
        self.assert_allowed(call("WebSearch", query="react 19 use hook"))
        self.assert_allowed(call("WebSearch", query="x", allowed_domains=["react.dev"]))

    def test_websearch_needs_a_nonempty_string_query(self):
        for query in [None, "", "   ", 42, ["a"], {"q": 1}]:
            self.assert_blocked(call("WebSearch", query=query))
        self.assert_blocked(call("WebSearch"))
        self.assert_blocked(call("WebSearch", q="react"))

    def test_allows_well_formed_context7_calls(self):
        self.assert_allowed(call(C7_RESOLVE, libraryName="react", query="hooks"))
        self.assert_allowed(call(C7_QUERY, libraryId="/facebook/react", query="useEffect cleanup"))
        self.assert_allowed(call(C7_RESOLVE))

    def test_context7_input_must_be_an_object(self):
        for tool in (C7_RESOLVE, C7_QUERY):
            for tool_input in [None, [], "react", 7]:
                payload = call(tool)
                payload["tool_input"] = tool_input
                self.assert_blocked(payload)

    # --- WebFetch: allowed ----------------------------------------------------

    def test_allows_public_https_urls(self):
        for url in ["https://react.dev/reference/react/use", "https://docs.python.org/3/library/os.html#os.path",
                    "https://www.npmjs.com/package/@scope/pkg", "https://medium.com/@user/post", "https://a.b/",
                    "https://example.com", "https://example.com?x=1", "https://example.com#frag",
                    "https://example.com:443/x", "https://EXAMPLE.com/Path", "HTTPS://example.com/",
                    "https://xn--80ak6aa92e.com/", "https://sub.domain.example.co.uk/a/b?c=d&e=f",
                    "https://raw.githubusercontent.com/o/r/main/README.md", "https://example.com/a%20b",
                    "https://example.com/?u=http://127.0.0.1/", "https://example.com/127.0.0.1",
                    "https://example.com/p@th", "https://127.0.0.1.nip.io/", "https://a-b.example.com/"]:
            self.assert_allowed(fetch(url))

    # --- WebFetch: blocked ----------------------------------------------------

    def test_blocks_anything_but_https(self):
        for url in ["http://react.dev/", "ftp://react.dev/", "file:///etc/passwd", "javascript:alert(1)", "data:text/plain,x",
                    "//react.dev/", "react.dev/path", "/etc/passwd", "https:react.dev", "https:/react.dev", "https:///react.dev",
                    "https:\\\\react.dev", "ws://react.dev/", "wss://react.dev/", "https//react.dev", "  https://react.dev/"]:
            self.assert_blocked(fetch(url))

    def test_blocks_userinfo(self):
        for url in ["https://user@react.dev/", "https://user:pw@react.dev/", "https://@react.dev/", "https://:@react.dev/",
                    "https://react.dev@evil.example/", "https://x@127.0.0.1/", "https://a@b@react.dev/", "https://react.dev%40evil.com@x.com/"]:
            self.assert_blocked(fetch(url), "userinfo")

    def test_blocks_every_ip_literal_form(self):
        for host in [
            "127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254", "8.8.8.8", "0.0.0.0", "255.255.255.255",
            "2130706433", "0x7f000001", "0x7f.0.0.1", "0x7F.0X0.0.0X1", "0177.0.0.1", "017700000001", "127.1", "127.0.1", "1.1",
            "0", "0.0", "00.00.00.00", "0x7f.1", "127.0.0.1.", "1.2.3.4.5", "256.256.256.256", "1.2.3.04", "1.2.3.0x4",
            "[::1]", "[::]", "[0:0:0:0:0:0:0:1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[fe80::1]", "[fd00::1]", "[2001:db8::1]",
            "[::1]:443", "::1", "0:0:0:0:0:0:0:1", "1::",
            "%31%32%37.0.0.1", "１２７.0.0.1", "127。0。0。1", "127．0．0．1",
            "xn--127.0.0.1", "example.0x7f", "example.123", "example.0", "foo.0x", "a.b.1",
        ]:
            self.assert_blocked(fetch(f"https://{host}/"))
            self.assert_blocked(fetch(f"https://{host}"))

    def test_blocks_localhost_and_non_public_suffixes(self):
        for host in ["localhost", "LOCALHOST", "localhost.", "foo.localhost", "a.b.localhost", "x.local", "printer.local", "db.internal",
                     "x.localdomain", "router.lan", "x.home.arpa", "1.0.0.127.in-addr.arpa", "x.corp", "intranet"]:
            self.assert_blocked(fetch(f"https://{host}/"))

    def test_blocks_dotless_empty_label_and_trailing_dot_hosts(self):
        for host in ["intranet", "example", "example.", "example.com.", ".example.com", "example..com", "..", ".", "-.example.com",
                     "example-.com", "exa mple.com", "example.com.:443", "ex_ample.com"]:
            self.assert_blocked(fetch(f"https://{host}/"))
        self.assert_blocked(fetch("https://"))
        self.assert_blocked(fetch("https:///path"))
        self.assert_blocked(fetch("https://:443/"))

    def test_blocks_hosts_that_are_not_plain_ascii_ldh(self):
        for host in ["exämple.com", "例え.jp", "exa%6dple.com", "example.com%2f", "ex*mple.com", "ex'mple.com", "example.c0m!", "a+b.com"]:
            self.assert_blocked(fetch(f"https://{host}/"))

    def test_blocks_overlong_labels_and_hosts(self):
        self.assert_blocked(fetch("https://" + "a" * 64 + ".com/"))
        self.assert_allowed(fetch("https://" + "a" * 63 + ".com/"))
        self.assert_blocked(fetch("https://" + ".".join(["a" * 60] * 5) + ".com/"))

    def test_only_port_443_is_allowed(self):
        for port in ["80", "8080", "8443", "0", "00443", "0443", "443443", "65536", "-1", "", "443a", "4_43", " 443", "443 "]:
            self.assert_blocked(fetch(f"https://example.com:{port}/"))
        self.assert_blocked(fetch("https://example.com:443:443/"))
        self.assert_allowed(fetch("https://example.com:443/"))
        self.assert_allowed(fetch("https://example.com:443"))

    def test_blocks_backslashes_whitespace_and_control_characters_anywhere(self):
        for url in ["https://example.com\\@127.0.0.1/", "https://example.com/a\\b", "https://example.com/ a", "https://example.com/\t",
                    "https://example.com/\n", "https://exam\nple.com/", "https://example.com/\x00", "https://example.com/\x1b[31m",
                    "https://example.com/\x7f", "https://ex\tample.com/", "https://example.com\r\n/", "https://example.com/ "]:
            self.assert_blocked(fetch(url))

    def test_webfetch_needs_a_string_url(self):
        for url in [None, "", 42, ["https://example.com/"], {"url": "https://example.com/"}]:
            self.assert_blocked(call("WebFetch", url=url, prompt="x"))
        self.assert_blocked(call("WebFetch", prompt="x"))
        self.assert_blocked(call("WebFetch", uri="https://example.com/"))

    def test_the_url_cannot_be_smuggled_through_another_field(self):
        payload = call("WebFetch", prompt="https://example.com/")
        self.assert_blocked(payload)
        payload = call("WebFetch", url="https://127.0.0.1/", prompt="x", other="https://example.com/")
        self.assert_blocked(payload)

    # --- fail closed ------------------------------------------------------------

    def test_blocks_other_tools_even_with_valid_inputs(self):
        for tool in ["Write", "Edit", "MultiEdit", "Bash", "Read", "Grep", "Glob", "Agent", "Task", "webfetch", "WEBFETCH", "websearch",
                     "WebFetch ", "", "mcp__context7__other", "mcp__context7__", "mcp__fs__read", "mcp__context7__query-docs ", "WebSearch|WebFetch"]:
            self.assert_blocked(call(tool, query="x", url="https://example.com/", file_path="/x"), "tool")

    def test_blocks_malformed_input(self):
        for stdin in [b"", b"   ", b"{", b"not json", b"null", b"[]", b'"WebFetch"', b"42", b"true", b"{}", b"\xff\xfe\x00",
                      b'{"tool_name": "WebSearch"', json.dumps(call("WebSearch", query="x")).encode()[:-4]]:
            self.assert_blocked(stdin)

    def test_blocks_missing_or_mistyped_fields(self):
        good = call("WebSearch", query="x")
        for mutate in [lambda p: p.pop("tool_name"), lambda p: p.pop("tool_input"), lambda p: p.update(tool_name=None),
                       lambda p: p.update(tool_name=["WebSearch"]), lambda p: p.update(tool_input=None),
                       lambda p: p.update(tool_input=["x"]), lambda p: p.update(tool_input="x")]:
            payload = json.loads(json.dumps(good))
            mutate(payload)
            self.assert_blocked(payload)

    def test_blocks_duplicate_keys(self):
        self.assert_blocked('{"tool_name":"WebFetch","tool_input":{"url":"https://127.0.0.1/","url":"https://example.com/"}}')
        self.assert_blocked('{"tool_name":"WebFetch","tool_input":{"url":"https://example.com/","url":"https://127.0.0.1/"}}')
        self.assert_blocked('{"tool_name":"WebSearch","tool_name":"WebSearch","tool_input":{"query":"x"}}')

    def test_blocks_deeply_nested_json_and_oversized_input_instead_of_crashing_open(self):
        self.assert_blocked(b"[" * 200_000 + b"]" * 200_000)
        self.assert_blocked(b'{"a":' * 200_000)
        self.assert_blocked(b'{"tool_name":"WebSearch","tool_input":{"query":"' + b"x" * (17 * 1024 * 1024) + b'"}}')

    def test_ignores_extra_fields(self):
        self.assert_allowed(call("WebSearch", query="x", extra=1) | {"agent_id": "a1", "agent_type": "kosmos-researcher", "permission_mode": "default"})

    def test_stderr_escapes_hostile_input(self):
        result = self.run_guard(fetch("https://\x1b[31mred\x1b[0m\n.example.com/"))
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(b"\x1b", result.stderr)
        self.assertEqual(result.stderr.count(b"\n"), 1)
        result = self.run_guard(call("\x1b[31mTool", query="x"))
        self.assertNotIn(b"\x1b", result.stderr)

    def test_the_guard_needs_no_environment(self):
        result = self.run_guard(call("WebSearch", query="x"), env={})
        self.assertEqual(result.returncode, 0, result.stderr)

    # --- built-in internal-suffix denylist ------------------------------------------

    def test_blocks_the_builtin_internal_and_special_use_suffixes(self):
        for host in ["host.ts.net", "my-box.tail1234.ts.net", "ts.net", "TS.NET", "a.b.c.ts.net", "x.test", "foo.example", "x.y.invalid",
                     "abcdefghij.onion", "x.onion", "a.test", "invalid.invalid"]:
            self.assert_blocked(fetch(f"https://{host}/"))
        for url in ["https://x.ts.net:443/", "https://x.ts.net", "https://x.ts.net/?a=b"]:
            self.assert_blocked(fetch(url))

    def test_the_builtin_suffixes_match_on_a_dot_boundary_only(self):
        for host in ["nots.net", "mots.net", "mytest.com", "latest.dev", "example.com", "example.org", "test.com", "onion.com",
                     "invalid.com", "ts.network", "ts.net.example.com", "ts-net.com", "www.example.co"]:
            self.assert_allowed(fetch(f"https://{host}/"))

    # --- user deny file ---------------------------------------------------------------

    def test_a_missing_file_adds_no_denies(self):
        self.assertFalse(self.deny_file().exists())
        self.assert_allowed(fetch("https://corp.com/"))

    def test_user_suffixes_match_the_host_and_dot_boundary_subdomains_only(self):
        self.write_deny("corp.com\nfritz.box\n")
        for host in ["corp.com", "x.corp.com", "a.b.corp.com", "CORP.COM", "fritz.box", "nas.fritz.box"]:
            self.assert_blocked(fetch(f"https://{host}/"), "deny")
        for host in ["evilcorp.com", "corp.com.evil.example.com", "mycorp.com", "corp.co", "fritz.boxes", "box.com", "example.com"]:
            self.assert_allowed(fetch(f"https://{host}/"))

    def test_file_format_comments_blank_lines_leading_dots_case_and_line_endings(self):
        self.write_deny("# internal hosts\n\n   \n.Corp.Com\r\nfritz.box   # my router\n\t# indented comment\nnoeol.example.net")
        for host in ["corp.com", "x.corp.com", "fritz.box", "noeol.example.net", "a.noeol.example.net"]:
            self.assert_blocked(fetch(f"https://{host}/"))
        self.assert_allowed(fetch("https://example.net/"))
        self.assert_allowed(fetch("https://other.com/"))

    def test_an_empty_or_comment_only_file_adds_no_denies(self):
        for content in ["", "\n\n", "# nothing\n"]:
            self.write_deny(content)
            self.assert_allowed(fetch("https://corp.com/"))

    def test_a_single_label_suffix_is_valid(self):
        self.write_deny("box\n")
        self.assert_blocked(fetch("https://fritz.box/"))
        self.assert_allowed(fetch("https://box.com/"))

    def test_xdg_config_home_wins_and_falls_back_to_home(self):
        self.write_deny("fromhome.com\n", "home")
        self.write_deny("fromxdg.com\n", "xdg")
        env = {"HOME": str(self.home), "XDG_CONFIG_HOME": str(self.xdg)}
        self.assertEqual(self.run_guard(fetch("https://x.fromxdg.com/"), env=env).returncode, 2)
        self.assertEqual(self.run_guard(fetch("https://x.fromhome.com/"), env=env).returncode, 0)
        for xdg in ["", "relative/dir"]:
            env = {"HOME": str(self.home), "XDG_CONFIG_HOME": xdg}
            self.assertEqual(self.run_guard(fetch("https://x.fromhome.com/"), env=env).returncode, 2, xdg)
            self.assertEqual(self.run_guard(fetch("https://x.fromxdg.com/"), env=env).returncode, 0, xdg)

    def test_a_malformed_file_blocks_every_webfetch_naming_the_file(self):
        bad_contents = [b"not a suffix\n", b"corp.com.\n", b"..corp.com\n", b".\n", b"a..b\n", b"-x.com\n", b"x_y.com\n", b"ex\xc3\xa4mple.com\n",
                        b"\xff\xfe\n", b"\xef\xbb\xbfcorp.com\n", b"corp.com\x00\n", b"a b.com\n", b"https://corp.com\n", b"corp.com/x\n",
                        b"*.corp.com\n", (".".join(["a" * 60] * 5) + "\n").encode(), b"corp.com\tx\n", b"[::1]\n", b"a" * 64 + b".com\n", b"corp.com\nbroken line\n"]
        for content in bad_contents:
            path = self.write_deny(content)
            for url in ["https://react.dev/", "https://corp.com/", "https://127.0.0.1/"]:
                result = self.run_guard(fetch(url))
                self.assertEqual(result.returncode, 2, (content, url))
                self.assertEqual(result.stdout, b"")
                self.assertIn(str(path), result.stderr.decode())
                self.assertEqual(result.stderr.count(b"\n"), 1)
            self.assertEqual(self.run_guard(call("WebSearch", query="x")).returncode, 0, "only WebFetch reads the file")

    def test_an_oversized_file_blocks(self):
        path = self.write_deny("corp.com\n" + "# padding\n" * 5000)
        result = self.run_guard(fetch("https://react.dev/"))
        self.assertEqual(result.returncode, 2)
        self.assertIn(str(path), result.stderr.decode())
        self.write_deny("corp.com\n" + "# padding\n" * 200)
        self.assertEqual(self.run_guard(fetch("https://react.dev/")).returncode, 0)

    def test_an_unreadable_or_non_regular_file_blocks(self):
        path = self.deny_file()
        path.mkdir(parents=True)  # a directory where the file should be
        result = self.run_guard(fetch("https://react.dev/"))
        self.assertEqual(result.returncode, 2)
        self.assertIn(str(path), result.stderr.decode())
        path.rmdir()
        path.write_text("corp.com\n")
        path.chmod(0)
        try:
            if os.access(path, os.R_OK):
                self.skipTest("running as a user that can read mode 000 files")
            result = self.run_guard(fetch("https://react.dev/"))
            self.assertEqual(result.returncode, 2)
            self.assertIn(str(path), result.stderr.decode())
        finally:
            path.chmod(0o644)

    def test_a_config_directory_that_is_a_file_blocks(self):
        (self.home / ".config").write_text("a file, not a directory")
        result = self.run_guard(fetch("https://react.dev/"))
        self.assertEqual(result.returncode, 2)
        self.assertIn("research-deny-suffixes", result.stderr.decode())

    def test_without_a_home_the_file_cannot_be_located_so_webfetch_blocks(self):
        result = self.run_guard(fetch("https://react.dev/"), env={})
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")
        self.assertIn("HOME", result.stderr.decode())
        self.assertEqual(self.run_guard(call("WebSearch", query="x"), env={}).returncode, 0)

    def test_a_symlinked_deny_file_is_followed(self):
        target = self.home / "dotfiles-list"
        target.write_text("corp.com\n")
        path = self.deny_file()
        path.parent.mkdir(parents=True)
        path.symlink_to(target)
        self.assert_blocked(fetch("https://x.corp.com/"), "deny")

    def test_a_dangling_symlink_at_the_deny_file_blocks_every_webfetch(self):
        # The user's suffixes must not silently vanish when the file is replaced by a broken symlink.
        target = self.home / "dotfiles-list"
        target.write_text("corp.com\n")
        path = self.deny_file()
        path.parent.mkdir(parents=True)
        path.symlink_to(target)
        target.unlink()
        for url in ["https://x.corp.com/", "https://react.dev/"]:
            result = self.run_guard(fetch(url))
            self.assertEqual(result.returncode, 2, url)
            self.assertEqual(result.stdout, b"")
            self.assertIn(str(path), result.stderr.decode())
            self.assertIn("dangling", result.stderr.decode())
        self.assertEqual(self.run_guard(call("WebSearch", query="x")).returncode, 0)

    def test_a_truly_missing_file_or_directory_still_adds_nothing(self):
        self.assert_allowed(fetch("https://corp.com/"))
        self.deny_file().parent.mkdir(parents=True)
        self.assert_allowed(fetch("https://corp.com/"))

    def test_a_fifo_at_the_deny_file_path_blocks_promptly_instead_of_hanging(self):
        path = self.deny_file()
        path.parent.mkdir(parents=True)
        os.mkfifo(path)
        try:
            result = subprocess.run([sys.executable, "-I", str(GUARD)], input=json.dumps(fetch("https://react.dev/")).encode(),
                                    env={"HOME": str(self.home)}, capture_output=True, timeout=10)
        except subprocess.TimeoutExpired:
            self.fail("the guard hung on a FIFO at the deny file path")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")
        self.assertIn(str(path), result.stderr.decode())
        self.assertIn("regular file", result.stderr.decode())

    def test_a_symlink_to_a_fifo_blocks_too(self):
        fifo = self.home / "fifo"
        os.mkfifo(fifo)
        path = self.deny_file()
        path.parent.mkdir(parents=True)
        path.symlink_to(fifo)
        result = subprocess.run([sys.executable, "-I", str(GUARD)], input=json.dumps(fetch("https://react.dev/")).encode(),
                                env={"HOME": str(self.home)}, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 2)

    def test_case_folding_cannot_turn_a_non_ascii_character_into_ascii(self):
        # U+212A KELVIN SIGN lowercases to ASCII k; U+0130 lowercases to i plus a combining dot.
        for host in ["\u212Aorp.example.com", "corp.\u212Aom", "\u0130nfo.example.com", "exampl\u0065.\u212Aom"]:
            self.assert_blocked(fetch(f"https://{host}/"))
        self.write_deny("\u212Aorp.com\n")
        result = self.run_guard(fetch("https://react.dev/"))
        self.assertEqual(result.returncode, 2)
        self.assertIn(str(self.deny_file()), result.stderr.decode())
        self.write_deny("corp.\u212Aom\n")
        self.assertEqual(self.run_guard(fetch("https://react.dev/")).returncode, 2)

    def test_the_file_is_never_created(self):
        self.assert_allowed(fetch("https://react.dev/"))
        self.assertEqual(list(self.home.iterdir()), [])

    def test_never_resolves_dns(self):
        # A name that would not resolve anywhere is still allowed: the guard does no lookups (best-effort, by design).
        self.assert_allowed(fetch("https://this-host-does-not-exist-12345.example.com/"))


class GuardParityTest(unittest.TestCase):
    """The fail-closed skeleton is duplicated in both guards on purpose; keep them in step."""

    def test_both_guards_fail_closed_on_the_same_hostile_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(os.path.realpath(tmp))
            env = {"HOME": str(home), "CLAUDE_PROJECT_DIR": str(home)}
            target = str(home / "docs" / "research" / "x.md")
            for stdin in [
                b"",
                b"{",
                b"[" * 200_000 + b"]" * 200_000,
                b'{"a":' * 200_000,
                b'{"tool_name":"Write","tool_name":"Write","tool_input":{"file_path":"%s"}}' % target.encode(),
                b'{"tool_name":"WebSearch","tool_name":"WebSearch","tool_input":{"query":"x"}}',
                b'{"tool_name":"WebSearch","tool_input":{"query":"' + b"x" * (17 * 1024 * 1024) + b'"}}',
                b'{"tool_name":"Write","tool_input":{"file_path":"%s","content":"%s"}}' % (target.encode(), b"x" * (17 * 1024 * 1024)),
                b"\xff\xfe\x00",
                b"null",
            ]:
                for guard in (GUARD, WRITE_GUARD):
                    result = subprocess.run([sys.executable, "-I", str(guard)], input=stdin, env=env, capture_output=True)
                    self.assertEqual(result.returncode, 2, (guard.name, stdin[:40]))
                    self.assertEqual(result.stdout, b"", (guard.name, stdin[:40]))
                    self.assertIn(b"blocked", result.stderr)


if __name__ == "__main__":
    unittest.main()

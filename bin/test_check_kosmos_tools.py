"""Fixture-based tests for check_kosmos_tools.py. Run: python3 -m unittest discover -s bin -p 'test_*.py'"""
import contextlib
import fnmatch
import io
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import check_kosmos_tools as guard  # noqa: E402

WEB = "~/.pi/agent/npm/node_modules/pi-web-access"
GUARD = "~/.pi/agent/npm/node_modules/kosmos-pi/guards/researcher-fetch-guard.ts"
GOOD_SETTINGS = {
    "subagents": {
        "defaultExtensions": [],
        "agentOverrides": {
            "researcher": {"extensions": [WEB]},
            "evidence-auditor": {"extensions": [WEB]},
        },
    }
}


def agent(name, tools, extensions=None, package="kosmos"):
    lines = ["---", f"name: {name}", f"package: {package}", f"tools: {', '.join(tools)}"]
    if extensions is not None:
        lines.append(f"extensions: {extensions}")
    lines += ["---", "", "body", ""]
    return "\n".join(lines)


class GuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.agents = self.root / "agents"
        self.agents.mkdir()

    def run_check(self, settings=GOOD_SETTINGS, installed=None):
        path = self.root / "settings.json"
        path.write_text(json.dumps(settings), encoding="utf-8")
        return guard.check(path, self.agents, installed)

    def write(self, filename, text):
        (self.agents / filename).write_text(text, encoding="utf-8")

    def test_passes_when_the_provider_is_listed(self):
        self.write("a.md", agent("a", ["read", "bash", "subagent", "contact_supervisor", "web_search"], WEB))
        errors, warnings, notes, _ = self.run_check()
        self.assertEqual(errors, [])

    def test_fails_naming_agent_tool_and_provider_when_extensions_missing(self):
        self.write("a.md", agent("a", ["read", "web_search", "fetch_content"]))
        errors, *_ = self.run_check()
        self.assertEqual(len(errors), 2)
        self.assertIn("agent kosmos.a (a.md)", errors[0])
        self.assertIn("'web_search'", errors[0])
        self.assertIn("'pi-web-access'", errors[0])

    def test_unknown_tool_fails_and_says_where_to_add_it(self):
        self.write("a.md", agent("a", ["read", "todo"], WEB))
        errors, *_ = self.run_check()
        self.assertEqual(len(errors), 1)
        self.assertIn("'todo'", errors[0])
        self.assertIn("PROVIDER_TOOLS", errors[0])

    def test_mcp_selection_is_noted_not_failed(self):
        self.write("a.md", agent("a", ["read", "mcp:docs"], ""))
        errors, _, notes, _ = self.run_check()
        self.assertEqual(errors, [])
        self.assertTrue(any("mcp:docs" in n for n in notes))

    def test_extension_path_forms(self):
        for entry in [WEB, WEB + "/", "/home/x/.pi/agent/npm/node_modules/pi-web-access/dist/index.js", "npm:pi-web-access", "/opt/other/pi-web-access"]:
            self.assertTrue(guard.provider_listed([entry], "pi-web-access"), entry)
        for entry in ["~/.pi/agent/npm/node_modules/pi-web-access-evil", "/x/pi-web-access/../other", "./other.ts"]:
            self.assertFalse(guard.provider_listed([entry], "pi-web-access"), entry)

    def test_the_researcher_fetch_guard_provides_the_pi_web_access_tools(self):
        for entry in [GUARD, "/home/x/Dotfiles/kosmos-pi/guards/researcher-fetch-guard.ts"]:
            self.assertTrue(guard.provider_listed([entry], "pi-web-access"), entry)
        for entry in ["/tmp/researcher-fetch-guard.ts", "~/.pi/agent/npm/node_modules/kosmos-pi/guards/other.ts",
                      "~/.pi/agent/npm/node_modules/kosmos-pi/guards/researcher-fetch-guard.ts.bak",
                      "~/.pi/agent/npm/node_modules/kosmos-pi/extensions/researcher-fetch-guard.ts"]:
            self.assertFalse(guard.provider_listed([entry], "pi-web-access"), entry)
        self.write("a.md", agent("a", ["read", "web_search", "fetch_content", "get_search_content", "source_check"], GUARD))
        errors, *_ = self.run_check()
        self.assertEqual(errors, [])

    def test_a_builtin_override_does_not_mask_a_kosmos_agent_of_the_same_name(self):
        # settings.json overrides the BUILTIN `researcher`; `kosmos.researcher` must stand on its own extensions.
        self.write("r.md", agent("researcher", ["web_search"]))
        errors, *_ = self.run_check()
        self.assertEqual(len(errors), 1)
        self.assertIn("agent kosmos.researcher", errors[0])
        self.write("r.md", agent("researcher", ["web_search"], GUARD))
        errors, *_ = self.run_check()
        self.assertEqual(errors, [])

    def test_override_beats_frontmatter(self):
        self.write("a.md", agent("a", ["web_search"], WEB))
        overrides = dict(GOOD_SETTINGS["subagents"]["agentOverrides"], **{"kosmos.a": {"extensions": []}})
        errors, *_ = self.run_check({"subagents": {"agentOverrides": overrides}})
        self.assertEqual(len(errors), 1)
        self.assertIn("agent kosmos.a", errors[0])

    def test_builtin_without_override_fails_for_its_own_providers_only(self):
        settings = {"subagents": {"agentOverrides": {"researcher": {"extensions": [WEB]}}}}
        errors, *_ = self.run_check(settings)
        self.assertEqual(len(errors), 1)
        self.assertIn("builtin agent evidence-auditor", errors[0])
        self.assertIn("agentOverrides.evidence-auditor.extensions", errors[0])

    def test_a_disabled_builtin_is_not_checked(self):
        settings = {"subagents": {"agentOverrides": {"researcher": {"disabled": True}, "evidence-auditor": {"disabled": True}}}}
        errors, _, _, summary = self.run_check(settings)
        self.assertEqual(errors, [])
        self.assertIn("0 builtin overrides", summary)

    def test_only_a_boolean_true_disables_a_builtin(self):
        for disabled in [False, "true", 1, None, "yes", [], {}]:
            settings = {"subagents": {"agentOverrides": {"researcher": {"disabled": disabled}, "evidence-auditor": {"extensions": [WEB]}}}}
            errors, *_ = self.run_check(settings)
            self.assertEqual(len(errors), 1, disabled)
            self.assertIn("builtin agent researcher", errors[0])

    def test_a_disabled_builtin_also_skips_installed_builtins_and_still_checks_others(self):
        installed = self.root / "pi-subagents"
        (installed / "agents").mkdir(parents=True)
        (installed / "agents" / "web.md").write_text(agent("webby", ["read", "web_search"]).replace("package: kosmos\n", ""), encoding="utf-8")
        overrides = {"researcher": {"disabled": True}, "evidence-auditor": {"disabled": True}, "webby": {"disabled": True}}
        errors, *_ = self.run_check({"subagents": {"agentOverrides": overrides}}, installed=installed)
        self.assertEqual(errors, [])
        del overrides["webby"]
        errors, *_ = self.run_check({"subagents": {"agentOverrides": overrides}}, installed=installed)
        self.assertEqual(len(errors), 1)
        self.assertIn("builtin agent webby", errors[0])

    def test_a_disabled_flag_does_not_hide_a_kosmos_agent(self):
        # pi-subagents applies overrides to builtins only: kosmos.researcher still runs, so it is still checked.
        self.write("r.md", agent("researcher", ["web_search"]))
        settings = {"subagents": {"agentOverrides": {"researcher": {"disabled": True}, "kosmos.researcher": {"disabled": True},
                                                     "evidence-auditor": {"disabled": True}}}}
        errors, *_ = self.run_check(settings)
        self.assertEqual(len(errors), 1)
        self.assertIn("agent kosmos.researcher", errors[0])
        self.write("r.md", agent("researcher", ["web_search"], WEB))
        errors, *_ = self.run_check(settings)
        self.assertEqual(errors, [])

    def test_installed_scan_finds_new_builtin_and_ignores_builtins_without_provider_tools(self):
        installed = self.root / "pi-subagents"
        (installed / "agents").mkdir(parents=True)
        (installed / "agents" / "web.md").write_text(agent("webby", ["read", "web_search"], package="x").replace("package: x\n", ""), encoding="utf-8")
        (installed / "agents" / "plain.md").write_text(agent("plain", ["read", "bash"]).replace("package: kosmos\n", ""), encoding="utf-8")
        errors, *_ = self.run_check(installed=installed)
        self.assertEqual(len(errors), 1)
        self.assertIn("builtin agent webby", errors[0])

    def test_installed_mode_warns_for_a_missing_extension_path(self):
        self.write("a.md", agent("a", ["read"], "~/definitely/not/here/pi-web-access"))
        installed = self.root / "pi-subagents"
        installed.mkdir()
        _, warnings, *_ = self.run_check(installed=installed)
        self.assertTrue(any("does not exist" in w for w in warnings))
        _, warnings, *_ = self.run_check(installed=None)
        self.assertEqual(warnings, [])

    def test_printed_names_have_control_characters_stripped(self):
        self.write("a.md", agent("a", ["read", "evil\x1b[31mtool\x07"], WEB))
        errors, *_ = self.run_check()
        self.assertEqual(len(errors), 1)
        self.assertNotRegex(errors[0], r"[\x00-\x1f\x7f-\x9f]")
        self.assertIn("evil[31mtool", errors[0])

    def test_main_exit_codes(self):
        self.write("ok.md", agent("ok", ["read", "web_search"], WEB))
        settings = self.root / "settings.json"
        settings.write_text(json.dumps(GOOD_SETTINGS), encoding="utf-8")
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(guard.main(["x", str(settings), str(self.agents)]), 0)
        self.assertIn("tool guard", out.getvalue())
        self.write("bad.md", agent("bad", ["web_search"]))
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(guard.main(["x", str(settings), str(self.agents)]), 1)
        self.assertIn("error: agent kosmos.bad", err.getvalue())

    def test_current_repo_passes(self):
        root = pathlib.Path(__file__).resolve().parent.parent
        errors, *_ = guard.check(root / "pi/agent/settings.json", root / "kosmos-pi/agents")
        self.assertEqual(errors, [])


class ResearcherShippingTest(unittest.TestCase):
    """The Pi researcher loads the web tools only through the guard, and the guard file ships in the package."""

    ROOT = pathlib.Path(__file__).resolve().parent.parent

    def extensions(self):
        fm = guard.parse_frontmatter((self.ROOT / "kosmos-pi/agents/researcher.md").read_text(encoding="utf-8"))
        return fm["extensions"]

    def test_the_researcher_lists_only_the_guard_and_it_exists(self):
        entries = self.extensions()
        self.assertEqual(len(entries), 1, entries)
        marker = "/kosmos-pi/guards/"
        self.assertIn(marker, entries[0])
        name = entries[0].split(marker, 1)[1]
        self.assertRegex(name, r"^[a-z0-9-]+\.ts$")
        self.assertTrue((self.ROOT / "kosmos-pi" / "guards" / name).is_file(), name)

    def test_the_guard_is_shipped_by_package_json_files(self):
        files = json.loads((self.ROOT / "kosmos-pi/package.json").read_text(encoding="utf-8"))["files"]
        name = self.extensions()[0].split("/kosmos-pi/guards/", 1)[1]
        relative = f"guards/{name}"
        included = any(relative.startswith(f) if f.endswith("/") else fnmatch.fnmatch(relative, f)
                       for f in files if not f.startswith("!"))
        excluded = any(fnmatch.fnmatch(relative, f[1:]) or (f[1:].endswith("/") and relative.startswith(f[1:]))
                       for f in files if f.startswith("!"))
        self.assertTrue(included, files)
        self.assertFalse(excluded, files)


if __name__ == "__main__":
    unittest.main()

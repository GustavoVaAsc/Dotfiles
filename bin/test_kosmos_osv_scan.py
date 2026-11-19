"""Tests for bin/kosmos-osv-scan with a fake osv-scanner on PATH. Run: python3 -I -m unittest discover -s bin -p 'test_*.py'"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

BIN = pathlib.Path(__file__).resolve().parent
WRAPPER = BIN / "kosmos-osv-scan"
CONFIG = BIN / "kosmos-osv-config.toml"

FAKE = """#!/bin/sh
python3 -c 'import json,sys; json.dump(sys.argv[1:], open("%s", "w"))' "$@"
echo "fake osv-scanner ran"
"""


class WrapperTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = pathlib.Path(os.path.realpath(tmp.name))
        self.repo = self.root / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        self.record = self.root / "argv.json"
        self.fakebin = self.root / "fakebin"
        self.fakebin.mkdir()
        fake = self.fakebin / "osv-scanner"
        fake.write_text(FAKE % self.record)
        fake.chmod(0o755)
        (self.repo / "package-lock.json").write_text("{}")
        (self.repo / "sub").mkdir()
        (self.repo / "sub" / "Cargo.lock").write_text("")
        (self.repo / "requirements.txt").write_text("")
        (self.root / "outside.lock").write_text("")
        (self.root / "yarn.lock").write_text("")

    def run_wrapper(self, *args, path=None, cwd=None):
        env = dict(os.environ, PATH=path if path is not None else f"{self.fakebin}{os.pathsep}{os.environ['PATH']}")
        return subprocess.run([sys.executable, "-I", str(WRAPPER), *args], cwd=cwd or self.repo, env=env, capture_output=True, text=True)

    def assert_rejected(self, *args, **kw):
        result = self.run_wrapper(*args, **kw)
        self.assertNotEqual(result.returncode, 0, args)
        self.assertFalse(self.record.exists(), f"scanner ran for {args}")
        return result

    def test_valid_lockfile_gets_the_exact_argv(self):
        result = self.run_wrapper("package-lock.json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.record.read_text()), [
            "scan", "source", "--no-call-analysis=all", f"--config={CONFIG}", "-L", f"package-lock.json:{self.repo / 'package-lock.json'}",
        ])

    def test_nested_lockfile_uses_its_own_parse_as_and_absolute_path(self):
        self.assertEqual(self.run_wrapper("sub/Cargo.lock").returncode, 0)
        self.assertEqual(json.loads(self.record.read_text())[-1], f"Cargo.lock:{self.repo / 'sub' / 'Cargo.lock'}")

    def test_absolute_path_inside_the_repo_is_accepted(self):
        self.assertEqual(self.run_wrapper(str(self.repo / "package-lock.json")).returncode, 0)

    def test_rejects_wrong_argument_counts(self):
        self.assert_rejected()
        self.assert_rejected("package-lock.json", "sub/Cargo.lock")
        self.assert_rejected("package-lock.json", "--format=json")

    def test_rejects_flag_like_and_quoted_arguments(self):
        self.assert_rejected("--output=/tmp/x")
        self.assert_rejected("-L")
        self.assert_rejected("'--output=~/.bashrc'")
        self.assert_rejected('"package-lock.json"')
        self.assert_rejected("\\--output=x")
        self.assert_rejected("package-lock.json\t--output=x")
        self.assert_rejected("")

    def test_rejects_paths_outside_the_repo(self):
        self.assert_rejected("../outside.lock")
        self.assert_rejected(str(self.root / "yarn.lock"))
        self.assert_rejected("/etc/passwd")

    def test_rejects_a_symlink_that_escapes_the_repo(self):
        (self.repo / "yarn.lock").symlink_to(self.root / "yarn.lock")
        self.assert_rejected("yarn.lock")
        (self.repo / "linkdir").symlink_to(self.root, target_is_directory=True)
        self.assert_rejected("linkdir/yarn.lock")

    def test_rejects_names_off_the_allowlist(self):
        self.assert_rejected("requirements.txt")
        for name in ["go.mod", "go.sum", "pom.xml", "build.gradle"]:
            (self.repo / name).write_text("")
            self.assert_rejected(name)

    def test_rejects_parse_as_prefixes_directories_and_missing_files(self):
        self.assert_rejected("package-lock.json:package-lock.json")
        self.assert_rejected("yarn.lock:requirements.txt")
        self.assert_rejected("sub")
        self.assert_rejected(".")
        self.assert_rejected("nope/package-lock.json")

    def test_a_symlink_to_a_disallowed_name_is_rejected(self):
        (self.repo / "go.mod").write_text("")
        (self.repo / "yarn.lock").symlink_to(self.repo / "go.mod")
        self.assert_rejected("yarn.lock")

    def test_missing_scanner_says_so_and_does_not_install(self):
        empty = self.root / "empty"
        empty.mkdir()
        python_dir = str(pathlib.Path(sys.executable).parent)
        git_dir = str(pathlib.Path(shutil.which("git")).parent)
        result = self.assert_rejected("package-lock.json", path=os.pathsep.join([str(empty), python_dir, git_dir]))
        self.assertEqual(result.returncode, 127)
        self.assertIn("osv-scanner is not installed", result.stderr)
        self.assertIn("Do not install it", result.stderr)
        self.assertIn("[approval]", result.stderr)

    def test_outside_git_is_refused_with_a_clear_message(self):
        plain = self.root / "plain"
        plain.mkdir()
        (plain / "yarn.lock").write_text("")
        result = self.assert_rejected("yarn.lock", cwd=plain)
        self.assertEqual(result.returncode, 2)
        self.assertIn("not inside a git repository", result.stderr)

    def test_hostile_core_worktree_cannot_widen_the_root(self):
        for target in [self.root / "elsewhere", pathlib.Path("/")]:
            if target != pathlib.Path("/"):
                target.mkdir(exist_ok=True)
            subprocess.run(["git", "config", "core.worktree", str(target)], cwd=self.repo, check=True)
            result = self.assert_rejected("package-lock.json")
            self.assertEqual(result.returncode, 2, target)
            self.assertIn("refusing", result.stderr)
            self.assert_rejected(str(self.root / "outside.lock"))
        subprocess.run(["git", "config", "--unset", "core.worktree"], cwd=self.repo, check=True)
        self.assertEqual(self.run_wrapper("package-lock.json").returncode, 0)

    def test_a_subdirectory_of_the_repo_works_as_cwd(self):
        self.assertEqual(self.run_wrapper("../package-lock.json", cwd=self.repo / "sub").returncode, 0)

    def test_pinned_config_is_empty_toml(self):
        import tomllib
        self.assertEqual(tomllib.loads(CONFIG.read_text()), {})
        self.assertTrue(os.access(WRAPPER, os.X_OK))


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Disposable PTY checks for Redline's zsh/bash integration (no user rc files)."""
import os
import pty
import select
import shutil
import signal
import tempfile
import time
import unittest
from pathlib import Path

SHIMS = Path(__file__).resolve().parents[1] / "src-tauri/shell-integration"

class Shell:
    def __init__(self, command, env, cwd):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe(command[0], command, env)
        self.output = b""
    def send(self, text):
        os.write(self.fd, text.encode())
    def until(self, marker, seconds=5):
        deadline = time.monotonic() + seconds
        while marker not in self.output and time.monotonic() < deadline:
            ready, _, _ = select.select([self.fd], [], [], 0.1)
            if ready:
                try:
                    self.output += os.read(self.fd, 65536)
                except OSError:
                    break
        if marker not in self.output:
            raise AssertionError(f"missing {marker!r}; output={self.output[-6000:]!r}")
        at = self.output.index(marker) + len(marker)
        data, self.output = self.output[:at], self.output[at:]
        return data
    def close(self):
        try:
            os.killpg(self.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.close(self.fd)
        os.waitpid(self.pid, 0)

class ShellIntegration(unittest.TestCase):
    def exercise(self, shell):
        with tempfile.TemporaryDirectory(prefix="redline-shell-shim-") as folder:
            home = Path(folder)
            shim = home / ".redline/shell-integration"
            shim.mkdir(parents=True)
            env = dict(os.environ, HOME=str(home), TERM="xterm-256color")
            env.pop("ZDOTDIR", None)
            if shell == "zsh":
                for source in ("zshenv", "zprofile", "zshrc"):
                    shutil.copyfile(SHIMS / source, shim / ("." + source))
                original = home / "custom-rc"
                original.mkdir()
                (original / ".zshenv").write_text('export RL_TEST_ENV=env\n')
                (original / ".zprofile").write_text('export RL_TEST_PROFILE=profile\n')
                (original / ".zshrc").write_text('export RL_TEST_RC=rc\nuser_prompt(){ RL_TEST_LAST_STATUS=$?; PROMPT="custom> "; }\nprecmd_functions=(user_prompt)\n')
                (original / ".zlogin").write_text('export RL_TEST_LOGIN=login\n')
                env.update(ZDOTDIR=str(shim), REDLINE_USER_ZDOTDIR=str(original), REDLINE_USER_ZDOTDIR_SET="1", REDLINE_SHELL_INTEGRATION_DIR=str(shim))
                command = ["/bin/zsh", "-l"]
                check = 'printf "STARTUP:%s:%s:%s:%s:%s\\n" "$RL_TEST_ENV" "$RL_TEST_PROFILE" "$RL_TEST_RC" "$RL_TEST_LOGIN" "$ZDOTDIR"\r'
                expected = f"STARTUP:env:profile:rc:login:{original}".encode()
            else:
                shutil.copyfile(SHIMS / "bashrc", shim / "bashrc")
                (home / ".bash_profile").write_text('export RL_TEST_PROFILE=profile\n. "$HOME/.bashrc"\n')
                (home / ".bashrc").write_text("export RL_TEST_RC=rc\nPROMPT_COMMAND='RL_TEST_LAST_STATUS=$?; RL_TEST_PROMPT=called'\nPS1='custom> '\n")
                command = ["/bin/bash", "--rcfile", str(shim / "bashrc"), "-i"]
                check = 'printf "STARTUP:%s:%s:%s\\n" "$RL_TEST_PROFILE" "$RL_TEST_RC" "$RL_TEST_PROMPT"\r'
                expected = b"STARTUP:profile:rc:called"
            session = Shell(command, env, home)
            try:
                session.until(b"\x1b]133;B\x07")
                session.send(check)
                self.assertIn(expected, session.until(expected))
                session.until(b"\x1b]133;D;0\x07")
                session.until(b"\x1b]133;B\x07")
                session.send("false\r")
                session.until(b"\x1b]133;D;1\x07")
                session.until(b"\x1b]133;B\x07")
                session.send('printf "USER_STATUS:%s\\n" "$RL_TEST_LAST_STATUS"\r')
                session.until(b"USER_STATUS:1")
                session.until(b"\x1b]133;B\x07")
                session.send('read answer; printf "ANSWER:%s\\n" "$answer"\r')
                session.until(b"\x1b]133;C\x07")
                session.send("interactive input\r")
                session.until(b"ANSWER:interactive input")
                session.until(b"\x1b]133;D;0\x07")
            finally:
                session.close()
    @unittest.skipUnless(Path("/bin/zsh").exists(), "zsh not installed")
    def test_zsh_startup_custom_zdotdir_prompt_hooks_exit_codes_and_interactive_input(self):
        self.exercise("zsh")
    @unittest.skipUnless(Path("/bin/bash").exists(), "bash not installed")
    def test_bash_startup_prompt_command_exit_codes_and_interactive_input(self):
        self.exercise("bash")

if __name__ == "__main__":
    unittest.main(verbosity=2)

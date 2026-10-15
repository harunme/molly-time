"""Exercise development startup and port cleanup without signalling real processes."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "run-dev.sh"


class RunDevTests(unittest.TestCase):
    def run_dev(self, mode, occupied_ports=(), api_port=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tools = root / "tools"
            tools.mkdir()
            (tools / "run-dev.sh").write_text(SCRIPT.read_text())
            for name in ("run-server.sh", "run-tv-web.sh"):
                (tools / name).write_text(
                    "printf '%s|%s|%s|%s|%s\\n' "
                    '"$(basename "$0")" "$*" '
                    '"$MOLLYTIME_API_PROXY" "$MOLLYTIME_WEB_PROXY" "$MOLLYTIME_TV_PROXY" '
                    '>> "$TEST_ROOT/started"\n'
                    'while [[ $(wc -l < "$TEST_ROOT/started") -lt 4 ]]; do /bin/sleep 0.01; done\n'
                )
            bin_dir = root / "bin"
            bin_dir.mkdir()
            for port in occupied_ports:
                (root / f"port-{port}").write_text("900001\n900001\n")
            lsof = bin_dir / "lsof"
            lsof.write_text('''#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    -iTCP:*) port="${arg#-iTCP:}" ;;
  esac
done
echo "$port" >> "$TEST_ROOT/checked"
cat "$TEST_ROOT/port-$port" 2>/dev/null
''')
            lsof.chmod(0o755)
            pnpm = bin_dir / "pnpm"
            pnpm.write_text('#!/usr/bin/env bash\n'
                            "printf 'pnpm|%s|%s|%s|%s\\n' "
                            '"$*" "$MOLLYTIME_API_PROXY" '
                            '"$MOLLYTIME_WEB_PROXY" "$MOLLYTIME_TV_PROXY" >> "$TEST_ROOT/started"\n'
                            'while [[ $(wc -l < "$TEST_ROOT/started") -lt 4 ]]; do /bin/sleep 0.01; done\n')
            pnpm.chmod(0o755)
            # Bash's kill builtin must be intercepted explicitly, not via PATH.
            startup = root / "startup.sh"
            startup.write_text('''kill() {
  local last="${!#}"
  if [[ "$last" != 900001 ]]; then
    builtin kill "$@"
    return
  fi
  echo "$*" >> "$TEST_ROOT/signals"
  if [[ "$TEST_MODE" == graceful || ( "$TEST_MODE" == forced && "$1" == -KILL ) ]]; then
    for file in "$TEST_ROOT"/port-*; do : > "$file"; done
    return 0
  fi
  return 1
}
sleep() { return 0; }
''')
            env = dict(os.environ, TEST_ROOT=directory, TEST_MODE=mode,
                       BASH_ENV=str(startup), PATH=f"{bin_dir}:{os.environ['PATH']}")
            env.pop("MOLLYTIME_LISTEN_PORT", None)
            env.pop("MOLLY_LISTEN_PORT", None)
            env.pop("MOLLYTIME_API_PROXY", None)
            env.pop("MOLLY_API_PROXY", None)
            if api_port is not None:
                env["MOLLYTIME_LISTEN_PORT"] = str(api_port)
            result = subprocess.run(["bash", str(tools / "run-dev.sh")], env=env,
                                    capture_output=True, text=True, timeout=10)
            read = lambda name: (root / name).read_text() if (root / name).exists() else ""
            return result, read("signals"), read("checked"), read("started")

    def test_free_ports_start_services(self):
        result, signals, checked, started = self.run_dev("graceful")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(signals, "")
        self.assertEqual(checked.splitlines(), ["8096", "5173", "5174", "4321"])
        commands = {line.split("|")[0]: line.split("|")[1] for line in started.splitlines()}
        self.assertEqual(commands["run-server.sh"], "--reload")
        self.assertEqual(commands["run-tv-web.sh"], "--port 5173 --strictPort")
        self.assertIn("pnpm|--dir apps/web dev --strictPort|", started)
        self.assertIn("pnpm|--dir apps/site dev|", started)
        self.assertEqual(len(started.splitlines()), 4)

    def test_occupied_ports_receive_term_once(self):
        result, signals, checked, started = self.run_dev("graceful", [8096])
        self.assertEqual(signals.splitlines(), ["-TERM 900001"])
        self.assertTrue(started)

    def test_stubborn_process_receives_kill(self):
        result, signals, checked, started = self.run_dev("forced", [18096], 18096)
        self.assertEqual(signals.splitlines(), ["-TERM 900001", "-KILL 900001"])
        self.assertNotIn("8096", checked.splitlines())
        self.assertTrue(all(line.split("|")[2:] == ["http://127.0.0.1:18096",
                            "http://127.0.0.1:5174", "http://127.0.0.1:5173"]
                            for line in started.splitlines()))
        self.assertTrue(started)

    def test_unreleased_port_prevents_startup(self):
        result, signals, checked, started = self.run_dev("blocked", [4321])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Could not release port 4321", result.stderr)
        self.assertEqual(started, "")

    def test_invalid_port_prevents_signals_and_startup(self):
        result, signals, checked, started = self.run_dev("graceful", api_port="bad")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((signals, checked, started), ("", "", ""))


if __name__ == "__main__":
    unittest.main()

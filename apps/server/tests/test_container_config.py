"""Configuration must import from the shorter production image path."""

import sys
import types
from pathlib import Path

from mollytime_server import config


def test_configuration_imports_from_container_path(monkeypatch):
    source = Path(config.__file__).read_text()
    module = types.ModuleType("container_config_check")
    module.__file__ = "/app/mollytime_server/config.py"
    monkeypatch.setitem(sys.modules, module.__name__, module)
    monkeypatch.setenv("MOLLYTIME_ANDROID_BUILD_TOOLS_DIR", "/usr/bin")
    exec(compile(source, module.__file__, "exec"), module.__dict__)
    settings = module.Settings(_env_file=None)
    assert settings.android_build_tools_dir == Path("/usr/bin")

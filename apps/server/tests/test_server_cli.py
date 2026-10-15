"""The API only enables its source watcher when explicitly requested."""

from pathlib import Path
from unittest.mock import patch

import pytest

from mollytime_server import main


@pytest.mark.parametrize("reload", [False, True])
def test_run_reload_mode(reload):
    argv = ["mollytime-server"] + (["--reload"] if reload else [])
    with patch("sys.argv", argv), patch.object(main.uvicorn, "run") as serve:
        main.run()

    args, kwargs = serve.call_args
    assert args == ("mollytime_server.main:create_app",)
    assert kwargs["factory"] is True
    assert kwargs["reload"] is reload
    assert kwargs["reload_dirs"] == (
        [str(Path(main.__file__).resolve().parent)] if reload else None
    )
    settings = main.get_settings()
    assert kwargs["host"] == settings.listen_host
    assert kwargs["port"] == settings.listen_port

"""Shared backup schedule and status for the API and Seoul host cron job."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import tempfile
from pathlib import Path
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field

from .config import get_settings

TIMEZONE = ZoneInfo("Asia/Shanghai")


class BackupConfig(BaseModel):
    enabled: bool = True
    hour: int = Field(default=3, ge=0, le=23)
    minute: int = Field(default=40, ge=0, le=59)
    local_retention_days: int = Field(default=7, ge=1, le=90)


def _directory() -> Path:
    path = get_settings().data_dir / "backups"
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    return path


def _read(name: str) -> dict:
    path = _directory() / name
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def _write(name: str, value: dict) -> None:
    directory = _directory()
    fd, temp = tempfile.mkstemp(prefix=".backup-", dir=directory)
    try:
        with os.fdopen(fd, "w") as handle:
            os.fchmod(handle.fileno(), 0o600)
            json.dump(value, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, directory / name)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def get_config() -> BackupConfig:
    return BackupConfig.model_validate(_read("schedule.json"))


def save_config(config: BackupConfig) -> BackupConfig:
    _write("schedule.json", config.model_dump())
    return config


def get_status() -> dict:
    return _read("status.json")


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def check_due() -> bool:
    now = _now()
    local = now.astimezone(TIMEZONE)
    status = get_status()
    status["last_checked_at"] = now.isoformat()
    config = get_config()
    due = (
        config.enabled
        and (local.hour, local.minute) >= (config.hour, config.minute)
        and status.get("last_attempt_date") != local.date().isoformat()
    )
    if due:
        status.update(
            last_attempt_date=local.date().isoformat(),
            last_started_at=now.isoformat(),
            last_result="running",
            last_error="",
        )
    _write("status.json", status)
    return due


def finish(success: bool, message: str = "") -> None:
    status = get_status()
    status["last_finished_at"] = _now().isoformat()
    status["last_result"] = "success" if success else "failed"
    status["last_error"] = "" if success else message[:200]
    if success:
        status["last_object_key"] = message
    _write("status.json", status)


def start_manual() -> None:
    status = get_status()
    status.update(last_started_at=_now().isoformat(), last_result="running", last_error="")
    _write("status.json", status)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("check", "start", "finish", "retention"))
    parser.add_argument("value", nargs="?", default="")
    parser.add_argument("detail", nargs="?", default="")
    args = parser.parse_args()
    if args.command == "check":
        print("due" if check_due() else "skip")
    elif args.command == "start":
        start_manual()
    elif args.command == "retention":
        print(get_config().local_retention_days)
    else:
        finish(args.value == "success", args.detail if args.value == "success" else "备份任务失败，请查看服务器日志")


if __name__ == "__main__":
    main()

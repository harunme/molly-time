"""Release notes stay bounded and never require an API key to deploy."""

import importlib.util
import json
import sys
from pathlib import Path


spec = importlib.util.spec_from_file_location(
    "generate_tv_release_notes", Path(__file__).resolve().parents[1] / "generate_tv_release_notes.py"
)
notes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notes)


def test_missing_key_writes_safe_fallback(tmp_path, monkeypatch):
    plan = tmp_path / "plan.json"
    state = tmp_path / "state.json"
    plan.write_text(json.dumps({"requiresApk": True, "sourceCommit": "a" * 40}))
    state.write_text(json.dumps({"current": {"sourceCommit": "b" * 40}}))
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setattr(sys, "argv", ["notes", "--plan", str(plan), "--state", str(state)])
    notes.main()
    assert json.loads(plan.read_text())["releaseNotes"] == notes.FALLBACK


def test_generated_notes_are_persisted(tmp_path, monkeypatch):
    plan = tmp_path / "plan.json"
    state = tmp_path / "state.json"
    plan.write_text(json.dumps({"requiresApk": True, "sourceCommit": "a" * 40}))
    state.write_text(json.dumps({"current": {"sourceCommit": "b" * 40}}))
    monkeypatch.setenv("DEEPSEEK_API_KEY", "fixture")
    monkeypatch.setattr(notes, "source_summary", lambda previous, current: "verified changes")
    monkeypatch.setattr(notes, "generate", lambda summary, key, model: "修复电视播放时偶发的卡顿")
    monkeypatch.setattr(sys, "argv", ["notes", "--plan", str(plan), "--state", str(state)])
    notes.main()
    assert json.loads(plan.read_text())["releaseNotes"] == "修复电视播放时偶发的卡顿"


def test_deepseek_request_uses_chat_completions(monkeypatch):
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    def open_request(request, timeout):
        assert request.full_url == "https://api.deepseek.com/chat/completions"
        assert request.get_header("Authorization") == "Bearer fixture"
        body = json.loads(request.data)
        assert body["model"] == "deepseek-flash"
        assert body["messages"][1]["content"] == "verified changes"
        return Response()

    monkeypatch.setattr(notes.urllib.request, "urlopen", open_request)
    monkeypatch.setattr(notes.json, "load", lambda response: {
        "choices": [{"finish_reason": "stop", "message": {"content": "修复遥控器操作问题"}}]
    })
    assert notes.generate("verified changes", "fixture", "deepseek-flash") == "修复遥控器操作问题"

import io
import wave

from test_operations import operator  # noqa: F401
from test_management import parent  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import startup_sound

PATH = "/api/manage/operations/startup-sound"


def wav(seconds=0.2):
    out = io.BytesIO()
    with wave.open(out, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b"\0\0" * round(8000 * seconds))
    return out.getvalue()


def test_boot_audio_public_before_pairing_and_removal(operator):
    assert operator.get("/api/startup").json()["configured"] is False
    result = operator.put(PATH + "?filename=hello.wav", content=wav())
    assert result.status_code == 200, result.text
    config = result.json()
    assert config["configured"] and config["filename"] == "hello.wav"
    assert config["durationMs"] == 200
    assert "data" not in config
    # No TV bearer or parent cookie is required during native boot.
    operator.cookies.clear()
    public = operator.get("/api/startup")
    assert public.json() == config
    sound = operator.get(config["audioUrl"])
    assert sound.status_code == 200 and sound.headers["content-type"] == "audio/mpeg"
    assert sound.content.startswith((b"ID3", b"\xff"))
    assert operator.get("/api/startup/audio/" + "a" * 64).status_code == 404
    startup_sound.remove()
    assert operator.get(config["audioUrl"]).status_code == 404
    assert not operator.get("/api/startup").json()["configured"]


def test_operator_controls_and_csrf(parent):
    assert parent.get(PATH).status_code == 403
    assert parent.put(PATH + "?filename=a.wav", content=wav()).status_code == 403
    assert parent.delete(PATH).status_code == 403


def test_validation_preserves_existing_sound(operator):
    saved = operator.put(PATH + "?filename=good.wav", content=wav()).json()
    for payload in (b"#EXTM3U\nfile:///etc/passwd", b"not audio", wav(5.2)):
        assert operator.put(PATH + "?filename=bad.wav", content=payload).status_code == 422
        assert operator.get(PATH).json() == saved
    assert operator.put(PATH + "?filename=large.wav", content=b"x" * (startup_sound.MAX_UPLOAD + 1)).status_code == 413
    assert operator.put(PATH + "?filename=empty.wav", content=b"").status_code == 413
    assert operator.delete(PATH, headers={"X-CSRF-Token": ""}).status_code == 403
    assert operator.delete(PATH).status_code == 200
    assert not operator.get(PATH).json()["configured"]

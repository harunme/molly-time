"""Fit the approved voice to the current logo's 300–1800 ms motion window."""
from pathlib import Path
import json
import re
import subprocess
import tempfile

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]
svg = (REPO / 'assets/brand/mollytime-flower/motion/mollytime-animated.svg').read_text()
timing = re.search(r'animation-duration:(\d+)ms; animation-delay:(\d+)ms;', svg)
if not timing:
    raise ValueError('Cannot identify the shared logo motion timing')
motion_ms, intro_ms = map(int, timing.groups())
total_ms = intro_ms + motion_ms
native = (REPO / 'apps/tv/client/src/main/java/com/molly/tv/StartupLogoView.kt').read_text()
if not re.search(rf'duration\s*=\s*{total_ms}\b', native):
    raise ValueError('Native and SVG timelines differ; reconcile them before exporting')

source = ROOT / 'mollytime-startup-with-m-master.wav'
sr = 48000
# Keep the quiet nasal attack and the complete added /m/, removing outer silence.
voice_start, voice_end = 0.078, 1.344
tempo = (voice_end - voice_start) / (motion_ms / 1000)
with tempfile.TemporaryDirectory(prefix='mollytime-sync-') as temp:
    stretched = Path(temp) / 'voice.wav'
    subprocess.run([
        'ffmpeg', '-nostdin', '-v', 'error', '-i', str(source),
        '-af', f'atrim=start={voice_start}:end={voice_end},asetpts=PTS-STARTPTS,atempo={tempo:.9f}',
        '-ar', str(sr), '-ac', '1', '-c:a', 'pcm_f32le', str(stretched),
    ], check=True)
    voice, rate = sf.read(stretched)
    assert rate == sr

motion_samples = round(motion_ms * sr / 1000)
# WSOLA may differ by a few samples at its boundary; only remove/pad its quiet tail.
if abs(len(voice) - motion_samples) > sr * 0.02:
    raise ValueError('Unexpected time-stretch duration; refusing to truncate speech')
voice = np.pad(voice, (0, max(0, motion_samples - len(voice))))[:motion_samples]
attack, release = round(sr * 0.003), round(sr * 0.012)
voice[:attack] *= np.linspace(0, 1, attack)
voice[-release:] *= np.linspace(1, 0, release)
result = np.concatenate((np.zeros(round(intro_ms * sr / 1000)), voice))
assert len(result) == round(total_ms * sr / 1000)
assert np.isfinite(result).all() and np.max(np.abs(result)) < 1
master = ROOT / 'mollytime-startup-synced-master.wav'
mp3 = ROOT / 'mollytime-startup-synced.mp3'
sf.write(master, result, sr, subtype='PCM_24')
subprocess.run([
    'ffmpeg', '-nostdin', '-y', '-v', 'error', '-i', str(master),
    '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '320k',
    '-ar', str(sr), '-ac', '1', '-id3v2_version', '3',
    '-metadata', 'title=Mollytime Startup - Animation Sync', str(mp3),
], check=True)
(ROOT / 'sync-processing.json').write_text(json.dumps({
    'source': source.name,
    'animation_source': 'assets/brand/mollytime-flower/motion/mollytime-animated.svg',
    'intro_ms': intro_ms,
    'voice_window_ms': [intro_ms, total_ms],
    'total_ms': total_ms,
    'source_voice_seconds': [voice_start, voice_end],
    'tempo_ratio': tempo,
    'pitch_preserved': True,
    'method': 'FFmpeg atempo (WSOLA), sample-exact silence and duration, boundary fades',
    'playback_contract': 'Start the audio file and logo timeline together; the file already includes the 300 ms intro.',
    'runtime_limit': 'Device audio output latency requires on-device verification; this export aligns the media timeline.'
}, indent=2) + '\n')
print(f'Exported {total_ms} ms; voice window {intro_ms}–{total_ms} ms; tempo {tempo:.3f}')

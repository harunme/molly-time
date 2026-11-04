"""Add a terminal /m/ using the child's own initial nasal, with pitch-synchronous overlap-add."""
from pathlib import Path
import json

import numpy as np
import soundfile as sf
from scipy import signal

ROOT = Path(__file__).resolve().parent
voice, sr = sf.read(ROOT / 'mollytime-startup-master.wav')
donor_start, donor_end = 0.100, 0.142
donor = voice[round(donor_start * sr):round(donor_end * sr)]
epochs, _ = signal.find_peaks(donor, distance=110, prominence=0.02)
period = int(round(np.median(np.diff(epochs))))
epochs = epochs[(epochs > period) & (epochs < len(donor) - period)]
assert len(epochs) >= 5

duration, onset, crossfade = 0.190, 1.154, 0.038
length = round(duration * sr)
nasal = np.zeros(length)
weights = np.zeros(length)
window = np.hanning(2 * period + 1)
position = 0.0
while position < length + period:
    progress = min(position / length, 1.0)
    epoch = epochs[round(progress * (len(epochs) - 1))]
    grain = donor[epoch - period:epoch + period + 1].copy()
    grain -= grain.mean()
    grain /= max(np.sqrt(np.mean(grain ** 2)), 1e-8)
    center = round(position)
    a, b = max(0, center - period), min(length, center + period + 1)
    if a < b:
        ga, gb = a - (center - period), b - (center - period)
        nasal[a:b] += grain[ga:gb] * window[ga:gb]
        weights[a:b] += window[ga:gb]
    position += sr / (291.0 - 12.0 * progress)
nasal /= np.maximum(weights, 1e-8)
nasal /= np.sqrt(np.mean(nasal ** 2))
t = np.arange(length) / sr
envelope = 0.069 * np.exp(-t / 0.095)
release = round(0.045 * sr)
envelope[-release:] *= np.cos(np.linspace(0, np.pi / 2, release)) ** 2
nasal *= envelope

start = round(onset * sr)
overlap = round(crossfade * sr)
result = np.zeros(start + length + round(0.090 * sr))
result[:start] = voice[:start]
mix = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, overlap))
result[start:start + overlap] = voice[start:start + overlap] * (1 - mix)
nasal[:overlap] *= mix
result[start:start + length] += nasal
assert np.isfinite(result).all() and np.max(np.abs(result)) < 0.95
sf.write(ROOT / 'mollytime-startup-with-m-master.wav', result, sr, subtype='PCM_24')
(ROOT / 'm-ending-processing.json').write_text(json.dumps({
    'donor': 'Initial /m/ region from the same child recording; no external voice model',
    'donor_master_seconds': [donor_start, donor_end],
    'method': 'Pitch-synchronous overlap-add, declining pitch, amplitude envelope, cosine crossfade',
    'pitch_hz': [291, 279],
    'nasal_duration_ms': duration * 1000,
    'crossfade_ms': crossfade * 1000,
    'output_duration_seconds': len(result) / sr,
    'review': 'Signal and encoding checks only; listening review is still needed'
}, indent=2) + '\n')
print(f'Duration: {len(result) / sr:.3f} s; peak: {20 * np.log10(max(abs(result))):.2f} dBFS')

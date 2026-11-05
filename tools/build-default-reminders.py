#!/usr/bin/env python3
"""Rebuild the two bundled reminder clips on macOS (Pillow, ffmpeg, system speech).

Uses the existing MollyTime symbol. No family resource or storage quota is needed.
"""
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'apps/server/mollytime_server/assets/reminders'
FONT = '/System/Library/Fonts/Hiragino Sans GB.ttc'
CLIPS = {
    'warning': ('这是最后一集啦', '看完这一集，我们就休息一下。'),
    'farewell': ('该休息啦', '让眼睛歇一歇，去玩一会儿吧。'),
}


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        work = Path(temporary)
        for kind, (title, speech) in CLIPS.items():
            frame = Image.new('RGB', (1280, 720), '#22201b')
            symbol = Image.open(ROOT / 'assets/brand/mollytime-flower/digital/mollytime-symbol-jasmine.png').convert('RGBA')
            symbol.thumbnail((160, 160), Image.Resampling.LANCZOS)
            frame.paste(symbol, ((1280 - symbol.width) // 2, 135), symbol)
            draw = ImageDraw.Draw(frame)
            for text, y, size, color in [(title, 360, 50, '#fae181'), (speech, 448, 28, '#c5c0b4')]:
                draw.text((640, y), text, font=ImageFont.truetype(FONT, size), anchor='mm', fill=color)
            frame.save(work / 'frame.png')
            subprocess.run(['say', '-v', 'Tingting', '-r', '165', '-o', str(work / 'voice.aiff'), title + '。' + speech], check=True)
            duration = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(work / 'voice.aiff')])) + 1.4
            subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-loop', '1', '-i', str(work / 'frame.png'),
                '-i', str(work / 'voice.aiff'), '-vf', f'fade=t=in:d=0.45,fade=t=out:st={duration - .5}:d=0.5',
                '-af', 'adelay=600|600,apad', '-t', str(duration), '-r', '24', '-c:v', 'libx264', '-preset', 'slow',
                '-crf', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart',
                str(OUTPUT / f'{kind}.mp4')], check=True)


if __name__ == '__main__':
    main()

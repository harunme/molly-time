import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from tools.prepare_samples import prepare, valid_video


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg required")
class PreviewAssetTests(unittest.TestCase):
    def test_incomplete_video_is_excluded_and_subtitle_tracks_are_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "source"
            episode = source / "English" / "Series [1]" / "Episode [2]"
            episode.mkdir(parents=True)
            video = episode / "视频.mp4"
            subprocess.run([
                "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=10",
                "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(video),
            ], check=True)
            broken = source / "broken.mp4"
            data = video.read_bytes()
            broken.write_bytes(data[:len(data) // 2])
            self.assertTrue(valid_video(video))
            self.assertFalse(valid_video(broken))
            for name in ("英文字幕", "中英字幕"):
                (episode / f"{name}.srt").write_text("1\n00:00:00,000 --> 00:00:00,800\nHello\n")
            output = root / "assets"
            items = prepare(source, output, 1)
            self.assertEqual(len(items), 1)
            self.assertEqual(items[0]["title"], "Episode")
            self.assertEqual(len(items[0]["subtitles"]), 2)
            self.assertTrue(all((output / track["path"]).is_file() for track in items[0]["subtitles"]))
            self.assertTrue(video.exists())
            self.assertTrue(broken.exists())


if __name__ == "__main__":
    unittest.main()

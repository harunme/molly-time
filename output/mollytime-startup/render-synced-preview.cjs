// Sample the actual SVG at exact frame times, then mux the synchronized audio.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
const { chromium } = createRequire(path.join(repo, 'apps/tv/web/package.json'))('@playwright/test');

(async () => {
  const frames = await fs.mkdtemp(path.join(os.tmpdir(), 'mollytime-sync-preview-'));
  const svg = await fs.readFile(path.join(repo, 'assets/brand/mollytime-flower/motion/mollytime-animated.svg'), 'utf8');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:#211F1B}body{display:grid;place-items:center}svg{width:194.4px;height:194.4px}</style>${svg}`);
    await page.evaluate(() => {
      window.logoAnimations = document.querySelector('svg').getAnimations({ subtree: true });
      if (window.logoAnimations.length !== 5) throw new Error('Expected all five shared logo animations');
      window.logoAnimations.forEach(animation => { animation.pause(); animation.currentTime = 0; });
    });
    for (let frame = 0; frame < 144; frame++) {
      await page.evaluate(time => window.logoAnimations.forEach(animation => { animation.currentTime = time; }), frame * 1000 / 60);
      await page.screenshot({ path: path.join(frames, `${String(frame).padStart(4, '0')}.png`) });
    }
  } finally {
    await browser.close();
  }
  execFileSync('ffmpeg', [
    '-nostdin', '-y', '-v', 'error', '-framerate', '60', '-i', path.join(frames, '%04d.png'),
    '-i', path.join(__dirname, 'mollytime-startup-synced.mp3'),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-af', 'apad', '-c:a', 'aac', '-b:a', '192k', '-t', '2.4', '-movflags', '+faststart',
    path.join(__dirname, 'mollytime-startup-synced-preview.mp4'),
  ]);
  console.log(`Rendered 144 frames at 60 fps. Frame directory: ${frames}`);
})().catch(error => { console.error(error); process.exitCode = 1; });

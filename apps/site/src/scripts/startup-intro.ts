/** Every homepage entry and reload uses the same 1.8 s audio/animation timeline. */
export function startIntro(intro: HTMLElement) {
  const content = document.querySelector<HTMLElement>('[data-site-content]');
  const backdrop = intro.querySelector<HTMLElement>('.startup-backdrop')!;
  const symbol = intro.querySelector<HTMLElement>('.startup-symbol')!;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const audio = intro.dataset.sound ? new Audio(intro.dataset.sound) : undefined;
  const animations = symbol.getAnimations({ subtree: true });
  const minimum = reduced.matches ? 600 : 1800;
  const duration = Math.max(minimum, Math.min(Number(intro.dataset.duration) || 0, 6000));
  let finished = false;
  let startedAt = performance.now();
  let frame = 0;
  let endTimer = 0;
  let audioTimer = 0;
  let audioExpired = false;
  let sounding = false;
  let timelineDuration = minimum;
  intro.dataset.ready = 'true';
  if (content) content.inert = true;

  const smooth = (value: number) => {
    const t = Math.max(0, Math.min(value, 1));
    return t * t * (3 - 2 * t);
  };
  function reveal(time: number) {
    const progress = Math.min(time / timelineDuration, 1);
    // Reveal the real page throughout the logo's timeline, not in a later fade.
    const shade = String(1 - smooth(progress));
    backdrop.style.opacity = shade;
    document.documentElement.style.setProperty('--startup-shade', shade);
    symbol.style.opacity = String(1 - smooth((progress - 0.74) / 0.26));
  }

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(endTimer);
    clearTimeout(audioTimer);
    clearTimeout(watchdog);
    cancelAnimationFrame(frame);
    audio?.pause();
    reveal(timelineDuration);
    intro.hidden = true;
    animations.forEach(animation => animation.cancel());
    document.removeEventListener('visibilitychange', hidden);
    window.removeEventListener('pagehide', finish);
    reduced.removeEventListener('change', motionChanged);
    if (content) content.inert = false;
    document.documentElement.classList.remove('startup-active');
  }
  function tick() {
    if (finished) return;
    // Scrub the existing brand animation using the audio clock, as the TV does.
    const time = sounding && audio && !audio.paused ? audio.currentTime * 1000 : performance.now() - startedAt;
    if (!reduced.matches) animations.forEach(animation => { animation.currentTime = time; });
    reveal(time);
    frame = requestAnimationFrame(tick);
  }
  function begin(withSound: boolean) {
    if (finished) return;
    sounding = withSound;
    timelineDuration = withSound ? duration : minimum;
    intro.dataset.playback = withSound ? 'sound' : 'silent';
    startedAt = performance.now();
    reveal(0);
    animations.forEach(animation => { animation.pause(); animation.currentTime = 0; });
    clearTimeout(endTimer);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(tick);
    endTimer = window.setTimeout(finish, timelineDuration);
  }
  function playSound() {
    if (!audio) { begin(false); return; }
    // Slow media must not hold the site hostage or start sounding after entry.
    audioTimer = window.setTimeout(() => {
      if (finished) return;
      audioExpired = true;
      audio.pause();
      begin(false);
    }, 800);
    void audio.play().then(() => {
      if (finished || audioExpired) { audio.pause(); return; }
      clearTimeout(audioTimer);
      begin(true);
    }).catch(() => {
      if (finished || audioExpired) return;
      clearTimeout(audioTimer);
      begin(false);
    });
  }
  function hidden() { if (document.hidden) finish(); }
  function motionChanged() { if (reduced.matches) finish(); }
  const watchdog = window.setTimeout(finish, 7000);
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('pagehide', finish);
  reduced.addEventListener('change', motionChanged);
  playSound();
}

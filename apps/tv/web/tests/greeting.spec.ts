import { test, expect } from '@playwright/test';
import { chooseGreeting, greetingCandidates, greetingPeriod } from '../src/greeting';

function memory() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
test('local time boundaries distinguish noon and use only gentle rest messages late at night', () => {
  for (const [hour, expected] of [[4, 'night'], [5, 'morning'], [10, 'morning'], [11, 'noon'], [13, 'noon'], [14, 'afternoon'], [18, 'evening'], [21, 'night']] as const) {
    expect(greetingPeriod(new Date(2026, 9, 30, hour))).toBe(expected);
  }
  const late = new Date(2026, 9, 31, 23);
  expect(greetingCandidates(late, true)).toEqual(greetingCandidates(late, false));
  expect(greetingCandidates(late, true)).not.toContain('今天慢一点，挑个喜欢的故事。');
});
test('weekend and resume phrases are eligible only when their context is true', () => {
  const weekday = new Date(2026, 9, 30, 15);
  const weekend = new Date(2026, 9, 31, 15);
  expect(greetingCandidates(weekday, false)).not.toContain('今天慢一点，挑个喜欢的故事。');
  expect(greetingCandidates(weekend, false)).toContain('今天慢一点，挑个喜欢的故事。');
  expect(greetingCandidates(weekday, false)).not.toContain('上次的故事，还等着你接着看。');
  expect(greetingCandidates(weekday, true)).toContain('上次的故事，还等着你接着看。');
});
test('each launch avoids the previous six phrases, even with identical random draws', () => {
  const storage = memory(); const selected: string[] = [];
  for (let i = 0; i < 40; i++) {
    const next = chooseGreeting(new Date(2026, 9, 30, 15), false, storage, () => 0).message;
    expect(selected.slice(-6)).not.toContain(next);
    selected.push(next);
  }
});
test('malformed history and unavailable storage cannot break the greeting', () => {
  const date = new Date(2026, 9, 30, 15);
  for (const storage of [undefined, { getItem: () => '{}', setItem: () => {} }, {
    getItem: () => { throw new Error('disabled'); }, setItem: () => { throw new Error('disabled'); },
  }]) expect(chooseGreeting(date, false, storage).message.length).toBeGreaterThan(0);
});

test.describe('home greeting', () => {
  test.use({ timezoneId: 'Asia/Shanghai' });
  test('stays stable after returning from a folder and changes on the next launch', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-30T15:00:00+08:00'));
    await page.goto('/tv/?mock=1');
    const message = page.locator('.home-greeting p');
    await expect(message).not.toBeEmpty();
    await expect(page.locator('.home-greeting h1')).toHaveText('下午好');
    const first = await message.textContent();
    await page.locator('[data-focus="home-2-demo-series-1"]').click();
    await expect(page.locator('.home-greeting')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(message).toHaveText(first!);
    await page.reload();
    await expect(message).not.toBeEmpty();
    await expect(message).not.toHaveText(first!);
    await page.screenshot({ path: '/tmp/mollytime-home-greeting.png' });
  });
});
